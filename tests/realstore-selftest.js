// THE REAL-STORE HARNESS, CHECKED WITHOUT ANY NETWORK (Deploy 2 real-store
// run plan v3.2, accepted as final by the owner, 26 Oct 2026; test code only).
// Everything runs against tests/lib/upstashStandIn.js, a local stand-in of
// Upstash's documented REST format, backed by a local Redis.
//   S-1  the direct client returns exactly what the local Redis client returns
//   S-2  the pinned scripts, every reply branch, through both paths
//   S-4  transport failures: a lost answer, never a reply; one arrival each
//   S-5  the tests' fault hooks behave as on local Redis
//   S-7, S-8, S-11, S-12/S-14  the classifier's order and strictness
//   S-9  the runner's clean-up verdicts (verified / not verified)
//   S-10 one destination only; the client's own Authorization never forwarded
//   S-13 no redirect is followed, on every path
//   store mode refuses rather than falls back
//   broken copies, each caught
// The full suite in store mode (S-3) is tests/realstore/selftest-suite.js.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const UR = require('./lib/upstashRest');
const { startRedis, restShim, storeForward } = require('./lib/localRedis');
const { upstashStandIn, countingServer } = require('./lib/upstashStandIn');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); } };
async function section(t, fn) { console.log('\n--- ' + t + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 7 * 60 * 1000).unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = (status, body, contentType = 'application/json') => ({ status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) });
const single = (base64 = true) => ({ kind: 'single', n: 1, base64, wellFormed: true });
const pipe = (n, base64 = true) => ({ kind: 'pipeline', n, base64, wellFormed: true });
const L1 = 'ERR max daily request limit exceeded', L2 = 'ERR max requests limit exceeded', L3 = 'ERR max request size exceeded';
const E1 = 'ERR wrong-type', E2 = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const E2s = E2 + ' script: ' + 'a'.repeat(40) + ', on @user_script:1.';

