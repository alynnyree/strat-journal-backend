// GOAL-SHEET CHECK -- the owner's seven handwritten fields, through the REAL
// server code (his goal sheet, 11 Oct 2026). Changes no file and
// reaches no network (Schwab, market data, Gemini, Pushcut and storage are
// all stand-ins at the edge). What runs for real: schwabClient
// (getOptionFills), matcher (pairing), cron (the sync and every enrichment
// step), ftfcCheck (underlying price and the 13-timeframe FTFC reading),
// aiClient (the play classification and its confidence bar).
//
// A mock trade (one purchase, one sale, as Schwab sends them) goes in at the
// network; the trade the sync queues for the phone is read back and each of
// the seven fields is checked against a value worked out independently here.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const BACKEND = process.env.BACKEND || path.join(__dirname, '..');
const APP = process.env.APP || path.join(__dirname, '..', '..', 'strat-journal-app');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.GEMINI_API_KEY = 'stand-in';

let pass = 0, fail = 0;
const check = (label, ok, detail) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); } };

// ---- storage stand-in
const store = {};
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
  lpush: async () => 1, lrange: async () => [], lrem: async () => 0, ltrim: async () => 'OK', rpop: async () => null,
  mget: async (...ks) => ks.map(k => (k in store ? JSON.parse(store[k]) : null)),
};
// Deploy 2 (queue plan v14.1 rev 3.2): "trades:state" is read and saved only by
// scripts now; the stand-in answers them (tests/lib/gen2StandIn.js).
const G2 = require('./lib/gen2StandIn');
fakeRedis.eval = G2.gen2Via(fakeRedis);
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const readState = () => (store['trades:state'] ? JSON.parse(store['trades:state']) : null);

// ---- market stand-in: one price path, minute by minute, from which every
// candle of every size is built (open = price at its start, close = price at
// its end). RISING: every timeframe is bullish at entry. FLAT: none is.
let market = 'rising';
const T0 = Date.parse('2024-01-01T00:00:00Z');
const priceAt = ms => market === 'flat' ? 500 : +(400 + (ms - T0) / 60000 * 0.0001).toFixed(6);
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
function priceHistory(p) {
  const end = Number(p.endDate) || Date.now();
  if (p.frequencyType === 'minute') return candles(end, Number(p.frequency), Math.ceil(Number(p.period) * 24 * 60 / Number(p.frequency)));
  if (p.frequencyType === 'daily') return candles(end, 24 * 60, 500);
  if (p.frequencyType === 'weekly') return candles(end, 7 * 24 * 60, 120);
  return candles(end, 30 * 24 * 60, 40); // monthly
}

// ---- the mock trade: what Schwab's transactions endpoint sends
const OCC = 'SPY   261009C00575000';
const ENTRY_MS = Date.parse('2026-10-09T14:31:30Z');   // Fri 9 Oct 2026, 10:31:30 New York
const EXIT_MS = Date.parse('2026-10-09T15:08:45Z');    // 11:08:45 New York
const tx = (id, buy, ms, price, qty, fee) => {
  const gross = +(price * 100 * qty).toFixed(2);
  return {
    activityId: id, tradeDate: new Date(ms).toISOString(),
    netAmount: buy ? -(gross + fee) : +(gross - fee).toFixed(2),
    transferItems: [{ instrument: { assetType: 'OPTION', symbol: OCC, underlyingSymbol: 'SPY', putCall: 'CALL' },
      amount: buy ? qty : -qty, price, cost: buy ? -gross : gross, positionEffect: buy ? 'OPENING' : 'CLOSING' }],
  };
};
let schwabTxs = [];
let geminiAnswer = null;
const asked = [];
const axios = {
  get: async (url, opts = {}) => {
    asked.push(url);
    if (/\/accounts\/accountNumbers$/.test(url)) return { data: [{ accountNumber: '000', hashValue: 'HASH-A' }] };
    if (/\/accounts\/[^/]+\/transactions$/.test(url)) return { data: JSON.parse(JSON.stringify(schwabTxs)) };
    if (/\/pricehistory$/.test(url)) return { data: { candles: priceHistory(opts.params || {}) } };
    throw new Error('unexpected GET ' + url);
  },
  post: async (url) => {
    asked.push(url);
    if (/generativelanguage|gemini/i.test(url)) return { data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(geminiAnswer) }] } }] } };
    throw new Error('unexpected POST ' + url);
  },
};

