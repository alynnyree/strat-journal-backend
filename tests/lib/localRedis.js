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
//
// REAL-STORE MODE (Deploy 2 real-store run plan v3.2, test code only). When,
// and only when, the runner (tests/realstore/run.js) starts a test with its
// run values in the environment (upstashRest.storeFromEnv: the binding is
// checked, and a refusal ENDS the process -- it never falls back to a local
// Redis):
//   - startRedis() starts NO local Redis; its client is the strict direct
//     client of upstashRest.js, talking to the run's temporary database;
//   - restShim() FORWARDS what the service's own client sends: unchanged when
//     no hook is installed (plan P-2), one command at a time when one is
//     (P-3), every answer judged by upstashRest.classify before anything of
//     it is returned, and an answer that is not usable ending the client's
//     connection unanswered (P-5), recorded in the run's ledger;
//   - stop() reports LOCAL ONLY; the runner itself cleans the database.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const UR = require('./upstashRest');
const STORE = UR.storeFromEnv();

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
  if (STORE) {
    return {
      client: UR.directClient(STORE), dir: null, pid: null, store: true,
      async stop() { return { localOnly: true }; },
    };
  }
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
function restShim(redisClient, { store = STORE } = {}) {
  const shim = { log: [], hooks: {}, count: 0 };
  const rec = store ? UR.recorder(store.ledgerDir) : null;
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', d => parts.push(d));
    req.on('end', async () => {
      if (store) { await storeForward(store, shim, req, res, Buffer.concat(parts), rec); return; }
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

// REAL-STORE FORWARDING (plan v2 2A, v3 A-B, v3.1 A1/D-R, v3.2 A2). The
// destination is ONLY the run's endpoint: a request's own Host header,
// address or Authorization header is never used to route or to sign.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isErrorReply = r => r !== null && typeof r === 'object' && !Array.isArray(r) && 'error' in r;
async function storeForward(store, shim, req, res, raw, rec) {
  const route = String(req.url).split('?')[0];
  const batch = route === '/pipeline';
  const refuse = why => { rec.fault('REFUSED', 0, null, why); res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'stand-in: refused (' + why + ')' })); };
  if (req.method !== 'POST' || (route !== '/' && route !== '/pipeline')) return refuse('a path or method the service never uses');
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { return refuse('a request body that is not JSON'); }
  const cmds = batch ? parsed : [parsed];
  if (!Array.isArray(cmds) || !cmds.length) return refuse('a pipeline that is not a non-empty list');
  const bad = cmds.find(c => !UR.commandOk(c));
  if (bad !== undefined) return refuse(UR.commandWhy(bad));
  const base64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
  const headers = { Authorization: 'Bearer ' + store.token, 'Content-Type': 'application/json' };
  if (base64) headers['Upstash-Encoding'] = 'base64';
  for (const c of cmds) { shim.count++; shim.log.push(c); }
  const unusable = (n, cl) => { rec.end(n, cl.decision, cl.step, cl.position); rec.fault(cl.decision, cl.step, cl.position, cl.why); req.socket.destroy(); };
  // P-2: no hook installed -- the ORIGINAL request, forwarded unchanged; the
  // answer returned with its original bytes only if every part of it passes.
  if (!shim.hooks.before && !shim.hooks.after) {
    const n = rec.start(cmds.map(c => c[0]));
    const a = await UR.send(store.endpoint + route, { headers, body: raw });
    const cl = UR.classify(a, { kind: batch ? 'pipeline' : 'single', n: cmds.length, base64, wellFormed: true });
    if (cl.decision !== 'RESULT' && cl.decision !== 'COMMAND_ERROR') return unusable(n, cl);
    rec.end(n, cl.decision, cl.step);
    res.statusCode = a.status;
    res.setHeader('content-type', a.contentType);
    res.end(a.bytes);
    return;
  }
  // P-3: a hook is installed -- one command at a time, in order, exactly as
  // the local stand-in does (Upstash pipelines are not atomic either).
  const answers = [];
  for (const cmd of cmds) {
    const b = shim.hooks.before ? await shim.hooks.before(cmd) : undefined;
    if (b && b.delayMs) await sleep(b.delayMs);
    if (b && b.drop) { req.socket.destroy(); return; }
    let reply, entry;
    if (b && 'reply' in b) reply = b.reply;
    else if (b && b.error) reply = { error: b.error };
    else {
      const n = rec.start([cmd[0]]);
      const a = await UR.send(store.endpoint + '/', { headers, body: JSON.stringify(cmd) });
      const cl = UR.classify(a, { kind: 'single', n: 1, base64, wellFormed: true });
      if (cl.decision !== 'RESULT' && cl.decision !== 'COMMAND_ERROR') return unusable(n, cl);
      rec.end(n, cl.decision, cl.step);
      entry = cl.entries[0];                                   // as Upstash sent it
      reply = 'error' in entry ? { error: entry.error } : (base64 ? UR.decodeValue(entry.result) : entry.result);
    }
    const af = shim.hooks.after ? await shim.hooks.after(cmd, reply) : undefined;
    if (af && af.delayMs) await sleep(af.delayMs);
    if (af && af.drop) { req.socket.destroy(); return; }
    if (af && 'reply' in af) { reply = af.reply; entry = undefined; }
    if (!entry) entry = isErrorReply(reply) ? { error: reply.error } : { result: base64 ? UR.encodeValue(reply) : reply };
    answers.push(entry);
  }
  res.setHeader('content-type', 'application/json');
  if (batch) { res.end(JSON.stringify(answers)); return; }
  if ('error' in answers[0]) res.statusCode = 400;
  res.end(JSON.stringify(answers[0]));
}

// The last line of every check file that used a Redis: in a local run, that
// the local Redis was stopped by SHUTDOWN NOSAVE and its folder removed; in a
// real-store run there is no local Redis, which is said, never passed.
function reportStop(check, stopped) {
  if (stopped && stopped.localOnly) { console.log('LOCAL ONLY: no local Redis was started (a real-store run); the runner cleans the database'); return; }
  check('the local Redis was stopped by SHUTDOWN NOSAVE and its folder removed', !!stopped && stopped.exited && stopped.folderGone, stopped);
}

const verb = cmd => String(cmd[0]).toLowerCase();
// For EVAL commands: which pinned script is it? (by exact text)
function scriptName(cmd, scripts) {
  if (verb(cmd) !== 'eval') return null;
  for (const [k, v] of Object.entries(scripts)) if (cmd[1] === v) return k;
  return 'UNKNOWN';
}

module.exports = { findRedis, startRedis, respClient, restShim, verb, scriptName, storeForward, reportStop, STORE };
