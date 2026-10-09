// STEP B of the audit's remediation (F3 + F4 + H-3 + H-7), authorized by
// the owner on 6 October 2026: "I authorize step B implementation".
//
// The record of what is waiting for the phone ("trades:state": open legs,
// waiting trades, the fills already handled) had several writers that each
// read the whole record, worked -- sometimes for minutes -- and wrote the
// whole thing back. A backfill also started from NO open legs and saved
// that, erasing live positions. This runs the REAL sync and backfill code
// (cron.js, matcher.js, tradeStore.js) against a stand-in for storage and
// Schwab, forces the overlaps on purpose, and checks the twelve points the
// auditor listed. Every race case also checks that the overlap really
// happened, so a pass cannot come from the job simply finishing first.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (label, ok) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } };

// ---- Stand-in storage. Values go through JSON, as they do on the wire, so
// nothing can pass by sharing one object between a reader and a writer.
const store = {};
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
};
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const readState = () => (store['trades:state'] ? JSON.parse(store['trades:state']) : null);
const writeState = s => { store['trades:state'] = JSON.stringify(s); };

// ---- Stand-in Schwab. Each call takes the next scripted answer.
const schwab = { answers: [], asked: [] };
function getOptionFills(token, startDate, endDate, report = null) {
  schwab.asked.push({ startDate, endDate });
  const a = schwab.answers.length ? schwab.answers.shift() : { fills: [] };
  if (report) {
    report.accountFound = true;
    report.windowsAsked = 1;
    report.windowsOk = a.refused ? 0 : 1;
    report.windowsFailed = a.refused ? 1 : 0;
    report.failures = a.refused ? [{ from: startDate, to: endDate, status: 429, why: a.refused }] : [];
    report.oldestWindowWithData = null;
  }
  return Promise.resolve(a.refused ? [] : JSON.parse(JSON.stringify(a.fills)));
}

// ---- The sign-in record holds the checkpoint.
const tokens = { last_transaction_check: null };

// ---- Enrichment can be held at a gate, so another operation can be made
// to land while a job is part-way through.
const gate = { held: null, entered: 0 };
function holdEnrichment(){ let open; gate.held = new Promise(r => { open = r; }); gate.entered = 0; return () => { gate.held = null; open(); }; }
const waitFor = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 5)); } return true; };

const stubs = {
  '@upstash/redis': { Redis },
  'node-cron': { schedule: () => ({ stop(){} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './schwabClient': { getOptionFills },
  './tokenStore': {
    getTokens: async () => ({ ...tokens }),
    setLastCheck: async iso => { tokens.last_transaction_check = iso; },
  },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async () => { gate.entered++; if (gate.held) await gate.held; return 500; },
    getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }),
  },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {} },
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

