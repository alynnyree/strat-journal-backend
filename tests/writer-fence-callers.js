// THE WRITER FENCE, GENERATION 1: what every writer of "trades:state" does
// when its save is refused -- Queue Exact-Removal plan v14.1 revision 2,
// section 5.8.2 ("WHAT A REFUSED SAVE DOES") and test Q-T24 (c), offline.
// Owner, 20 Oct 2026: "I authorize Q-D: implementation of Queue
// Exact-Removal plan v14.1 revision 2, stage 1 only (Deploy 1's code)".
//
// Runs the REAL sync, reset, history import, removal routes and save module
// against stand-ins for storage and Schwab (as tests/sync-state-safety.js
// does), with the fence set to 2 -- what a newer server generation leaves.
// For each writer (W1 to W7 of the plan's inventory): the save is refused,
// the stored record is byte-identical, and the caller fails the way the plan
// lists. Each case first runs WITHOUT the fence, to show the same call does
// save there, so a pass cannot come from a call that never saves anything.
//
// The stand-in answers the save the way the script does (tests/lib/
// gen1SaveStandIn.js). The script itself, on a real Redis, is
// tests/writer-fence.js.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.APP_SECRET = process.env.APP_SECRET || 'test-only-not-a-real-key';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };
async function section(fn) { try { await fn(); } catch (e) { fail++; console.log('FAIL: this case threw:', e && e.stack || e); } }

// ---- Stand-in storage, through JSON as on the wire.
const store = {};
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
};
const gen1Save = require('./lib/gen1SaveStandIn').gen1SaveVia(fakeRedis);
// Every save attempt and its answer, so a refusal that a caller swallows is
// still seen here.
const saves = [];
fakeRedis.eval = async (...a) => { const r = await gen1Save(...a); saves.push({ r, doc: JSON.parse(a[2][0]) }); return r; };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const RECORD = 'trades:state', FENCE = '{trades:state}:fence';
const recordText = () => store[RECORD];

// ---- Stand-in Schwab and the rest of the world.
const schwab = { answers: [] };
function getOptionFills(token, startDate, endDate, report = null) {
  const a = schwab.answers.length ? schwab.answers.shift() : { fills: [] };
  if (report) { report.accountFound = true; report.windowsAsked = 1; report.windowsOk = 1; report.windowsFailed = 0; report.failures = []; report.oldestWindowWithData = null; }
  return Promise.resolve(JSON.parse(JSON.stringify(a.fills)));
}
const tokens = { last_transaction_check: null };
const told = { closed: 0, opened: 0 };
const gate = { held: null, entered: 0 };
function holdEnrichment(){ let open; gate.held = new Promise(r => { open = r; }); gate.entered = 0; return () => { gate.held = null; open(); }; }
const waitFor = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 5)); } return true; };

