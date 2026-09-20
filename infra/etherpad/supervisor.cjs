// Only a small supervisor remains running when the Etherpad server is stopped.
// No Docker socket, shell commands, or arbitrary process arguments are exposed.
const http = require('node:http');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');
let child;
let stopping = false;
function valid(req) {
  const expected = Buffer.from(`Bearer ${process.env.ETHERPAD_CONTROL_TOKEN || ''}`);
  const actual = Buffer.from(req.headers.authorization || '');
  return process.env.ETHERPAD_CONTROL_TOKEN && actual.length === expected.length && timingSafeEqual(actual, expected);
}
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (!valid(req)) { res.writeHead(401).end(); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/start' && !child && !stopping) {
    child = spawn(process.execPath, ['--require', 'tsx/cjs', 'node/server.ts'], {
      cwd: '/opt/etherpad-lite/src', stdio: 'inherit', env: process.env,
    });
    const current = child;
    current.once('exit', () => { if (child === current) child = undefined; stopping = false; });
  } else if (req.method === 'POST' && req.url === '/stop' && child) {
    stopping = true;
    const current = child;
    current.kill('SIGTERM');
    const kill = setTimeout(() => { if (child === current) current.kill('SIGKILL'); }, 20000);
    kill.unref();
  } else if (req.method !== 'GET' || req.url !== '/status') {
    // start/stop are idempotent.
    if (!['/start', '/stop'].includes(req.url)) { res.writeHead(404).end(); return; }
  }
  let ready = false;
  if (child && !stopping) {
    try { ready = (await fetch('http://127.0.0.1:9001/health', { signal: AbortSignal.timeout(1500) })).ok; } catch {}
  }
  res.end(JSON.stringify({ running: !!child, ready, stopping }));
}).listen(9002, '0.0.0.0');
process.on('SIGTERM', () => { child?.kill('SIGTERM'); setTimeout(() => process.exit(), 20000).unref(); if (!child) process.exit(); });
