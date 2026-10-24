// A REAL Redis on this machine, behind a stand-in of Upstash's web service,
// for the generation-2 checks (Queue plan v14.1 revision 3.2, Deploy 2).
//
// The service's own storage client (@upstash/redis) talks to the stand-in
// exactly as it talks to Upstash: one JSON command per request, text answers
// in base64. The stand-in passes every command to the real Redis, so every
// script runs in a real script engine. It can also be told to LOSE an answer
// (after the command ran, or before), to delay one, or to answer reads with
// an older copy -- the faults the plan's tests need, made on purpose.
//
// The Redis is started as this process's own child: no TCP port (port 0), a
// private socket in a fresh folder, nothing saved to disk. It is identified
// by its process id over that socket before use, and stopped ONLY by
// "SHUTDOWN NOSAVE" over the same connection -- no process signals (the Gate 1
// rule). Request bodies are collected as bytes and decoded once, so a
// character split between two pieces is never damaged (Gate 1, RR.3).
//
// What it is NOT: Upstash. A real-store run (plan 6.0, revision 3.2) is
// separately authorised.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function findRedis() {
  const r = spawnSync('sh', ['-c', 'command -v redis-server'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// A small Redis wire-protocol client over a socket file.
function respClient(socketPath) {
  const sock = net.connect(socketPath);
  let buf = Buffer.alloc(0);
  const waiting = [];
  let closed = null;
  function parse(b, i) {
    if (i >= b.length) return null;
    const type = String.fromCharCode(b[i]);
    const eol = b.indexOf('\r\n', i);
    if (eol < 0) return null;
    const line = b.slice(i + 1, eol).toString('utf8');
    if (type === '+') return [line, eol + 2];
    if (type === '-') return [{ error: line }, eol + 2];
    if (type === ':') return [Number(line), eol + 2];
    if (type === '$') {
      const n = Number(line);
      if (n < 0) return [null, eol + 2];
      if (b.length < eol + 2 + n + 2) return null;
      return [b.slice(eol + 2, eol + 2 + n).toString('utf8'), eol + 2 + n + 2];
    }
    if (type === '*') {
      const n = Number(line);
      if (n < 0) return [null, eol + 2];
      const out = []; let j = eol + 2;
      for (let k = 0; k < n; k++) { const r = parse(b, j); if (!r) return null; out.push(r[0]); j = r[1]; }
      return [out, j];
    }
    throw new Error('unexpected reply type ' + type);
  }
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = parse(buf, 0);
      if (!r) break;
      buf = buf.slice(r[1]);
      const w = waiting.shift();
      if (w) w.res(r[0]);
    }
  });
  sock.on('close', () => { closed = closed || 'closed'; while (waiting.length) waiting.shift().res({ error: 'connection closed' }); });
  sock.on('error', e => { closed = e.message; });
  const ready = new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  return {
    ready,
    call(...args) {
      if (closed) return Promise.resolve({ error: 'connection closed' });
      const parts = args.map(a => (Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')));
      const chunks = [Buffer.from(`*${parts.length}\r\n`)];
      for (const p of parts) chunks.push(Buffer.from(`$${p.length}\r\n`), p, Buffer.from('\r\n'));
      return new Promise(res => { waiting.push({ res }); sock.write(Buffer.concat(chunks)); });
    },
    close() { sock.destroy(); },
  };
}

async function startRedis() {
  const bin = findRedis();
  if (!bin) {
    if (process.env.REQUIRE_REAL_REDIS === '1') throw new Error('REQUIRE_REAL_REDIS is set and no redis-server is installed');
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-redis-'));
  const sockPath = path.join(dir, 'r.sock');
  const child = spawn(bin, ['--port', '0', '--unixsocket', sockPath, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', dir],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  while (!fs.existsSync(sockPath)) {
    if (exited || Date.now() - t0 > 5000) throw new Error('local Redis did not start');
    await new Promise(r => setTimeout(r, 20));
  }
  const c = respClient(sockPath);
  await c.ready;
  const info = await c.call('INFO', 'server');
  const m = /process_id:(\d+)/.exec(String(info));
  if (!m || Number(m[1]) !== child.pid) { c.close(); throw new Error('the Redis on the socket is not the one this test started'); }
  return {
    client: c, dir, pid: child.pid,
    async stop() {
      // SHUTDOWN NOSAVE over the verified connection; the connection closing
      // is its answer. No process signals.
      await c.call('SHUTDOWN', 'NOSAVE').catch(() => {});
      const t = Date.now();
      while (!exited && Date.now() - t < 5000) await new Promise(r => setTimeout(r, 20));
      c.close();
      fs.rmSync(dir, { recursive: true, force: true });
      return { exited, folderGone: !fs.existsSync(dir) };
    },
  };
}

// ---- The stand-in of Upstash's web service.
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
function encode(v, base64) {
  if (typeof v === 'string') return base64 ? b64(v) : v;
  if (Array.isArray(v)) return v.map(x => encode(x, base64));
  return v;
}
// hooks: { before(cmd) -> undefined | {drop: true} | {error} | {reply} | {delayMs},
//          after(cmd, reply) -> undefined | {drop: true} | {reply} | {delayMs} }
// "drop" ends the connection with no answer: the client sees a lost reply.
function restShim(redisClient) {
  const shim = { log: [], hooks: {}, count: 0 };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', d => parts.push(d));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: 'stand-in: not JSON' })); return; }
      const base64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
      const batch = req.url.startsWith('/pipeline') || req.url.startsWith('/multi-exec');
      const cmds = batch ? parsed : [parsed];
      const answers = [];
      for (const cmd of cmds) {
        shim.count++;
        shim.log.push(cmd);
        const b = shim.hooks.before ? await shim.hooks.before(cmd) : undefined;
        if (b && b.delayMs) await new Promise(r => setTimeout(r, b.delayMs));
        if (b && b.drop) { req.socket.destroy(); return; }
        let reply;
        if (b && 'reply' in b) reply = b.reply;
        else if (b && b.error) reply = { error: b.error };
        else reply = await redisClient.call(...cmd.map(x => (typeof x === 'string' ? x : JSON.stringify(x))));
        const a = shim.hooks.after ? await shim.hooks.after(cmd, reply) : undefined;
        if (a && a.delayMs) await new Promise(r => setTimeout(r, a.delayMs));
        if (a && a.drop) { req.socket.destroy(); return; }
        if (a && 'reply' in a) reply = a.reply;
        answers.push(reply && typeof reply === 'object' && !Array.isArray(reply) && 'error' in reply
          ? { error: reply.error } : { result: encode(reply, base64) });
      }
      res.setHeader('content-type', 'application/json');
      if (batch) { res.end(JSON.stringify(answers)); return; }
      if (answers[0].error) res.statusCode = 400;
      res.end(JSON.stringify(answers[0]));
    });
  });
  shim.server = server;
  shim.listen = () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  shim.close = () => new Promise(r => server.close(() => r()));
  return shim;
}

const verb = cmd => String(cmd[0]).toLowerCase();
// For EVAL commands: which pinned script is it? (by exact text)
function scriptName(cmd, scripts) {
  if (verb(cmd) !== 'eval') return null;
  for (const [k, v] of Object.entries(scripts)) if (cmd[1] === v) return k;
  return 'UNKNOWN';
}

module.exports = { findRedis, startRedis, respClient, restShim, verb, scriptName };
