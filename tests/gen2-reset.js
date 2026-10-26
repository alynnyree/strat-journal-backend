// THE RESET, THE SERVICE SIDE (Queue plan v14.1 rev 3.2, 5.9.3; Q-T26 (c)-(h)
// and the route answers of S-R4 and S-R6), through the REAL routes (api.js)
// and save module against a real Redis on this machine.
//   (c) a late copy after its CANCEL: "cancelled", nothing reset
//   (d) a late copy after it committed: "recovered", nothing reset twice
//   (e) no waiting behind a running sync or import: 409 busy at once
//   (f) no false success: generation 1's false 200 reproduced on the REAL
//       generation-1 build (characterisation), then shown gone
//   (g) retention by count, through the status route
//   (h) a legacy reset (no requestId): S-R7, with S-R4's answers
// Two real processes sending the same requestId at once (Q-T26 (b)) are in
// tests/gen2-processes.js; stale reads (Q-T26 (k)) in tests/gen2-stale-reads.js.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const { setUp } = require('./lib/gen2Harness');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) return false; await sleep(2); } return true; };
const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 5 * 60 * 1000).unref();

const gate = { held: null, entered: 0 };
const stubs = {
  './schwabClient': { getOptionFills: async (t, f, to, report) => { if (report) Object.assign(report, { accountFound: true, windowsAsked: 1, windowsOk: 1, windowsFailed: 0, failures: [] }); gate.entered++; if (gate.held) await gate.held; return []; } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': { getUnderlyingPriceAt: async () => 500, getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }) },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
};

(async () => {
  const h = await setUp({ stubs });
  if (!h) { console.log('SKIPPED: no redis-server on this machine.\n\n0 passed, 0 failed'); process.exit(0); }
  const { shim, tradeStore: ts } = h;
  const cron = require(path.join(h.BACKEND, 'cron.js'));
  const api = require(path.join(h.BACKEND, 'api.js'));
  // Calls a real route's handler (as trade-ids.js does).
  const route = (method, p, req = {}) => {
    const layer = api.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    return new Promise(resolve => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
      layer.route.stack[0].handle({ method: method.toUpperCase(), params: {}, query: {}, body: {}, ...req }, res, err => resolve({ next: err }));
    });
  };
  const reset = (requestId, base = 0) => route('post', '/trades/reset', { body: requestId === undefined ? {} : { requestId, base } });
  const status = (requestId, base) => route('get', '/trades/reset/:requestId', { params: { requestId }, query: { base: String(base) } });
  const cancel = requestId => route('post', '/trades/reset/:requestId/cancel', { params: { requestId } });
  const START = { openLegs: [{ occ: 'X', openFillId: '1' }], pending: [{ id: 'W1', fills: ['1', '2'] }], lastProcessedIds: ['1', '2'], exceptions: { 'k:1': { kind: 'k', key: 'k:1', status: 'open' } } };
  try {
    await section('S-R4 and S-R6 THE ANSWERS, each meaning one thing', async () => {
      await h.ready(START);
      const st = await route('get', '/trades/reset/state');
      check('GET /trades/reset/state before any reset: {resetCounter: 0, prunedResetThrough: 0}', st.status === 200 && st.body.resetCounter === 0 && st.body.prunedResetThrough === 0, st);
      const pend = await route('get', '/trades/pending');
      check('GET /trades/pending carries removalEnabled false and the two counters (added fields)', pend.body.removalEnabled === false && pend.body.resetCounter === 0 && pend.body.prunedResetThrough === 0);
      for (const [label, body, reason] of [['a requestId that is not 32 lower-case hex', { requestId: 'ABC', base: 0 }, 'bad-request-id'], ['a base that is not a whole number', { requestId: hex('x'), base: -1 }, 'bad-base']]) {
        const r = await route('post', '/trades/reset', { body });
        check(`${label}: 400 {applied: false, reason: "${reason}"}, nothing done`, r.status === 400 && r.body.applied === false && r.body.reason === reason && (await h.doc()).pending.length === 1, r);
      }
      const id = hex('r1');
      const r = await reset(id, 0);
      const d = await h.doc();
      check('a reset: 200 {applied: true, status: "applied", requestId} ONLY after THE COMMIT confirmed it', r.status === 200 && r.body.applied === true && r.body.status === 'applied' && r.body.requestId === id, r);
      check('and the record: the lists emptied, exceptions kept, resetCounter 1, the reset\'s own record under the requestId',
        d.pending.length === 0 && d.openLegs.length === 0 && d.exceptions['k:1'] && d.resetCounter === 1 && d.opRecords[id] && d.opRecords[id].kind === 'reset');
      const s1 = await status(id, 0);
      check('its status: "applied"', s1.status === 200 && s1.body.status === 'applied', s1);
      const s2 = await status(hex('never'), 1);
      check('a requestId never sent, base = the current counter: "not-yet"', s2.body.status === 'not-yet', s2);
      check('status with a malformed id or base: 400', (await status('x', 0)).status === 400 && (await route('get', '/trades/reset/:requestId', { params: { requestId: id }, query: { base: 'z' } })).status === 400);
    });

    await section('Q-T26 (d) LATE ARRIVAL AFTER COMMIT: "recovered", nothing reset twice', async () => {
      await h.ready(START);
      const id = hex('d');
      await reset(id, 0);
      // Something arrives after the reset.
      await ts.protect('legacy-removal', h.Q.legacyRemovalById, { payload: { id: 'none' } });
      await ts.protect('progress', h.Q.progressUpdate, { payload: { after: 1 } });
      const before = await h.doc();
      const again = await reset(id, 0);
      const d = await h.doc();
      check('the same requestId again: 200 "recovered"; resetCounter still 1; the record unchanged by it',
        again.status === 200 && again.body.status === 'recovered' && d.resetCounter === 1 && d.stateVersion === before.stateVersion && d.lastBackfill.after === 1, again);
    });

    await section('Q-T26 (c) LATE ARRIVAL AFTER CANCEL: "cancelled", nothing reset', async () => {
      await h.ready(START);
      const id = hex('c');
      // The reset is held at the client boundary (its first read), its CANCEL
      // commits meanwhile, then the reset is released.
      let release; const held = new Promise(r => { release = r; });
      let holding = false;
      shim.hooks.before = async cmd => { if (!holding && h.scriptOf(cmd) === 'RESOLUTION_READ' && heldFor === 'reset') { holding = true; await held; } };
      let heldFor = 'reset';
      const pr = reset(id, 0);
      await waitFor(() => holding);
      heldFor = 'none';
      const c = await cancel(id);
      release();
      const r = await pr;
      shim.hooks = {};
      const d = await h.doc();
      check('the CANCEL committed a tombstone, and its answer is final: "cancelled"', c.status === 200 && c.body.status === 'cancelled' && c.body.final === true, c);
      check('the late copy of the reset: 409 {applied: false, reason: "cancelled"}; nothing reset', r.status === 409 && r.body.reason === 'cancelled' && d.pending.length === 1 && d.opRecords[id].kind === 'reset-cancel', r);
      check('its status afterwards: "cancelled"', (await status(id, 0)).body.status === 'cancelled');
      const c2 = await cancel(id);
      check('a second CANCEL: no change, the answer is the record ("cancelled")', c2.body.status === 'cancelled' && (await h.doc()).stateVersion === d.stateVersion);
      const id2 = hex('c2');
      await reset(id2, 1);
      const c3 = await cancel(id2);
      check('a CANCEL after the reset applied: no tombstone, the answer "applied"', c3.body.status === 'applied' && (await h.doc()).opRecords[id2].kind === 'reset');
    });

    await section('Q-T26 (e) NO WAITING: a reset while an import runs answers 409 busy at once; nothing reset later', async () => {
      await h.ready(START);
      let open; gate.held = new Promise(r => { open = r; }); gate.entered = 0;
      const job = cron.runBackfill(30).catch(() => {});
      await waitFor(() => gate.entered > 0);
      const t0 = Date.now();
      const r = await reset(hex('e'), 0);
      const took = Date.now() - t0;
      open(); gate.held = null;
      await job;
      await sleep(50);
      const d = await h.doc();
      check(`409 {applied: false, reason: "busy"} at once (${took} ms), naming the running job`, r.status === 409 && r.body.reason === 'busy' && r.body.busyWith === 'backfill' && took < 2000, r);
      check('nothing was reset, then or later', d.pending.length === 1 && !d.resetCounter && !(hex('e') in d.opRecords));
    });

    await section('Q-T26 (f) NO FALSE SUCCESS: generation 1\'s false 200 (characterisation), then gone', async () => {
      const { olderBuild, removeOlderBuilds, GEN1 } = require('./lib/olderBuild');
      const GEN1DIR = olderBuild(GEN1);
      try {
        const store = {};
        const fake = { get: async k => (k in store ? JSON.parse(store[k]) : null), set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; }, del: async k => { delete store[k]; return 1; } };
        fake.eval = require('./lib/gen1SaveStandIn').gen1SaveVia(fake, GEN1DIR);
        const prevLoad = Module._load;
        Module._load = function (request, parent) {
          if (request === '@upstash/redis' && parent && parent.filename && parent.filename.startsWith(GEN1DIR)) return { Redis: Object.assign(class { constructor() { return fake; } }, { fromEnv: () => fake }) };
          return prevLoad.apply(this, arguments);
        };
        const g1cron = require(path.join(GEN1DIR, 'cron.js'));
        const g1api = require(path.join(GEN1DIR, 'api.js'));
        Module._load = prevLoad;
        store['trades:state'] = JSON.stringify(START);
        // A slow first reset: the save is held, so a second reset arrives while it runs.
        let open; const slow = new Promise(r => { open = r; });
        const realEval = fake.eval;
        fake.eval = async (...a) => { await slow; return realEval(...a); };
        const first = g1cron.resetSyncState();
        await sleep(20);
        const layer = g1api.stack.find(l => l.route && l.route.path === '/trades/reset' && l.route.methods.post);
        const second = await new Promise(resolve => {
          const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
          layer.route.stack[0].handle({ method: 'POST', params: {}, query: {}, body: {} }, res, e => resolve({ next: e }));
        });
        open(); await first;
        check('CHARACTERISATION, generation 1 (eb3880b): a reset sent while another reset runs answers 200 {ok: true} although IT did nothing', second.status === 200 && second.body.ok === true, second);
      } finally { removeOlderBuilds(); }
      await h.ready(START);
      let release; const held = new Promise(r => { release = r; });
      let holding = false;
      shim.hooks.before = async cmd => { if (!holding && h.scriptOf(cmd) === 'COMMIT') { holding = true; await held; } };
      const p1 = reset(hex('f1'), 0);
      await waitFor(() => holding);
      const r2 = await reset(hex('f2'), 0);
      release();
      const r1 = await p1;
      shim.hooks = {};
      check('generation 2: the second reset answers 409 busy, never 200 without its own commit or record', r2.status === 409 && r2.body.applied === false && !((await h.doc()).opRecords[hex('f2')]), r2);
      check('the first one answers 200 only because it committed', r1.status === 200 && r1.body.status === 'applied');
    });

    await section('Q-T26 (g) RETENTION by count, through the status route', async () => {
      await h.ready(START);
      const ids = [];
      for (let i = 0; i < 203; i++) { const id = hex('g' + i); ids.push(id); const r = i % 2 ? await cancel(id) : await reset(id, i); if (r.status !== 200) throw new Error('setup step failed ' + JSON.stringify(r)); }
      const st = (await route('get', '/trades/reset/state')).body;
      check(`after 203 reset-kind records: resetCounter ${st.resetCounter}, prunedResetThrough ${st.prunedResetThrough}`, st.resetCounter === 203 && st.prunedResetThrough === 3, st);
      const oldest = await status(ids[0], 0);
      check('a pruned record, base below prunedResetThrough: "unknown" (absent, and prunedResetThrough >= base + 1)', oldest.body.status === 'unknown', oldest.body);
      check('a record still kept: "applied" / "cancelled"', (await status(ids[202], 0)).body.status === 'applied' && (await status(ids[201], 0)).body.status === 'cancelled');
      check('absent, prunedResetThrough < base + 1: "not-yet"', (await status(hex('new'), 3)).body.status === 'not-yet');
      check('absent, prunedResetThrough >= base + 1: "unknown"', (await status(hex('new'), 2)).body.status === 'unknown');
    });

    await section('Q-T26 (h) A LEGACY RESET (no requestId, every app before the 5.9 change): S-R7 with S-R4\'s answers', async () => {
      await h.ready(START);
      const r = await reset(undefined);
      const d = await h.doc();
      check('200 {applied: true, status: "applied"}, through THE COMMIT, with a service-made id', r.status === 200 && r.body.applied === true && /^[0-9a-f]{32}$/.test(r.body.requestId) && d.opRecords[r.body.requestId].kind === 'reset' && d.resetCounter === 1, r);
      const r2 = await reset(undefined);
      check('a second legacy reset is a SEPARATE reset (it carries no id), as S-R7 says', r2.status === 200 && r2.body.requestId !== r.body.requestId && (await h.doc()).resetCounter === 2);
      let open; gate.held = new Promise(x => { open = x; }); gate.entered = 0;
      const job = cron.runBackfill(30).catch(() => {});
      await waitFor(() => gate.entered > 0);
      const busy = await reset(undefined);
      open(); gate.held = null; await job;
      check('a legacy reset while an import runs: 409 busy (an older app sees a failure, as QR-19 says)', busy.status === 409 && busy.body.reason === 'busy');
    });
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    const stopped = await h.tearDown();
    require('./lib/localRedis').reportStop(check, stopped);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
