// TWO (OR THREE) REAL SERVICE PROCESSES, ONE REAL REDIS (Queue plan v14.1 rev
// 3.2, Deploy 2). Each process is a real Node process (tests/lib/gen2Child.js)
// running the service's real save module and import code, each through its
// own stand-in of Upstash's web service, so this file can make both read the
// same record before either saves, hold or drop any request, and END a
// process at an exact point.
//   Q-T19 (a)  every ordered pair of writer kinds, forced to read the same
//              record before either saves; (b) no write bypasses the
//              protected save (counted at the store's door)
//   Q-T20 (a)  2 x 1,000 log calls at once; (e) a process that ends between
//              exhaustion and its log call; (f) the two-command broken copy
//   Q-T14 (a)-(d), (f)  the poison guard across real process exits, ONE TRADE
//              AT A TIME (the correction of 25 Oct 2026): a failing trade
//              first, middle and last in a batch with healthy ones; a crash
//              after a decision is saved but before publication (T2); and two
//              broken copies (the pre-correction build, a forgetful guard);
//              a decision that cannot be saved (a reset or another process in
//              the gap, a mismatch) stops the batch; one already saved by
//              another process is kept and the batch goes on
//   Q-T5 (a)-(d)   restarts: after staging; then a reset; two measurements of
//              one item; a process ending at the publication's save
//   Q-T23 (f)  a process ending at each point of a commit
//   Q-T15 (g), (h)  two processes recovering the queue identity at once; a
//              recovery whose answer is lost
//   Q-T26 (b)  the same requestId from two processes at once
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { startRedis, restShim, scriptName, verb } = require('./lib/localRedis');
const { olderBuild, removeOlderBuilds } = require('./lib/olderBuild');
// The pull request's own head before the poison-guard correction (25 Oct
// 2026): its batch-wide count is the broken copy Q-T14 (f) must catch.
const PRE_CORRECTION = 'a783456a3a741580659d80c49cb5215189fa8c23';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 700)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } finally { await killAll(); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 8000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) return false; await sleep(3); } return true; };
const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 12 * 60 * 1000).unref();

const BACKEND = path.join(__dirname, '..');
const Q = require(path.join(BACKEND, 'queueOps.js'));
const SCRIPTS = (() => { const m = require('fs').readFileSync(path.join(BACKEND, 'tradeStore.js'), 'utf8'); const out = {};
  for (const n of ['RAISE', 'COMMIT', 'RESOLUTION_READ', 'LOG']) { const x = new RegExp('const ' + n + ' = (\\[[\\s\\S]*?\\])\\.join').exec(m); out[n] = JSON.parse(x[1].replace(/,\s*\]$/, ']')).join('\n'); } return out; })();
