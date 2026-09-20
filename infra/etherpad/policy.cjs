const crypto = require('node:crypto');
const policies = new Map();
const pending = new Map();
const MAX_CHARS = 1000;
const MAX_REVISIONS = 10000;
const rawText = text => text.endsWith('\n') ? text.slice(0, -1) : text;
exports.rawText = rawText;
// Identity is server-signed: browser preferences cannot change study colours.
exports.applyIdentity = (message, grant) => {
  const identity = { name: grant.authorName || 'Participant', colorId: /^#[a-f0-9]{6}$/i.test(grant.authorColor || '') ? grant.authorColor : '#000000' };
  if (message.type === 'CLIENT_READY') message.userInfo = identity;
  if (message.type === 'COLLABROOM' && message.data?.type === 'USERINFO_UPDATE') message.data.userInfo = identity;
};
exports.trackWrite = (id, write) => {
  const result = write();
  const writes = pending.get(id) || new Set();
  pending.set(id, writes); writes.add(result);
  result.finally(() => { writes.delete(result); if (!writes.size) pending.delete(id); }).catch(() => {});
  return result;
};
exports.authorize = (padId, token) => {
  try {
    const [payload, signature] = String(token).split('.');
    const expected = crypto.createHmac('sha256', process.env.ETHERPAD_CONTROL_TOKEN).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (grant.padId !== padId || grant.exp <= Date.now() || !/^t\.[\w-]+$/.test(grant.authorToken)) return null;
    return grant;
  } catch { return null; }
};
exports.assertWrite = (padId, text, head) => {
  // Creation of a new blank pad precedes policy registration; all other writes fail closed.
  if (head === -1 && text === '\n') return;
  const policy = policies.get(padId);
  if (!policy || policy.closed || Date.now() >= policy.deadline) throw new Error('GDM: This writing phase has ended.');
  if ([...rawText(text)].length > MAX_CHARS) throw new Error('GDM: Maximum 1,000 characters. Your last edit was not saved.');
  if (head >= MAX_REVISIONS) throw new Error('GDM: Editing limit reached.');
};
exports.padLoad = async (_hook, { pad }) => {
  const db = require('./node/db/DB');
  const policy = await db.get(`gdm:${pad.id}`);
  if (policy) policies.set(pad.id, policy);
};
exports.handleMessage = async (_hook, { message }) => {
  // No second chat channel, pad deletion, rename, settings or client imports.
  if (message.type === 'COLLABROOM' && !['USER_CHANGES', 'USERINFO_UPDATE'].includes(message.data?.type)) return null;
};
exports.expressPreSession = async (_hook, { app }) => {
  const express = require('express');
  app.use('/gdm', express.json({ limit: '16kb' }), async (req, res) => {
    const expected = Buffer.from(`Bearer ${process.env.ETHERPAD_CONTROL_TOKEN || ''}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (!process.env.ETHERPAD_CONTROL_TOKEN || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.status(401).end(); return; }
    try {
      const manager = require('./node/db/PadManager');
      const db = require('./node/db/DB');
      const id = req.body?.padId;
      if (!/^gdm-[a-f0-9-]{36}$/.test(id || '')) { res.status(400).json({ error: 'Invalid pad' }); return; }
      if (req.path === '/create') {
        if (!Number.isFinite(req.body.deadline)) throw new Error('Missing deadline');
        const pad = await manager.getPad(id, '');
        let policy = policies.get(id);
        if (!policy) {
          policy = { deadline: req.body.deadline, closed: false };
          await db.set(`gdm:${id}`, policy);
          policies.set(id, policy);
        }
        res.json({ text: rawText(pad.text()), revision: pad.head, ...policy });
        return;
      }
      if (!(await manager.doesPadExist(id))) { res.status(404).json({ error: 'Missing pad' }); return; }
      const pad = await manager.getPad(id);
      if (req.path === '/close') {
        const policy = policies.get(id);
        if (!policy) throw new Error('Missing pad policy');
        policy.closed = true;
        await db.set(`gdm:${id}`, policy);
        // An accepted revision may still be persisting (or rolling back).
        // Freeze first, then await those writes before taking the snapshot.
        await Promise.allSettled([...(pending.get(id) || [])]);
        await pad.saveToDatabase();
      } else if (req.path !== '/snapshot') { res.status(404).end(); return; }
      res.json({ text: rawText(pad.text()), revision: pad.head, ...policies.get(id) });
    } catch (error) { res.status(503).json({ error: String(error.message) }); }
  });
};
