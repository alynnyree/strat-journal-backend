// FTFC Fix 1, the service half (13 Oct 2026; owner: "I authorize FTFC Fix 1
// implementation"). Consolidated spec sections A and B. Reaches no network:
// Schwab, Alpaca and storage are stand-ins at the edge; ftfcCheck, ftfcRetry,
// the matcher, the sync, the history import and the routes run for real.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const http = require('http');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (label, ok, detail) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)); } };

// ---- storage stand-in
const store = {};
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
  lpush: async () => 1, lrange: async () => [], lrem: async () => 0, ltrim: async () => 'OK', rpop: async () => null,
  mget: async (...ks) => ks.map(k => (k in store ? JSON.parse(store[k]) : null)),
};
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const readState = () => (store['trades:state'] ? JSON.parse(store['trades:state']) : null);
const writeState = s => { store['trades:state'] = JSON.stringify(s); };

// ---- market stand-in. Every candle is built from one rising price path, so
// the right answer is known by construction: everything bullish at entry.
const T0 = Date.parse('2024-01-01T00:00:00Z');
const priceAt = ms => +(400 + (ms - T0) / 60000 * 0.0001).toFixed(6);
function candles(endMs, minutes, count) {
  const step = minutes * 60000;
  const last = Math.floor(endMs / step) * step;
  const out = [];
  for (let s = last - (count - 1) * step; s <= last; s += step) {
    const o = priceAt(s), c = priceAt(s + step);
    out.push({ datetime: s, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000 });
  }
  return out;
}
// Behaviour per series: 'ok' | 'empty' | 'refused' | 'unreachable' | 'gap' (minute data stopping
// 15 minutes before the entry, as Alpaca's free plan does for a fresh trade).
let behave = {};
const httpErr = status => Object.assign(new Error('refused'), { response: { status } });
function priceHistory(p) {
  const kind = p.frequencyType === 'minute' ? 'minute' : p.frequencyType;
  const b = behave[kind] || 'ok';
  if (b === 'refused') throw httpErr(429);
  if (b === 'unreachable') throw new Error('socket hang up');
  if (b === 'empty') return [];
  const end = Number(p.endDate) || Date.now();
  if (kind === 'minute') {
    const all = candles(end, 1, 2 * 24 * 60);
    return b === 'gap' ? all.filter(c => c.datetime <= end - 15 * 60000) : all;
  }
  if (kind === 'daily') return candles(end, 24 * 60, 500);
  if (kind === 'weekly') return candles(end, 7 * 24 * 60, 120);
  return candles(end, 30 * 24 * 60, 40);
}
const axios = {
  get: async (url, opts = {}) => {
    if (/\/accounts\/accountNumbers$/.test(url)) return { data: [{ accountNumber: '000', hashValue: 'HASH-A' }] };
    if (/\/accounts\/[^/]+\/transactions$/.test(url)) return { data: JSON.parse(JSON.stringify(schwabTxs)) };
    if (/\/pricehistory$/.test(url)) return { data: { candles: priceHistory(opts.params || {}) } };
    throw new Error('unexpected GET ' + url);
  },
  post: async (url) => { throw new Error('unexpected POST ' + url); },
};
// Alpaca: only the exact print, when switched on; no bars (the minute series comes from Schwab here).
let print = null;   // { price, at } or null
const alpacaStub = {
  isReady: async () => false, isConfigured: () => false, fetchBars: async () => [],
  underlyingPriceAt: async () => (print ? { price: print.price, source: 'alpaca-trade', exact: true, feed: 'sip', upgradable: false, printAt: print.at } : null),
};
let alpacaOn = false;
const alpacaProxy = new Proxy(alpacaStub, { get: (t, k) => (k === 'isReady' ? async () => alpacaOn : t[k]) });

let schwabTxs = [];
const tokens = { last_transaction_check: null };
const stubs = {
  axios, '@upstash/redis': { Redis }, 'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
  './alpacaClient': alpacaProxy,
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => ({ strategy: null }) },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {}, notifySignInExpiring: async () => {}, lastPhoneAlert: async () => null },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const ftfc = require(path.join(BACKEND, 'ftfcCheck.js'));
const R = require(path.join(BACKEND, 'ftfcRetry.js'));
const cron = require(path.join(BACKEND, 'cron.js'));
const TF = ftfc.TIMEFRAMES;
const INTRADAY = ['4H', '2H', '1H', '30m', '15m', '5m', '3m', '1m'];

