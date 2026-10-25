// THE WRITER FENCE, GENERATION 1 -- Queue Exact-Removal plan v14.1 revision
// 2, section 5.8.2 ("Deploy 1") and test Q-T24 (a), (b) and (h), offline.
// Owner, 20 Oct 2026: "I authorize Q-D: implementation of Queue
// Exact-Removal plan v14.1 revision 2, stage 1 only (Deploy 1's code)".
//
// What it proves, in two parts:
//   A. THE WIRE, always run. The REAL storage client (@upstash/redis) talks to
//      a stand-in of Upstash's web service on this machine, which records
//      every command. A save goes out as ONE script command and never as a
//      SET; the text it stores is exactly the text today's SET stores; and
//      each possible answer is handled as the plan says.
//   B. THE SCRIPT ITSELF, on a REAL Redis started on this machine (where one
//      is installed). The same real client and the same stand-in web
//      service, which this time passes every command to that Redis. The
//      fence's every value is tried; a raise is raced against a run of
//      saves; and a broken two-command copy is shown to be caught.
//
// SINCE DEPLOY 2 (queue plan v14.1 rev 3.2, Q-T24 (a), (b), (h)): the
// generation-1 save lives only in history, so this runs the REAL generation-1
// build (eb3880b, tests/lib/olderBuild.js) -- the build that may still be
// running beside generation 2 during the deploy. The checks of the CURRENT
// tree's sources moved to tests/source-check.js.
//
// What it does NOT prove: that Upstash's own servers behave as this Redis
// does (the separately authorised real-store gate, plan 6.0), or how the
// callers of the save behave when refused (tests/writer-fence-callers.js).
// No network beyond this machine is reached.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const BACKEND = path.join(__dirname, '..');
const { olderBuild, removeOlderBuilds, GEN1 } = require('./lib/olderBuild');
const GEN1DIR = olderBuild(GEN1);

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};

// ---- A tiny Redis wire-protocol client, for the real Redis in part B.
function respClient(port) {
  const sock = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0);
  const waiting = [];
  function parse(b, i) {
    if (i >= b.length) return null;
    const type = String.fromCharCode(b[i]);
    const eol = b.indexOf('\r\n', i);
    if (eol < 0) return null;
    const line = b.slice(i + 1, eol).toString();
    if (type === '+') return [line, eol + 2];
    if (type === '-') return [{ error: line }, eol + 2];
    if (type === ':') return [Number(line), eol + 2];
    if (type === '$') {
      const n = Number(line);
      if (n < 0) return [null, eol + 2];
      if (b.length < eol + 2 + n + 2) return null;
      return [b.slice(eol + 2, eol + 2 + n).toString(), eol + 2 + n + 2];
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
      waiting.shift()(r[0]);
    }
  });
  const ready = new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  return {
    ready,
    call(...args) {
      const parts = args.map(a => String(a));
      let s = `*${parts.length}\r\n`;
      for (const p of parts) s += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
      return new Promise(res => { waiting.push(res); sock.write(s); });
    },
    close() { sock.destroy(); },
  };
}

// ---- A stand-in of Upstash's web service. The client posts one command as
// a JSON list and, as it asks by default, gets text answers back in base64.
const shim = { mode: 'record', log: [], answer: null, redis: null };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const encode = v => (typeof v === 'string' ? (v === 'OK' ? 'OK' : b64(v))
  : Array.isArray(v) ? v.map(x => (typeof x === 'string' ? b64(x) : x)) : v);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { res.end(JSON.stringify({ error: 'stand-in: not JSON' })); return; }
    // The client batches commands by default ("auto-pipelining"): a batch
    // arrives at /pipeline as a list of commands and is answered with a
    // list of answers, each its own command run on its own.
    const batch = req.url.startsWith('/pipeline');
    const cmds = batch ? parsed : [parsed];
    const answers = [];
    for (const cmd of cmds) {
      shim.log.push(cmd);
      const reply = shim.mode === 'redis' ? await shim.redis.call(...cmd) : (shim.answer ? shim.answer(cmd) : null);
      answers.push(reply && typeof reply === 'object' && !Array.isArray(reply) && 'error' in reply
        ? { error: reply.error } : { result: encode(reply) });
    }
    res.setHeader('content-type', 'application/json');
    if (batch) { res.end(JSON.stringify(answers)); return; }
    if (answers[0].error) res.statusCode = 400;
    res.end(JSON.stringify(answers[0]));
  });
});

const verb = c => String(c[0]).toLowerCase();

