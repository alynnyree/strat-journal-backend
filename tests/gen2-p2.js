// P2, QUEUE ONLY AFTER MEASUREMENT (Queue plan v14.1 rev 3.2, section 3;
// Deploy 2), with the REAL import code (cron.js) and save module against a
// real Redis on this machine (tests/lib/gen2Harness.js), and a stand-in
// market whose answers the test controls trade by trade.
//
//   Q-T1   a 60-trade import: the waiting list, polled throughout, never shows
//          an item whose batch is unfinished; each item appears once and is
//          never replaced (Q-T9, the runtime half); the waits are REPORTED.
//   Q-T4   a measurement that fails is still published, unmeasured, under its
//          reason, and is never measured again.
//   Q-T6   the per-trade wait limit with a CONTROLLED timer: (a)-(h), and the
//          broken copies of (e).
//   Q-T7   a batch that finishes after a reset publishes nothing.
//   I4     (the poison-guard correction of 25 Oct 2026) no measurement starts
//          on a count whose outcome is unknown.
//   Q-T2, Q-T3  CHARACTERISATION of the harm on the REAL generation-1 build
//          (eb3880b, which still queues before measuring), then the same
//          scenario on generation 2: nothing lost.
// Process restarts (Q-T5, Q-T14) are tests/gen2-processes.js.
const Module = require('module');
const path = require('path');
const { setUp } = require('./lib/gen2Harness');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The kind of the change a COMMIT carries: its NEWEST record (older records
// stay in the record for an hour, so a text search would find them too).
const newKind = cmd => { const d = JSON.parse(cmd[6]); const r = Object.values(d.opRecords).find(x => x.committedVersion === d.stateVersion); return r && r.kind; };
const waitFor = async (cond, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) return false; await sleep(2); } return true; };
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 6 * 60 * 1000).unref();

// ---- The stand-in market and Schwab. A trade is known by its entry time.
const T0 = Date.parse('2026-10-20T14:00:00Z');
const OCC = 'SPY   261231C00600000';
const fillsFor = (n, base = 0) => {
  const out = [];
  for (let i = base; i < base + n; i++) {
    for (const [kind, minute, id] of [['open', i * 10, 800000 + 2 * i], ['close', i * 10 + 5, 800000 + 2 * i + 1]]) {
      const ts = T0 + minute * 60000; const d = new Date(ts);
      out.push({ transactionId: String(id), accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL',
        instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66,
        date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts });
    }
  }
  return out;
};
const indexOfTs = ts => Math.floor((ts - T0) / 60000 / 10);
const market = {
  behaviour: new Map(),      // trade index -> 'ok' | 'throw' | 'hang' | {gate, mutate}
  starts: new Map(),         // trade index -> times its measurement was asked
  hung: [],                  // promises' resolvers of hanging calls
  async price(ts) {
    const i = indexOfTs(ts);
    const isEntry = ((ts - T0) / 60000) % 10 === 0;
    if (isEntry) market.starts.set(i, (market.starts.get(i) || 0) + 1);
    const b = market.behaviour.get(i) || 'ok';
    if (isEntry && b === 'throw') throw null;               // escapes the step's own catch (err.message of null)
    if (isEntry && b === 'hang') await new Promise(r => market.hung.push(r));
    if (isEntry && b && typeof b === 'object' && b.gate) await b.gate;
    await sleep(1);
    return 500;
  },
};
const schwab = { answers: [] };
const stubs = {
  './schwabClient': { getOptionFills: async (tok, from, to, report) => {
    if (report) Object.assign(report, { accountFound: true, windowsAsked: 1, windowsOk: 1, windowsFailed: 0, failures: [], oldestWindowWithData: null });
    return JSON.parse(JSON.stringify(schwab.answers.length ? schwab.answers.shift() : []));
  } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': { getUnderlyingPriceAt: async (tok, ticker, ts) => market.price(ts),
    getFtfcForTrade: async () => ({ timeframes: { '1D': 'BULLISH' }, runLength: 4, confirmed: true, direction: 'BULLISH', timeframesInRun: ['1D'] }) },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
};