(async () => {
  if (!(await startRedis().then(r => { if (r) r.stop(); return !!r; }))) {
    if (process.env.REQUIRE_REAL_REDIS === '1') { console.log('FAIL: no redis-server on this machine, and REQUIRE_REAL_REDIS=1'); process.exit(1); }
    console.log('SKIPPED: no redis-server on this machine\n\n0 passed, 0 failed'); process.exit(0);
  }

  await section('S-11 (A1): strict, canonical base64', async () => {
    for (const s of ['QR==', 'QQ=', 'Q=Q=', 'QQ==\n', '-_8=', 'QQ===', '//4=']) {
      check(`"${JSON.stringify(s).slice(1, -1)}" refused as a result under base64`, UR.classify(A(200, { result: s }), single()).decision === 'AMBIGUOUS');
      check(`"${JSON.stringify(s).slice(1, -1)}" refused inside a nested array`, UR.classify(A(200, { result: ['QQ==', [s]] }), single()).decision === 'AMBIGUOUS');
    }
    for (const s of ['OK', '', 'QQ==', Buffer.from('café ✓').toString('base64')]) check(`${JSON.stringify(s)} accepted`, UR.classify(A(200, { result: s }), single()).decision === 'RESULT');
    const big = Buffer.from('x'.repeat(4 * 1024 * 1024)).toString('base64');
    check('a 4 MB reply is judged without overflowing (found by S-3: one pattern over the whole text overflowed)', UR.classify(A(200, { result: big }), single()).decision === 'RESULT');
    check('...and a 4 MB reply with one wrong character is refused', UR.classify(A(200, { result: big.slice(0, -5) + '-' + big.slice(-4) }), single()).decision === 'AMBIGUOUS');
    check('U+FFFD in a plain-JSON reply is refused (path D)', UR.classify(A(200, { result: 'a�b' }), single(false)).decision === 'AMBIGUOUS');
    const permissive = s => { try { return Buffer.from(s, 'base64').length >= 0; } catch (e) { return false; } };
    check('a command outside the list is refused BY NAME, never with its arguments', UR.commandWhy(['CONFIG', 'SET', 'secret-arg']) === 'a command this harness does not forward: CONFIG');
    check('BROKEN COPY: Node\'s permissive decoder accepts "QR==" and "Q=Q=" (so S-11 catches it)', permissive('QR==') && permissive('Q=Q='));
  });

  await section('S-14 (A2, plan v3.2): one order, the first applicable step decides', async () => {
    const c = (a, r) => UR.classify(a, r);
    for (const body of ['<html>no</html>', '', '[1,2]', JSON.stringify({ error: '' })]) {
      const r = c(A(401, body, 'text/html'), single()); check(`401 with body ${JSON.stringify(body).slice(0, 20)}: IDENTITY at step 2`, r.decision === 'IDENTITY' && r.step === 2, r);
      const p = c(A(401, body), pipe(3)); check(`401 pipeline: IDENTITY at step 2`, p.decision === 'IDENTITY' && p.step === 2);
    }
    for (const body of ['plain', '{}', '[1]', JSON.stringify({ error: L1 })]) {
      const r = c(A(429, body, 'text/plain'), single()); check(`429 with body ${JSON.stringify(body).slice(0, 20)}: LIMIT at step 3`, r.decision === 'LIMIT' && r.step === 3, r);
    }
    const ev = c(A(429, { error: L1 }), single()); check('429: the evidence names the marker, never the body', ev.evidence && ev.evidence.marker === L1 && !('body' in ev));
    check('400 WRONGPASS: IDENTITY at step 5', c(A(400, { error: 'WRONGPASS invalid password' }), single()).step === 5);
    check('400 L-1: LIMIT at step 6', (r => r.decision === 'LIMIT' && r.step === 6)(c(A(400, { error: L1 }), single())));
    check('200 {error: L-2}: still LIMIT at step 6', (r => r.decision === 'LIMIT' && r.step === 6)(c(A(200, { error: L2 }), single())));
    const pl = c(A(200, [{ result: 'OK' }, { error: L1 }, { result: 'QQ==' }]), pipe(3));
    check('pipeline entry 2 = L-1: LIMIT at position 2', pl.decision === 'LIMIT' && pl.position === 2, pl);
    check('pipeline 400 single {error: L-3}: LIMIT', c(A(400, { error: L3 }), pipe(3)).decision === 'LIMIT');
    const syn = c(A(400, { error: 'ERR syntax error' }), pipe(3)); check('pipeline 400 single "ERR syntax error": AMBIGUOUS, never a command error', syn.decision === 'AMBIGUOUS', syn);
    const order1 = c(A(200, [{ result: 'OK' }, { error: E1 }, { error: L1 }]), pipe(3));
    check('E-1 at 2 then L-1 at 3: LIMIT at position 3 (nothing forwarded)', order1.decision === 'LIMIT' && order1.position === 3, order1);
    const order2 = c(A(200, [{ result: 'OK' }, { error: 'ERR unlisted' }, { error: L1 }]), pipe(3));
    check('unlisted at 2 then L-1 at 3: AMBIGUOUS at position 2 (command order decides)', order2.decision === 'AMBIGUOUS' && order2.position === 2, order2);
    const mal = c(A(200, [{ result: 'OK' }, { result: 'OK', error: 'x' }, { error: L1 }]), pipe(3));
    check('malformed entry 2, L-1 at 3: AMBIGUOUS at step 4, evidence "limit text at position 3"', mal.decision === 'AMBIGUOUS' && mal.step === 4 && mal.evidence && mal.evidence.position === 3, mal);
    check('200 {result: "QR=="}: AMBIGUOUS at step 8', (r => r.decision === 'AMBIGUOUS' && r.step === 8)(c(A(200, { result: 'QR==' }), single())));
    check('200 {result: 1.5}: AMBIGUOUS', c(A(200, { result: 1.5 }), single()).decision === 'AMBIGUOUS');
    check('400 {result: "x"}: AMBIGUOUS at step 9', (r => r.decision === 'AMBIGUOUS' && r.step === 9)(c(A(400, { result: 'eA==' }), single())));
    check('a correct 3-entry answer with one E-2: RESULT (returned)', c(A(200, [{ result: 'OK' }, { error: E2 }, { result: 'MQ==' }]), pipe(3)).decision === 'RESULT');
    check('E-1 single: COMMAND_ERROR at step 7', (r => r.decision === 'COMMAND_ERROR' && r.step === 7)(c(A(400, { error: E1 }), single())));
    check('E-2 with the script suffix: COMMAND_ERROR', c(A(400, { error: E2s }), single()).decision === 'COMMAND_ERROR');
    // BROKEN COPIES (S-14):
    const envelopeFirst = (a, r) => { try { const b = JSON.parse(a.body); if (!(b && typeof b === 'object' && ('result' in b || 'error' in b))) return { decision: 'AMBIGUOUS' }; } catch (e) { return { decision: 'AMBIGUOUS' }; } return UR.classify(a, r); };
    check('BROKEN COPY: a classifier that checks the envelope before the status turns a 401 with an HTML body into AMBIGUOUS (caught)', envelopeFirst(A(401, '<html>'), single()).decision === 'AMBIGUOUS');
    const firstAcceptable = (a, r) => { const b = JSON.parse(a.body); if (Array.isArray(b) && b.some(e => 'error' in e && UR.ACCEPTED_ERRORS.some(f => f(e.error)))) return { decision: 'RESULT' }; return UR.classify(a, r); };
    check('BROKEN COPY: one that stops at the first acceptable entry returns the E-1-then-L-1 batch (caught)', firstAcceptable(A(200, [{ result: 'OK' }, { error: E1 }, { error: L1 }]), pipe(3)).decision === 'RESULT');
  });

  await section('S-7 (A): only the two listed Redis errors are replies', async () => {
    for (const [label, a] of [['wrong number of arguments', A(400, { error: "ERR wrong number of arguments for 'get' command" })], ['syntax error', A(400, { error: 'ERR syntax error' })],
      ['empty text', A(400, { error: '' })], ['an extra key', A(400, { error: 'x', extra: 1 })], ['text/plain', A(400, { error: E1 }, 'text/plain')],
      ['a script runtime error', A(400, { error: 'ERR user_script:1: attempt to perform arithmetic on a nil value script: ' + 'b'.repeat(40) + ', on @user_script:1.' })]]) {
      check(`400 ${label}: AMBIGUOUS`, UR.classify(a, single()).decision === 'AMBIGUOUS');
    }
    check('E-1 and both forms of E-2 pass as command errors', [E1, E2, E2s].every(t => UR.classify(A(400, { error: t }), single()).decision === 'COMMAND_ERROR'));
    const anyErr = a => { const b = JSON.parse(a.body); return b && 'error' in b ? 'COMMAND_ERROR' : 'RESULT'; };
    check('BROKEN COPY: a shim accepting any 400 {error} as a reply takes "ERR syntax error" as one (caught)', anyErr(A(400, { error: 'ERR syntax error' })) === 'COMMAND_ERROR');
  });

  await section('S-8 (B): a pipeline answer is judged whole', async () => {
    for (const [label, body] of [['2 entries for 3', [{ result: 'OK' }, { result: 'OK' }]], ['4 entries for 3', [{ result: 'OK' }, { result: 'OK' }, { result: 'OK' }, { result: 'OK' }]],
      ['an entry {}', [{ result: 'OK' }, {}, { result: 'OK' }]], ['an entry with both keys', [{ result: 'OK' }, { result: 'OK', error: 'x' }, { result: 'OK' }]],
      ['{result: {}}', [{ result: 'OK' }, { result: {} }, { result: 'OK' }]], ['{result: 1.5}', [{ result: 'OK' }, { result: 1.5 }, { result: 'OK' }]],
      ['an unlisted error', [{ result: 'OK' }, { error: 'ERR nope' }, { result: 'OK' }]], ['an object body', { result: 'OK' }]]) {
      check(`3-command pipeline answered with ${label}: AMBIGUOUS`, UR.classify(A(200, body), pipe(3)).decision === 'AMBIGUOUS');
    }
    check('a correct 3-entry answer with one listed error passes', UR.classify(A(200, [{ result: 'OK' }, { error: E1 }, { result: 'MQ==' }]), pipe(3)).decision === 'RESULT');
  });

  await section('store mode refuses rather than falls back (plan I-3)', async () => {
    check('no QUEUE_REALSTORE_RUN: ordinary local mode (null)', UR.storeFromEnv({}) === null);
    const good = { QUEUE_REALSTORE_RUN: 'authorised', QUEUE_REALSTORE_ID: 'i', QUEUE_REALSTORE_ENDPOINT: 'https://abc.upstash.io', QUEUE_REALSTORE_TOKEN: 't'.repeat(30) };
    good.QUEUE_REALSTORE_BINDING = UR.bindingOf(good.QUEUE_REALSTORE_ID, good.QUEUE_REALSTORE_ENDPOINT, good.QUEUE_REALSTORE_TOKEN);
    check('a correct set of run values: store mode', !!UR.storeFromEnv(good));
    for (const [label, env] of [['a wrong binding', { ...good, QUEUE_REALSTORE_BINDING: '0'.repeat(64) }], ['a missing token', { ...good, QUEUE_REALSTORE_TOKEN: '' }],
      ['not "authorised"', { ...good, QUEUE_REALSTORE_RUN: 'yes' }], ['a local endpoint outside self-test', { ...good, QUEUE_REALSTORE_ENDPOINT: 'http://127.0.0.1:1' }],
      ['another host', { ...good, QUEUE_REALSTORE_ENDPOINT: 'https://abc.example.com' }]]) {
      let refused = false; try { UR.storeFromEnv(env); } catch (e) { refused = e.code === 'STORE_REFUSED'; }
      check(`${label}: REFUSED (no fall-back)`, refused);
    }
  });

  // ---- Against the stand-in.
  const S = await upstashStandIn();
  const store = Object.freeze({ id: S.id, endpoint: S.endpoint, token: S.token, ledgerDir: null });
  const local = await startRedis();
  const L = local.client;
  const D = UR.directClient(store);

  await section('S-1: the direct client returns exactly what the local Redis client returns', async () => {
    for (const R of [L, D]) { await R.call('FLUSHALL'); }
    const steps = [['SET', 'k', 'café ✓ "q"'], ['GET', 'k'], ['GET', 'none'], ['EXISTS', 'k'], ['RPUSH', 'l', 'a'], ['LPUSH', 'l', 'b'], ['LRANGE', 'l', '0', '-1'], ['LLEN', 'l'],
      ['LTRIM', 'l', '0', '0'], ['TYPE', 'l'], ['TYPE', 'k'], ['GET', 'l'], ['EVAL', "return {'a', 1, {'b', nil}}", '0'], ['EVAL', "return redis.error_reply('wrong-type')", '0'],
      ['EVAL', "return redis.call('GET', KEYS[1])", '1', 'l'], ['EVAL', "return redis.status_reply('OK')", '0'],
      ['HSET', 'h', 'f', 'ü', 'g', '2'], ['HGETALL', 'h'], ['HGETALL', 'none'], ['MGET', 'k', 'none', 'l'], ['SET', 'e', 'x', 'EX', '100'], ['TTL', 'e'], ['PERSIST', 'e'], ['TTL', 'e'],
      ['RPUSH', 'r', 'a', 'b', 'a'], ['LREM', 'r', '0', 'a'], ['RPOP', 'r'], ['RPOP', 'r'], ['SMEMBERS', 'none'], ['ZRANGE', 'none', '0', '-1', 'WITHSCORES'],
      ['DBSIZE'], ['DEL', 'k', 'l', 'h', 'e'], ['DBSIZE']];
    for (const s of steps) {
      const a = await L.call(...s); const b = await D.call(...s);
      const norm = v => (v && v.error ? { error: v.error.replace(/script: [0-9a-f]{40}/, 'script: X') } : v);
      check(`${s.slice(0, 2).join(' ')}: identical (${JSON.stringify(a).slice(0, 40)})`, JSON.stringify(norm(a)) === JSON.stringify(norm(b)), { local: a, store: b });
    }
  });

  await section('S-2: the pinned scripts, every reply branch, through both paths', async () => {
    const ts = require(path.join(__dirname, '..', 'tradeStore.js'));
    const { SCRIPTS } = ts;
    const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');
    const shim = restShim(null, { store }); const url = await shim.listen();
    const { Redis } = require('@upstash/redis');
    const P = new Redis({ url, token: 'local-only', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 } });
    const viaP = async (script, keys, args) => { try { return await P.eval(script, keys, args); } catch (e) { return { error: e.message }; } };
    const branches = [
      ['RAISE from absent', s => s, 'RAISE', ['{trades:state}:fence'], []],
      ['RAISE at 2 (ALREADY)', async R => R.call('SET', '{trades:state}:fence', '2'), 'RAISE', ['{trades:state}:fence'], []],
      ['RAISE at 3 (FENCED)', async R => R.call('SET', '{trades:state}:fence', '3'), 'RAISE', ['{trades:state}:fence'], []],
      ['RAISE malformed', async R => R.call('SET', '{trades:state}:fence', 'x'), 'RAISE', ['{trades:state}:fence'], []],
      ['RESOLUTION_READ absent', s => s, 'RESOLUTION_READ', ['trades:state'], []],
      ['RESOLUTION_READ present', async R => R.call('SET', 'trades:state', '{"a":1}'), 'RESOLUTION_READ', ['trades:state'], []],
      ['LOG on a string (E-1)', async R => R.call('SET', 'queue:casFailures', 'x'), 'LOG', ['queue:casFailures'], ['{"op":"x"}', '1000']],
    ];
    for (const [label, prep, name, keys, args] of branches) {
      for (const R of [L, D]) { await R.call('FLUSHALL'); await prep(R); }
      const a = await L.call('EVAL', SCRIPTS[name], String(keys.length), ...keys, ...args);
      const b = await D.call('EVAL', SCRIPTS[name], String(keys.length), ...keys, ...args);
      await D.call('FLUSHALL'); await prep(D);
      const p = await viaP(SCRIPTS[name], keys, args);
      const same = JSON.stringify(a) === JSON.stringify(b);
      const pOk = a && a.error ? !!(p && p.error && p.error.includes(a.error.replace(/^ERR /, ''))) : JSON.stringify(p) === JSON.stringify(a);
      check(`${label}: direct identical to local (${JSON.stringify(a).slice(0, 50)}); the service's client the same`, same && pOk, { local: a, direct: b, product: p });
    }
    // THE COMMIT, its reply branches, by the real save path through the store-mode shim.
    for (const R of [L, D]) { await R.call('FLUSHALL'); await R.call('SET', '{trades:state}:fence', '2'); await R.call('SET', 'trades:state', '{"v":1}'); }
    const t = '{"v":1}';
    for (const [label, fence, h0] of [['COMMITTED', '2', sha1(t)], ['CONFLICT', '2', sha1('other')], ['FENCED', '3', sha1(t)]]) {
      for (const R of [L, D]) { await R.call('SET', 'trades:state', t); await R.call('SET', '{trades:state}:fence', fence); }
      const a = await L.call('EVAL', SCRIPTS.COMMIT, '2', 'trades:state', '{trades:state}:fence', h0, '{"v":2}', '2');
      const b = await D.call('EVAL', SCRIPTS.COMMIT, '2', 'trades:state', '{trades:state}:fence', h0, '{"v":2}', '2');
      check(`COMMIT ${label}: direct identical to local (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b), { a, b });
    }
    await shim.close();
  });

  await section('S-4 and S-6: transport failures are lost answers, never replies; one arrival each', async () => {
    const shim = restShim(null, { store }); const url = await shim.listen();
    const { Redis } = require('@upstash/redis');
    const P = new Redis({ url, token: 'local-only', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 }, signal: () => AbortSignal.timeout(20000) });
    for (const [label, scripted] of [['500', { status: 500, body: 'oops' }], ['502', { status: 502, body: '' }], ['429', { status: 429, body: '{}' }], ['401', { status: 401, body: '{}' }],
      ['a redirect', { redirect: 302, location: 'http://127.0.0.1:1/' }], ['not JSON', { status: 200, body: 'hello' }], ['neither field', { status: 200, body: '{"x":1}' }],
      ['a reset connection', { destroy: true }], ['nothing for 11 s', { delayMs: 11000, status: 200, body: '{"result":"T0s="}' }]]) {
      const before = S.arrivals;
      S.next.push(scripted);
      let pr = 'no answer'; try { pr = await P.get('k'); pr = 'A VALUE: ' + JSON.stringify(pr); } catch (e) { pr = 'lost'; }
      const arrivedP = S.arrivals - before;
      S.next.push(scripted);
      let dr; try { dr = await D.call('GET', 'k'); dr = 'returned ' + JSON.stringify(dr); } catch (e) { dr = e.code === 'TRANSPORT' ? 'threw ' + e.decision : 'threw other'; }
      check(`${label}: the service's client sees a LOST answer; exactly one arrival (no retry); the direct client THROWS`, pr === 'lost' && arrivedP === 1 && /^threw (AMBIGUOUS|IDENTITY|LIMIT)$/.test(dr), { pr, arrivedP, dr });
    }
    // Broken copies (S-6).
    const fabricate = async () => { S.next.push({ status: 500, body: 'x' }); const a = await UR.send(S.endpoint + '/', { headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' }, body: '["GET","k"]' }); return a.status === 500 ? { result: null } : a; };
    check('BROKEN COPY: a shim that fabricates a reply on a 5xx hands the client a value (S-4 catches it)', (await fabricate()).result === null);
    const before = S.arrivals;
    const retrying = async () => { S.next.push({ status: 503, body: '' }); let a = await UR.send(S.endpoint + '/', { headers: { Authorization: 'Bearer ' + S.token }, body: '["GET","k"]' }); if (a.status >= 500) a = await UR.send(S.endpoint + '/', { headers: { Authorization: 'Bearer ' + S.token }, body: '["GET","k"]' }); return a; };
    await retrying();
    check('BROKEN COPY: a retrying shim makes TWO arrivals (S-4 counts it)', S.arrivals - before === 2);
    const softDirect = async () => { S.next.push({ destroy: true }); try { return await D.call('GET', 'k'); } catch (e) { return { error: 'connection closed' }; } };
    check('BROKEN COPY: a direct client that turns a transport failure into {error} would return a Redis-looking error (S-4 requires a throw)', !!(await softDirect()).error);
    await shim.close();
  });

  await section('S-5: the tests\' fault hooks behave as on local Redis', async () => {
    const { Redis } = require('@upstash/redis');
    const run = async (shim) => {
      const url = await shim.listen();
      const C = new Redis({ url, token: 'local-only', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 } });
      const out = [];
      await C.set('h', 'v0');
      shim.hooks.before = async cmd => (String(cmd[0]).toUpperCase() === 'GET' ? { reply: 'substituted' } : undefined);
      out.push(await C.get('h'));
      shim.hooks.before = async cmd => (String(cmd[0]).toUpperCase() === 'GET' ? { error: 'ERR stand-in: substituted' } : undefined);
      try { await C.get('h'); out.push('no error'); } catch (e) { out.push('error'); }
      shim.hooks.before = undefined;
      shim.hooks.after = async (cmd, reply) => (String(cmd[0]).toUpperCase() === 'SET' ? { drop: true } : undefined);
      try { await C.set('h', 'v1'); out.push('answered'); } catch (e) { out.push('lost'); }
      shim.hooks.after = async (cmd, reply) => (String(cmd[0]).toUpperCase() === 'GET' ? { reply: reply + '!' } : undefined);
      out.push(await C.get('h'));
      shim.hooks = {};
      out.push(await C.get('h'));
      await shim.close();
      return out;
    };
    await L.call('FLUSHALL'); await D.call('FLUSHALL');
    const loc = await run(restShim(L, { store: null }));
    const sto = await run(restShim(null, { store }));
    check('the same sequence of hooks gives the same answers on local Redis and in store mode', JSON.stringify(loc) === JSON.stringify(sto), { loc, sto });
    check('...and that sequence is the expected one (substituted, error, lost-after-landing, after-hook edit, real)', JSON.stringify(sto) === JSON.stringify(['substituted', 'error', 'lost', 'v1!', 'v1']), sto);
  });

  await section('S-10: one destination; the client\'s own Authorization is never forwarded', async () => {
    const other = await countingServer();
    const shim = restShim(null, { store }); const url = await shim.listen();
    const before = S.requests.length;
    const port = Number(url.split(':').pop());
    await new Promise(r => { const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { Host: other.url.replace('http://', ''), Authorization: 'Bearer stolen-token', 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', r); }); q.end('["GET","k"]'); });
    await new Promise(r => { const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: other.url + '/', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', r); }); q.end('["GET","k"]'); });
    const seen = S.requests.slice(before);
    check('a request carrying another Host reached ONLY the run\'s endpoint, signed with the run\'s token', seen.length >= 1 && seen[0].auth === 'Bearer ' + S.token && other.hits === 0, { seen, hits: other.hits });
    check('a request naming an absolute address was not forwarded anywhere else', other.hits === 0);
    check('the client\'s own Authorization header never reached the store', !S.requests.some(r => r.auth === 'Bearer stolen-token'));
    await shim.close(); await other.close();
  });

  await section('S-13 (D-R): no redirect is followed, on any path', async () => {
    const target = await countingServer();
    const shim = restShim(null, { store }); const url = await shim.listen();
    const { Redis } = require('@upstash/redis');
    const C = new Redis({ url, token: 'local-only', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 } });
    for (const code of [301, 302, 307, 308]) {
      S.next.push({ redirect: code, location: target.url + '/' }); let a = 'value'; try { await C.get('k'); } catch (e) { a = 'lost'; }
      S.next.push({ redirect: code, location: target.url + '/' }); let b = 'value'; try { await D.call('GET', 'k'); } catch (e) { b = e.decision; }
      S.next.push({ redirect: code, location: target.url + '/' }); const m = await UR.send(S.metricsUrl, { method: 'GET' });
      check(`${code}: the service's client sees a lost answer, the direct client throws AMBIGUOUS, the runner's metrics read is not followed`, a === 'lost' && b === 'AMBIGUOUS' && m.status === code, { a, b, m: m.status });
    }
    const { requestCreation } = require('./realstore/gate1/creation.js');
    let cr = null; try { await requestCreation({ url: S.endpoint + '/', id: crypto.randomUUID(), attempts: 1, fetchImpl: async (u, o) => { S.next.push({ redirect: 302, location: target.url }); return fetch(u, o); } }); } catch (e) { cr = e.message; }
    check('the creation request (Gate 1\'s code) does not follow a redirect either', /redirect/.test(cr || ''), cr);
    check('the redirect target received NOTHING on any path', target.hits === 0, target.hits);
    const src = ['tests/lib/upstashRest.js', 'tests/realstore/run.js', 'tests/realstore/gate1/creation.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    const calls = src.join('\n').match(/fetchImpl\(|fetch\(/g) || [];
    check('source check: every request in the harness is built with redirect: \'manual\'', calls.length > 0 && src.every(s => !/fetch(Impl)?\([^)]*\)/.test(s) || /redirect: 'manual'/.test(s)));
    await shim.close(); await target.close();
  });

  await section('S-9: the runner\'s clean-up verdicts', async () => {
    const { run } = require('./realstore/run.js');
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-fixtures-'));
    fs.writeFileSync(path.join(fx, 'clean.js'), `
      const { startRedis, restShim, reportStop } = require(${JSON.stringify(path.join(__dirname, 'lib', 'localRedis.js'))});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:a', '1'); await r.client.call('SET', 'fixture:b', '2');
        console.log('PASS: wrote two keys'); reportStop(()=>{}, await r.stop()); console.log('\\n1 passed, 0 failed'); process.exit(0); })();`);
    fs.writeFileSync(path.join(fx, 'inflight.js'), `
      const { startRedis } = require(${JSON.stringify(path.join(__dirname, 'lib', 'localRedis.js'))});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:c', '1');
        setInterval(() => {}, 1000); await r.client.call('GET', 'fixture:hold'); })();`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-selftest-out-'));
    await D.call('FLUSHALL');
    const r1 = await run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [['clean.js', 10]], testsDir: fx, outDir, quietMs: 200, secondScanMs: 200, identityWaitMs: 5000, quiet: true });
    const log1 = fs.readFileSync(r1.logFile, 'utf8');
    check('a clean file: its keys deleted, both scans 0, the ledger complete -> "clean-up VERIFIED"; the run passes', r1.ok && /CLEAN-UP clean\.js: VERIFIED/.test(log1) && /first scan found 2 key\(s\) \[fixture:/.test(log1), log1.split('\n').filter(l => /CLEAN-UP|STOP|SUMMARY|TESTS/.test(l)));
    check('the step-0 probe ran and matched on the stand-in', /STEP 0 ok +P pipeline of 3/.test(log1) && !/STEP 0 DIFF/.test(log1));
    check('the log holds no credential of the run', !log1.includes(S.token) && !log1.includes(S.endpoint), null);
    await D.call('FLUSHALL');
    // The in-flight fixture: the stand-in holds its GET of "fixture:hold" for
    // 20 s, past the runner's 3 s stall limit, so the runner ends the process
    // group while that request is still in flight: its outcome is unknown.
    S.holdWhen = body => (body.includes('fixture:hold') ? 20000 : 0);
    const r2 = await run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [['inflight.js', 10]], testsDir: fx, outDir, quietMs: 200, secondScanMs: 200, identityWaitMs: 5000, stallMs: 3000, quiet: true });
    S.holdWhen = null;
    const log2 = fs.readFileSync(r2.logFile, 'utf8');
    check('a file ended while a request was in flight: clean-up STILL ran, both scans recorded, verdict "NOT VERIFIED" with an unknown outcome; the run fails', !r2.ok && /CLEAN-UP inflight\.js: \(a\) DATABASE: first scan found 1 key/.test(log2) && /second scan after/.test(log2) && /CLEAN-UP inflight\.js: NOT VERIFIED/.test(log2) && /UNKNOWN OUTCOME/.test(log2) && /STALLED/.test(log2), log2.split('\n').filter(l => /CLEAN-UP|STOP|STALL|FILE/.test(l)));
    const v = r2.verdicts.find(x => x.label === 'inflight.js');
    const s9 = x => !!(x && x.scan1 && x.scan2) && x.unknown.length > 0 && x.verified === false;
    check('S-9 holds on the real runner\'s verdict (scans present, unknown outcome, NOT VERIFIED)', s9(v), v);
    const brokenSkip = x => (x.unknown.length ? { ...x, scan1: null, scan2: null } : x);
    const brokenVerify = x => ({ ...x, verified: !!(x.scan2 && x.scan2.found === 0) });
    check('BROKEN COPY: a runner that skips clean-up when the ledger is unresolved fails S-9', !!v && !s9(brokenSkip(v)));
    check('BROKEN COPY: a runner that calls clean-up verified whenever the second scan reads 0 fails S-9', !!v && v.scan2.found === 0 && !s9(brokenVerify(v)));
    // A false pass the auditor found (harness review, Part 2): the final
    // decision read only the printed total. A file that prints a perfect total
    // and then EXITS UNSUCCESSFULLY, or prints a FAIL line under a "0 failed"
    // total, must fail the run.
    const lr = JSON.stringify(path.join(__dirname, 'lib', 'localRedis.js'));
    fs.writeFileSync(path.join(fx, 'exit1.js'), `
      const { startRedis, reportStop } = require(${lr});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:e', '1');
        console.log('PASS: looks fine'); reportStop(()=>{}, await r.stop()); console.log('\\n1 passed, 0 failed'); process.exit(1); })();`);
    fs.writeFileSync(path.join(fx, 'hiddenfail.js'), `
      const { startRedis, reportStop } = require(${lr});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:h', '1');
        console.log('FAIL: something did go wrong'); reportStop(()=>{}, await r.stop()); console.log('\\n1 passed, 0 failed'); process.exit(0); })();`);
    const oldPassedAll = rr => rr.files.length === 1 && rr.files.every(f => f.failed === 0 && f.passed > 0);
    for (const [fixture, why] of [['exit1.js', /ended with exit 1, not 0/], ['hiddenfail.js', /printed 1 FAIL line\(s\) although its total said 0 failed/]]) {
      await D.call('FLUSHALL');
      const rr = await run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [[fixture, 10]], testsDir: fx, outDir, quietMs: 200, secondScanMs: 200, identityWaitMs: 5000, quiet: true });
      const lg = fs.readFileSync(rr.logFile, 'utf8');
      check(`${fixture}: a perfect printed total does NOT pass the run; it stops, saying why, and the clean-up still ran and was VERIFIED`, !rr.ok && why.test(lg) && /TESTS: FAILED/.test(lg) && new RegExp(`CLEAN-UP ${fixture.replace('.', '\\.')}: VERIFIED`).test(lg), lg.split('\n').filter(l => /FILE|STOP|TESTS|CLEAN-UP .*: (VERIFIED|NOT)/.test(l)));
      check(`BROKEN COPY: the old final check (the printed total only) would have PASSED ${fixture}`, oldPassedAll(rr));
    }
    fs.rmSync(fx, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  });

  await section('C-3 (run 1): the identity check waits for slow metrics, refuses another database, and logs every reading', async () => {
    // Real run 1 stopped here: the metrics by id did not show the nonce within
    // 60 s, and the stop did not record the readings, so slow metrics and the
    // wrong database could not be told apart.
    const { run } = require('./realstore/run.js');
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-identity-'));
    fs.writeFileSync(path.join(fx, 'clean.js'), `
      const { startRedis, reportStop } = require(${JSON.stringify(path.join(__dirname, 'lib', 'localRedis.js'))});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:i', '1');
        console.log('PASS: wrote a key'); reportStop(()=>{}, await r.stop()); console.log('\\n1 passed, 0 failed'); process.exit(0); })();`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-identity-out-'));
    const go = waitMs => run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [['clean.js', 10]], testsDir: fx, outDir, quietMs: 200, secondScanMs: 200, identityWaitMs: waitMs, identityPollMs: 100, quiet: true });
    const readings = lg => lg.split('\n').filter(l => /^IDENTITY before step 0: reading t\+\d+s keys \d+, commands_total \d+, uptime_seconds \d+$/.test(l));
    // (a) Metrics that refresh only every 1.5 s, with a 5 s wait: confirmed.
    await D.call('FLUSHALL'); S.metricsLagMs = 1500; S.snap = null;
    const ra = await go(5000);
    const la = fs.readFileSync(ra.logFile, 'utf8');
    const rda = readings(la);
    const frozen = rda.length >= 2 && rda[0].replace(/^.*keys/, 'keys') === rda[1].replace(/^.*keys/, 'keys');
    check('(a) slow metrics (refreshed every 1.5 s): identity CONFIRMED within the longer wait, and the run passes', ra.ok && /IDENTITY before step 0: the endpoint is this run's database .* after \d+ s/.test(la), la.split('\n').filter(l => /IDENTITY|STOP|TESTS/.test(l)).slice(0, 30));
    check('(a) EVERY reading is in the log as plain numbers, and the unchanged readings while the metrics lagged are visible', rda.length >= 5 && frozen, rda.slice(0, 6));
    check('(a) the SET and DEL answers are in the log', /IDENTITY before step 0: SET nonce answered "OK"/.test(la) && /IDENTITY before step 0: DEL nonce answered 1/.test(la));
    check('(a) the log holds no credential of the run', !la.includes(S.token) && !la.includes(S.endpoint));
    // BROKEN COPY: the old 60 s limit, scaled: a wait SHORTER than the lag.
    await D.call('FLUSHALL'); S.snap = null;
    const rb = await go(1000);
    const lb = fs.readFileSync(rb.logFile, 'utf8');
    check('BROKEN COPY (the old short wait): it gives up before the slow metrics refresh -- and its stop now NAMES the cause: the numbers did not move', !rb.ok && /STOP: IDENTITY: .*within 1 s \(first to last: keys 0 -> 0, commands_total (\d+) -> \1;/.test(lb), lb.split('\n').filter(l => /STOP/.test(l)));
    check('...and after that stop nothing else was sent: no step 0, no file, and the nonce is gone', !/STEP 0/.test(lb) && !/^FILE /m.test(lb) && (await D.call('DBSIZE')) === 0);
    S.metricsLagMs = 0; S.snap = null;
    // (b) Metrics of ANOTHER database: they move, never with the nonce.
    await D.call('FLUSHALL'); S.metricsOther = { keys: 5, commands_total: 100 };
    const rc = await go(2000);
    S.metricsOther = null;
    const lc = fs.readFileSync(rc.logFile, 'utf8');
    check('(b) metrics of another database: REFUSED (IDENTITY), the stop showing keys unchanged while commands moved', !rc.ok && /STOP: IDENTITY: .*\(first to last: keys 5 -> 5, commands_total (\d+) -> (?!\1;)\d+;/.test(lc), lc.split('\n').filter(l => /STOP/.test(l)));
    check('(b) every reading is in the log, and nothing else was sent: no step 0, no file, the nonce gone', readings(lc).length >= 5 && !/STEP 0/.test(lc) && !/^FILE /m.test(lc) && (await D.call('DBSIZE')) === 0);
    const weak = lg => readings(lg).some(l => { const x = /commands_total (\d+)/.exec(l); return x && Number(x[1]) > 100; });
    check('BROKEN COPY: a check that accepted "commands_total rose" alone would have CONFIRMED the other database here', weak(lc));
    // (c) A metrics read that fails: the reason is logged, never a bare stop.
    await D.call('FLUSHALL');
    S.metricsNext = [{ status: 503, body: 'unavailable' }];
    const rd = await go(2000);
    const ld = fs.readFileSync(rd.logFile, 'utf8');
    check('(c) a metrics read answered 503: the stop says so ("HTTP 503"), with the reading line', !rd.ok && /IDENTITY before step 0: before the nonce: t\+\d+s NO READING: HTTP 503/.test(ld) && /STOP: IDENTITY: the metrics could not be read \(HTTP 503\)/.test(ld), ld.split('\n').filter(l => /IDENTITY|STOP/.test(l)));
    fs.rmSync(fx, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  });

  await section('C-3 at full scale (auditor, run 1): metrics 90 s late, the REAL wait and poll', async () => {
    const { run, IDENTITY } = require('./realstore/run.js');
    check('the real run\'s identity wait is 5 minutes, read every 10 s', IDENTITY.waitMs === 300000 && IDENTITY.pollMs === 10000, IDENTITY);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-identity90-'));
    const go = extra => run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [], outDir, quietMs: 200, secondScanMs: 200, identityPollMs: IDENTITY.pollMs, quiet: true, ...extra });
    // The real limit (no override): confirmed after the 90 s delay.
    await D.call('FLUSHALL'); S.metricsLagMs = 90000; S.snap = null;
    const t0 = Date.now();
    const ra = await go({});
    const la = fs.readFileSync(ra.logFile, 'utf8');
    const conf = /IDENTITY before step 0: the endpoint is this run's database .* after (\d+) s/.exec(la);
    check('90 s late metrics, the real 5-minute limit: identity CONFIRMED (after about 90 s), the run passes', ra.ok && !!conf && Number(conf[1]) >= 90 && Number(conf[1]) < 300, { secs: conf && conf[1], took: Math.round((Date.now() - t0) / 1000), lines: la.split('\n').filter(l => /STOP|confirmed|this run's database/.test(l)) });
    // BROKEN COPY: the old 60 s limit gives up first.
    await D.call('FLUSHALL'); S.snap = null;
    const rb = await go({ identityWaitMs: 60000 });
    const lb = fs.readFileSync(rb.logFile, 'utf8');
    check('BROKEN COPY (the old 60 s limit): it gives up before the 90 s delay ends, the stop showing the numbers frozen', !rb.ok && /STOP: IDENTITY: .*within 60 s \(first to last: keys 0 -> 0, commands_total (\d+) -> \1;/.test(lb), lb.split('\n').filter(l => /STOP/.test(l)));
    check('...and nothing else was sent after that stop: no step 0, no clean-up against the unconfirmed database', !/^STEP 0/m.test(lb) && !/^CLEAN-UP /m.test(lb), lb.split('\n').filter(l => /^(STEP 0|CLEAN-UP|FILE|STOP)/.test(l)));
    S.metricsLagMs = 0; S.snap = null;
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  await section('C-4 and C-5 (real-store run 2): E-1 in either form; any other error text QUOTED where the run stops', async () => {
    const one = t => UR.classify(A(400, { error: t }), single());
    const suf = ' script: ' + 'c'.repeat(40) + ', on @user_script:3.';
    for (const t of ['ERR wrong-type', 'wrong-type', 'wrong-type' + suf, 'ERR wrong-type' + suf]) check(`E-1 accepted: ${JSON.stringify(t).slice(0, 40)}`, one(t).decision === 'COMMAND_ERROR');
    for (const t of ['ERR  wrong-type', 'WRONG-TYPE', 'wrong-type!', 'xwrong-type', 'ERR Error running script, wrong-type', 'wrong-type script: abc, on @user_script:1.']) {
      const c = one(t);
      check(`refused AND quoted: ${JSON.stringify(t).slice(0, 44)}`, c.decision === 'AMBIGUOUS' && c.step === 9 && c.why === 'an error not on the accepted list: ' + JSON.stringify(t), c.why);
    }
    const oldE1 = t => t === 'ERR wrong-type';
    check('BROKEN COPY: the old E-1 rule (exact "ERR wrong-type") refuses the bare form -- the run-2 stop', !oldE1('wrong-type'));
    const long = one('E'.repeat(500));
    check('a long error text is quoted to 200 characters, never in full', long.why === 'an error not on the accepted list: ' + JSON.stringify('E'.repeat(200) + '...'));
    check('an unlisted error under the wrong status says so', /\(under status 200\): "wrong-type"$/.test(UR.classify(A(200, { error: 'wrong-type' }), single()).why || ''));
    check('a whole-batch refusal quotes its text', /whole-batch error not identity or limit: "ERR syntax error"$/.test(UR.classify(A(400, { error: 'ERR syntax error' }), pipe(3)).why));
    check('identity and limit texts are still NOT quoted (marker only)', !('why' in UR.classify(A(400, { error: 'WRONGPASS invalid password' }), single())) && UR.classify(A(400, { error: L1 }), single()).marker === L1);
    // Through the runner, against the stand-in.
    const { run } = require('./realstore/run.js');
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-e1-'));
    fs.writeFileSync(path.join(fx, 'clean.js'), `
      const { startRedis, reportStop } = require(${JSON.stringify(path.join(__dirname, 'lib', 'localRedis.js'))});
      (async () => { const r = await startRedis(); await r.client.call('SET', 'fixture:w', '1');
        console.log('PASS: wrote a key'); reportStop(()=>{}, await r.stop()); console.log('\\n1 passed, 0 failed'); process.exit(0); })();`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-e1-out-'));
    const go = () => run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, files: [['clean.js', 10]], testsDir: fx, outDir, quietMs: 200, secondScanMs: 200, identityWaitMs: 5000, quiet: true });
    await D.call('FLUSHALL'); S.errorText = t => t.replace(/^ERR wrong-type/, 'wrong-type');
    const ra = await go(); const la = fs.readFileSync(ra.logFile, 'utf8');
    check('E-1 worded "wrong-type" (the older form): step 0 accepts it, logs the answer as received, and the run passes', ra.ok && /STEP 0 ok +D E-1 .*: got \{"error":"wrong-type"\}/.test(la), la.split('\n').filter(l => /STEP 0|STOP|TESTS/.test(l)));
    check('every step-0 answer is logged as received ("got ..." on every line)', la.split('\n').filter(l => /^STEP 0 /.test(l)).every(l => / got /.test(l)));
    await D.call('FLUSHALL'); S.errorText = t => t.replace(/^ERR wrong-type/, 'ERR Error running script (call to f_0123): @user_script:1: wrong-type');
    const rb = await go(); const lb = fs.readFileSync(rb.logFile, 'utf8');
    check('E-1 in an unknown wording: the run STOPS and the stop QUOTES Upstash\'s text', !rb.ok && /STOP: .*an error not on the accepted list: "ERR Error running script \(call to f_0123\): @user_script:1: wrong-type"/.test(lb), lb.split('\n').filter(l => /STOP/.test(l)));
    check('...and no test file ran after that stop', !/^FILE /m.test(lb));
    S.errorText = null;
    fs.rmSync(fx, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
  });

  await section('the runner refuses to run for real without the owner\'s words', async () => {
    const { run } = require('./realstore/run.js');
    const saved = process.env.DEPLOY2_REALSTORE_RUN; delete process.env.DEPLOY2_REALSTORE_RUN;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-refuse-'));
    const before = S.arrivals;
    const r = await run({ outDir, quiet: true });
    if (saved !== undefined) process.env.DEPLOY2_REALSTORE_RUN = saved;
    check('no DEPLOY2_REALSTORE_RUN=authorised: REFUSED, nothing created or sent', !r.ok && /REFUSED/.test(r.stopped || '') && S.arrivals === before);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  await local.stop();
  const st = await S.close();
  check('the local Redis of the stand-in was stopped by SHUTDOWN NOSAVE and its folder removed', st.exited && st.folderGone, st);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: TEST CRASHED', e && e.stack || e); process.exit(1); });