(async () => {
  let redisProc = null, redisDir = null, direct = null;
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const URL_ = `http://127.0.0.1:${server.address().port}`;
    process.env.UPSTASH_REDIS_REST_URL = URL_;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stand-in-token';
    process.env.UPSTASH_DISABLE_TELEMETRY = '1';
    const tradeStore = require(path.join(GEN1DIR, 'tradeStore.js'));
    const { Redis } = require('@upstash/redis');
    const other = new Redis({ url: URL_, token: 'stand-in-token', retry: false });

    // =================================================================
    console.log('--- A. the wire: one script, the same text, every answer handled ---');
    const doc = { openLegs: [{ occ: 'SPY   261231C00600000', remaining: 1 }], pending: [{ id: 'T1', fills: ['1', '2'], note: 'café ü — "quoted"' }],
                  lastProcessedIds: ['1', '2'], n: 1.5, nothing: null, empty: [], nested: { a: { b: [1, 2, 3] } } };
    let stored = null;
    shim.mode = 'record';
    shim.answer = cmd => {
      if (verb(cmd) === 'get') return stored;
      if (verb(cmd) === 'eval') { stored = cmd[5]; return 'SAVED'; }
      if (verb(cmd) === 'set') return 'OK';
      return { error: 'stand-in: unexpected command ' + verb(cmd) };
    };
    shim.log = [];
    await tradeStore.updateState(() => doc);
    const sent = shim.log.filter(c => verb(c) !== 'get');
    check('A1. a save sends exactly ONE command, and it is a script', sent.length === 1 && verb(sent[0]) === 'eval', shim.log.map(verb));
    check('A1. no SET of "trades:state" is ever sent', !shim.log.some(c => verb(c) === 'set'));
    const e = sent[0] || [];
    check('A1. the script is the generation-1 save, with the record and the fence as its two keys',
      e[1] === tradeStore.GEN1_SAVE_SCRIPT && Number(e[2]) === 2 && e[3] === 'trades:state' && e[4] === '{trades:state}:fence' && e.length === 6,
      e.slice(2, 5));
    check('A1. the fence key shares the record\'s storage slot (braces around "trades:state")', tradeStore.FENCE_KEY === '{trades:state}:fence');
    shim.log = [];
    await other.set('trades:state', doc);           // what TODAY's save sends
    const todays = shim.log.find(c => verb(c) === 'set');
    check('A2. the text saved is exactly the text today\'s SET saves (same client, same record)', todays && todays[2] === e[5], { todays: todays && todays[2].slice(0, 80), now: String(e[5]).slice(0, 80) });
    shim.log = [];
    const back = await tradeStore.getState();
    check('A2. and it reads back as the same record', JSON.stringify(back) === JSON.stringify(doc));
    check('A8. reading is unchanged: one GET of "trades:state"', shim.log.length === 1 && verb(shim.log[0]) === 'get' && shim.log[0][1] === 'trades:state', shim.log);
    check('A3. after a SAVED answer this process reports generation 1, not fenced',
      tradeStore.writerStatus().generation === 1 && tradeStore.writerStatus().fenced === false && !!tradeStore.writerStatus().lastSaveAt);

    shim.answer = cmd => (verb(cmd) === 'eval' ? 'FENCED' : verb(cmd) === 'get' ? stored : { error: 'unexpected' });
    let err = null;
    try { await tradeStore.updateState(s => ({ ...s, touched: 1 })); } catch (x) { err = x; }
    check('A4. a FENCED answer makes the save fail, named "fenced"', err && err.code === 'FENCED' && /^fenced/.test(err.message), err && err.message);
    check('A4. and this process now reports itself fenced (what /health shows)', tradeStore.writerStatus().fenced === true && !!tradeStore.writerStatus().lastRefusedAt);
    for (const f of ['saveState', 'addPendingTrade', 'removePendingTrade', 'removePendingTradeIfPair']) {
      let x = null;
      try { await (f === 'saveState' ? tradeStore.saveState(doc) : f === 'removePendingTradeIfPair' ? tradeStore.removePendingTradeIfPair('T1', ['1', '2']) : tradeStore[f](f === 'addPendingTrade' ? { id: 'N' } : 'T1')); } catch (y) { x = y; }
      check(`A4. ${f} is refused the same way`, x && x.code === 'FENCED', x && x.message);
    }

    shim.answer = cmd => (verb(cmd) === 'eval' ? 'SAVED' : verb(cmd) === 'get' ? stored : { error: 'unexpected' });
    let ok = false;
    try { await tradeStore.updateState(s => ({ ...s, after: 1 })); ok = true; } catch (x) { /* reported below */ }
    check('A5. the one-at-a-time queue is not jammed by a refusal: the next save goes through', ok && tradeStore.writerStatus().fenced === false);

    for (const [label, ans] of [['"OK"', 'OK'], ['a number', 1], ['nothing (nil)', null], ['an error reply', { error: 'ERR script failed' }]]) {
      shim.answer = cmd => (verb(cmd) === 'eval' ? ans : verb(cmd) === 'get' ? stored : null);
      const before = tradeStore.writerStatus().lastSaveAt;
      let y = null;
      try { await tradeStore.updateState(s => ({ ...s, odd: 1 })); } catch (z) { y = z; }
      check(`A6. an answer of ${label} is never taken as a save`, !!y && tradeStore.writerStatus().lastSaveAt === before, y && y.message);
    }
    shim.log = [];
    shim.answer = cmd => (verb(cmd) === 'get' ? stored : 'SAVED');
    await tradeStore.updateState(() => null);
    check('A7. a change that returns nothing sends no save at all (as today)', !shim.log.some(c => verb(c) !== 'get'), shim.log.map(verb));

    // (A9, the source checks of the current tree, are in tests/source-check.js.)

    // =================================================================
    console.log('\n--- B. the script itself, on a real Redis on this machine ---');
    const which = spawnSync('sh', ['-c', 'command -v redis-server'], { encoding: 'utf8' });
    if (!which.stdout.trim()) {
      console.log('SKIPPED: part B -- no redis-server on this machine. The script was NOT run here; it runs in the real-store gate (plan 6.0).');
    } else {
      redisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-fence-'));
      const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
      redisProc = spawn(which.stdout.trim(), ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', redisDir], { stdio: 'ignore' });
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { direct = respClient(port); await direct.ready; up = (await direct.call('PING')) === 'PONG'; } catch (x) { await new Promise(r => setTimeout(r, 50)); }
      }
      check('B0. a real Redis started on this machine', up);
      if (up) {
        shim.redis = respClient(port); await shim.redis.ready;
        shim.mode = 'redis';
        const ver = await direct.call('INFO', 'server');
        console.log('     Redis', (String(ver).match(/redis_version:(\S+)/) || [])[1] || '?');
        const KEYS = ['trades:state', '{trades:state}:fence'];
        const seed = async (fence, kind = 'string') => {
          await direct.call('FLUSHALL');
          await direct.call('SET', KEYS[0], JSON.stringify({ before: true }));
          if (fence === undefined) return;
          if (kind === 'list') await direct.call('RPUSH', KEYS[1], 'x');
          else await direct.call('SET', KEYS[1], fence);
        };
        const attempt = async () => { try { await tradeStore.updateState(() => ({ saved: 'new' })); return 'SAVED'; } catch (x) { return x.code || x.message; } };

        // B1 (Q-T24 (a)): saves land with no fence, or a fence of 0 or 1.
        for (const f of [undefined, '0', '000', '1', '01', '001']) {
          await seed(f);
          const r = await attempt();
          const text = await direct.call('GET', KEYS[0]);
          const fenceAfter = await direct.call('GET', KEYS[1]);
          check(`B1. fence ${f === undefined ? 'absent' : JSON.stringify(f)}: the save lands, with exactly today's text`,
            r === 'SAVED' && text === JSON.stringify({ saved: 'new' }), { r, text });
          check(`B1. fence ${f === undefined ? 'absent' : JSON.stringify(f)}: the fence is untouched${f === undefined ? ' (the save never creates it)' : ''}`,
            f === undefined ? (await direct.call('EXISTS', KEYS[1])) === 0 : fenceAfter === f, fenceAfter);
        }
        // B2 (Q-T24 (a)): a fence above 1 refuses, and nothing is written.
        // 20 digits and 2^64 are beyond a 64-bit integer: on Upstash, tonumber()
        // of them gave nil and the old script stopped with an error (Gate 1 Step 1).
        for (const f of ['2', '02', '3', '10', '99999999999999999999', '18446744073709551616', '99999999999999999999999']) {
          await seed(f);
          const r = await attempt();
          check(`B2. fence ${JSON.stringify(f)}: refused "fenced", the record byte-identical, the fence unchanged`,
            r === 'FENCED' && (await direct.call('GET', KEYS[0])) === JSON.stringify({ before: true }) && (await direct.call('GET', KEYS[1])) === f, r);
        }
        // B3 (Q-T24 (a)): a fence that is not a whole number fails closed.
        for (const f of ['x', '-1', '1.5', ' 1', '1 ', '', '0x2', '+1', '1e0']) {
          await seed(f);
          const r = await attempt();
          check(`B3. malformed fence ${JSON.stringify(f)}: refused, nothing written`,
            r === 'FENCED' && (await direct.call('GET', KEYS[0])) === JSON.stringify({ before: true }), r);
        }
        // B4: a fence key of the wrong type makes the script fail; nothing is written.
        await seed('x', 'list');
        const r4 = await attempt();
        check('B4. a fence of the wrong type: the save fails (not taken as saved), nothing written',
          r4 !== 'SAVED' && (await direct.call('GET', KEYS[0])) === JSON.stringify({ before: true }), r4);

        // B5 (Q-T24 (b)): a raise raced against a run of saves. Saves that
        // finished before the raise was confirmed are allowed; NONE may land
        // after it. Each save writes a new counter value, so a landing is seen.
        const race = async (saveOnce) => {
          await seed(undefined);
          const outcomes = [];
          let raisedAt = -1, afterRaise = null, n = 0, stop = false;
          const saver = (async () => {
            // "After the raise" is judged when the save STARTS: a save sent
            // before the raise was confirmed may land before it (allowed by
            // Q-T24 (b)) and only answer after it. Judging it on its answer,
            // as this did until 25 Oct 2026, now and then counted such a save
            // as landing after the raise (1 run in 7 locally). The record's
            // own re-read below ("unchanged") is the check on the store.
            while (!stop && n < 400) { n++; const startedAfter = raisedAt >= 0; outcomes.push({ n, r: await saveOnce(n), afterConfirmed: startedAfter }); }
          })();
          await new Promise(r => setTimeout(r, 40));
          await direct.call('SET', KEYS[1], '2');     // THE RAISE, by "another process"
          raisedAt = n;
          afterRaise = await direct.call('GET', KEYS[0]);
          await new Promise(r => setTimeout(r, 60));
          stop = true; await saver;
          const final = await direct.call('GET', KEYS[0]);
          const landedAfter = outcomes.filter(o => o.afterConfirmed && o.r === 'SAVED').length;
          return { outcomes, landedAfter, unchanged: final === afterRaise, before: outcomes.filter(o => o.r === 'SAVED').length, refusedAfter: outcomes.filter(o => o.afterConfirmed && o.r !== 'SAVED').length };
        };
        const real = await race(async n => { try { await tradeStore.updateState(() => ({ counter: n })); return 'SAVED'; } catch (x) { return x.code || x.message; } });
        check('B5. the race happened: saves landed before the raise, and attempts were made after it', real.before > 0 && real.refusedAfter > 0, { before: real.before, after: real.refusedAfter });
        check('B5. NO save landed after the raise was confirmed, and the record never changed after it', real.landedAfter === 0 && real.unchanged, real.landedAfter);

        // B6 (Q-T24 (h)): the broken copy -- read the fence, then save in a
        // SECOND command -- with the raise falling between the two. The same
        // property must catch it.
        let hook = null;
        const broken = async n => {
          const f = await other.get(KEYS[1]);
          if (f != null && Number(f) > 1) return 'FENCED';
          if (hook) { const h = hook; hook = null; await h(); }
          await other.set(KEYS[0], { counter: n });
          return 'SAVED';
        };
        await seed(undefined);
        let raisedConfirmed = false;
        hook = async () => { await direct.call('SET', KEYS[1], '2'); raisedConfirmed = true; };
        const r6 = await broken(1);
        const landed = (await direct.call('GET', KEYS[0])) === JSON.stringify({ counter: 1 });
        check('B6. broken copy (fence read, then a separate save): a save LANDS after the raise was confirmed -- the check catches it',
          raisedConfirmed && r6 === 'SAVED' && landed);
        await seed(undefined);
        hook = null;
        let raised2 = false;
        // The same raise at the same point against the real save: refused.
        const realWithRaise = await (async () => {
          await direct.call('SET', KEYS[1], '2'); raised2 = true;
          try { await tradeStore.updateState(() => ({ counter: 1 })); return 'SAVED'; } catch (x) { return x.code; }
        })();
        check('B6. the real one-script save, raised at the same point, is refused', raised2 && realWithRaise === 'FENCED' && (await direct.call('GET', KEYS[0])) === JSON.stringify({ before: true }));
      }
    }
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    try { if (shim.redis) shim.redis.close(); if (direct) direct.close(); } catch (e) { /* closing only */ }
    if (redisProc) redisProc.kill('SIGKILL');
    if (redisDir) try { fs.rmSync(redisDir, { recursive: true, force: true }); } catch (e) { /* temp folder only */ }
    server.close();
    removeOlderBuilds();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
