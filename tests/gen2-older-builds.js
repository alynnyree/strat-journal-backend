// THE ROLLBACK BOUNDARY, WITH THE REAL OLDER BUILDS (Queue plan v14.1 rev 3.2,
// Deploy 2; plan v2 section 4). Every build here is a real process
// (tests/lib/olderChild.js) running a build written out of history,
// UNMODIFIED -- generation 1 = eb3880b (Deploy 1, main today), generation 0 =
// 6cb24a4 (main before Deploy 1) -- or this checkout (generation 2), each
// through its own stand-in of Upstash's web service in front of ONE local
// Redis, with the outside world (Schwab, the market) replaced.
//   Q-T11 (a)  generation 1 against the new record with the fence at 2: every
//              writer W1 to W7 refused, the record byte-identical, each
//              caller's failure path as 5.8.2 lists it
//   Q-T11 (b)  generation 0 against the new record: CHARACTERISATION only --
//              what it would destroy, which is why RB-2 forbids it
//   Q-T11 (c)  generation 1 against an unexpanded record with no fence: the
//              stored text after each writer equals generation 0's
//   Q-T15 (n)  the same decisions as today: generation 2's stored outcome,
//              apart from the new-schema fields, equals generation 1's
//   Q-T11 (d), (e)  the preserved-state report, read-only from the live
//              record; an empty staging list never marks a rollback safe
//   Q-T24 (g)  a failed deploy after the raise: generation 2 raises and ends
//              before expanding while generation 1 keeps running
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { startRedis, restShim, scriptName } = require('./lib/localRedis');
const { olderBuild, removeOlderBuilds, GEN1, GEN0 } = require('./lib/olderBuild');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 900)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } finally { await killAll(); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 10000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) return false; await sleep(5); } return true; };
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 10 * 60 * 1000).unref();

const BACKEND = path.join(__dirname, '..');
const Q = require(path.join(BACKEND, 'queueOps.js'));
const SCRIPTS = (() => { const m = require('fs').readFileSync(path.join(BACKEND, 'tradeStore.js'), 'utf8'); const out = {};
  for (const n of ['RAISE', 'COMMIT', 'RESOLUTION_READ', 'LOG']) { const x = new RegExp('const ' + n + ' = (\\[[\\s\\S]*?\\])\\.join').exec(m); out[n] = JSON.parse(x[1].replace(/,\s*\]$/, ']')).join('\n'); } return out; })();