const stubs = {
  '@upstash/redis': { Redis },
  'node-cron': { schedule: () => ({ stop(){} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './schwabClient': { getOptionFills },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async () => { gate.entered++; if (gate.held) await gate.held; return 500; },
    getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }),
  },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
  './pushcut': { notifyTradeClosed: async () => { told.closed++; }, notifyTradeOpened: async () => { told.opened++; }, notifyTradeStillOpen: async () => {} },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const cron = require(path.join(BACKEND, 'cron.js'));
const tradeStore = require(path.join(BACKEND, 'tradeStore.js'));
const api = require(path.join(BACKEND, 'api.js'));

const OCC = 'SPY   261231C00600000';
const ACCT = 'acct-aaaaaaaaaaaaaaaa';
const T0 = Date.now() - 3 * 60 * 60 * 1000;
function fill(id, kind, minute) {
  const ts = T0 + minute * 60000; const d = new Date(ts);
  return { transactionId: id, accountRef: ACCT, occ: OCC, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const START = { openLegs: [], pending: [{ id: 'WAITING-1', fills: ['111', '112'] }], lastProcessedIds: ['111', '112'], exceptions: {} };
function fresh(fence) {
  for (const k of Object.keys(store)) delete store[k];
  store[RECORD] = JSON.stringify(START);
  if (fence !== undefined) store[FENCE] = JSON.stringify(fence);
  tokens.last_transaction_check = null; schwab.answers = []; told.closed = 0; told.opened = 0;
}
// Calls a real route's handler, as trade-ids.js does. A failure handed to
// next() is what errorHandler turns into its 500 answer.
function route(method, p, req) {
  const layer = api.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  return new Promise(resolve => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    layer.route.stack[0].handle({ method: method.toUpperCase(), params: {}, query: {}, ...req }, res, err => resolve({ next: err }));
  });
}

(async () => {
  console.log('--- W1. the live-sync landing ---');
  await section(async () => {
    fresh(undefined);
    schwab.answers.push({ fills: [fill('201', 'open', 0), fill('202', 'close', 5)] });
    await cron.runSyncCheck();
    check('control, no fence: the sync saves its trade and moves its checkpoint', recordText() !== JSON.stringify(START) && tokens.last_transaction_check !== null);
    fresh(2);
    const before = recordText();
    schwab.answers.push({ fills: [fill('201', 'open', 0), fill('202', 'close', 5)] });
    await cron.runSyncCheck();
    check('fence 2: the record is byte-identical (the fills are NOT marked processed)', recordText() === before);
    check('fence 2: the checkpoint did not move, so a later tick takes the fills again', tokens.last_transaction_check === null);
    check('fence 2: no phone alert was sent for a trade that was not saved', told.closed === 0 && told.opened === 0, told);
    check('fence 2: this process reports itself fenced', tradeStore.writerStatus().fenced === true);
  });

  console.log('\n--- W2. the reset ---');
  await section(async () => {
    fresh(undefined);
    await cron.resetSyncState();
    check('control, no fence: the reset empties the record', JSON.parse(recordText()).pending.length === 0);
    fresh(2);
    const before = recordText();
    let err = null;
    try { await cron.resetSyncState(); } catch (e) { err = e; }
    check('fence 2: resetSyncState fails with "fenced"', err && err.code === 'FENCED', err && err.message);
    check('fence 2: the record is byte-identical', recordText() === before);
    const r = await route('post', '/trades/reset', {});
    check('fence 2: the reset route answers that it could not be done (500, "Reset failed")', r.status === 500 && r.body && r.body.error === 'Reset failed', r);
    check('fence 2: and the record is still byte-identical', recordText() === before);
    check('fence 2: the one-job-at-a-time guard was released (no job left marked running)', cron.jobRunning() === null, cron.jobRunning());
  });

  console.log('\n--- W3 and W5. the history import: its progress notes and its staging ---');
  await section(async () => {
    fresh(undefined);
    schwab.answers.push({ fills: [fill('301', 'open', 0), fill('302', 'close', 3)] });
    await cron.runBackfill(30);
    const ctl = JSON.parse(recordText());
    check('control, no fence: the import stages its trade and records its progress', ctl.pending.length === 2 && ctl.lastBackfill && ctl.lastBackfill.status === 'done', ctl.lastBackfill);
    fresh(2);
    const before = recordText();
    schwab.answers.push({ fills: [fill('301', 'open', 0), fill('302', 'close', 3)] });
    let err = null;
    saves.length = 0;
    try { await cron.runBackfill(30); } catch (e) { err = e; }
    const notes = saves.filter(x => x.doc.lastBackfill && x.doc.pending.length === 1);
    const staging = saves.filter(x => x.doc.pending.length === 2);
    check('fence 2: the import run fails with "fenced" (W5, staging refused)', err && err.code === 'FENCED' && staging.length === 1 && staging[0].r === 'FENCED', { err: err && err.message, staging: staging.map(x => x.r) });
    check('fence 2: every progress note (from "running" to "failed") was refused and swallowed, as today (W3)',
      notes.length >= 2 && notes.every(x => x.r === 'FENCED') && notes[0].doc.lastBackfill.status === 'running' && notes[notes.length - 1].doc.lastBackfill.status === 'failed',
      notes.map(x => [x.r, x.doc.lastBackfill && x.doc.lastBackfill.status]));
    check('fence 2: the record is byte-identical (nothing staged, no progress written, fills not processed)', recordText() === before);
    check('fence 2: the guard was released', cron.jobRunning() === null);
  });

  console.log('\n--- W4. refreshing waiting trades, fenced part-way through an import ---');
  await section(async () => {
    fresh(undefined);
    schwab.answers.push({ fills: [fill('401', 'open', 0), fill('402', 'close', 3)] });
    const release = holdEnrichment();
    const job = cron.runBackfill(30).then(() => null, e => e);
    const reached = await waitFor(() => gate.entered > 0);
    const staged = JSON.parse(recordText()).pending.some(t => (t.fills || []).join('+') === '401+402');
    store[FENCE] = JSON.stringify(2);                 // a newer generation raises the fence now
    const atRaise = recordText();
    release();
    const err = await job;
    check('the case really happened: the import had staged its trade and was mid-enrichment at the raise', reached && staged);
    check('the refresh after the raise is refused: the run fails with "fenced"', err && err.code === 'FENCED', err && err.message);
    check('the record is exactly as it was at the raise (no refresh, no progress note landed after it)', recordText() === atRaise);
    check('the guard was released', cron.jobRunning() === null);
  });

  console.log('\n--- W6 and W7. the removal routes ---');
  await section(async () => {
    fresh(undefined);
    const r0 = await route('delete', '/trades/pending/:id', { params: { id: 'WAITING-1' }, query: { fills: '111,112' } });
    check('control, no fence: removal by id and pair removes the entry', r0.status === 200 && r0.body.removed === 1, r0);
    for (const [label, query] of [['W7, by id and pair', { fills: '111,112' }], ['W6, by id only (older apps)', {}]]) {
      fresh(2);
      const before = recordText();
      const r = await route('delete', '/trades/pending/:id', { params: { id: 'WAITING-1' }, query });
      check(`fence 2, ${label}: the route answers with an error (handed to the error handler), not success`, r.next && r.next.code === 'FENCED' && r.status === undefined, r);
      check(`fence 2, ${label}: the entry is still there, the record byte-identical`, recordText() === before);
    }
  });

  console.log('\n--- after all of it: nothing created, raised or removed the fence ---');
  await section(async () => {
    fresh(2);
    await cron.runSyncCheck();
    try { await cron.resetSyncState(); } catch (e) { /* refused, as above */ }
    check('the fence still reads 2: generation 1 never changes it', store[FENCE] === JSON.stringify(2));
    fresh(undefined);
    schwab.answers.push({ fills: [fill('501', 'open', 0), fill('502', 'close', 5)] });
    await cron.runSyncCheck();
    check('with no fence, saving never creates one', !(FENCE in store));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: TEST CRASHED', e && e.stack || e); process.exit(1); });
