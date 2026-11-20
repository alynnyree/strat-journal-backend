// A REAL Redis server for the Step 1B checks, with the same few methods the
// service uses on Upstash (get, set with nx/ex, hashes, lists, eval).
//
// Why real: the answer script must be ATOMIC -- two devices answering at the
// same moment can never both win. An in-memory stand-in runs one call at a
// time and would pass whether or not the script were atomic. A real server
// over two connections can interleave, so the check can fail.
//
// Where: REDIS_TEST_URL (the CI job runs a redis service), otherwise a
// private redis-server started here on a spare port. With
// REQUIRE_REAL_REDIS=1 a missing server is a failure, never a skip.
const net = require('net');
const { spawn, execSync } = require('child_process');

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) { const s = Buffer.from(String(a)); out += `$${s.length}\r\n${s}\r\n`; }
  return out;
}

// Parses one RESP value from buf at i -> [value, nextIndex] or null if incomplete.
function parse(buf, i) {
  if (i >= buf.length) return null;
  const type = String.fromCharCode(buf[i]);
  const end = buf.indexOf('\r\n', i);
  if (end < 0) return null;
  const line = buf.slice(i + 1, end).toString();
  if (type === '+') return [line, end + 2];
  if (type === '-') return [new Error(line), end + 2];
  if (type === ':') return [Number(line), end + 2];
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    if (buf.length < end + 2 + n + 2) return null;
    return [buf.slice(end + 2, end + 2 + n).toString(), end + 2 + n + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    const arr = [];
    let j = end + 2;
    for (let k = 0; k < n; k++) { const r = parse(buf, j); if (!r) return null; arr.push(r[0]); j = r[1]; }
    return [arr, j];
  }
  throw new Error('unknown reply type ' + type);
}

function connect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    let buf = Buffer.alloc(0);
    const waiting = [];
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = parse(buf, 0);
        if (!r) break;
        buf = buf.slice(r[1]);
        const w = waiting.shift();
        if (w) (r[0] instanceof Error ? w.reject(r[0]) : w.resolve(r[0]));
      }
    });
    sock.on('error', err => { while (waiting.length) waiting.shift().reject(err); reject(err); });
    sock.on('connect', () => {
      const cmd = (...args) => new Promise((res, rej) => { waiting.push({ resolve: res, reject: rej }); sock.write(encode(args)); });
      const client = {
        cmd,
        get: k => cmd('GET', k),
        set: async (k, v, o = {}) => {
          const a = ['SET', k, v];
          if (o.ex) a.push('EX', o.ex);
          if (o.nx) a.push('NX');
          return cmd(...a);
        },
        del: (...k) => cmd('DEL', ...k),
        exists: k => cmd('EXISTS', k),
        hget: (k, f) => cmd('HGET', k, f),
        hset: (k, obj) => cmd('HSET', k, ...Object.entries(obj).flat()),
        hgetall: async k => { const a = await cmd('HGETALL', k); const o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; return Object.keys(o).length ? o : null; },
        hdel: (k, ...f) => cmd('HDEL', k, ...f),
        lpush: (k, ...v) => cmd('LPUSH', k, ...v),
        rpush: (k, ...v) => cmd('RPUSH', k, ...v),
        lrange: (k, a, b) => cmd('LRANGE', k, a, b),
        ltrim: (k, a, b) => cmd('LTRIM', k, a, b),
        eval: (script, keys, args) => cmd('EVAL', script, keys.length, ...keys, ...args),
        flushdb: () => cmd('FLUSHDB'),
        close: () => sock.end(),
      };
      resolve(client);
    });
  });
}

// -> { url, stop } or { skipped: reason }
async function realRedis() {
  if (process.env.REDIS_TEST_URL) return { url: process.env.REDIS_TEST_URL, stop: () => {} };
  let bin = null;
  try { bin = execSync('command -v redis-server', { encoding: 'utf8' }).trim(); } catch (e) { bin = null; }
  if (!bin) {
    if (process.env.REQUIRE_REAL_REDIS === '1') throw new Error('a real Redis server is required for this check and none is available');
    return { skipped: 'no Redis server on this machine (set REDIS_TEST_URL)' };
  }
  const port = 6390 + Math.floor(Math.random() * 500);
  const child = spawn(bin, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const c = await connect(url); c.close(); return { url, stop: () => child.kill() }; }
    catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  child.kill();
  throw new Error('the local Redis server did not start');
}

module.exports = { realRedis, connect };