const KEY = 'trades:state', FENCE = '{trades:state}:fence';
// A test-only key, made up for this run. Never the owner's.
const APP_KEY = 'test-only-' + crypto.randomBytes(9).toString('hex');
const CLOCK = '2026-10-24T15:00:00.000Z';
const T0 = Date.parse('2026-10-24T13:40:00Z');
const OCC = 'SPY   261231C00600000';
const fillsFor = (n, base) => {
  const out = [];
  for (let i = base; i < base + n; i++) for (const [kind, minute, id] of [['open', i * 10, 700000 + 2 * i], ['close', i * 10 + 5, 700000 + 2 * i + 1]]) {
    const t = T0 + minute * 60000; const d = new Date(t);
    out.push({ transactionId: String(id), accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL', instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66, date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: t });
  }
  return out;
};
// The record as today's main holds it (made-up values; no production data).
const BASE = () => ({ openLegs: [], pending: [{ id: 'WAITING-1', fills: ['111', '112'], contract: OCC }, { id: 'WAITING-2', fills: ['113', '114'], contract: OCC }],
  lastProcessedIds: ['111', '112', '113', '114'], exceptions: {} });

let redis = null, R = null, GEN1DIR = null, GEN0DIR = null;
const children = [], allShims = [];
async function child(name, build, { clock = null } = {}) {
  const shim = restShim(R); const url = await shim.listen(); allShims.push(shim);
  const proc = fork(path.join(__dirname, 'lib', 'olderChild.js'), [build], { silent: true });
  const c = { name, proc, shim, events: [], pending: new Map(), seq: 0, exited: false, err: '' };
  proc.stdout.on('data', () => {}); proc.stderr.on('data', d => { c.err += d; });
  proc.on('message', m => {
    if (m.event) { c.events.push(m); return; }
    const p = c.pending.get(m.id); if (!p) return; c.pending.delete(m.id);
    if (m.ok) p.res(m.value); else p.rej(new Error(m.error));
  });
  c.exitedP = new Promise(r => proc.on('exit', () => { c.exited = true; for (const p of c.pending.values()) p.rej(new Error(name + ' exited')); c.pending.clear(); r(); }));
  c.call = msg => new Promise((res, rej) => { if (c.exited) return rej(new Error(name + ' has exited')); const id = ++c.seq; c.pending.set(id, { res, rej }); proc.send({ ...msg, id }); });
  if (!(await waitFor(() => c.events.some(e => e.event === 'ready')))) throw new Error(name + ' did not start: ' + c.err.slice(0, 500));
  children.push(c);
  const init = await c.call({ cmd: 'init', url, key: APP_KEY, clock });
  c.port = init.port;
  c.http = async (method, p, { key = APP_KEY } = {}) => {
    const r = await fetch(`http://127.0.0.1:${c.port}${p}`, { method, headers: key ? { authorization: 'Bearer ' + key } : {} });
    let body = null; try { body = await r.json(); } catch (e) { /* not JSON */ }
    return { status: r.status, body };
  };
  return c;
}
async function killAll() {
  for (const c of children.splice(0)) { if (!c.exited) { c.proc.send({ cmd: 'exit', id: 0 }); await Promise.race([c.exitedP, sleep(3000)]); } }
  for (const s of allShims.splice(0)) await Promise.race([s.close(), sleep(1000)]);
}
const text = async () => R.call('GET', KEY);
const doc = async () => JSON.parse(await text());
const fence = async () => R.call('GET', FENCE);
async function fresh(record = BASE(), fenceValue) {
  await R.call('FLUSHALL');
  await R.call('SET', KEY, JSON.stringify(record));
  if (fenceValue !== undefined) await R.call('SET', FENCE, String(fenceValue));
}

// THE NEW RECORD, as a real generation-2 process leaves it: raised and
// expanded at start-up, a live sync landed (entries carrying a qid), then a
// history import staged its trades and the process ENDED mid-measurement --
// so the record holds visible tagged and untagged entries, staged entries,
// operation records and the counters. Returns its exact stored text.
async function newRecord() {
  await fresh(BASE(), '1');
  const g2 = await child('gen2', BACKEND);
  const st = await g2.call({ cmd: 'start' });
  if (!st.ready) throw new Error('generation 2 did not start: ' + JSON.stringify(st));
  await g2.call({ cmd: 'schwab', fills: fillsFor(2, 0) });
  await g2.call({ cmd: 'sync' });
  await g2.call({ cmd: 'schwab', fills: fillsFor(2, 4) });
  await g2.call({ cmd: 'hang', on: true });
  const was = await g2.call({ cmd: 'entered' });       // the sync's own measurements
  await g2.call({ cmd: 'backfillStart' });
  await waitFor(async () => (await g2.call({ cmd: 'entered' })) > was);
  await g2.call({ cmd: 'exit' }).catch(() => null);
  await g2.exitedP;
  const t = await text();
  if (!(JSON.parse(t).pendingStaged || []).length) throw new Error('set-up: the import had staged nothing when generation 2 ended');
  return t;
}
// "Apart from the new-schema fields": the nine the expansion adds, the two
// reset counters of 5.9.3 (S-R1, S-R5), and the staged count that 3.1 adds to
// lastBackfill. Each is named here; nothing else is set aside.
const LATER_NAMES = ['resetCounter', 'prunedResetThrough'];
const strip = d => {
  const o = { ...d };
  for (const n of Q.NEW_NAMES.concat(LATER_NAMES)) delete o[n];
  if (o.lastBackfill && typeof o.lastBackfill === 'object') { o.lastBackfill = { ...o.lastBackfill }; delete o.lastBackfill.stagedCount; }
  if (Array.isArray(o.pending)) o.pending = o.pending.map(e => { const x = { ...e }; delete x.qid; return x; });
  return o;
};
const firstDiff = (a, b) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i === n && a.length === b.length ? null : { at: i, a: a.slice(Math.max(0, i - 80), i + 120), b: b.slice(Math.max(0, i - 80), i + 120) }; };

(async () => {
  redis = await startRedis();
  if (!redis) {
    if (process.env.REQUIRE_REAL_REDIS === '1') { console.log('FAIL: no redis-server on this machine, and REQUIRE_REAL_REDIS=1'); process.exit(1); }
    console.log('SKIPPED: no redis-server on this machine (these checks need a real one)'); process.exit(0);
  }
  R = redis.client;
  GEN1DIR = olderBuild(GEN1); GEN0DIR = olderBuild(GEN0);
  check('the two older builds were written out of history (generation 1 = eb3880b, generation 0 = 6cb24a4)', !!GEN1DIR && !!GEN0DIR);

  await section('the new record, as a real generation-2 process leaves it', async () => {
    const t = await newRecord(); const d = JSON.parse(t);
    check('it is expanded (schemaVersion 2) and the fence reads 2', d.schemaVersion === 2 && (await fence()) === '2', { schemaVersion: d.schemaVersion });
    check('it holds tagged entries, untagged entries, staged entries and operation records',
      d.pending.some(e => Q.isTagged(e)) && d.pending.some(e => !Q.isTagged(e)) && d.pendingStaged.length > 0 && Object.keys(d.opRecords).length > 0,
      { pending: d.pending.map(e => [e.id, e.qid || null]), staged: d.pendingStaged.length, ops: Object.keys(d.opRecords).length });
  });

  // ---------------------------------------------------------------- Q-T11 (a)
  await section('Q-T11 (a): GENERATION 1 against the new record, fence at 2, every writer', async () => {
    const before = await newRecord();
    const g1 = await child('gen1', GEN1DIR);
    await g1.call({ cmd: 'schwab', fills: fillsFor(2, 10) });
    await g1.call({ cmd: 'sync' });
    const tok = await g1.call({ cmd: 'tokens' });
    check('W1 sync: the record is byte-identical (fills NOT marked processed)', (await text()) === before);
    check('W1 sync: the sign-in record\'s checkpoint did not move, so the fills are taken again later', tok.setCalls === 0, tok);
    const w = await g1.call({ cmd: 'writer' });
    check('W1 sync: generation 1 reports itself fenced', w && w.fenced === true, w);

    const rs = await g1.call({ cmd: 'reset' });
    check('W2 reset: refused "fenced", the record byte-identical', !rs.ok && rs.code === 'FENCED' && (await text()) === before, rs);
    const rr = await g1.http('POST', '/api/trades/reset');
    check('W2 reset route: answers that it could not be done (500 "Reset failed"); the record byte-identical',
      rr.status === 500 && rr.body && rr.body.error === 'Reset failed' && (await text()) === before, rr);

    await g1.call({ cmd: 'schwab', fills: fillsFor(2, 20) });
    await g1.call({ cmd: 'backfillStart' });
    const bf = await g1.call({ cmd: 'backfillResult' });
    check('W3 and W5, the history import: it fails "fenced", nothing staged, no progress note landed; the record byte-identical',
      !bf.ok && bf.code === 'FENCED' && (await text()) === before, bf);
    check('W3 and W5: the one-job-at-a-time guard was released', (await g1.call({ cmd: 'jobRunning' })) === null);

    for (const [label, q] of [['W7, removal by id and pair', '?fills=111,112'], ['W6, removal by id only', '']]) {
      const r = await g1.http('DELETE', '/api/trades/pending/WAITING-1' + q);
      check(`${label}: answers an error, not success; the entry stays, the record byte-identical`, r.status === 500 && (await text()) === before, r);
    }
    const tagged = JSON.parse(before).pending.find(e => Q.isTagged(e));
    const r2 = await g1.http('DELETE', `/api/trades/pending/${encodeURIComponent(tagged.id)}?fills=${tagged.fills.join(',')}`);
    check('W7 on an entry generation 2 tagged: refused the same way', r2.status === 500 && (await text()) === before, r2);
    check('after all of it the fence still reads 2', (await fence()) === '2');
  });

  await section('Q-T11 (a), W4: generation 1\'s refreshWaiting, fenced part-way through its import', async () => {
    await fresh(BASE(), '1');
    const g1 = await child('gen1', GEN1DIR);
    await g1.call({ cmd: 'schwab', fills: fillsFor(2, 30) });
    await g1.call({ cmd: 'hang', on: true });
    await g1.call({ cmd: 'backfillStart' });
    const reached = await waitFor(async () => (await g1.call({ cmd: 'entered' })) > 0);
    const staged = (await doc()).pending.length === 4;
    const g2 = await child('gen2', BACKEND);
    const st = await g2.call({ cmd: 'start' });
    const atRaise = await text();
    await g1.call({ cmd: 'release' });
    const bf = await g1.call({ cmd: 'backfillResult' });
    check('the case happened: generation 1 had staged its trades and was mid-measurement when generation 2 raised and expanded',
      reached && staged && st.ready === true && JSON.parse(atRaise).schemaVersion === 2, { reached, staged, st });
    check('W4: the refresh after the raise is refused; the run fails "fenced"', !bf.ok && bf.code === 'FENCED', bf);
    check('W4: the record is exactly as generation 2 left it (no refresh, no progress note landed after the raise)', (await text()) === atRaise);
  });

  // ---------------------------------------------------------------- Q-T11 (b)
  await section('Q-T11 (b): GENERATION 0 against the new record (CHARACTERISATION, test keys only; not a pass condition for any build)', async () => {
    const before = await newRecord();
    const g0 = await child('gen0', GEN0DIR);
    const rr = await g0.http('POST', '/api/trades/reset');
    const after = await doc();
    const dropped = Q.NEW_NAMES.filter(n => !(n in after));
    console.log('     recorded: generation 0\'s reset answered', rr.status, 'and dropped', JSON.stringify(dropped));
    check('RECORDED: generation 0 ignores the fence; its reset DROPS all nine new-schema fields', rr.status === 200 && dropped.length === 9 && JSON.stringify(dropped) === JSON.stringify(Q.NEW_NAMES), { status: rr.status, dropped });

    await R.call('SET', KEY, before);
    const newer = JSON.parse(before);
    await g0.call({ cmd: 'save', doc: BASE() });
    check('RECORDED: generation 0\'s plain save overwrites a newer record wholesale (stateVersion, staged trades and qids gone)',
      (await text()) === JSON.stringify(BASE()) && newer.stateVersion > 0, { stateVersionLost: newer.stateVersion });

    await fresh(BASE(), '2');
    const g0b = await child('gen0b', GEN0DIR);
    await g0b.call({ cmd: 'schwab', fills: fillsFor(1, 40) });
    await g0b.call({ cmd: 'hang', on: true });
    await g0b.call({ cmd: 'backfillStart' });
    await waitFor(async () => (await g0b.call({ cmd: 'entered' })) > 0);
    const d = await doc();
    const mine = d.pending.find(e => !['WAITING-1', 'WAITING-2'].includes(e.id));
    mine.qid = '0123456789abcdef0123456789abcdef-1';     // as a generation-2 tag would carry
    await R.call('SET', KEY, JSON.stringify(d));
    await g0b.call({ cmd: 'release' });
    await g0b.call({ cmd: 'backfillResult' });
    const e2 = (await doc()).pending.find(e => e.id === mine.id);
    check('RECORDED: generation 0\'s refreshWaiting replaces a tagged entry with a copy WITHOUT its qid', !!e2 && !('qid' in e2), e2 && Object.keys(e2));
  });

  // ---------------------------------------------------------------- Q-T11 (c)
  const WRITERS = [
    ['W1 sync', async c => { await c.call({ cmd: 'schwab', fills: fillsFor(2, 50) }); await c.call({ cmd: 'sync' }); }],
    ['W2 reset', async c => { await c.call({ cmd: 'reset', args: { requestId: crypto.randomBytes(16).toString('hex') } }); }],
    ['W3, W4 and W5, the history import', async c => { await c.call({ cmd: 'schwab', fills: fillsFor(3, 60) }); await c.call({ cmd: 'backfillStart' }); await c.call({ cmd: 'backfillResult' }); }],
    ['W6 removal by id', async c => { await c.http('DELETE', '/api/trades/pending/WAITING-1'); }],
    ['W7 removal by id and pair', async c => { await c.http('DELETE', '/api/trades/pending/WAITING-2?fills=113,114'); }],
  ];
  await section('Q-T11 (c): GENERATION 1 against an UNEXPANDED record, no fence: the stored text equals generation 0\'s', async () => {
    for (const [label, run] of WRITERS) {
      await fresh(BASE());
      const g0 = await child('gen0', GEN0DIR, { clock: CLOCK });
      await run(g0);
      const t0 = await text();
      await killAll();
      await fresh(BASE());
      const g1 = await child('gen1', GEN1DIR, { clock: CLOCK });
      await run(g1);
      const t1 = await text();
      check(`${label}: the record changed (so the comparison is not of two no-ops)`, t1 !== JSON.stringify(BASE()));
      check(`${label}: generation 1's stored text equals generation 0's, byte for byte`, t1 === t0, firstDiff(t0, t1));
      check(`${label}: no fence was created`, (await fence()) === null);
      await killAll();
    }
  });

  // ---------------------------------------------------------------- Q-T15 (n)
  await section('Q-T15 (n): THE SAME DECISIONS AS TODAY: generation 2 against generation 1, same record, same moment', async () => {
    console.log('     (W9 to W12 exist only on PR #94\'s head and are not part of this build; they are compared when that change is.)');
    for (const [label, run] of WRITERS) {
      await fresh(BASE());
      const g1 = await child('gen1', GEN1DIR, { clock: CLOCK });
      await run(g1);
      const t1 = await text();
      await killAll();
      await fresh(BASE(), '1');
      const g2 = await child('gen2', BACKEND, { clock: CLOCK });
      const st = await g2.call({ cmd: 'start' });
      await run(g2);
      const d2 = await doc();
      const s2 = JSON.stringify(strip(d2)), s1 = JSON.stringify(strip(JSON.parse(t1)));
      check(`${label}: generation 2 was ready and its write landed, changing the record's old fields (not a comparison of two no-ops)`,
        st.ready === true && d2.stateVersion >= 2 && s2 !== JSON.stringify(strip(BASE())), { st, stateVersion: d2.stateVersion });
      check(`${label}: apart from the new-schema fields, generation 2's stored outcome equals generation 1's, byte for byte`, s2 === s1, firstDiff(s1, s2));
      if (label === 'W3, W4 and W5, the history import') check(`${label}: nothing is left staged`, d2.pendingStaged.length === 0, d2.pendingStaged.length);
      if (label === 'W1 sync' || label === 'W3, W4 and W5, the history import') {
        const fresh2 = d2.pending.filter(e => !['WAITING-1', 'WAITING-2'].includes(e.id));
        check(`${label}: and every new entry generation 2 wrote carries a qid`, fresh2.length > 0 && fresh2.every(e => Q.isQid(e.qid)), fresh2.map(e => e.qid || null));
      }
      await killAll();
    }
  });

  // ------------------------------------------------------------ Q-T11 (d), (e)
  await section('Q-T11 (d), (e): THE PRESERVED-STATE REPORT, read-only from the live record', async () => {
    const before = await newRecord();
    const g2 = await child('gen2', BACKEND);
    const calls0 = g2.shim.log.length;
    const r1 = await g2.call({ cmd: 'report' });
    const d = JSON.parse(before);
    check('(d) it reads the fence, schemaVersion, stateVersion and staged count from the live record',
      r1.fence === '2' && r1.schemaVersion === 2 && r1.stateVersion === d.stateVersion && r1.stagedCount === d.pendingStaged.length && r1.stagedCount > 0, r1);
    check('(d) and the untagged counts and the count of damaged records',
      r1.untagged.visible === Q.untaggedCounts(d).visible && r1.untagged.staged === Q.untaggedCounts(d).staged && r1.damagedRecords === 0, r1);
    const sent = g2.shim.log.slice(calls0);
    check('(d) it is read-only: only the read script and GET reached the store', sent.length > 0 && sent.every(c => scriptName(c, SCRIPTS) === 'RESOLUTION_READ' || String(c[0]).toLowerCase() === 'get'), sent.map(c => scriptName(c, SCRIPTS) || c[0]));
    check('(d) the record is byte-identical after it', (await text()) === before);
    check('(e) with the fence at 2 it says a rollback to generation 0 or 1 is NOT SAFE', /^NOT SAFE/.test(r1.rollback), r1.rollback);

    const empty = JSON.parse(before);
    empty.pendingStaged = []; empty.stateVersion += 1;
    const op = Object.keys(empty.opRecords)[0]; empty.opRecords[op] = { ...empty.opRecords[op], check: '0'.repeat(64) };
    await R.call('SET', KEY, JSON.stringify(empty));
    const r2 = await g2.call({ cmd: 'report' });
    check('(d) it reads LIVE: a changed record gives the changed figures, not a remembered one',
      r2.stateVersion === empty.stateVersion && r2.stagedCount === 0 && r2.damagedRecords === 1, r2);
    check('(e) stagedCount = 0 alone NEVER marks the rollback safe: still NOT SAFE with an empty staging list', r2.stagedCount === 0 && /^NOT SAFE/.test(r2.rollback), r2.rollback);
    const saysSafe = r => /safe/i.test(JSON.stringify(r).replace(/NOT SAFE/g, '').replace(/Whether a rollback is safe is decided by plan 5\.4, never by this report/g, ''));
    check('(e) nothing in the report says a rollback is safe', !saysSafe(r1) && !saysSafe(r2), r2);

    await R.call('DEL', FENCE);
    const r3 = await g2.call({ cmd: 'report' });
    check('(e) even with no fence it never says a rollback is safe; that is decided by plan 5.4', r3.fence === 'absent' && !/^NOT SAFE/.test(r3.rollback) && /never by this report/.test(r3.rollback) && !saysSafe(r3), r3.rollback);
    await R.call('SET', FENCE, '2');

    const viaRoute = await g2.http('GET', '/api/queue/status');
    check('the route behind the app key gives the same report', viaRoute.status === 200 && viaRoute.body.fence === '2' && viaRoute.body.stagedCount === 0, viaRoute);
    const noKey = await g2.http('GET', '/api/queue/status', { key: null });
    check('without the app key the route refuses', noKey.status === 401 || noKey.status === 403, noKey.status);
  });

  // ---------------------------------------------------------------- Q-T24 (g)
  await section('Q-T24 (g): A FAILED DEPLOY AFTER THE RAISE: generation 2 raises, then ends before expanding, generation 1 keeps running', async () => {
    await fresh(BASE(), '1');
    const before = await text();
    const g1 = await child('gen1', GEN1DIR);
    const g2 = await child('gen2', BACKEND);
    g2.shim.hooks.before = cmd => (scriptName(cmd, SCRIPTS) === 'COMMIT' ? new Promise(() => {}) : undefined);
    g2.call({ cmd: 'start' }).catch(() => null);
    const raised = await waitFor(async () => (await fence()) === '2' && g2.shim.log.some(c => scriptName(c, SCRIPTS) === 'COMMIT'));
    await g2.call({ cmd: 'exit' }).catch(() => null);
    await g2.exitedP;
    check('the case happened: the fence reads 2, the expansion never committed, generation 2 has ended',
      raised && g2.exited && (await text()) === before && JSON.parse(before).schemaVersion === undefined);
    await g1.call({ cmd: 'schwab', fills: fillsFor(2, 70) });
    await g1.call({ cmd: 'sync' });
    const rs = await g1.call({ cmd: 'reset' });
    const rr = await g1.http('POST', '/api/trades/reset');
    const rd = await g1.http('DELETE', '/api/trades/pending/WAITING-1?fills=111,112');
    await g1.call({ cmd: 'schwab', fills: fillsFor(2, 80) });
    await g1.call({ cmd: 'backfillStart' });
    const bf = await g1.call({ cmd: 'backfillResult' });
    check('generation 1 saves NOTHING: sync, reset, reset route, removal and history import all refused',
      !rs.ok && rs.code === 'FENCED' && rr.status === 500 && rd.status === 500 && !bf.ok && bf.code === 'FENCED', { rs, rr: rr.status, rd: rd.status, bf });
    check('the record is byte-identical to before the raise', (await text()) === before);
    const health = await g1.http('GET', '/health');
    check('generation 1\'s /health reports "fenced"', health.status === 200 && health.body.writer && health.body.writer.fenced === true && health.body.writer.generation === 1, health.body && health.body.writer);
    check('the fence still reads 2 (nothing lowers it)', (await fence()) === '2');
  });

  removeOlderBuilds();
  const stopped = await redis.stop();
  require('./lib/localRedis').reportStop(check, stopped);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.log('FAIL: TEST CRASHED', e && e.stack || e); await killAll(); removeOlderBuilds(); if (redis) await redis.stop(); process.exit(1); });