// ---- Fills, the way schwabClient hands them over.
const OCC = 'SPY   261231C00600000';           // expires end of 2026: never "dead"
const T0 = Date.now() - 3 * 60 * 60 * 1000;
// M-1: a fill id must be a decimal broker id, and every fill carries its
// account. The readable names below stay in the cases; ID() turns each into a
// fixed decimal id.
const NAMES = new Map();
const ID = name => {
  if (name == null) return null;
  const id = /^[0-9]+$/.test(String(name)) ? String(name) : '9' + [...String(name)].map(c => c.charCodeAt(0)).join('');
  NAMES.set(id, String(name));
  return id;
};
const NAME = id => NAMES.get(String(id)) || id;   // back to the readable name, for the checks
const ACCT = 'acct-test';
function fill(id, kind, minute, price = 1, qty = 1, occ = OCC){
  const ts = T0 + minute * 60000; const d = new Date(ts);
  return { transactionId: ID(id), accountRef: ACCT, occ, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
    price, quantity: qty, fees: 0.66,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const liveLeg = (id, minute) => {
  const f = fill(id, 'open', minute);
  return { occ: f.occ, ticker: 'SPY', dir: 'Long', openPrice: f.price, openDate: f.date, openTime: f.time,
    openTimestamp: f.timestamp, totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: ID(id), accountRef: ACCT };
};
const pairs = st => (st.pending || []).map(t => (t.fills || []).map(NAME).join('+'));
const fresh = (s) => { for (const k of Object.keys(store)) delete store[k]; writeState(s); tokens.last_transaction_check = null; schwab.answers = []; schwab.asked = []; };
const noRepeats = list => new Set(list.map(String)).size === list.length;

(async () => {
  try {
    // =====================================================================
    console.log('--- 1. an acknowledgement made during a sync stays acknowledged ---');
    {
      fresh({ openLegs: [], pending: [{ id: 'WAITING-A', fills: ['x1', 'x2'] }], lastProcessedIds: ['x1', 'x2'] });
      schwab.answers.push({ fills: [fill('o1', 'open', 0), fill('c1', 'close', 5)] });
      const release = holdEnrichment();
      const job = cron.runSyncCheck();
      const reached = await waitFor(() => gate.entered > 0);
      await tradeStore.removePendingTrade('WAITING-A');        // the phone says "taken"
      const stillRunning = gate.held !== null;
      release(); await job;
      const st = readState();
      check('the overlap really happened (sync was mid-enrichment when the phone answered)', reached && stillRunning);
      check('the acknowledged trade does not come back', !st.pending.some(t => t.id === 'WAITING-A'));
      check('the sync\'s own new trade is waiting', pairs(st).includes('o1+c1'));
    }

    // =====================================================================
    console.log('\n--- 2 & 3. a live open leg survives a backfill; its close still becomes a trade ---');
    {
      fresh({ openLegs: [liveLeg('o-live', 100)], pending: [], lastProcessedIds: [ID('o-live')] });
      schwab.answers.push({ fills: [fill('h1', 'open', 0), fill('h2', 'close', 3)] });   // history
      await cron.runBackfill(30);
      const st = readState();
      check('2. the live open leg is still there after the backfill', (st.openLegs || []).some(l => l.openFillId === ID('o-live')));
      check('the backfill\'s own historical trade was queued', pairs(st).includes('h1+h2'));
      schwab.answers.push({ fills: [fill('c-live', 'close', 110)] });
      await cron.runSyncCheck();
      const after = readState();
      check('3. the later close becomes a trade with its opening', pairs(after).includes('o-live+c-live'));
      check('and the closed leg is gone from the open legs', !(after.openLegs || []).some(l => l.openFillId === ID('o-live')));
    }

    // =====================================================================
    console.log('\n--- 4. a trade queued during another operation is not erased ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('b1', 'open', 0), fill('b2', 'close', 2)] });
      const release = holdEnrichment();
      const job = cron.runBackfill(30);
      const reached = await waitFor(() => gate.entered > 0);
      await tradeStore.addPendingTrade({ id: 'ADDED-DURING', fills: ['z1', 'z2'] });
      // A five-minute tick arriving now must not run alongside the backfill.
      schwab.answers.push({ fills: [fill('s1', 'open', 10), fill('s2', 'close', 12)] });
      const checkpointBefore = tokens.last_transaction_check;
      // Not awaited outright: on code without a guard this tick would wait
      // at the same gate as the backfill, and the test would wait for ever.
      const tick = cron.runSyncCheck();
      const tickDone = await Promise.race([tick.then(() => true), new Promise(r => setTimeout(() => r(false), 300))]);
      const checkpointAfterTick = tokens.last_transaction_check;
      const stillRunning = gate.held !== null;
      release(); await job; await tick;
      const st = readState();
      check('the overlap really happened (backfill was mid-enrichment)', reached && stillRunning);
      check('a trade added during the backfill is still waiting', st.pending.some(t => t.id === 'ADDED-DURING'));
      check('the backfill\'s own trade is waiting', pairs(st).includes('b1+b2'));
      check('the tick that arrived during the backfill did not run alongside it', !pairs(st).includes('s1+s2'));
      check('the tick returned at once instead of waiting on the backfill', tickDone);
      check('and did not move the checkpoint', checkpointAfterTick === checkpointBefore);
      await cron.runSyncCheck();                            // the next tick
      check('the next tick picks those fills up, so nothing is lost', pairs(readState()).includes('s1+s2'));
    }

    // =====================================================================
    console.log('\n--- 5. overlapping syncs do not process anything twice ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const both = [fill('d1', 'open', 0), fill('d2', 'close', 4)];
      schwab.answers.push({ fills: both }, { fills: both });
      const release = holdEnrichment();
      const a = cron.runSyncCheck();
      await waitFor(() => gate.entered > 0);
      const b = cron.runSyncCheck();
      await new Promise(r => setTimeout(r, 30));
      release(); await Promise.all([a, b]);
      const st = readState();
      const n = pairs(st).filter(p => p === 'd1+d2').length;
      check(`one trade, not two (found ${n})`, n === 1);
      check('each fill id recorded once', noRepeats(st.lastProcessedIds));
    }

    // =====================================================================
    console.log('\n--- 6, 7, 8. a mixed batch: one fill already handled elsewhere, others new ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('m1', 'open', 0), fill('m2', 'close', 2), fill('n1', 'open', 20), fill('n2', 'close', 25)] });
      const release = holdEnrichment();
      const job = cron.runSyncCheck();
      const reached = await waitFor(() => gate.entered > 0);
      // Another operation (a second process, say) handles m1+m2 meanwhile.
      const s = readState();
      s.pending.unshift({ id: 'OTHER-OP', fills: ['m1', 'm2'] });
      s.lastProcessedIds = [...s.lastProcessedIds, ID('m1'), ID('m2')];
      writeState(s);
      release(); await job;
      const st = readState();
      const m = pairs(st).filter(p => p === 'm1+m2').length;
      check('the overlap really happened', reached);
      check(`6. the already-handled fills are not processed twice (m1+m2 appears ${m} time(s))`, m === 1);
      check('7. the unrelated new fills in that batch are still processed', pairs(st).includes('n1+n2'));
      check('the other operation\'s trade is kept', st.pending.some(t => t.id === 'OTHER-OP'));
      check('8. processed ids have no repeats', noRepeats(st.lastProcessedIds));
    }
    {
      // A backfill large enough to save in several batches (25 per batch):
      // its own later batches must not be mistaken for duplicates.
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const many = [];
      for (let i = 0; i < 60; i++) many.push(fill('p' + i, 'open', i * 2), fill('q' + i, 'close', i * 2 + 1));
      schwab.answers.push({ fills: many });
      await cron.runBackfill(30);
      const st = readState();
      const mine = st.pending.filter(t => /^p\d+\+q\d+$/.test((t.fills || []).map(NAME).join('+')));
      check(`8. all 60 trades from a three-batch backfill are waiting (${mine.length})`, mine.length === 60);
      check('8. and every one carries its enrichment from the later batches', mine.every(t => t.undEntry === 500));
      check('8. processed ids have no repeats', noRepeats(st.lastProcessedIds) && st.lastProcessedIds.length === 120);
    }

    // =====================================================================
    console.log('\n--- 9. more than 500 processed ids are kept ---');
    {
      const old = []; for (let i = 0; i < 600; i++) old.push('old' + i);
      fresh({ openLegs: [], pending: [], lastProcessedIds: old });
      schwab.answers.push({ fills: [fill('k1', 'open', 0), fill('k2', 'close', 1)] });
      await cron.runSyncCheck();
      const ids = readState().lastProcessedIds;
      check(`all 602 kept (${ids.length})`, ids.length === 602);
      check('including the oldest', ids.includes('old0'));
    }

    // =====================================================================
    console.log('\n--- 10, 11, 12. a refused Schwab window ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const before = new Date(Date.now() - 2 * 86400000).toISOString();
      tokens.last_transaction_check = before;
      schwab.answers.push({ refused: '429 Too Many Requests' });
      await cron.runSyncCheck();
      const st = readState();
      check('10. the checkpoint did not move', tokens.last_transaction_check === before);
      check('11. the refusal is recorded with Schwab\'s answer',
        !!(st.lastSync && st.lastSync.windowsFailed === 1 && JSON.stringify(st.lastSync).includes('429')));
      schwab.answers.push({ fills: [fill('r1', 'open', 0), fill('r2', 'close', 3)] });
      await cron.runSyncCheck();
      const asked = schwab.asked[schwab.asked.length - 1];
      check('12. the next run asks again from the same starting day', asked.startDate === before.slice(0, 10));
      check('12. and picks up the fills', pairs(readState()).includes('r1+r2'));
      check('12. and only then moves the checkpoint', tokens.last_transaction_check !== before);
      check('and the record no longer shows a refusal', !(readState().lastSync || {}).windowsFailed);
    }
    {
      // An EMPTY answer is not a refusal: the checkpoint moves.
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const before = new Date(Date.now() - 86400000).toISOString();
      tokens.last_transaction_check = before;
      schwab.answers.push({ fills: [] });
      await cron.runSyncCheck();
      check('an empty answer still moves the checkpoint (empty is not refused)', tokens.last_transaction_check !== before);
    }
  } catch (err) {
    console.log('FAIL: TEST CRASHED', err && err.stack || err);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