// ---- picture/video trigger spies (field 5)
const alerts = [];
const browserEvents = [];
const tokens = { last_transaction_check: null };
const stubs = {
  axios, '@upstash/redis': { Redis }, 'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
  './alpacaClient': { isReady: async () => false, isConfigured: () => false, underlyingPriceAt: async () => null, fetchBars: async () => [] },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './pushcut': {
    notifyTradeClosed: async t => { alerts.push({ kind: 'closed', trade: t }); },
    notifyTradeOpened: async l => { alerts.push({ kind: 'opened', leg: l }); },
    notifyTradeStillOpen: async () => {}, notifySignInExpiring: async () => {}, lastPhoneAlert: async () => null,
  },
  './browserEvents': { queueBrowserEvent: async (kind, payload) => { browserEvents.push({ kind, payload }); } },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const cron = require(path.join(BACKEND, 'cron.js'));
const { PLAYS } = require(path.join(BACKEND, 'aiClient.js'));

const ny = ms => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
};
const reset = () => { for (const k of Object.keys(store)) delete store[k]; store['trades:state'] = JSON.stringify(G2.expanded({ openLegs: [], pending: [], lastProcessedIds: [] })); store['{trades:state}:fence'] = JSON.stringify('2'); tokens.last_transaction_check = null; alerts.length = 0; browserEvents.length = 0; };

// The owner's sheet, item 7, matched to the app's three play names.
const SHEET = {
  a: { sheet: '"2" candlestick turns into a 3', key: '2s Turning Into 3s' },
  b: { sheet: 'Broadening Formation drawn on ANY higher timeframe, scalp on ANY smaller one (owner, 11 Oct: e.g. 4HR/15min, 1HR/5min)', key: 'Broadening Formation Scalp' },
  c: { sheet: 'Strat setup in direction of FTFC after taking out pivot/liquidity looking to reverse (T1 setup completion, T2 gap/major pivot)', key: 'FTFC Direction Play' },
};

async function runTrade(play, playConfidence = 'high') {
  reset();
  geminiAnswer = { strategy: 'unclear', confidence: 'low', reasoning: 'stand-in', play, playConfidence, playReasoning: 'stand-in', notation: 'unclear', broadeningFormation: 'unclear' };
  schwabTxs = [tx(900000000001, true, ENTRY_MS, 1.25, 2, 1.32)];
  await cron.runSyncCheck();                                    // the purchase arrives
  schwabTxs = [tx(900000000001, true, ENTRY_MS, 1.25, 2, 1.32), tx(900000000002, false, EXIT_MS, 1.80, 2, 1.32)];
  await cron.runSyncCheck();                                    // the sale arrives: the trade is formed
  return readState();
}

