const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
process.env.GDM_ENV = 'development';
let forwarded = 0;
globalThis.fetch = async () => { forwarded++; return Response.json({ internal: true }); };
require('./local-mocks.cjs');
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

const classify = async text => {
  const response = await fetch('https://api.anthropic.com/v1/messages', post({
    messages: [{ content: `Text: "${text}"\n\nPRECEDING CONTEXT:` }],
    output_config: { format: { schema: { properties: { relevance: {}, coherence: {}, invites_participation: {} } } } },
  }));
  return JSON.parse((await response.json()).content[0].text);
};

test('AI response contains graded classifier ratings without external fetch', async () => {
  const result = await classify('I agree, oxygen should rank first because we need it. Any thoughts?');
  assert.deepEqual(Object.keys(result), ['relevance', 'coherence', 'invites_participation']);
  assert.equal(result.relevance.rating, 5);
  assert.equal(result.coherence.rating, 3);
  assert.equal(result.invites_participation.value, true);
  for (const dimension of ['relevance', 'coherence']) {
    assert.ok(Number.isInteger(result[dimension].rating));
    assert.ok(result[dimension].rating >= 1 && result[dimension].rating <= 5);
    assert.equal(typeof result[dimension].reason, 'string');
  }
});

test('off-topic text gets the lowest ratings and no invitation', async () => {
  const result = await classify('Calibration phrase: purple rectangle, violin, tram 741.');
  assert.equal(result.relevance.rating, 1);
  assert.equal(result.coherence.rating, 1);
  assert.equal(result.invites_participation.value, false);
});

test('nudge addresses requested target and percentage', async () => {
  const response = await fetch('https://api.anthropic.com/v1/messages', post({
    messages: [{ content: 'Address @Fox exactly once. Include the exact contribution percentage 80% exactly once.' }],
    output_config: { format: { schema: { properties: { message: {} } } } },
  }));
  const result = JSON.parse((await response.json()).content[0].text);
  assert.match(result.message, /@Fox/);
  assert.match(result.message, /80%/);
});

test('Prolific validation and payment lifecycle use local responses', async () => {
  const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const root = 'https://api.prolific.com/api/v1';
  const submission = await (await fetch(`${root}/submissions/${id}/`)).json();
  assert.equal(submission.participant, id);
  assert.equal(submission.study_id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((await fetch(`${root}/submissions/${id}/request-return/`, post({}))).status, 200);
  const batch = await (await fetch(`${root}/submissions/bonus-payments/`, post({}))).json();
  assert.match(batch.id, /^mock-/);
  const payment = await (await fetch(`${root}/bulk-bonus-payments/${batch.id}/pay/`, post({}))).json();
  assert.equal(payment.mock, true);
  assert.equal(forwarded, 0);
});

test('unknown external routes are blocked; internal traffic passes through', async () => {
  assert.equal((await fetch('https://api.prolific.com/unknown')).status, 404);
  assert.equal((await fetch('https://api.anthropic.com/unknown')).status, 404);
  assert.equal(forwarded, 0);
  assert.deepEqual(await (await fetch('http://synapse:8008/health')).json(), { internal: true });
  assert.equal(forwarded, 1);
});

test('mock preload refuses production', () => {
  const result = spawnSync(process.execPath, ['-r', require.resolve('./local-mocks.cjs'), '-e', ''], {
    env: { ...process.env, GDM_ENV: 'production' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require GDM_ENV=development/);
});
