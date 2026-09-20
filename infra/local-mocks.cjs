// Loaded only by docker-compose.local.yml. Production refuses this preload.
if (process.env.GDM_ENV !== 'development') {
  throw new Error('Local integration mocks require GDM_ENV=development');
}
const realFetch = globalThis.fetch;
const json = (body, status = 200) => Response.json(body, { status });
const studyId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

globalThis.fetch = async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['api.anthropic.com', 'api.prolific.com'].includes(url.hostname)) {
    return realFetch(input, init);
  }
  // Never fall through to these external services, even for unknown endpoints.
  const method = (init.method || input.method || 'GET').toUpperCase();
  const body = JSON.parse(init.body || '{}');
  if (url.hostname === 'api.anthropic.com' && url.pathname === '/v1/messages' && method === 'POST') {
    const prompt = body.messages?.[0]?.content || '';
    const properties = body.output_config?.format?.schema?.properties || {};
    let output;
    if (properties.relevance) {
      const message = prompt.match(/Text: "([\s\S]*?)"\n\nPRECEDING CONTEXT:/)?.[1] || '';
      const reason = 'Local mock: deterministic text heuristic, not an AI judgment.';
      const hits = pattern => (message.match(pattern) || []).length;
      // Graded 1-5 ratings from keyword counts, mirroring the v2 prompt order.
      const rating = score => ({ rating: Math.max(1, Math.min(5, 1 + score)), reason });
      const indicator = value => ({ value, reason });
      const itemHits = hits(/oxygen|water|food|rope|map|parachute|radio|pistol|milk|match|compass|raft|kit|flare/gi);
      const stanceHits = hits(/because|should|rank|first|second|suggest|think|let.s/gi);
      const replyHits = hits(/agree|disagree|you said|good point/gi);
      const mentionHits = hits(/\byou\b|\byour\b/gi);
      output = {
        relevance: rating(itemHits + stanceHits),
        coherence: rating(2 * replyHits + mentionHits),
        invites_participation: indicator(/what do you|anyone|thoughts|do you agree|what about/i.test(message)),
      };
    } else if (properties.message) {
      const name = prompt.match(/Address @(.+?) exactly once/)?.[1] || 'Participant';
      const percent = prompt.match(/percentage (\d+)%/)?.[1] || '0';
      output = { message: `@${name}, thanks for contributing ${percent}% of the discussion. Could you invite the others to share their thoughts?` };
    } else if (properties.flagged) {
      output = { flagged: prompt.includes('[mock-abuse]'), reason: 'Local mock moderation marker' };
    } else {
      return json({ error: 'Unsupported mock Anthropic schema' }, 400);
    }
    return json({ model: 'local-mock', content: [{ type: 'text', text: JSON.stringify(output) }] });
  }
  if (url.hostname === 'api.prolific.com') {
    const submission = url.pathname.match(/^\/api\/v1\/submissions\/([a-f0-9]{24})\/$/);
    if (submission && method === 'GET') {
      return json({ id: submission[1], participant: submission[1], study_id: studyId, status: 'ACTIVE' });
    }
    if (/^\/api\/v1\/submissions\/[a-f0-9]{24}\/request-return\/$/.test(url.pathname) && method === 'POST') {
      return json({ mock: true, status: 'RETURN_REQUESTED' });
    }
    if (url.pathname === '/api/v1/submissions/bonus-payments/' && method === 'POST') {
      return json({ id: `mock-${require('node:crypto').randomUUID()}` });
    }
    if (/^\/api\/v1\/bulk-bonus-payments\/mock-[\w-]+\/pay\/$/.test(url.pathname) && method === 'POST') {
      return json({ mock: true, status: 'PAID' });
    }
  }
  return json({ error: 'Unsupported local mock endpoint' }, 404);
};
console.warn('[LOCAL MOCKS] Anthropic and Prolific requests are simulated; no external AI calls or payments.');