(async () => {
  try {
    // Generation 2: this process raises the fence and expands the record first.
    await require(path.join(BACKEND, 'tradeStore.js')).startGeneration2({ pauseMs: 0 });
    // ================= RISING market, the play answered "2s Turning Into 3s"
    market = 'rising';
    const st = await runTrade(SHEET.a.key);
    const t = st && st.pending && st.pending[0];
    check('one trade formed from the mock purchase and sale', st && st.pending.length === 1 && t, st);
    if (!t) throw new Error('no trade formed -- nothing further can be checked');
    const eNY = ny(ENTRY_MS), xNY = ny(EXIT_MS);

    console.log('\n--- 1. Time of entry & exit (automatic) ---');
    check(`entry time ${t.entryTime} = ${eNY.time} New York`, t.entryTime === eNY.time, t);
    check(`exit time ${t.exitTime} = ${xNY.time} New York`, t.exitTime === xNY.time, t);
    check('exact fill instants kept (to the second)', t.entryTimestamp === ENTRY_MS && t.exitTimestamp === EXIT_MS, { e: t.entryTimestamp, x: t.exitTimestamp });

    console.log('\n--- 2. Date of entry & exit (automatic) ---');
    check(`entry date ${t.entryDate} = ${eNY.date}`, t.entryDate === eNY.date);
    check(`exit date ${t.exitDate} = ${xNY.date}`, t.exitDate === xNY.date);

    console.log('\n--- 3. Contract price at entry & exit (automatic) ---');
    check(`entry price ${t.optEntry} = 1.25`, t.optEntry === 1.25);
    check(`exit price ${t.optExit} = 1.80`, t.optExit === 1.8);
    check(`contracts ${t.contracts} = 2`, t.contracts === 2);
    check(`profit before fees ${t.pnlDollar} = (1.80-1.25) x 100 x 2 = 110.00`, Math.abs(t.pnlDollar - 110) < 1e-9, t.pnlDollar);
    check(`fees ${t.fees} = 1.32 + 1.32 = 2.64 (from the cash)`, Math.abs(t.fees - 2.64) < 1e-9, t.fees);

    console.log('\n--- 4. Underlying stock price at entry & exit (automatic; a RECONSTRUCTION, see note) ---');
    // The app's documented rule: the close of the last 1-minute candle
    // starting at or before the fill. With the fill at :30 that is the
    // candle containing the fill, whose close is 30 s after it.
    const minuteStart = ms => Math.floor(ms / 60000) * 60000;
    const expEntry = priceAt(minuteStart(ENTRY_MS) + 60000), expExit = priceAt(minuteStart(EXIT_MS) + 60000);
    check(`underlying at entry ${t.undEntry} = ${expEntry}`, t.undEntry === expEntry, t.undEntry);
    check(`underlying at exit ${t.undExit} = ${expExit}`, t.undExit === expExit, t.undExit);
    check('each price says where it came from (schwab-candle, not exact)', t.undEntrySource === 'schwab-candle' && t.undEntryExact === false && t.undExitSource === 'schwab-candle');

    console.log('\n--- 5. Screenshot / video capture triggered (automatic) ---');
    const opened = alerts.filter(a => a.kind === 'opened'), closed = alerts.filter(a => a.kind === 'closed');
    check('phone alert fired once when the trade OPENED', opened.length === 1 && opened[0].leg.openTimestamp === ENTRY_MS, alerts.map(a => a.kind));
    check('phone alert fired once when the trade CLOSED, for this trade', closed.length === 1 && closed[0].trade.id === t.id);
    check('laptop capture queued at open (timestamp = entry) and at close (timestamp = exit)',
      browserEvents.some(e => e.kind === 'opened' && e.payload.timestamp === ENTRY_MS) && browserEvents.some(e => e.kind === 'closed' && e.payload.timestamp === EXIT_MS), browserEvents);

    console.log('\n--- 6. FTFC status at entry ---');
    const label = x => x.ftfcConfirmed === true ? 'FTFC' : x.ftfcConfirmed === false ? 'NO FTFC' : 'NOT MEASURED';
    // A fill at 10:31:30. Only the 1-minute may be blank (by design: at minute
    // resolution the entry minute's own open IS the price at entry). Before
    // the 11 Oct fix, 3m-1H were blank too and the run was 7.
    const blankIntraday = ['1m','3m','5m','15m','30m','1H','2H','4H'].filter(k => !(t.ftfc || {})[k]);
    check(`rising market: ${label(t)} (run ${t.ftfcRun}, ${t.ftfcDirection}), blank intraday: ${blankIntraday.join(',') || 'none'} -> "FTFC", only 1m blank`,
      label(t) === 'FTFC' && blankIntraday.join(',') === '1m' && t.ftfcRun === 12, { run: t.ftfcRun, dir: t.ftfcDirection, tfs: t.ftfc });
    check('the reading names its direction and its rule version', t.ftfcDirection != null && t.ftfcVersion === cron.FTFC_RULE_VERSION);

    console.log('\n--- 7. Active strategy (play) ---');
    check(`play recorded "${t.play}" = sheet 7a "${SHEET.a.key}"`, t.play === SHEET.a.key, t.play);

    // ================= FLAT market -> NO FTFC; other plays; refusals
    market = 'flat';
    const t2 = (await runTrade(SHEET.b.key)).pending[0];
    check(`flat market: ${label(t2)} (run ${t2 && t2.ftfcRun}) -> "NO FTFC"`, t2 && label(t2) === 'NO FTFC', t2 && { run: t2.ftfcRun, tfs: t2.ftfc });
    check(`play recorded "${t2 && t2.play}" = sheet 7b "${SHEET.b.key}"`, t2 && t2.play === SHEET.b.key);
    const t3 = (await runTrade(SHEET.c.key)).pending[0];
    check(`play recorded "${t3 && t3.play}" = sheet 7c "${SHEET.c.key}"`, t3 && t3.play === SHEET.c.key);
    const t4 = (await runTrade('Some Fourth Play')).pending[0];
    check('a play that is NOT one of the three is never recorded', t4 && (t4.play == null), t4 && t4.play);
    const t5 = (await runTrade(SHEET.a.key, 'medium')).pending[0];
    check('a play the reader is not sure of is left blank (for you to pick), never guessed', t5 && t5.play == null, t5 && t5.play);

    console.log('\n--- the three plays: server, app picker and the goal sheet agree ---');
    // The app lives in its own project. When it is not beside this one (as on
    // GitHub), its picker cannot be read here; that is said, not hidden.
    const appFile = path.join(APP, 'index.html');
    const html = fs.existsSync(appFile) ? fs.readFileSync(appFile, 'utf8') : null;
    if (!html) console.log('NOTE: the app is not beside this project, so its play picker is not read here (2 of the checks below use it, and are not run).');
    const picker = !html ? [] : [...html.matchAll(/class="strat-opt play-opt" data-v="([^"]+)"/g)].map(m => m[1]);
    const server = PLAYS.map(p => p.key);
    check(`server has exactly three plays: ${server.join(' | ')}`, server.length === 3);
    if (html) check(`app picker offers the same three: ${picker.join(' | ')}`, picker.length === 3 && picker.every(k => server.includes(k)));
    check('each goal-sheet play maps to one of them', Object.values(SHEET).every(s => server.includes(s.key)));
    const bfDesc = PLAYS.find(p => p.key === SHEET.b.key).desc;
    check('7b rule: ANY higher-timeframe formation with a scalp on ANY smaller timeframe, no fixed minutes (owner, 11 Oct)',
      /HIGHER timeframe chart/.test(bfDesc) && /SMALLER timeframe chart/.test(bfDesc) && /ANY such pairing qualifies/.test(bfDesc)
      && /No timeframe is fixed/.test(bfDesc) && !/1-minute or 5-minute/.test(bfDesc) && !/30-minute or 1-hour/.test(bfDesc),
      'classifier text: ' + bfDesc.slice(0, 400));
    const pickerText = !html ? null : (html.match(/data-v="Broadening Formation Scalp"[\s\S]*?<div class="d">([^<]*)</) || [])[1] || '';
    // (the picker's wording is checked with the rule, so the card he reads and the AI's instructions cannot drift apart)
    if (pickerText != null) check('the app picker describes 7b the same way (any smaller timeframe, no fixed minutes)', /any smaller one/.test(pickerText) && !/1 or 5 minute/.test(pickerText), pickerText);

    console.log('\n--- nothing left this machine ---');
    check('only stand-in addresses were asked', asked.every(u => /schwabapi|pricehistory|accounts|generativelanguage|gemini/i.test(u)), asked.filter(u => !/schwabapi|pricehistory|accounts|generativelanguage|gemini/i.test(u)));
  } catch (e) {
    fail++; console.log('FAIL: crashed', e && e.stack);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
