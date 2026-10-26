'use strict';
// A LOCAL STAND-IN OF UPSTASH'S REST INTERFACE, for the real-store harness's
// own self-tests (Deploy 2 real-store run plan v2 2B, v3 E, v3.1, v3.2 S-14).
// Backed by a real local Redis (tests/lib/localRedis.js), it answers in the
// format Upstash DOCUMENTS (saved copy of its REST API page):
//   POST "/" with a JSON command          -> 200 {"result": ...} or 400 {"error": "..."}
//   POST "/pipeline" with a list of them  -> 200 [{"result"}|{"error"}, ...]
//   "Upstash-Encoding: base64"            -> every string base64, except "OK"
//   a wrong token                         -> 401 {"error": "WRONGPASS invalid password"}
//   another method                        -> 405
//   GET "/metrics/<id>"                   -> the documented metrics fields
// and it can be told to answer the NEXT request(s) with anything at all (a
// status, a body, a delay, a dropped connection, a redirect), so that every
// way a real answer could go wrong can be shown to the harness.
// It is built from the documentation, so it can be wrong where the
// documentation is silent: the live probe (step 0) runs on the real database.
const http = require('http');
const { startRedis } = require('./localRedis');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const enc = (v, base64) => (typeof v === 'string' ? (base64 && v !== 'OK' ? b64(v) : v)
  : Array.isArray(v) ? v.map(x => enc(x, base64)) : v);
const isErr = r => r !== null && typeof r === 'object' && !Array.isArray(r) && 'error' in r;

async function upstashStandIn({ token = 'stand-in-token-0123456789abcdef', id = '00000000-0000-4000-8000-000000000000' } = {}) {
  const redis = await startRedis();
  if (!redis || redis.store) throw new Error('the Upstash stand-in needs a LOCAL Redis');
  const R = redis.client;
  const s = { token, id, arrivals: 0, bytesIn: 0, bytesOut: 0, next: [], requests: [], started: Date.now() };
  const reply = (res, status, body, contentType = 'application/json') => {
    const b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    s.bytesOut += b.length;
    res.statusCode = status; res.setHeader('content-type', contentType); res.end(b);
  };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', d => parts.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(parts);
      s.arrivals++; s.bytesIn += raw.length;
      s.requests.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization || null, encoding: req.headers['upstash-encoding'] || null });
      // A scripted answer for this request, if one is queued.
      const scripted = s.next.length ? s.next.shift() : null;
      if (scripted) {
        if (scripted.delayMs) await new Promise(r => setTimeout(r, scripted.delayMs));
        if (scripted.destroy) { req.socket.destroy(); return; }
        if (scripted.redirect) { res.statusCode = scripted.redirect; res.setHeader('location', scripted.location); res.end(); return; }
        if (scripted.status) return reply(res, scripted.status, scripted.body === undefined ? '' : scripted.body, scripted.contentType || 'application/json');
        // else: fall through, answered normally (e.g. only a delay)
      }
      // A request the self-test wants held open (an in-flight forward).
      if (s.holdWhen) { const ms = s.holdWhen(raw.toString('utf8')); if (ms) await new Promise(r => setTimeout(r, ms)); }
      if (req.method === 'GET' && req.url === `/metrics/${s.id}`) {
        const cs = String(await R.call('INFO', 'commandstats'));
        let commands = 0; for (const l of cs.split(/\r?\n/)) { const x = /^cmdstat_([a-z_|]+):calls=(\d+)/.exec(l); if (x && !/^(info|config)/.test(x[1])) commands += Number(x[2]); }
        return reply(res, 200, { uptime_seconds: Math.round((Date.now() - s.started) / 1000), expires_at: new Date(s.started + 3 * 86400000).toISOString(),
          console_url: 'stand-in', commands_total: commands, commands_per_sec_1m: 0, keys: await R.call('DBSIZE'), memory_bytes: 0, bytes_in: s.bytesIn, bytes_out: s.bytesOut });
      }
      if (!['POST', 'GET', 'HEAD', 'PUT'].includes(req.method)) return reply(res, 405, { error: 'method not allowed' });
      if (req.headers.authorization !== 'Bearer ' + s.token) return reply(res, 401, { error: 'WRONGPASS invalid password' });
      const base64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { return reply(res, 400, { error: 'ERR failed to parse command' }); }
      const run = async cmd => {
        const r = await R.call(...cmd.map(x => String(x)));
        return isErr(r) ? { error: r.error } : { result: enc(r, base64) };
      };
      if (req.url === '/pipeline') {
        if (!Array.isArray(parsed)) return reply(res, 400, { error: 'ERR invalid pipeline' });
        const out = [];
        for (const c of parsed) out.push(await run(c));
        return reply(res, 200, out);
      }
      if (req.url !== '/') return reply(res, 400, { error: 'ERR unknown path' });
      const one = await run(parsed);
      return reply(res, 'error' in one ? 400 : 200, one);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.endpoint = `http://127.0.0.1:${server.address().port}`;
  s.metricsUrl = `${s.endpoint}/metrics/${s.id}`;
  s.R = R;
  s.close = async () => { await new Promise(r => server.close(() => r())); return redis.stop(); };
  s.server = server;
  return s;
}

// A second local server that only COUNTS what reaches it: the redirect
// target that must receive nothing (plan v3.1 D-R, S-13).
async function countingServer() {
  const c = { hits: 0 };
  const server = http.createServer((req, res) => { c.hits++; res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  c.url = `http://127.0.0.1:${server.address().port}`;
  c.close = () => new Promise(r => server.close(() => r()));
  return c;
}

module.exports = { upstashStandIn, countingServer };