const KEY = 'trades:state', FENCE = '{trades:state}:fence', LOG = 'queue:casFailures';
const T0 = Date.parse('2026-10-20T14:00:00Z');
const OCC = 'SPY   261231C00600000';
const fillsFor = (n, base) => {
  const out = [];
  for (let i = base; i < base + n; i++) for (const [kind, minute, id] of [['open', i * 10, 500000 + 2 * i], ['close', i * 10 + 5, 500000 + 2 * i + 1]]) {
    const t = T0 + minute * 60000; const d = new Date(t);
    out.push({ transactionId: String(id), accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL', instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66, date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: t });
  }
  return out;
};

let redis = null, R = null;
const children = [];
const allShims = [];
async function child(name, build) {
  const shim = restShim(R); const url = await shim.listen(); allShims.push(shim);
  const proc = fork(path.join(__dirname, 'lib', 'gen2Child.js'), build ? [build] : [], { silent: true });
  const c = { name, proc, shim, url, events: [], pending: new Map(), seq: 0, exited: false };
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  proc.on('message', m => {
    if (m.event) { c.events.push(m); return; }
    const p = c.pending.get(m.id); if (!p) return; c.pending.delete(m.id);
    if (m.ok) p.res(m.value); else p.rej(new Error(m.error));
  });
  c.exitedP = new Promise(r => proc.on('exit', () => { c.exited = true; for (const p of c.pending.values()) p.rej(new Error(name + ' exited')); c.pending.clear(); r(); }));
  c.call = msg => new Promise((res, rej) => { if (c.exited) return rej(new Error(name + ' has exited')); const id = ++c.seq; c.pending.set(id, { res, rej }); proc.send({ ...msg, id }); });
  await waitFor(() => c.events.some(e => e.event === 'ready'));
  children.push(c);
  return c;
}
async function killAll() {
  for (const c of children.splice(0)) { if (!c.exited) { c.proc.send({ cmd: 'exit', id: 0 }); await Promise.race([c.exitedP, sleep(2000)]); } }
  for (const s of allShims.splice(0)) await s.close();
}
const text = async () => R.call('GET', KEY);
const doc = async () => JSON.parse(await text());
// A fresh store with the fence at 1 and the record as given; the first
// process to start raises and expands it.
async function fresh(record = { openLegs: [], pending: [], lastProcessedIds: [] }) {
  await R.call('FLUSHALL');
  await R.call('SET', KEY, JSON.stringify(record));
  await R.call('SET', FENCE, '1');
}
// Holds the first COMMIT (matching `filter`) that reaches this shim, until
// released; release() resolves once the store has executed it.
function holdFirstCommit(shim, filter = () => true) {
  let arrivedRes, goRes, executedRes, held = null;
  const arrived = new Promise(r => { arrivedRes = r; });
  const go = new Promise(r => { goRes = r; });
  const executed = new Promise(r => { executedRes = r; });
  const prevB = shim.hooks.before, prevA = shim.hooks.after;
  shim.hooks.before = async cmd => {
    if (!held && scriptName(cmd, SCRIPTS) === 'COMMIT' && filter(cmd)) { held = cmd; arrivedRes(cmd); await go; return undefined; }
    return prevB ? prevB(cmd) : undefined;
  };
  shim.hooks.after = async (cmd, reply) => { if (cmd === held) executedRes(reply); return prevA ? prevA(cmd, reply) : undefined; };
  return { arrived, release: () => { goRes(); return executed; } };
}
const newestKind = cmd => { const d = JSON.parse(cmd[6]); const r = Object.values(d.opRecords).find(x => x.committedVersion === d.stateVersion); return r && r.kind; };

(async () => {
  redis = await startRedis();
  if (!redis) { console.log('SKIPPED: no redis-server on this machine.\n\n0 passed, 0 failed'); process.exit(0); }
  R = redis.client;
  try {
    await section('Q-T26 (b) THE SAME requestId FROM TWO PROCESSES AT ONCE', async () => {
      await fresh({ openLegs: [], pending: [{ id: 'W', fills: ['1', '2'] }], lastProcessedIds: ['1', '2'] });
      const a = await child('A'), b = await child('B');
      await a.call({ cmd: 'init', url: a.url }); await b.call({ cmd: 'init', url: b.url });
      const id = hex('same');
      const ha = holdFirstCommit(a.shim), hb = holdFirstCommit(b.shim);
      const pa = a.call({ cmd: 'protect', update: 'reset', opts: { opId: id, acceptKinds: ['reset', 'reset-cancel'] } });
      const pb = b.call({ cmd: 'protect', update: 'reset', opts: { opId: id, acceptKinds: ['reset', 'reset-cancel'] } });
      await ha.arrived; await hb.arrived;                     // both read the same record before either saved
      const ra = await ha.release(); const rb = await hb.release();
      const [oa, ob] = await Promise.all([pa, pb]);
      const d = await doc();
      check('both read the same record first; A committed, B was refused CONFLICT', ra === 'COMMITTED' && rb === 'CONFLICT', [ra, rb]);
      check('exactly one reset applied: A "committed", B "recovered"; resetCounter rose by one; one record', oa.status === 'committed' && ob.status === 'recovered' && d.resetCounter === 1 && Object.values(d.opRecords).filter(r => r.kind === 'reset').length === 1, [oa, ob]);
    });

    await section('Q-T19 (a), (b) EVERY ORDERED PAIR OF WRITER KINDS, both reading the same record before either saves', async () => {
      const KINDS = ['staging', 'landing', 'publication', 'poison', 'qidRemoval', 'legacyRemoval', 'reset', 'progress'];
      const E = 'e'.repeat(32);
      const base = (() => {
        const d = require('./lib/gen2StandIn').expanded({ openLegs: [], pending: [], lastProcessedIds: [] });
        d.queueEpoch = E; d.queueSeq = 20;
        d.pendingStaged = [1, 2].map(c => ({ id: 'S' + c, fills: ['s' + c, 't' + c], qid: E + '-' + c, stagedAt: 'x', stagedTries: 0 }));
        d.pending = [1, 2].map(c => ({ id: 'L' + c, fills: ['l' + c, 'm' + c], qid: E + '-' + (10 + c) })).concat([1, 2].map(c => ({ id: 'LEG' + c, fills: ['g' + c, 'h' + c] })));
        return d;
      })();
      const op = (k, c, n) => {
        const fills = fillsFor(1, 1000 + n * 2 + c);
        switch (k) {
          case 'staging': return { update: 'staging', payload: { fills } };
          case 'landing': return { update: 'landing', payload: { fills } };
          case 'publication': return { update: 'publication', payload: { prev: { qid: E + '-' + c, decided: 'result', trade: { ...base.pendingStaged[c - 1], measured: c } }, qids: [E + '-' + c] } };
          case 'poison': return { update: 'poison', payload: { prev: null, qid: E + '-' + c } };
          case 'qidRemoval': return { update: 'qidRemoval', payload: { id: 'L' + c, pair: ['l' + c, 'm' + c], qid: E + '-' + (10 + c) } };
          case 'legacyRemoval': return { update: 'legacyRemoval', payload: { id: 'LEG' + c } };
          case 'reset': return { update: 'reset', opts: { acceptKinds: ['reset', 'reset-cancel'] } };
          case 'progress': return { update: 'progress', payload: { field: 'p' + c, value: n } };
        }
      };
      const effect = (k, c, d, n) => {
        switch (k) {
          case 'staging': return d.pendingStaged.some(e => e.fills[0] === String(500000 + 2 * (1000 + n * 2 + c)));
          case 'landing': return d.pending.some(e => e.fills[0] === String(500000 + 2 * (1000 + n * 2 + c)));
          case 'publication': return d.pending.some(e => e.measured === c);
          case 'poison': return d.pendingStaged.some(e => e.qid === E + '-' + c && e.stagedTries === 1);
          case 'qidRemoval': return !d.pending.some(e => e.qid === E + '-' + (10 + c));
          case 'legacyRemoval': return !d.pending.some(e => e.id === 'LEG' + c);
          case 'reset': return d.resetCounter >= 1;
          case 'progress': return d.lastBackfill && d.lastBackfill['p' + c] === n;
        }
      };
      const a = await child('A'), b = await child('B');
      await fresh(base); await R.call('SET', FENCE, '2');
      await a.call({ cmd: 'init', url: a.url }); await b.call({ cmd: 'init', url: b.url });
      const allQids = new Set(); let dupQids = 0;
      const problems = [];
      let n = 0, reruns = 0;
      for (const ka of KINDS) for (const kb of KINDS) {
        n++;
        await R.call('SET', KEY, JSON.stringify(base));
        const ha = holdFirstCommit(a.shim), hb = holdFirstCommit(b.shim);
        const pa = a.call({ cmd: 'protect', ...op(ka, 1, n) });
        const pb = b.call({ cmd: 'protect', ...op(kb, 2, n) });
        await ha.arrived; await hb.arrived;
        const ra = await ha.release(); const rb = await hb.release();
        const [oa, ob] = await Promise.all([pa, pb]);
        a.shim.hooks = {}; b.shim.hooks = {};
        const d = await doc();
        if (ob.runs >= 2) reruns++;
        for (const e of [...d.pending, ...d.pendingStaged]) if (e.qid && !e.qid.startsWith(E + '-')) { if (allQids.has(e.qid)) dupQids++; allQids.add(e.qid); }
        // A reset that committed AFTER the other change removes it on
        // purpose; one that committed BEFORE leaves the other nothing to do.
        const aOk = oa.status === 'committed' && (effect(ka, 1, d, n) || kb === 'reset');
        // A publication re-run after a reset finds its trade gone: since the
        // second correction (25 Oct 2026) it REFUSES ("decision-not-saved")
        // rather than quietly doing nothing.
        const bOk = (['committed', 'unchanged'].includes(ob.status) && (effect(kb, 2, d, n) || (ka === 'reset' && ob.status === 'unchanged') || (ka === 'reset' && kb !== 'reset' && ob.status === 'committed')))
          || (ka === 'reset' && kb === 'publication' && ob.status === 'refused' && ob.why === 'decision-not-saved');
        if (!(ra === 'COMMITTED' && rb === 'CONFLICT' && aOk && bOk)) problems.push({ pair: ka + ' then ' + kb, ra, rb, oa: oa.status, ob: ob.status });
      }
      check(`${n} ordered pairs: both read the same record first; the first saved, the second was refused, re-ran on the newer record, and BOTH changes are in it (unless a reset removed one on purpose)`, problems.length === 0, problems.slice(0, 5));
      check(`every refused save was re-run on the newer record (${reruns} of ${n} second writers ran twice or more)`, reruns === n);
      const issued = [...allQids];
      check(`every qid issued across the pairs is distinct (${issued.length} kept; duplicates ${dupQids})`, dupQids === 0);
      const bypass = [...a.shim.log, ...b.shim.log].filter(c => ['set', 'del', 'setex', 'getset', 'unlink', 'rename'].includes(verb(c)) && [KEY, FENCE].includes(c[1])
        || (verb(c) === 'eval' && !['COMMIT', 'RAISE', 'RESOLUTION_READ', 'LOG'].includes(scriptName(c, SCRIPTS))));
      check(`(b) NO BYPASS: of ${a.shim.log.length + b.shim.log.length} commands the two processes sent, writes to the record or fence other than THE COMMIT / THE RAISE: ${bypass.length}`, bypass.length === 0);
      const fenceWrites = [...a.shim.log, ...b.shim.log].filter(c => scriptName(c, SCRIPTS) === 'RAISE').length;
      check(`(Q-T24 (f)) the fence was written only by THE RAISE (${fenceWrites} raises), and reads 2`, (await R.call('GET', FENCE)) === '2');
    });

    await section('Q-T20 (a) 2 x 1,000 LOG CALLS AT ONCE; (f) the two-command broken copy', async () => {
      await fresh();
      const a = await child('A'), b = await child('B');
      await a.call({ cmd: 'init', url: a.url, start: false }); await b.call({ cmd: 'init', url: b.url, start: false });
      let over = 0, missing = 0, confirmed = 0;
      for (const s of [a.shim, b.shim]) s.hooks.after = async (cmd, reply) => {
        if (scriptName(cmd, SCRIPTS) !== 'LOG') return;
        if (typeof reply !== 'number') return;
        confirmed++;
        if (reply > 100) over++;
        const now = await R.call('LRANGE', LOG, '0', '-1');
        if (!now.includes(cmd[4])) missing++;
      };
      const run = async (c, tag) => { for (let i = 0; i < 1000; i++) await c.call({ cmd: 'log', entry: { operation: tag, i } }); };
      await Promise.all([run(a, 'A'), run(b, 'B')]);
      const list = await R.call('LRANGE', LOG, '0', '-1');
      const wellFormed = list.every(x => { try { const e = JSON.parse(x); return ['A', 'B'].includes(e.operation) && Number.isInteger(e.i); } catch (e) { return false; } });
      check(`${confirmed} confirmed calls: after every one the list held at most 100 (${over} over), and its own entry was there when its length came back (${missing} missing)`, confirmed === 2000 && over === 0 && missing === 0);
      check(`at the end exactly 100 well-formed entries (${list.length})`, list.length === 100 && wellFormed);
      // (f) append then trim as TWO commands, stopped between them each time.
      await R.call('DEL', LOG);
      for (let i = 0; i < 150; i++) { await R.call('LPUSH', LOG, JSON.stringify({ i })); /* stopped here: the trim never runs */ }
      check('(f) BROKEN COPY, append and trim as two commands, stopped between: more than 100 entries with nothing left to trim them (caught)', (await R.call('LLEN', LOG)) > 100);
    });

    await section('Q-T20 (e) A PROCESS ENDS BETWEEN EXHAUSTION AND ITS LOG CALL', async () => {
      await fresh();
      const a = await child('A');
      await a.call({ cmd: 'init', url: a.url });
      const before = await doc();
      let n = 0;
      a.shim.hooks.before = async cmd => {
        if (scriptName(cmd, SCRIPTS) === 'COMMIT') { const d = await doc(); d.lastSync = { n: ++n }; d.stateVersion++; await R.call('SET', KEY, JSON.stringify(d)); }
        if (scriptName(cmd, SCRIPTS) === 'LOG') { a.proc.send({ cmd: 'exit', id: 0 }); return { drop: true }; }
      };
      await a.call({ cmd: 'protect', update: 'progress', payload: { field: 'lost', value: 1 } }).catch(() => null);
      await a.exitedP;
      const b = await child('B');
      await b.call({ cmd: 'init', url: b.url });
      const w = await b.call({ cmd: 'writer' });
      const d = await doc();
      check('the process ended at its log call: no durable entry; after the restart the in-memory counters start again at 0 (the limit, made visible)',
        (await R.call('LLEN', LOG)) === 0 && w.casExhausted.count === 0 && w.casLogFailed.count === 0);
      check('the record is intact (the competitor\'s last save) and the failed change is absent', d.lastSync.n === n && !(d.lastBackfill && d.lastBackfill.lost) && d.stateVersion === before.stateVersion + n);
    });

    // THE POISON GUARD, ONE TRADE AT A TIME (3.11 as corrected on 25 Oct 2026;
    // the auditor's accepted correction plan and its rules I1-I5). A batch of
    // three trades; X ends the process every time it is measured; A and C are
    // healthy. Runs until a run finishes (at most 4), each a new real process.
    const NAMES = ['A', 'B', 'C'];
    async function poisonRuns(xAt, { build, variant } = {}) {
      await fresh();
      const label = i => (i === xAt ? 'X' : NAMES[i]);
      const measured = {}, maxTries = {}, history = [];
      let order = [];
      for (let run = 1; run <= 4; run++) {
        const c = await child('run' + run, build);
        await c.call({ cmd: 'init', url: c.url });
        if (variant) await c.call({ cmd: 'variant', name: variant });
        await c.call({ cmd: 'market', behaviour: { [xAt]: 'exit' } });
        if (run === 1) await c.call({ cmd: 'schwab', fills: fillsFor(3, 0) });
        // (b) at the store's door: each counting commit is CONFIRMED before that trade's measurement starts.
        c.shim.hooks.after = async (cmd, reply) => { if (scriptName(cmd, SCRIPTS) === 'COMMIT' && reply === 'COMMITTED' && newestKind(cmd) === 'poison-guard') order.push('guard saved'); };
        const seen = new Set();
        const watch = setInterval(() => { for (const e of c.events) if (e.event === 'measuring' && !seen.has(e)) { seen.add(e); order.push('measuring ' + label(e.index)); } }, 1);
        const done = c.call({ cmd: 'backfill' }).then(() => 'finished', () => 'ended');
        const how = await Promise.race([done, c.exitedP.then(() => 'ended')]);
        clearInterval(watch);
        for (const e of c.events) if (e.event === 'measuring') measured[label(e.index)] = (measured[label(e.index)] || 0) + 1;
        const d = await doc();
        for (const e of d.pendingStaged) { const i = Math.round((e.entryTimestamp - T0) / 600000); maxTries[label(i)] = Math.max(maxTries[label(i)] || 0, e.stagedTries || 0); }
        history.push(run + ':' + how + ' staged ' + JSON.stringify(d.pendingStaged.map(e => [label(Math.round((e.entryTimestamp - T0) / 600000)), e.stagedTries, e.decided || null])));
        if (how === 'finished') { c.proc.send({ cmd: 'exit', id: 0 }); await c.exitedP; break; }
      }
      const d = await doc();
      const pub = {};
      for (const e of d.pending) pub[label(Math.round((e.entryTimestamp - T0) / 600000))] = e.undEntry === 500 ? 'measured' : 'unmeasured';
      return { d, measured, maxTries, history, pub, order };
    }
    const healthyOk = r => ['A', 'B', 'C'].filter(n => n in r.pub || n in r.measured).every(n => r.pub[n] === 'measured' && r.measured[n] === 1 && (r.maxTries[n] || 0) <= 1);

    for (const [xAt, where] of [[0, 'FIRST'], [1, 'MIDDLE'], [2, 'LAST']]) {
      await section(`Q-T14 (a), (f) THE POISON GUARD, X ${where} in a batch with two healthy trades, across real process exits`, async () => {
        const r = await poisonRuns(xAt);
        console.log('     ' + r.history.join(' | '));
        const healthy = NAMES.filter((n, i) => i !== xAt);
        check(`X ${where}: X is published "abandoned" at run 3, measured at most twice, its counter left at 2`,
          r.history.length === 3 && r.pub.X === 'unmeasured' && r.measured.X === 2 && r.maxTries.X === 2 && r.d.lastBackfill.unmeasured.counts.abandoned === 1, { history: r.history, measured: r.measured, pub: r.pub });
        check(`X ${where}: the healthy trades (${healthy.join(', ')}) are measured EXACTLY ONCE and published MEASURED; their counters never pass 1`,
          healthy.every(n => r.pub[n] === 'measured' && r.measured[n] === 1 && (r.maxTries[n] || 0) <= 1) && !r.d.lastBackfill.unmeasured.counts.failed, { measured: r.measured, maxTries: r.maxTries, pub: r.pub });
        check(`X ${where}: nothing is left staged; nothing was published twice`, r.d.pendingStaged.length === 0 && r.d.pending.length === 3);
        if (xAt === 1) {
          const firstMeasure = r.order.indexOf('measuring A');
          check('(b) every measurement started only after a counting commit was CONFIRMED at the store', firstMeasure > 0 && r.order.slice(0, firstMeasure).includes('guard saved')
            && r.order.every((x, i) => !x.startsWith('measuring') || r.order.slice(0, i).filter(y => y === 'guard saved').length > r.order.slice(0, i).filter(y => y.startsWith('measuring')).length), r.order);
        }
      });
    }

    await section('T2: A CRASH AFTER A DECISION IS SAVED, BEFORE PUBLICATION: the resume publishes it with NO new measurement', async () => {
      await fresh();
      let a = await child('run1');
      await a.call({ cmd: 'init', url: a.url });
      await a.call({ cmd: 'market', behaviour: {} });
      await a.call({ cmd: 'schwab', fills: fillsFor(2, 0) });
      // The process ends the moment its PUBLICATION reaches the store: both
      // decisions were computed, the first one saved by the second's guard.
      a.shim.hooks.before = async cmd => { if (scriptName(cmd, SCRIPTS) === 'COMMIT' && newestKind(cmd) === 'publication') { a.proc.send({ cmd: 'exit', id: 0 }); return { drop: true }; } };
      a.call({ cmd: 'backfill' }).catch(() => {});
      await a.exitedP;
      let d = await doc();
      const first = d.pendingStaged.find(e => e.entryTimestamp === T0), second = d.pendingStaged.find(e => e.entryTimestamp === T0 + 600000);
      check('run 1 ended before publication: nothing visible; the first trade\'s decision is SAVED in staging (measured), the second\'s is not',
        d.pending.length === 0 && first && first.decided === 'result' && first.undEntry === 500 && first.stagedTries === 1 && second && second.decided === undefined && second.stagedTries === 1, d.pendingStaged);
      a = await child('run2');
      await a.call({ cmd: 'init', url: a.url });
      await a.call({ cmd: 'backfill' });
      d = await doc();
      const m = a.events.filter(e => e.event === 'measuring').map(e => e.index);
      check('run 2: the saved decision is published WITHOUT measuring it again (I3); only the undecided trade is measured', JSON.stringify(m) === '[1]', m);
      check('run 2: both published measured, nothing staged, the saved trade\'s counter never raised again', d.pending.length === 2 && d.pending.every(e => e.undEntry === 500) && d.pendingStaged.length === 0
        && !d.lastBackfill.unmeasured, d.pending.map(e => [e.entryTimestamp, e.undEntry]));
    });

    // A DECISION THAT CANNOT BE SAVED STOPS THE BATCH (the second correction
    // of 25 Oct 2026, the auditor's targeted review). Two staged trades A, B,
    // one batch; another process acts in the gap between A's measurement and
    // the commit that would save it. Throughout, the waiting list is watched:
    // it must never show A without B, or B without A.
    const measuredBy = (c, i) => c.events.filter(e => e.event === 'measuring' && e.index === i).length;
    const watchPartial = qids => { let bad = 0, stop = false; const run = (async () => { while (!stop) { const d = await doc(); const n = d.pending.filter(e => qids.includes(e.qid)).length; if (n && n !== qids.length) bad++; await sleep(2); } })(); return async () => { stop = true; await run; return bad; }; };
    async function twoStaged(c) { await c.call({ cmd: 'protect', update: 'staging', payload: { fills: fillsFor(2, 0) } }); return (await doc()).pendingStaged; }

    await section('DECISION NOT SAVED (a): a RESET between A\'s measurement and its save: the batch stops, nothing more measured, the reason kept', async () => {
      await fresh();
      const p1 = await child('P1'), p2 = await child('P2');
      await p1.call({ cmd: 'init', url: p1.url }); await p2.call({ cmd: 'init', url: p2.url });
      const entries = await twoStaged(p1);
      const watch = watchPartial(entries.map(e => e.qid));
      await p1.call({ cmd: 'market', behaviour: { 0: 'hang' } });
      const job = p1.call({ cmd: 'batch', entries }).then(() => null, e => e);
      await waitFor(async () => measuredBy(p1, 0) === 1);
      await p2.call({ cmd: 'protect', update: 'reset', opts: { acceptKinds: ['reset', 'reset-cancel'] } });
      await p2.call({ cmd: 'protect', update: 'staging', payload: { fills: fillsFor(1, 5) } });
      await p1.call({ cmd: 'release' });
      const err = await job;
      const d = await doc();
      check('P1 stopped: "the decision for A was not saved (not-staged)"', err && /stopped/.test(err.message) && err.message.includes(entries[0].qid) && /not-staged/.test(err.message), err && err.message);
      check('P1 measured nothing after it: B never measured', measuredBy(p1, 1) === 0);
      check('the trade staged after the reset is untouched (never counted), nothing published', d.pendingStaged.length === 1 && d.pendingStaged[0].stagedTries === 0 && d.pending.length === 0, d.pendingStaged);
      check('the reason is kept: lastBackfill.decisionNotSaved names A, "not-staged"', d.lastBackfill && d.lastBackfill.decisionNotSaved && d.lastBackfill.decisionNotSaved.examples[0].qid === entries[0].qid && d.lastBackfill.decisionNotSaved.examples[0].outcome === 'not-staged', d.lastBackfill);
      check('the waiting list never showed part of the batch', (await watch()) === 0);
    });

    await section('DECISION NOT SAVED (b): ANOTHER PROCESS publishes A (and B) in the gap: P1 stops; each trade published once, by the process that saved first', async () => {
      await fresh();
      const p1 = await child('P1'), p2 = await child('P2');
      await p1.call({ cmd: 'init', url: p1.url }); await p2.call({ cmd: 'init', url: p2.url });
      const entries = await twoStaged(p1);
      const watch = watchPartial(entries.map(e => e.qid));
      await p1.call({ cmd: 'market', behaviour: { 0: 'hang' }, price: 502 });
      await p2.call({ cmd: 'market', behaviour: {}, price: 501 });
      const job = p1.call({ cmd: 'batch', entries }).then(() => null, e => e);
      await waitFor(async () => measuredBy(p1, 0) === 1);
      await p2.call({ cmd: 'batch', entries });
      await p1.call({ cmd: 'release' });
      const err = await job;
      const d = await doc();
      check('P1 stopped: A\'s decision not saved (not-staged), and P1 never measured B', err && /not-staged/.test(err.message) && measuredBy(p1, 1) === 0, err && err.message);
      check('A and B are published ONCE each, with P2\'s measurements; nothing staged', d.pending.length === 2 && d.pending.every(e => e.undEntry === 501) && d.pendingStaged.length === 0, d.pending.map(e => e.undEntry));
      check('the reason is kept for A', d.lastBackfill.decisionNotSaved.examples[0].qid === entries[0].qid);
      check('the waiting list never showed part of the batch', (await watch()) === 0);
    });

    await section('DECISION NOT SAVED (c): a decision that is NOT about the staged trade ("mismatch"): refused, the batch stops, the next run finishes it', async () => {
      await fresh();
      const p1 = await child('P1');
      await p1.call({ cmd: 'init', url: p1.url });
      await p1.call({ cmd: 'variant', name: 'mismatch-decision' });
      const entries = await twoStaged(p1);
      const before = await text();
      let err = null;
      try { await p1.call({ cmd: 'batch', entries }); } catch (e) { err = e; }
      let d = await doc();
      check('the guard REFUSED it: the batch stopped "mismatch", B never measured', err && /mismatch/.test(err.message) && measuredBy(p1, 0) === 1 && measuredBy(p1, 1) === 0, err && err.message);
      check('nothing of the refused change was written: A counted once, undecided; B never counted; nothing published',
        d.pendingStaged.map(e => [e.stagedTries, e.decided || null]).join('|') === '1,|0,' && d.pending.length === 0 && d.lastBackfill.decisionNotSaved.examples[0].outcome === 'mismatch', d.pendingStaged.map(e => [e.stagedTries, e.decided]));
      void before;
      const p2 = await child('P2');
      await p2.call({ cmd: 'init', url: p2.url });
      await p2.call({ cmd: 'publishStaged' });
      d = await doc();
      check('a correct process then measures and publishes both; nothing lost', d.pending.length === 2 && d.pending.every(e => e.undEntry === 500) && d.pendingStaged.length === 0);
    });

    await section('ALREADY DECIDED: two processes measured A; the FIRST saved decision is kept (never overwritten, never measured again) and the batch goes on', async () => {
      await fresh();
      const p1 = await child('P1'), p2 = await child('P2');
      await p1.call({ cmd: 'init', url: p1.url }); await p2.call({ cmd: 'init', url: p2.url });
      const entries = await twoStaged(p1);
      const watch = watchPartial(entries.map(e => e.qid));
      await p1.call({ cmd: 'market', behaviour: { 0: 'hang' }, price: 502 });
      await p2.call({ cmd: 'market', behaviour: { 0: 'hang', 1: 'hang' }, price: 501 });
      const j1 = p1.call({ cmd: 'batch', entries }).then(() => null, e => e);
      await waitFor(async () => measuredBy(p1, 0) === 1);
      const j2 = p2.call({ cmd: 'batch', entries }).then(() => null, e => e);
      await waitFor(async () => measuredBy(p2, 0) === 1);
      await p2.call({ cmd: 'release' });                               // P2 saves A (501), counts B, hangs on B
      await waitFor(async () => measuredBy(p2, 1) === 1);
      let d = await doc();
      check('set-up: P2 saved its decision for A first', d.pendingStaged[0].decided === 'result' && d.pendingStaged[0].undEntry === 501);
      await p1.call({ cmd: 'release' });                               // P1 hands in its own A (502)
      const e1 = await j1;
      d = await doc();
      check('P1 was told "already-decided" and CARRIED ON: it measured B and published the batch', e1 === null && measuredBy(p1, 1) === 1 && d.pending.length === 2, e1 && e1.message);
      check('A was published with P2\'s decision (501): the first saved decision was not overwritten by P1\'s (502)', d.pending.find(e => e.qid === entries[0].qid).undEntry === 501);
      check('B was published with P1\'s measurement; nothing staged', d.pending.find(e => e.qid === entries[1].qid).undEntry === 502 && d.pendingStaged.length === 0);
      await p2.call({ cmd: 'release' });
      const e2 = await j2;
      d = await doc();
      check('P2, finishing B late, stopped (B already published, "not-staged"); nothing published twice', e2 && /not-staged/.test(e2.message) && d.pending.length === 2, e2 && e2.message);
      check('the waiting list never showed part of the batch', (await watch()) === 0);
    });

    await section('Q-T14 (f) BROKEN COPIES: each must be CAUGHT by the mixed-batch check', async () => {
      const PRE = olderBuild(PRE_CORRECTION);
      const r1 = await poisonRuns(1, { build: PRE });
      console.log('     the PR\'s own pre-correction build (' + PRE_CORRECTION.slice(0, 7) + ', batch-wide count): ' + r1.history.join(' | '));
      check('the batch-wide guard (the PR\'s pre-correction build, run for real) FAILS: a healthy trade is measured twice or published unmeasured',
        !healthyOk(r1) && (r1.pub.A === 'unmeasured' || r1.measured.A > 1), { measured: r1.measured, pub: r1.pub });
      const r2 = await poisonRuns(1, { variant: 'forget-decisions' });
      console.log('     a guard that forgets saved decisions: ' + r2.history.join(' | '));
      check('a guard that FORGETS saved decisions FAILS: the healthy trade before X is measured twice', r2.measured.A > 1 && !healthyOk(r2), { measured: r2.measured, pub: r2.pub });
    });

    await section('Q-T14 (d) TWO PROCESSES START THE SAME BATCH AT ONCE: both starts counted (0, 1, 2)', async () => {
      await fresh();
      const a = await child('A'), b = await child('B');
      await a.call({ cmd: 'init', url: a.url }); await b.call({ cmd: 'init', url: b.url });
      await a.call({ cmd: 'market', behaviour: { 0: 'hang' } }); await b.call({ cmd: 'market', behaviour: { 0: 'hang' } });
      await a.call({ cmd: 'protect', update: 'staging', payload: { fills: fillsFor(1, 0) } });
      const entries = (await doc()).pendingStaged;
      const ha = holdFirstCommit(a.shim), hb = holdFirstCommit(b.shim);
      const pa = a.call({ cmd: 'batch', entries }), pb = b.call({ cmd: 'batch', entries });
      await ha.arrived; await hb.arrived;
      const ra = await ha.release(); const rb = await hb.release();
      await waitFor(async () => (await doc()).pendingStaged[0].stagedTries === 2);
      check('both read stagedTries 0; the first saved 1, the second was refused, re-read 1 and saved 2 -- never 0, 1, 1', ra === 'COMMITTED' && rb === 'CONFLICT' && (await doc()).pendingStaged[0].stagedTries === 2);
      // Both processes then END mid-measurement (as a crash would), so the
      // item is still staged, tried twice, for the next run.
      a.proc.send({ cmd: 'exit', id: 0 }); b.proc.send({ cmd: 'exit', id: 0 });
      await Promise.all([pa.catch(() => null), pb.catch(() => null), a.exitedP, b.exitedP]);
      const c = await child('C');
      await c.call({ cmd: 'init', url: c.url });
      await c.call({ cmd: 'publishStaged' });
      check('the next run abandons it (published unmeasured, not measured again)', (await doc()).lastBackfill.unmeasured.counts.abandoned === 1 && !c.events.some(e => e.event === 'measuring'));
    });

    await section('Q-T5 (a), (b) RESTARTS: after staging; then a reset before the resume', async () => {
      await fresh();
      let a = await child('A');
      await a.call({ cmd: 'init', url: a.url }); await a.call({ cmd: 'market', behaviour: { 0: 'exit' } });
      await a.call({ cmd: 'schwab', fills: fillsFor(3, 0) });
      a.call({ cmd: 'backfill' }).catch(() => {}); await a.exitedP;
      check('the process ended after staging, before publication: 3 staged, none visible', (await doc()).pendingStaged.length === 3 && (await doc()).pending.length === 0);
      a = await child('B');
      await a.call({ cmd: 'init', url: a.url });
      await a.call({ cmd: 'backfill' });
      let d = await doc();
      check('(a) after the restart the resume publishes every staged item exactly once; none lost', d.pending.length === 3 && new Set(d.pending.map(e => e.qid)).size === 3 && d.pendingStaged.length === 0);
      await fresh();
      a = await child('C');
      await a.call({ cmd: 'init', url: a.url }); await a.call({ cmd: 'market', behaviour: { 0: 'exit' } });
      await a.call({ cmd: 'schwab', fills: fillsFor(3, 0) });
      a.call({ cmd: 'backfill' }).catch(() => {}); await a.exitedP;
      a = await child('D');
      await a.call({ cmd: 'init', url: a.url });
      const r = await a.call({ cmd: 'protect', update: 'reset', opts: { acceptKinds: ['reset', 'reset-cancel'] } });
      await a.call({ cmd: 'backfill' });
      d = await doc();
      check('(b) restart, then a RESET before the resume: nothing published, both lists empty, the resume found nothing to do', r.status === 'committed' && d.pending.length === 0 && d.pendingStaged.length === 0 && !a.events.some(e => e.event === 'measuring'));
    });

    await section('Q-T5 (c) TWO MEASUREMENTS OF ONE STAGED ITEM, two real processes, both orders', async () => {
      for (const firstPublisher of ['B', 'A']) {
        await fresh();
        const a = await child('A'), b = await child('B');
        await a.call({ cmd: 'init', url: a.url }); await b.call({ cmd: 'init', url: b.url });
        await a.call({ cmd: 'protect', update: 'staging', payload: { fills: fillsFor(1, 0) } });
        const entries = (await doc()).pendingStaged;
        const slow = firstPublisher === 'B' ? a : b, quick = firstPublisher === 'B' ? b : a;
        await slow.call({ cmd: 'market', behaviour: { 0: 'hang' } });
        const ps = slow.call({ cmd: 'batch', entries });
        await waitFor(() => slow.events.some(e => e.event === 'measuring'));
        await quick.call({ cmd: 'batch', entries });
        await slow.call({ cmd: 'release' });
        const late = await ps.then(() => null, e => e);
        const d = await doc();
        // Since the second correction (25 Oct 2026) the late batch, whose own
        // decision can no longer be saved (its trade was published), STOPS and
        // records why, instead of finishing quietly as "not-staged".
        check(`${firstPublisher === 'B' ? 'the resume publishes first, the slow call second' : 'the slow call publishes first, the resume second'}: exactly ONE entry for the qid; the late batch STOPPED ("not-staged"), recorded its reason, and changed nothing else`,
          d.pending.filter(e => e.qid === entries[0].qid).length === 1 && d.pendingStaged.length === 0 && late && /not-staged/.test(late.message)
          && d.lastBackfill.decisionNotSaved && d.lastBackfill.decisionNotSaved.count === 1 && d.lastBackfill.decisionNotSaved.examples[0].qid === entries[0].qid, late && late.message);
        await killAll();
      }
    });

    await section('Q-T5 (d), Q-T23 (f) A PROCESS ENDING AT THE PUBLICATION\'S SAVE: before it, after it, and with its answer lost', async () => {
      for (const point of ['before the save', 'after the save returned', 'save sent, answer never received']) {
        await fresh();
        const a = await child('A');
        await a.call({ cmd: 'init', url: a.url });
        await a.call({ cmd: 'schwab', fills: fillsFor(3, 0) });
        let oldText = null;
        a.shim.hooks.before = async cmd => {
          if (scriptName(cmd, SCRIPTS) === 'COMMIT' && newestKind(cmd) === 'publication') {
            oldText = await text();
            if (point === 'before the save') { a.proc.send({ cmd: 'exit', id: 0 }); return { drop: true }; }
          }
        };
        a.shim.hooks.after = async (cmd, reply) => {
          if (scriptName(cmd, SCRIPTS) === 'COMMIT' && newestKind(cmd) === 'publication') {
            if (point === 'after the save returned') { setTimeout(() => a.proc.send({ cmd: 'exit', id: 0 }), 0); return undefined; }
            if (point === 'save sent, answer never received') { a.proc.send({ cmd: 'exit', id: 0 }); return { drop: true }; }
          }
        };
        a.call({ cmd: 'backfill' }).catch(() => {});
        await a.exitedP;
        const atEnd = await text();
        const wholly = atEnd === oldText || (JSON.parse(atEnd).stateVersion === JSON.parse(oldText).stateVersion + 1 && Object.values(JSON.parse(atEnd).opRecords).some(r => r.kind === 'publication' && r.committedVersion === JSON.parse(atEnd).stateVersion));
        const b = await child('B');
        await b.call({ cmd: 'init', url: b.url });
        await b.call({ cmd: 'backfill' });
        const d = await doc();
        const qids = [...d.pending, ...d.pendingStaged].map(e => e.qid);
        check(`${point}: the record was wholly the old one or wholly the new one; after the restart every item is published exactly once, never both, never neither`,
          !!oldText && wholly && d.pending.length === 3 && d.pendingStaged.length === 0 && new Set(qids).size === qids.length, { wholly, p: d.pending.length, s: d.pendingStaged.length });
        await killAll();
      }
    });

    await section('Q-T15 (g), (h) THE QUEUE IDENTITY: two processes recover it at once; a recovery whose answer is lost', async () => {
      const E = 'd'.repeat(32);
      const damaged = (() => {
        const d = require('./lib/gen2StandIn').expanded({ openLegs: [], pending: [], lastProcessedIds: [] });
        d.queueEpoch = E; delete d.queueSeq;                                      // C2: the counter is gone
        d.pendingStaged = [1, 2, 3].map(i => ({ id: 'S' + i, fills: ['s' + i, 't' + i], qid: E + '-' + i, stagedTries: 0 }));
        d.pending = [4, 5, 6].map(i => ({ id: 'V' + i, fills: ['v' + i, 'w' + i], qid: E + '-' + i }));
        return d;
      })();
      await fresh(damaged); await R.call('SET', FENCE, '2');
      const a = await child('A'), b = await child('B'), c = await child('C');
      for (const x of [a, b, c]) await x.call({ cmd: 'init', url: x.url });
      const ca = hex('candA'), cb = hex('candB');
      const ha = holdFirstCommit(a.shim), hb = holdFirstCommit(b.shim);
      const pa = a.call({ cmd: 'protect', update: 'landing', payload: { fills: fillsFor(1, 10) }, opts: { candidateEpoch: ca } });
      const pb = b.call({ cmd: 'protect', update: 'landing', payload: { fills: fillsFor(1, 11) }, opts: { candidateEpoch: cb } });
      await ha.arrived; await hb.arrived;
      const removals = [];
      for (const i of [4, 5]) removals.push(await c.call({ cmd: 'protect', update: 'qidRemoval', payload: { id: 'V' + i, pair: ['v' + i, 'w' + i], qid: E + '-' + i } }));
      await ha.release(); await hb.release();
      const [oa, ob] = await Promise.all([pa, pb]);
      removals.push(await c.call({ cmd: 'protect', update: 'qidRemoval', payload: { id: 'V4', pair: ['v4', 'w4'], qid: E + '-4' } }));
      const d = await doc();
      const text1 = JSON.stringify(d);
      const stored = [ca, cb].filter(x => text1.includes(x));
      const qids = [...d.pending, ...d.pendingStaged].map(e => e.qid);
      check('exactly ONE of the two candidates is stored anywhere; the other appears nowhere', stored.length === 1 && d.queueEpoch === stored[0], stored);
      check('both landings went through (one under the recovered identity, one continuing it)', oa.status === 'committed' && ob.status === 'committed');
      check('every old-qid removal answered "removed" (or "not-found" once gone) and removed only its own entry', removals[0].result.reason === 'removed' && removals[1].result.reason === 'removed' && removals[2].result.reason === 'not-found' && d.pending.some(e => e.id === 'V6'));
      check(`every qid is unique (${qids.length})`, new Set(qids).size === qids.length);
      // (h) a recovery whose answer is lost.
      await fresh(damaged); await R.call('SET', FENCE, '2');
      let n = 0; a.shim.hooks.after = async cmd => (scriptName(cmd, SCRIPTS) === 'COMMIT' && !n++ ? { drop: true } : undefined);
      const oh = await a.call({ cmd: 'protect', update: 'landing', payload: { fills: fillsFor(1, 12) }, opts: { candidateEpoch: hex('candH') } });
      a.shim.hooks = {};
      const dh = await doc();
      check('(h) the recovery lands, its answer is lost: the retry finds its record and returns the stored result VERBATIM -- the same new epoch and the same qid; nothing applied twice',
        oh.status === 'recovered' && dh.queueEpoch === hex('candH') && oh.result.landed[0].qid === hex('candH') + '-1' && dh.pending.filter(e => e.qid === hex('candH') + '-1').length === 1 && dh.queueSeq === 1, oh);
    });
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    await killAll();
    removeOlderBuilds();
    const stopped = await redis.stop();
    require('./lib/localRedis').reportStop(check, stopped);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