(async () => {
  const h = await setUp({ stubs });
  if (!h) { console.log('SKIPPED: no redis-server on this machine.\n\n0 passed, 0 failed'); process.exit(0); }
  const { tradeStore: ts, Q, shim } = h;
  const cron = require(path.join(h.BACKEND, 'cron.js'));
  const fresh = async () => { market.behaviour.clear(); market.starts.clear(); market.hung.length = 0; schwab.answers = []; await h.ready(); };
  const measured = e => e.undEntry === 500 && e.ftfcConfirmed === true;
  try {
    await section('Q-T1 A 60-TRADE IMPORT, POLLED THROUGHOUT (and Q-T9, the runtime half)', async () => {
      await fresh();
      schwab.answers.push(fillsFor(60));
      const decisions = [];
      cron.P2_EVENTS.observe = ev => decisions.push({ ...ev, at: Date.now() });
      const publications = [];
      shim.hooks.after = async (cmd, reply) => { if (h.scriptOf(cmd) === 'COMMIT' && reply === 'COMMITTED' && newKind(cmd) === 'publication') publications.push(Date.now()); };
      const t0 = Date.now();
      let done = false, polls = 0, unmeasuredSeen = 0, firstSeen = null;
      const seen = new Map();   // id -> the text it was first seen with
      let replaced = 0, duplicates = 0;
      const job = cron.runBackfill(30).then(() => { done = true; });
      while (!done) {
        const st = await ts.getState(); polls++;
        const ids = new Set();
        for (const e of st.pending || []) {
          if (ids.has(e.id)) duplicates++; ids.add(e.id);
          if (!measured(e)) unmeasuredSeen++;
          const text = JSON.stringify(e);
          if (!seen.has(e.id)) { seen.set(e.id, text); if (firstSeen === null) firstSeen = Date.now() - t0; } else if (seen.get(e.id) !== text) replaced++;
        }
        await sleep(5);
      }
      await job;
      cron.P2_EVENTS.observe = null; shim.hooks = {};
      const st = await h.doc();
      check(`${polls} polls during the import: no item was ever visible unmeasured (${unmeasuredSeen})`, polls > 5 && unmeasuredSeen === 0);
      check(`each item appeared exactly once, and once visible was never replaced (duplicates ${duplicates}, replaced ${replaced})`, duplicates === 0 && replaced === 0);
      check('all 60 published, measured, each with its own qid; nothing left staged', st.pending.length === 60 && st.pending.every(measured) && new Set(st.pending.map(e => e.qid)).size === 60 && st.pendingStaged.length === 0);
      check('published in groups of up to 25 (three publications for 60)', publications.length === 3, publications.length);
      const waits = decisions.map(d => d.waitedMs);
      console.log(`     REPORTED: first group visible after ${firstSeen} ms; batches published at ${publications.map(p => p - t0).join(', ')} ms;`);
      console.log(`     REPORTED: ${decisions.length} decisions, all "${[...new Set(decisions.map(d => d.decision))].join('/')}"; waits min ${Math.min(...waits)} ms, max ${Math.max(...waits)} ms (stand-in market; no bound asserted)`);
      check('every trade\'s decision and wait were recorded (60)', decisions.length === 60);
    });

    await section('Q-T4 A MEASUREMENT THAT FAILS: still published, unmeasured, under its reason; never measured again', async () => {
      await fresh();
      market.behaviour.set(1, 'throw');
      schwab.answers.push(fillsFor(3));
      await cron.runBackfill(30);
      const st = await h.doc();
      const bad = st.pending.find(e => e.entryTimestamp === T0 + 10 * 60000);
      check('the failing trade is published, with whatever was obtained and no measurement', bad && !measured(bad) && st.pending.length === 3, bad);
      check('its reason "failed" is recorded in lastBackfill.unmeasured', st.lastBackfill.unmeasured && st.lastBackfill.unmeasured.counts.failed === 1, st.lastBackfill.unmeasured);
      const asked = market.starts.get(1);
      schwab.answers.push(fillsFor(3));
      await cron.runBackfill(30);
      check('a later import does not measure it again (its fills are processed; it is not staged)', market.starts.get(1) === asked && (await h.doc()).pending.length === 3);
    });

    // ---- Q-T6, with a CONTROLLED timer: only the timer whose delay is the
    // sentinel ITEM_WAIT is held here; every other timer is the real one.
    const SENTINEL = 987654;
    const realST = global.setTimeout, realCT = global.clearTimeout, realNow = Date.now;
    const held = [];
    let offset = 0;
    const controlTimers = on => {
      if (on) {
        cron.ITEM_WAIT.ms = SENTINEL;
        global.setTimeout = function (fn, ms, ...a) { if (ms === SENTINEL) { const t = { fn, cleared: false, fired: false }; held.push(t); return t; } return realST(fn, ms, ...a); };
        global.clearTimeout = function (t) { if (t && held.includes(t)) { t.cleared = true; return undefined; } return realCT(t); };
        Date.now = () => realNow() + offset;
      } else {
        global.setTimeout = realST; global.clearTimeout = realCT; Date.now = realNow; cron.ITEM_WAIT.ms = 90 * 1000; held.length = 0; offset = 0;
      }
    };
    const fireLatest = () => { const t = held.filter(x => !x.cleared && !x.fired).pop(); if (t) { t.fired = true; t.fn(); } return !!t; };

    await section('Q-T6 (a), (b) ONE TRADE NEVER ANSWERS: decided "timed-out", THEN published; a late answer changes nothing', async () => {
      await fresh();
      market.behaviour.set(1, 'hang');
      schwab.answers.push(fillsFor(3));
      const order = [];
      cron.P2_EVENTS.observe = ev => order.push('decision:' + ev.decision);
      shim.hooks.after = async (cmd, reply) => { if (h.scriptOf(cmd) === 'COMMIT' && reply === 'COMMITTED' && newKind(cmd) === 'publication') order.push('publication'); };
      controlTimers(true);
      const job = cron.runBackfill(30);
      const hanging = await waitFor(() => market.hung.length === 1 && held.some(t => !t.cleared && !t.fired));
      offset += SENTINEL;
      const fired = fireLatest();
      await job;
      controlTimers(false); cron.P2_EVENTS.observe = null; shim.hooks = {};
      const st = await h.doc();
      const slow = st.pending.find(e => e.entryTimestamp === T0 + 10 * 60000);
      check('the controlled timer ran and recorded "timed-out"', hanging && fired && order.includes('decision:timed-out'));
      check('ORDER: the decision was recorded, THEN the publication (no wall-clock time asserted)', order.indexOf('decision:timed-out') < order.indexOf('publication'), order);
      check('it is published unmeasured with reason "timed-out"; the rest of its batch normally, in the same write',
        slow && !measured(slow) && st.pending.filter(measured).length === 2 && st.lastBackfill.unmeasured.counts['timed-out'] === 1 && order.filter(x => x === 'publication').length === 1);
      const before = await h.text();
      market.hung.forEach(r => r()); await sleep(100);
      check('(b) the slow call answers afterwards: the stored record byte-identical, no second entry', (await h.text()) === before);
    });

    await section('Q-T6 (c) THE ONE DECISION, both orders, driven deterministically', async () => {
      await fresh();
      const staged = { id: 'X', qid: 'a'.repeat(32) + '-1', entryTimestamp: T0 + 50 * 60000, exitTimestamp: T0 + 55 * 60000, ticker: 'SPY' };
      for (const order of ['result-then-timer', 'timer-then-result']) {
        let open; const gate = new Promise(r => { open = r; });
        market.behaviour.set(5, { gate });
        const decisions = [];
        cron.P2_EVENTS.observe = ev => decisions.push(ev.decision);
        controlTimers(true);
        const p = cron.enrichOne('tok', staged);
        await waitFor(() => held.length > 0);
        const t = held[held.length - 1];
        if (order === 'result-then-timer') { open(); await waitFor(() => decisions.length > 0); t.fn(); }
        else { offset += SENTINEL; t.fn(); open(); }
        const r = await p; await sleep(20);
        controlTimers(false); cron.P2_EVENTS.observe = null;
        const want = order === 'result-then-timer' ? 'result' : 'timed-out';
        check(`${order}: the decision is "${want}", recorded ONCE, and the other callback does nothing`, r.decision === want && decisions.length === 1 && decisions[0] === want, decisions);
      }
    });

    await section('Q-T6 (d) A BATCH WHERE EVERY TRADE TIMES OUT (controlled clock): 25 x ITEM_WAIT, then the next batch', async () => {
      await fresh();
      for (let i = 0; i < 26; i++) market.behaviour.set(i, i < 25 ? 'hang' : 'ok');
      schwab.answers.push(fillsFor(26));
      const waits = [];
      cron.P2_EVENTS.observe = ev => waits.push(ev);
      controlTimers(true);
      const job = cron.runBackfill(30);
      for (let k = 0; k < 25; k++) {
        await waitFor(() => market.hung.length === k + 1 && held.some(t => !t.cleared && !t.fired));
        offset += SENTINEL; fireLatest();
      }
      await job;
      controlTimers(false); cron.P2_EVENTS.observe = null;
      const first25 = waits.slice(0, 25);
      const sum = first25.reduce((a, w) => a + w.waitedMs, 0);
      check(`its waiting sums to 25 x ITEM_WAIT of that clock (${sum} against ${25 * SENTINEL}, plus processing time only)`,
        first25.every(w => w.decision === 'timed-out' && w.waitedMs >= SENTINEL) && sum >= 25 * SENTINEL && sum < 25 * SENTINEL + 25 * 2000);
      check('and the next batch started: the 26th trade was measured and published', waits.length === 26 && waits[25].decision === 'result' && (await h.doc()).pending.filter(measured).length === 1);
      market.hung.forEach(r => r());
    });

    await section('Q-T6 (e) BROKEN COPIES are caught by the same checks', async () => {
      // No limit: the decision never comes.
      const noLimit = () => new Promise(() => {});
      const r = await Promise.race([noLimit(), sleep(200).then(() => 'still waiting')]);
      check('a copy that waits WITHOUT a limit never decides on a hung call (caught by (a))', r === 'still waiting');
      // Both callbacks act: two decisions.
      const both = []; const bothCopy = (fireTimer, fireResult) => { fireTimer(() => both.push('timed-out')); fireResult(() => both.push('result')); };
      bothCopy(f => f(), f => f());
      check('a copy that lets both callbacks act records two decisions (caught by (c))', both.length === 2);
      // A late answer written: the stored record would change after publication.
      await fresh();
      const before = await h.text();
      await ts.protect('progress', Q.progressUpdate, { payload: { lateAnswer: 1 } });
      check('a copy that writes a late answer changes the stored record after publication (caught by (b))', (await h.text()) !== before);
    });

    await section('Q-T6 (f), (h) OWN COPY; NO CANCELLATION IS CLAIMED', async () => {
      await fresh();
      let lateMutate = null;
      market.behaviour.set(0, 'hang');
      schwab.answers.push(fillsFor(2));
      controlTimers(true);
      const job = cron.runBackfill(30);
      await waitFor(() => market.hung.length === 1 && held.some(t => !t.cleared && !t.fired));
      const stagedBefore = JSON.stringify((await h.doc()).pendingStaged);
      offset += SENTINEL; fireLatest();
      await job;
      controlTimers(false);
      const st = await h.doc();
      const published = JSON.stringify(st.pending.find(e => e.entryTimestamp === T0));
      // The hung call now answers, and the step goes on to change ITS copy.
      market.hung.forEach(r => r()); await sleep(100);
      void lateMutate;
      check('(f) the late call changes only its own copy: the published entry and the record are unchanged', JSON.stringify((await h.doc()).pending.find(e => e.entryTimestamp === T0)) === published && stagedBefore.includes('"stagedTries":1'));
      const fs = require('fs');
      const src = fs.readFileSync(path.join(h.BACKEND, 'cron.js'), 'utf8');
      check('(h) nothing in the code claims to stop or cancel a measurement (no abort signal, no "cancelled")',
        !/AbortController|abort\(|cancell?ed the (call|request|enrichment)/i.test(src.slice(src.indexOf('P2, QUEUE ONLY AFTER MEASUREMENT'), src.indexOf('W5, THE HISTORY IMPORT'))));
      check('(h) the recorded reason is "timed-out", a wait that ended, not a call that was stopped', st.lastBackfill.unmeasured.counts['timed-out'] === 1);
    });

    await section('Q-T6 (g) A DELAYED TIMER: whichever callback RUNS first decides', async () => {
      await fresh();
      const staged = { id: 'Y', qid: 'b'.repeat(32) + '-1', entryTimestamp: T0 + 60 * 60000, exitTimestamp: T0 + 65 * 60000, ticker: 'SPY' };
      for (const first of ['result', 'timer']) {
        let open; const gate = new Promise(r => { open = r; });
        market.behaviour.set(6, { gate });
        const decisions = [];
        cron.P2_EVENTS.observe = ev => decisions.push(ev);
        controlTimers(true);
        const p = cron.enrichOne('tok', staged);
        await waitFor(() => held.length > 0);
        const t = held[held.length - 1];
        offset += 2 * SENTINEL;                              // the clock is past the threshold, the timer held back
        if (first === 'result') { open(); await waitFor(() => decisions.length > 0); t.fn(); } else { t.fn(); open(); }
        const r = await p; await sleep(20);
        controlTimers(false); cron.P2_EVENTS.observe = null;
        check(first === 'result' ? 'the result runs BEFORE the delayed timer: "result", once, with its measured wait past the threshold; the late timer does nothing'
          : 'the delayed timer runs BEFORE the result: "timed-out", once; the result does nothing',
          decisions.length === 1 && r.decision === (first === 'result' ? 'result' : 'timed-out') && (first !== 'result' || decisions[0].waitedMs > SENTINEL), decisions);
      }
    });

    await section('Q-T7 A BATCH THAT FINISHES AFTER A RESET publishes nothing and records "not-staged"', async () => {
      await fresh();
      let open; const gate = new Promise(r => { open = r; });
      market.behaviour.set(0, { gate });
      schwab.answers.push(fillsFor(2));
      const job = cron.runBackfill(30);
      await waitFor(() => market.starts.get(0) === 1);
      // A reset from ANOTHER process (this one is busy with the import, and a
      // reset never waits behind it): straight through THE COMMIT.
      const rs = await ts.protect('reset', Q.resetUpdate, { acceptKinds: ['reset', 'reset-cancel'] });
      open();
      await job;
      const st = await h.doc();
      check('the reset committed while the batch was being measured; afterwards nothing was published, both lists are empty',
        rs.status === 'committed' && st.pending.length === 0 && st.pendingStaged.length === 0, { rs: rs.status, p: st.pending.length });
      check('the batch\'s qids were noted "not-staged"', st.lastBackfill && st.lastBackfill.notStaged && st.lastBackfill.notStaged.count === 2, st.lastBackfill);
    });

    await section('I4 (the correction of 25 Oct 2026): NO MEASUREMENT ON A COUNT WHOSE OUTCOME IS UNKNOWN', async () => {
      // (1) The counting commit lands but its answer is lost; the save resolves
      // it ("recovered") and only THEN may the measurement start.
      await fresh();
      let st = await ts.protect('staging', cron.stagingUpdate(fillsFor(2, 70)));
      const entries = st.out.staged;
      const seq = [];
      let dropped = false;
      const orig = market.price;
      market.price = async t => { if (((t - T0) / 60000) % 10 === 0) seq.push('measuring ' + indexOfTs(t)); return orig(t); };
      shim.hooks.before = async cmd => { if (dropped && h.scriptOf(cmd) === 'RESOLUTION_READ') seq.push('resolution read'); };
      shim.hooks.after = async (cmd, reply) => { if (!dropped && h.scriptOf(cmd) === 'COMMIT' && reply === 'COMMITTED' && newKind(cmd) === 'poison-guard') { dropped = true; seq.push('count landed, answer lost'); return { drop: true }; } };
      const r = await cron.runStagedBatch('tok', entries);
      let d = await h.doc();
      check('a lost answer to the count: resolved as "recovered" BEFORE the trade\'s measurement started', r.guards[0].status === 'recovered'
        && seq.indexOf('count landed, answer lost') < seq.indexOf('resolution read') && seq.indexOf('resolution read') < seq.indexOf('measuring 70'), seq);
      check('and the trade was counted ONCE and measured ONCE; both published measured', market.starts.get(70) === 1 && market.starts.get(71) === 1 && d.pending.filter(measured).length === 2 && !d.pendingStaged.length, { starts: [...market.starts], seq });
      // (2) The answer is lost and the outcome CANNOT be resolved (every read
      // refused): "outcome-unknown", so the batch stops and nothing is measured.
      await fresh();
      st = await ts.protect('staging', cron.stagingUpdate(fillsFor(2, 72)));
      dropped = false;
      shim.hooks.before = async cmd => (dropped && h.scriptOf(cmd) === 'RESOLUTION_READ' ? { error: 'stand-in: this read is refused' } : undefined);
      shim.hooks.after = async (cmd, reply) => { if (!dropped && h.scriptOf(cmd) === 'COMMIT' && reply === 'COMMITTED' && newKind(cmd) === 'poison-guard') { dropped = true; return { drop: true }; } };
      let err = null;
      try { await cron.runStagedBatch('tok', st.out.staged); } catch (e) { err = e; }
      check('an outcome that cannot be resolved: the batch stops ("outcome-unknown") and the trade is NOT measured', err && /outcome-unknown/.test(err.message) && !market.starts.get(72) && !market.starts.get(73), { err: err && err.message, starts: [...market.starts] });
      shim.hooks = {};
      d = await h.doc();
      check('the count had in fact landed (stagedTries 1), and nothing is visible', d.pendingStaged.find(e => e.entryTimestamp === T0 + 72 * 600000).stagedTries === 1 && d.pending.length === 0);
      await cron.publishStaged('tok', null);
      d = await h.doc();
      check('the resume counts it again (the bounded cost of QR-12) and measures it once; both published measured', market.starts.get(72) === 1 && d.pending.filter(measured).length === 2 && !d.pendingStaged.length, [...market.starts]);
      market.price = orig;
    });

    await section('Q-T2, Q-T3 CHARACTERISATION on the REAL generation-1 build, then the same with P2 and P1', async () => {
      const { olderBuild, removeOlderBuilds, GEN1 } = require('./lib/olderBuild');
      const GEN1DIR = olderBuild(GEN1);
      try {
        // The generation-1 build gets its own stand-in storage; everything
        // else (market, Schwab) is the same stand-in.
        const store = {};
        const fake = { get: async k => (k in store ? JSON.parse(store[k]) : null), set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; }, del: async k => { delete store[k]; return 1; } };
        fake.eval = require('./lib/gen1SaveStandIn').gen1SaveVia(fake, GEN1DIR);
        const prevLoad = Module._load;
        Module._load = function (request, parent) {
          if (request === '@upstash/redis' && parent && parent.filename && parent.filename.startsWith(GEN1DIR)) return { Redis: Object.assign(class { constructor() { return fake; } }, { fromEnv: () => fake }) };
          return prevLoad.apply(this, arguments);
        };
        const g1cron = require(path.join(GEN1DIR, 'cron.js'));
        const g1store = require(path.join(GEN1DIR, 'tradeStore.js'));
        // H2: the phone collects the unmeasured copy early and removes it.
        store['trades:state'] = JSON.stringify({ openLegs: [], pending: [], lastProcessedIds: [] });
        market.behaviour.clear(); market.starts.clear();
        let open; const gate = new Promise(r => { open = r; });
        market.behaviour.set(0, { gate });
        schwab.answers.push(fillsFor(1));
        const job = g1cron.runBackfill(30);
        await waitFor(() => market.starts.get(0) === 1);
        const early = (await g1store.getState()).pending[0];
        await g1store.removePendingTradeIfPair(early.id, early.fills);
        open(); await job;
        const after = (await g1store.getState()).pending;
        check('H2 on generation 1: the phone could collect the UNMEASURED copy, and after its removal the measured copy is never queued (characterisation: the harm exists)',
          early && !measured(early) && after.length === 0);
        // H1: read, replace, remove deletes the unseen copy.
        store['trades:state'] = JSON.stringify({ openLegs: [], pending: [], lastProcessedIds: [] });
        market.behaviour.clear(); market.starts.clear();
        let open2; const gate2 = new Promise(r => { open2 = r; });
        market.behaviour.set(1, { gate: gate2 });
        schwab.answers.push(fillsFor(1, 1));
        const job2 = g1cron.runBackfill(30);
        await waitFor(() => market.starts.get(1) === 1);
        const seenByPhone = JSON.stringify((await g1store.getState()).pending[0]);
        open2(); await job2;
        const replacedCopy = (await g1store.getState()).pending[0];
        await g1store.removePendingTradeIfPair(replacedCopy.id, replacedCopy.fills);
        check('H1 on generation 1: the copy the phone READ was replaced by the measured one, and its removal deleted the copy it never saw (characterisation)',
          seenByPhone !== JSON.stringify(replacedCopy) && measured(replacedCopy) && (await g1store.getState()).pending.length === 0);
        Module._load = prevLoad;
      } finally { removeOlderBuilds(); }
      // The same on generation 2.
      await fresh();
      let open; const gate = new Promise(r => { open = r; });
      market.behaviour.set(0, { gate });
      schwab.answers.push(fillsFor(1));
      const job = cron.runBackfill(30);
      await waitFor(() => market.starts.get(0) === 1);
      const visibleWhileMeasuring = (await ts.getState()).pending.length;
      open(); await job;
      const st = await h.doc();
      check('H2/H1 with P2: while it is measured the trade is NOT visible (nothing to collect early, nothing to replace); then the MEASURED copy appears once',
        visibleWhileMeasuring === 0 && st.pending.length === 1 && measured(st.pending[0]));
      // P1: a removal naming an old qid removes nothing else.
      const e = st.pending[0];
      const twin = await G2addTwin(ts, Q, e);
      const stale = await ts.protect('qid-removal', Q.qidRemoval, { payload: { id: e.id, pair: e.fills, qid: 'f'.repeat(32) + '-999' } });
      check('with P1 a removal naming a qid that is not there removes NOTHING (409 "other-qids"), though two entries share its id and pair',
        twin && stale.status === 'unchanged' && stale.result.reason === 'other-qids' && (await h.doc()).pending.length === 2);
    });
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    const stopped = await h.tearDown();
    check('the local Redis was stopped by SHUTDOWN NOSAVE and its folder removed', stopped.exited && stopped.folderGone, stopped);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();

// A second entry with the same id and pair, constructed (4.1 allows two to
// coexist), through THE COMMIT with its own qid.
async function G2addTwin(ts, Q, e) {
  const out = await ts.protect('sync-landing', (doc, fx) => {
    const ids = Q.issueQids(doc, 1, fx.candidateEpoch, fx.at);
    const twin = { ...e, qid: ids.qids[0] };
    return { next: { ...doc, ...ids.fields, pending: [twin, ...doc.pending] }, result: { landed: [{ id: String(twin.id), qid: twin.qid }], fillsProcessed: 0 } };
  });
  return out.status === 'committed';
}
