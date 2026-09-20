const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function fixture() {
  const rows = new Map(); const pads = new Map(); let handler;
  const db = { get: async id => rows.get(id), set: async (id, value) => rows.set(id, structuredClone(value)) };
  const manager = { doesPadExist: async id => pads.has(id), getPad: async id => {
    if (!pads.has(id)) pads.set(id, { id, head: 0, value: '\n', text() { return this.value; }, async saveToDatabase() {} });
    return pads.get(id);
  } };
  const context = { exports: {}, process: { env: { ETHERPAD_CONTROL_TOKEN: 'secret' } }, Buffer, console,
    require: name => name === 'node:crypto' ? crypto : name === 'express' ? { json: () => () => {} } : name.endsWith('/DB') ? db : manager };
  vm.runInNewContext(readFileSync(`${__dirname}/policy.cjs`, 'utf8'), context);
  const policy = context.exports;
  policy.expressPreSession(null, { app: { use: (_path, _parser, callback) => { handler = callback; } } });
  const call = async (path, body, authorization = 'Bearer secret') => {
    let status = 200, value;
    await handler({ path, body, headers: { authorization } }, { status(n) { status = n; return this; }, end() {}, json(v) { value = v; } });
    return { status, value };
  };
  return { policy, call, pads, db };
}
const id = 'gdm-11111111-1111-4111-8111-111111111111';

test('signed grants bind a participant author to one pad and an expiry', () => {
  const { policy } = fixture();
  const sign = value => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${crypto.createHmac('sha256', 'secret').update(payload).digest('base64url')}`; };
  const grant = { padId: id, exp: Date.now() + 10000, authorToken: 't.alice' };
  assert.equal(policy.authorize(id, sign(grant)).authorToken, 't.alice');
  assert.equal(policy.authorize('another-pad', sign(grant)), null);
  assert.equal(policy.authorize(id, sign({ ...grant, exp: 1 })), null);
  assert.equal(policy.authorize(id, `${sign(grant)}x`), null);
});
test('blank creation only, code-point limit and deadlines are enforced at every revision', async () => {
  const { policy, call } = fixture();
  assert.doesNotThrow(() => policy.assertWrite(id, '\n', -1));
  assert.throws(() => policy.assertWrite(id, 'seed\n', -1));
  await call('/create', { padId: id, deadline: Date.now() + 10000 });
  assert.doesNotThrow(() => policy.assertWrite(id, '🌕'.repeat(1000) + '\n', 0));
  assert.throws(() => policy.assertWrite(id, '🌕'.repeat(1001) + '\n', 0), /1,000/);
  assert.throws(() => policy.assertWrite(id, 'x\n', 10000), /Editing limit/);
  await call('/close', { padId: id });
  assert.throws(() => policy.assertWrite(id, 'x\n', 1), /ended/);
});
test('close waits for in-flight persistence and then returns the authoritative raw text', async () => {
  const { policy, call, pads } = fixture();
  await call('/create', { padId: id, deadline: Date.now() + 10000 });
  let release;
  policy.trackWrite(id, () => new Promise(resolve => { release = () => { pads.get(id).value = 'accepted\n'; resolve(); }; }));
  let closed = false;
  const close = call('/close', { padId: id }).then(value => { closed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => policy.assertWrite(id, 'late edit\n', 1), /ended/);
  release();
  assert.equal((await close).value.text, 'accepted');
  assert.equal((await call('/snapshot', { padId: id }, 'wrong')).status, 401);
});
test('stored closed policies survive an editor restart', async () => {
  const { policy, db } = fixture();
  await db.set(`gdm:${id}`, { deadline: Date.now() + 10000, closed: true });
  await policy.padLoad(null, { pad: { id } });
  assert.throws(() => policy.assertWrite(id, 'late\n', 1), /ended/);
});