const ENTRY = Date.parse('2026-10-09T14:31:30Z');   // Fri 9 Oct 2026, 10:31:30 New York
const V = cron.FTFC_RULE_VERSION;
const measure = (exact = null) => ftfc.getFtfcForTrade('tok', 'SPY', ENTRY, exact, { version: V });

(async () => {
  // ===================== A. THE READING =====================
  console.log('--- A1. a full reading: every timeframe measured ---');
  {
    behave = {};
    const r = (await measure({ price: priceAt(ENTRY), at: null, atMs: ENTRY })).reading;
    check('complete, 13 statuses, nothing missing', r.complete === true && TF.every(tf => ['bull', 'bear', 'level'].includes(r.status[tf])), r.status);
    check('every timeframe bullish on a rising market', TF.every(tf => r.status[tf] === 'bull'), r.status);
    check('the 1m is MEASURED, never exempt (no by-design status exists)', r.status['1m'] === 'bull' && !JSON.stringify(r).includes('by-design'));
    check('verdict present: run 13, confirmed, bull', r.run === 13 && r.confirmed === true && r.direction === 'bull' && r.timeframesInRun.length === 13, r);
    check('price source is the exact print, inside the entry second', r.priceSource === 'exact-print' && r.priceTime === ENTRY);
    check('the service\'s own checks accept it', R.readingProblems(r, ENTRY).length === 0, R.readingProblems(r, ENTRY));
    check('diagnostics name each series', /Schwab answered/.test(r.diagnostics.daily) && /Schwab answered/.test(r.diagnostics.minute), r.diagnostics);
  }

  console.log('\n--- A2. the price at entry: evidence, never hindsight ---');
  {
    behave = {};
    const bare = (await ftfc.getFtfcForTrade('tok', 'SPY', ENTRY, 123.45, { version: V })).reading;
    check('a bare number (no time) is not evidence: the prior minute is used instead', bare.priceSource === 'prior-minute-close' && bare.priceAtEntry !== 123.45, bare);
    const prior = ENTRY - (ENTRY % 60000) - 60000;
    check('prior-minute-close = the close of the bar starting exactly 60 s before the entry minute', bare.priceTime === prior && bare.priceAtEntry === priceAt(prior + 60000), bare);
    const early = (await measure({ price: 1, atMs: ENTRY - 1500 })).reading;
    check('a print from before the entry second is not accepted', early.priceSource === 'prior-minute-close', early.priceSource);
    const late = (await measure({ price: 1, atMs: ENTRY + 1 })).reading;
    check('a print after the entry is not accepted', late.priceSource === 'prior-minute-close', late.priceSource);
    behave = { minute: 'empty' };
    const none = (await measure(null)).reading;
    check('no print and no minute data: NO price (the daily close is never used)', none.priceAtEntry === null && none.priceSource === null && none.priceTime === null, none);
    check('...and all 13 timeframes say "no price at entry"', TF.every(tf => none.status[tf] === 'missing' && none.missing[tf] === 'no price at entry'), none.missing);
    check('...the hidden failure is kept as a diagnostic', /Schwab answered with nothing/.test(none.diagnostics.minute), none.diagnostics);
    check('...no verdict', none.run === null && none.confirmed === null && none.direction === null && none.timeframesInRun.length === 0);
    check('...valid incomplete reading to the service\'s checks', R.readingProblems(none, ENTRY).length === 0, R.readingProblems(none, ENTRY));
  }

  console.log('\n--- A3. one reason per missing timeframe, by fixed precedence ---');
  {
    behave = { daily: 'refused', weekly: 'empty', monthly: 'unreachable' };
    const r = (await measure({ price: priceAt(ENTRY), atMs: ENTRY })).reading;
    check('daily refused gives 1D "Schwab refused (status 429)"', r.missing['1D'] === 'Schwab refused (status 429)', r.missing);
    check('weekly empty gives 1W "Schwab answered with nothing"', r.missing['1W'] === 'Schwab answered with nothing', r.missing);
    check('monthly unreachable gives 1M, 3M and 6M "could not reach Schwab"', ['1M', '3M', '6M'].every(tf => r.missing[tf] === 'could not reach Schwab'), r.missing);
    check('intraday still measured', INTRADAY.every(tf => r.status[tf] === 'bull'), r.status);
    check('INCOMPLETE, no verdict', r.complete === false && r.run === null && r.confirmed === null);
    check('grid holds only the measured bull/bear', Object.keys(r.grid).length === 8, r.grid);
    check('valid to the service\'s checks', R.readingProblems(r, ENTRY).length === 0, R.readingProblems(r, ENTRY));

    behave = { minute: 'gap' };   // a fresh trade: Alpaca's free plan holds back the last 15 minutes
    const g = (await measure({ price: priceAt(ENTRY), atMs: ENTRY })).reading;
    const recent = INTRADAY.filter(tf => g.status[tf] === 'missing');
    check('a minute series that stops 15 minutes short leaves the short timeframes "data did not contain this bar"',
      recent.length > 0 && recent.every(tf => g.missing[tf] === 'data did not contain this bar'), g.missing);

    behave = {};
    const pre = Date.parse('2026-10-09T13:20:00Z');      // 09:20 New York
    const p = (await ftfc.getFtfcForTrade('tok', 'SPY', pre, { price: 500, atMs: pre }, { version: V })).reading;
    check('an entry before 09:30 gives the intraday timeframes "entry before the session opened"', INTRADAY.every(tf => p.missing[tf] === 'entry before the session opened'), p.missing);
    check('...while daily and up are still measured', ['1D', '1W', '1M', '3M', '6M'].every(tf => p.status[tf] !== 'missing'), p.status);
    check('...valid to the service\'s checks', R.readingProblems(p, pre).length === 0, R.readingProblems(p, pre));

    // The full combination table: every combination gives one fixed reason per timeframe and passes the checks.
    let combos = 0, bad = [];
    for (const minute of ['ok', 'empty', 'refused', 'gap']) for (const daily of ['ok', 'refused']) for (const monthly of ['ok', 'empty']) for (const withPrint of [true, false]) {
      behave = { minute, daily, monthly };
      const a = (await measure(withPrint ? { price: priceAt(ENTRY), atMs: ENTRY } : null)).reading;
      const b = (await measure(withPrint ? { price: priceAt(ENTRY), atMs: ENTRY } : null)).reading;
      combos++;
      if (JSON.stringify(a.missing) !== JSON.stringify(b.missing)) bad.push(['not deterministic', minute, daily, monthly, withPrint]);
      if (R.readingProblems(a, ENTRY).length) bad.push([minute, daily, monthly, withPrint, R.readingProblems(a, ENTRY)[0]]);
    }
    check(`all ${combos} combinations: deterministic, one valid reason per missing timeframe`, bad.length === 0, bad);
  }

  console.log('\n--- A4. the service rejects malformed readings ---');
  {
    behave = {};
    const good = (await measure({ price: priceAt(ENTRY), atMs: ENTRY })).reading;
    const mut = f => { const r = JSON.parse(JSON.stringify(good)); f(r); return R.readingProblems(r, ENTRY); };
    check('a missing status is caught', mut(r => { delete r.status['1H']; }).length > 0);
    check('an unknown status is caught', mut(r => { r.status['1H'] = 'by-design'; }).length > 0);
    check('complete=true with a missing timeframe is caught', mut(r => { r.status['1H'] = 'missing'; r.missing['1H'] = 'data did not contain this bar'; }).length > 0);
    check('a missing timeframe without a reason is caught', mut(r => { r.status['1H'] = 'missing'; r.complete = false; r.run = r.confirmed = r.direction = null; r.timeframesInRun = []; delete r.grid['1H']; }).length > 0);
    check('a reason for a measured timeframe is caught', mut(r => { r.missing['1H'] = 'x'; }).length > 0);
    check('an incomplete reading carrying a verdict is caught', mut(r => { r.status['1H'] = 'missing'; r.complete = false; r.missing['1H'] = 'data did not contain this bar'; delete r.grid['1H']; }).length > 0);
    check('a verdict that disagrees with the statuses is caught', mut(r => { r.run = 4; }).length > 0);
    check('a grid that disagrees is caught', mut(r => { r.grid['1H'] = 'bear'; }).length > 0);
    check('a complete reading without a price is caught', mut(r => { r.priceAtEntry = null; r.priceSource = null; r.priceTime = null; }).length > 0);
    check('an exact print outside the entry second is caught', mut(r => { r.priceTime = ENTRY - 5000; }).length > 0);
    check('a reason breaking the precedence is caught ("no price" with a price)', mut(r => { r.status['1D'] = 'missing'; r.missing['1D'] = 'no price at entry'; r.complete = false; r.run = r.confirmed = r.direction = null; r.timeframesInRun = []; delete r.grid['1D']; }).length > 0);
    check('a reason in no allowed form is caught', mut(r => { r.status['1D'] = 'missing'; r.missing['1D'] = 'who knows'; r.complete = false; r.run = r.confirmed = r.direction = null; r.timeframesInRun = []; delete r.grid['1D']; }).length > 0);
    check('a reading without a rule version is caught', mut(r => { r.version = null; }).length > 0);
  }

  // ===================== B. CYCLES =====================
  // A store with the same contract as tradeStore (updateState, getState), in memory.
  const mem = () => { let st = { pending: [] }; return {
    getState: async () => JSON.parse(JSON.stringify(st)),
    updateState: async f => { const next = await f(JSON.parse(JSON.stringify(st))); if (next != null) st = next; return st; },
    peek: () => st, set: s => { st = s; },
  }; };
  behave = { daily: 'refused' };
  const incomplete = (await measure({ price: priceAt(ENTRY), atMs: ENTRY })).reading;
  behave = {};
  const complete = (await measure({ price: priceAt(ENTRY), atMs: ENTRY })).reading;
  const base = { version: V, open: 'O1', close: 'C1', ticker: 'SPY', entryTimestamp: ENTRY };

  console.log('\n--- B1. attempt 0 ---');
  {
    const a = R.startCycle({ ...base, reading: complete, now: 1000 });
    check('a complete first reading needs no retry record', a.record === null && a.envelope.kind === 'retry' && a.envelope.attempts.length === 1);
    const b = R.startCycle({ ...base, reading: incomplete, now: 1000 });
    check('an incomplete one gets a record: T0 = now, first retry due T0 + 5 min', b.record && b.record.t0 === 1000 && b.record.nextAt === 1000 + 5 * 60e3 && b.record.counter === 0);
    const c = R.startCycle({ ...base, reading: null, now: 1000 });
    check('an unmeasured trade gets attempt 0 "interrupted" ("not measured during the sync") and a record',
      c.envelope.attempts[0].outcome === 'interrupted' && c.envelope.attempts[0].reason === 'not measured during the sync' && !!c.record);
  }

  console.log('\n--- B2. the schedule: 5 min, 30 min, 2 h from T0; at most 3; final ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { [R.cycleKey(V, 'O1', 'C1')]: record } });
    const calls = [];
    const run = (t, reading = incomplete) => R.runFtfcRetries({ store: s, version: V, now: () => t, measure: async () => { calls.push(t); return reading; } });
    await run(4 * 60e3);
    check('nothing at 4 minutes', calls.length === 0);
    await run(5 * 60e3);
    check('attempt 1 at 5 minutes', calls.length === 1 && s.peek().ftfcRetry[R.cycleKey(V, 'O1', 'C1')].counter === 1);
    await run(20 * 60e3);
    check('nothing at 20 minutes', calls.length === 1);
    await run(30 * 60e3);
    check('attempt 2 at 30 minutes', calls.length === 2);
    await run(120 * 60e3);
    const rec = s.peek().ftfcRetry[R.cycleKey(V, 'O1', 'C1')];
    check('attempt 3 at 2 hours, then closed EXHAUSTED_READING', calls.length === 3 && rec.closed && rec.closedCode === 'EXHAUSTED_READING');
    const env = s.peek().ftfcUpdates[0];
    check('one waiting update: kind final, code EXHAUSTED_READING, all 4 attempts, highestSeq 3',
      s.peek().ftfcUpdates.length === 1 && env.kind === 'final' && env.finalCode === 'EXHAUSTED_READING' && env.attempts.length === 4 && env.highestSeq === 3, env && { kind: env.kind, code: env.finalCode, n: env.attempts.length });
    await run(500 * 60e3);
    check('never a fourth attempt', calls.length === 3);
  }

  console.log('\n--- B3. an outage: one attempt per tick, never more than three ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { k: record } });
    let n = 0;
    const run = t => R.runFtfcRetries({ store: s, version: V, now: () => t, measure: async () => { n++; return incomplete; } });
    await run(4 * 3600e3);
    check('back after 4 hours: ONE attempt this tick', n === 1);
    await run(4 * 3600e3 + 60e3);
    check('next attempt waits at least 5 minutes after the previous closed', n === 1);
    await run(4 * 3600e3 + 5 * 60e3);
    await run(4 * 3600e3 + 10 * 60e3);
    await run(4 * 3600e3 + 15 * 60e3);
    check('three attempts in total, however overdue', n === 3 && s.peek().ftfcRetry.k.closed);
  }

  console.log('\n--- B4. a complete retry closes the cycle ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { k: record } });
    await R.runFtfcRetries({ store: s, version: V, now: () => 5 * 60e3, measure: async () => complete });
    const rec = s.peek().ftfcRetry.k, env = s.peek().ftfcUpdates[0];
    check('closed as complete after attempt 1', rec.closed && rec.closedCode === 'complete' && rec.counter === 1);
    check('the update is kind "retry" with both attempts, the complete reading last', env.kind === 'retry' && env.attempts.length === 2 && env.attempts[1].reading.complete === true);
  }

  console.log('\n--- B5. five per tick, oldest first ---');
  {
    const s = mem(); const recs = {};
    for (let i = 0; i < 7; i++) { const r = R.startCycle({ ...base, open: 'O' + i, close: 'C' + i, reading: incomplete, now: i * 1000 }).record; recs['k' + i] = r; }
    s.set({ pending: [], ftfcRetry: recs });
    const seen = [];
    await R.runFtfcRetries({ store: s, version: V, now: () => 3600e3, measure: async rec => { seen.push(rec.open); return incomplete; } });
    check('7 due: 5 run, oldest first', seen.join(',') === 'O0,O1,O2,O3,O4', seen);
    await R.runFtfcRetries({ store: s, version: V, now: () => 3600e3 + 60e3, measure: async rec => { seen.push(rec.open); return incomplete; } });
    check('the other 2 at the next tick', seen.slice(5).join(',') === 'O5,O6', seen);
  }

  console.log('\n--- B6. an interrupted attempt: spent, recorded, never repeated for free ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    record.counter = 1; record.inflight = { seq: 1, startedAt: 5 * 60e3 };      // started, then the service died
    s.set({ pending: [], ftfcRetry: { k: record } });
    let n = 0;
    await R.runFtfcRetries({ store: s, version: V, now: () => 14 * 60e3, measure: async () => { n++; return incomplete; } });
    check('not yet interrupted at 9 minutes', !s.peek().ftfcRetry.k.attempts.find(a => a.seq === 1));
    await R.runFtfcRetries({ store: s, version: V, now: () => 16 * 60e3, measure: async () => { n++; return incomplete; } });
    const rec = s.peek().ftfcRetry.k;
    const a1 = rec.attempts.find(a => a.seq === 1);
    check('after 10 minutes: attempt 1 INTERRUPTED, reason "the service stopped during this attempt"', a1 && a1.outcome === 'interrupted' && a1.reason === 'the service stopped during this attempt', a1);
    check('the counter did not go back: attempt 1 stays spent', rec.counter === 1 && n === 0);
    check('attempt 2 due at max(T0+30 min, closed+5 min)', rec.nextAt === Math.max(30 * 60e3, 16 * 60e3 + 5 * 60e3), rec.nextAt);
    check('an update was queued with the interrupted entry', s.peek().ftfcUpdates.length === 1 && s.peek().ftfcUpdates[0].attempts[1].outcome === 'interrupted');
    // Attempt 3 interrupted -> final EXHAUSTED_INTERRUPTED.
    rec.counter = 3; rec.inflight = { seq: 3, startedAt: 200 * 60e3 }; rec.attempts.push({ seq: 2, outcome: 'reading', reading: incomplete, closedAt: 1 });
    rec.attempts.sort((x, y) => x.seq - y.seq);
    s.set({ ...s.peek(), ftfcRetry: { k: rec } });
    await R.runFtfcRetries({ store: s, version: V, now: () => 211 * 60e3, measure: async () => incomplete });
    const env = s.peek().ftfcUpdates[0];
    check('attempt 3 interrupted ends the cycle: final EXHAUSTED_INTERRUPTED, with the reason', env.kind === 'final' && env.finalCode === 'EXHAUSTED_INTERRUPTED' && env.attempts[3].reason === 'the service stopped during this attempt', env);
  }

  console.log('\n--- B7. a result that lands after the record moved on is discarded ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { k: record } });
    await R.runFtfcRetries({ store: s, version: V, now: () => 5 * 60e3, measure: async () => {
      const st = s.peek(); st.ftfcRetry.k.closed = true; st.ftfcRetry.k.closedCode = 'SUPERSEDED'; st.ftfcRetry.k.inflight = null; return complete; } });
    check('the late result did not land', !(s.peek().ftfcUpdates || []).length && s.peek().ftfcRetry.k.attempts.length === 1);
  }

  console.log('\n--- B8. a measurement that throws is an interrupted attempt with its reason ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { k: record } });
    await R.runFtfcRetries({ store: s, version: V, now: () => 5 * 60e3, measure: async () => { throw new Error('sign-in expired'); } });
    const a1 = s.peek().ftfcRetry.k.attempts[1];
    check('recorded as interrupted: "the attempt failed: sign-in expired"', a1.outcome === 'interrupted' && a1.reason === 'the attempt failed: sign-in expired', a1);
  }

  console.log('\n--- B9. a rule-version change closes old cycles ONCE ---');
  {
    const s = mem();
    const { record } = R.startCycle({ ...base, version: V - 1, reading: incomplete, now: 0 });
    s.set({ pending: [], ftfcRetry: { old: record } });
    let n = 0;
    await R.runFtfcRetries({ store: s, version: V, now: () => 10 * 60e3, measure: async () => { n++; return incomplete; } });
    const env = s.peek().ftfcUpdates;
    check('closed SUPERSEDED with ONE final for the old version, no attempt made', env.length === 1 && env[0].finalCode === 'SUPERSEDED' && env[0].version === V - 1 && n === 0 && s.peek().ftfcRetry.old.closedCode === 'SUPERSEDED');
    await R.runFtfcRetries({ store: s, version: V, now: () => 20 * 60e3, measure: async () => { n++; return incomplete; } });
    check('nothing more is ever sent for it', s.peek().ftfcUpdates.length === 1 && n === 0);
  }

  console.log('\n--- B10. one waiting update per cycle identity; versions kept apart; closed records expire ---');
  {
    let st = { ftfcUpdates: [] };
    const e = (v, seq) => ({ version: v, open: 'O', close: 'C', kind: 'retry', highestSeq: seq, attempts: [] });
    st.ftfcUpdates = R.putUpdate(st, e(V, 1));
    st.ftfcUpdates = R.putUpdate(st, e(V, 2));
    check('a newer update for the same cycle replaces the waiting one', st.ftfcUpdates.length === 1 && st.ftfcUpdates[0].highestSeq === 2);
    st.ftfcUpdates = R.putUpdate(st, e(V - 1, 3));
    check('an old-version update does not replace the new-version one: both wait', st.ftfcUpdates.length === 2);
    const s = mem();
    s.set({ pending: [], ftfcRetry: { done: { ...R.startCycle({ ...base, reading: incomplete, now: 0 }).record, closed: true, closedAt: 0, closedCode: 'complete' } } });
    await R.runFtfcRetries({ store: s, version: V, now: () => 31 * 24 * 3600e3, measure: async () => incomplete });
    check('a closed record is deleted after 30 days', !s.peek().ftfcRetry.done);
  }

  // ===================== C. THROUGH THE REAL SYNC, IMPORT AND ROUTES =====================
  const OCC = 'SPY   261009C00575000';
  const EXIT = Date.parse('2026-10-09T15:08:45Z');
  const tx = (id, buy, ms, price, qty, fee) => {
    const gross = +(price * 100 * qty).toFixed(2);
    return { activityId: id, tradeDate: new Date(ms).toISOString(), netAmount: buy ? -(gross + fee) : +(gross - fee).toFixed(2),
      transferItems: [{ instrument: { assetType: 'OPTION', symbol: OCC, underlyingSymbol: 'SPY', putCall: 'CALL' },
        amount: buy ? qty : -qty, price, cost: buy ? -gross : gross, positionEffect: buy ? 'OPENING' : 'CLOSING' }] };
  };
  const reset = () => { for (const k of Object.keys(store)) delete store[k]; writeState({ openLegs: [], pending: [], lastProcessedIds: [] }); tokens.last_transaction_check = null; };
  const syncTrade = async () => {
    schwabTxs = [tx(900000000001, true, ENTRY, 1.25, 2, 1.32)];
    await cron.runSyncCheck();
    schwabTxs = [tx(900000000001, true, ENTRY, 1.25, 2, 1.32), tx(900000000002, false, EXIT, 1.80, 2, 1.32)];
    await cron.runSyncCheck();
    return readState();
  };

  console.log('\n--- C1. live sync, incomplete reading: envelope AND retry record in the same write ---');
  {
    reset(); alpacaOn = true; print = { price: priceAt(ENTRY), at: ENTRY }; behave = { daily: 'refused' };
    const st = await syncTrade();
    const t = (st.pending || [])[0] || {};
    check('the waiting trade is marked ftfcProtocol 1, origin "live"', t.ftfcProtocol === 1 && t.ftfcOrigin === 'live', { p: t.ftfcProtocol, o: t.ftfcOrigin });
    check('it carries a "retry" envelope with attempt 0 = the incomplete reading', t.ftfcEnvelope && t.ftfcEnvelope.kind === 'retry' && t.ftfcEnvelope.attempts[0].reading && t.ftfcEnvelope.attempts[0].reading.complete === false);
    check('...whose 1D reason is Schwab\'s refusal', t.ftfcEnvelope && t.ftfcEnvelope.attempts[0].reading.missing['1D'] === 'Schwab refused (status 429)');
    const key = R.cycleKey(V, String(t.fills[0]), String(t.fills[1]));
    check('the retry record exists in the SAME saved state', !!(st.ftfcRetry && st.ftfcRetry[key]) && st.ftfcRetry[key].counter === 0);
    check('no loose copy of the reading beside the envelope', !('ftfcReading' in t));
    check('the exact print was used, with its time', t.ftfcEnvelope.attempts[0].reading.priceSource === 'exact-print');

    // The tick, 5 minutes later, with Schwab answering again.
    behave = {};
    const rec = st.ftfcRetry[key];
    rec.nextAt = 0; writeState({ ...readState(), ftfcRetry: { [key]: rec } });
    await cron.runFtfcRetryTick();
    const after = readState();
    check('the real tick re-measured: the record is closed complete', after.ftfcRetry[key].closed && after.ftfcRetry[key].closedCode === 'complete', after.ftfcRetry[key]);
    const up = (after.ftfcUpdates || [])[0];
    check('one waiting update with both attempts, the second complete', up && up.attempts.length === 2 && up.attempts[1].reading.complete === true);
    alpacaOn = false; print = null;
  }

  console.log('\n--- C2. live sync, complete reading: no retry record ---');
  {
    reset(); alpacaOn = true; print = { price: priceAt(ENTRY), at: ENTRY }; behave = {};
    const st = await syncTrade();
    const t = (st.pending || [])[0] || {};
    check('complete attempt 0 in the envelope', t.ftfcEnvelope && t.ftfcEnvelope.attempts[0].reading.complete === true);
    check('no retry record', !st.ftfcRetry || Object.keys(st.ftfcRetry).length === 0, st.ftfcRetry);
    alpacaOn = false; print = null;
  }

  console.log('\n--- C3. the history import: origin "history", kind "single", never a cycle ---');
  {
    reset(); behave = { daily: 'refused' };
    schwabTxs = [tx(900000000001, true, ENTRY, 1.25, 2, 1.32), tx(900000000002, false, EXIT, 1.80, 2, 1.32)];
    await cron.runBackfill(30);
    const st = readState();
    const t = (st.pending || [])[0] || {};
    check('marked ftfcProtocol 1, origin "history"', t.ftfcProtocol === 1 && t.ftfcOrigin === 'history', t);
    check('a "single" envelope: one entry, seq 0, a reading, no finalCode', t.ftfcEnvelope && t.ftfcEnvelope.kind === 'single' && t.ftfcEnvelope.attempts.length === 1 && t.ftfcEnvelope.attempts[0].seq === 0 && !('finalCode' in t.ftfcEnvelope));
    check('NO retry record from a history import, even for an incomplete reading', !st.ftfcRetry || Object.keys(st.ftfcRetry).length === 0, st.ftfcRetry);
    // Before measurement an item carries no envelope (it is contradictory on the phone, by design).
    behave = {};
  }

  console.log('\n--- C4. a reset keeps live retry cycles and their updates ---');
  {
    writeState({ openLegs: [], pending: [{ id: 'x' }], lastProcessedIds: ['1'], ftfcRetry: { k: { closed: false } }, ftfcUpdates: [{ version: V }] });
    await cron.resetSyncState();
    const st = readState();
    check('pending emptied, retry records and updates kept', st.pending.length === 0 && st.ftfcRetry && st.ftfcRetry.k && st.ftfcUpdates.length === 1);
  }

  console.log('\n--- C5. the routes: list, and remove ONLY on an exact match ---');
  {
    const express = require('express');
    stubs['./appKey'] = { keyOk: () => true, requireAppKey: (req, res, next) => next(), keyCheck: () => ({ ok: true }) };
    delete require.cache[require.resolve(path.join(BACKEND, 'api.js'))];
    const api = require(path.join(BACKEND, 'api.js'));
    const app = express(); app.use(express.json()); app.use('/api', api);
    const server = await new Promise(r => { const sv = app.listen(0, () => r(sv)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const env = (v, seq) => ({ version: v, open: 'O', close: 'C', kind: 'retry', highestSeq: seq, attempts: [] });
    writeState({ pending: [], ftfcUpdates: [env(V, 2), env(V - 1, 3)] });
    const list = await (await fetch(base + '/ftfc/updates')).json();
    check('GET lists the waiting updates', list.updates.length === 2 && list.waiting === 2);
    let r = await (await fetch(`${base}/ftfc/updates?version=${V}&fills=O,C&seq=1`, { method: 'DELETE' })).json();
    check('a stale seq (1, while 2 waits) removes nothing', r.removed === 0 && readState().ftfcUpdates.length === 2);
    r = await (await fetch(`${base}/ftfc/updates?version=${V}&fills=O,X&seq=2`, { method: 'DELETE' })).json();
    check('a wrong pair removes nothing', r.removed === 0);
    r = await (await fetch(`${base}/ftfc/updates?version=${V}&fills=O,C&seq=2`, { method: 'DELETE' })).json();
    check('the exact version, pair and seq removes exactly that one', r.removed === 1 && readState().ftfcUpdates.length === 1 && readState().ftfcUpdates[0].version === V - 1);
    const bad = await fetch(`${base}/ftfc/updates?fills=O,C`, { method: 'DELETE' });
    check('a removal that does not name the update exactly is refused (400)', bad.status === 400);
    server.close();
  }

  console.log('\n--- C6. the service writes Fix-1 records only where the plan says ---');
  {
    const src = f => fs.readFileSync(path.join(BACKEND, f), 'utf8');
    const writers = ['cron.js', 'api.js', 'server.js', 'tradeStore.js', 'aiRoutes.js', 'media.js'].filter(f => fs.existsSync(path.join(BACKEND, f)))
      .filter(f => /ftfcRetry\s*[:=]|ftfcUpdates\s*[:=]/.test(src(f)));
    check('only cron.js (sync write, reset) and api.js (the removal route) touch retry records or updates outside ftfcRetry.js',
      writers.every(f => f === 'cron.js' || f === 'api.js'), writers);
    const cronFtfcWrites = (src('cron.js').match(/trade\.ftfc\w*\s*=[^=]/g) || []).length;
    check(`cron.js writes FTFC fields only in enrichWithFtfc (${cronFtfcWrites} assignments, all inside it)`,
      (() => { const s = src('cron.js'); const a = s.indexOf('async function enrichWithFtfc('); const b = s.indexOf('\n}\n', a);
        const inside = (s.slice(a, b).match(/trade\.ftfc\w*\s*=[^=]/g) || []).length; return inside === cronFtfcWrites; })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
