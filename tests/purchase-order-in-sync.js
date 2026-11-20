// Step 1B inside the REAL sync: the purchase record is written BEFORE the
// save that makes a trade collectible (P0), confirmed AFTER it (P1), the
// repair sweep reads the record as it is now (P3), and the Pushcut alert is
// still sent exactly as before (B13). A purchase from before the switch-on
// gets nothing, and a failing purchase store never blocks the import.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };

const store = {};
const order = [];
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); if (k === 'trades:state') order.push('save'); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
};
const standIn = require('./lib/gen1SaveStandIn').gen1SaveVia(fakeRedis);
fakeRedis.eval = async (...a) => { const r = await standIn(...a); order.push('save'); return r; };
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;

let switchOn = 0;
let purchasesFail = false;
const purchases = {
  beforeSave: async (legs, o) => { order.push('P0:' + legs.map(l => l.openFillId).join(',')); if (purchasesFail) throw new Error('store down'); return { created: legs.length, failed: 0 }; },
  afterSave: async (legs, o) => { order.push('P1:' + legs.map(l => l.openFillId).join(',')); if (purchasesFail) throw new Error('store down'); },
  sweep: async (state, o) => { order.push('P3:' + ((state.openLegs || []).length + (state.pending || []).length)); },
  currentAnswer: async () => null, recentAnswers: async () => [],
};
const pushcut = [];
const tokens = { last_transaction_check: null };
const OCC = 'SPY   261231C00600000';
let txs = [];
const tx = (id, buy, minutesAgo) => ({
  activityId: id, tradeDate: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  netAmount: buy ? -100.66 : 99.34,
  transferItems: [{ instrument: { assetType: 'OPTION', symbol: OCC, underlyingSymbol: 'SPY', putCall: 'CALL' },
    amount: buy ? 1 : -1, price: 1, cost: buy ? -100 : 100, positionEffect: buy ? 'OPENING' : 'CLOSING' }],
});
const stubs = {
  axios: { get: async url => {
    if (/accountNumbers$/.test(url)) return { data: [{ accountNumber: '0', hashValue: 'H' }] };
    if (/transactions$/.test(url)) return { data: JSON.parse(JSON.stringify(txs)) };
    throw new Error('unexpected ' + url);
  } },
  '@upstash/redis': { Redis }, 'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': { getUnderlyingPriceAt: async () => 500, getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }) },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async l => { pushcut.push(l.openFillId); }, notifyTradeStillOpen: async () => {} },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
  './purchases': purchases,
  './setupSwitch': { switchOnAt: async () => switchOn },
};
const origLoad = Module._load;
Module._load = function (req) { if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req]; return origLoad.apply(this, arguments); };
const cron = require(path.join(BACKEND, 'cron.js'));
const reset = () => { for (const k of Object.keys(store)) delete store[k]; store['trades:state'] = JSON.stringify({ openLegs: [], pending: [], lastProcessedIds: [] }); order.length = 0; pushcut.length = 0; tokens.last_transaction_check = null; };

(async () => {
  // 1. A purchase: P0 before the save, P1 after, then the sweep.
  reset(); switchOn = Date.now() - 86400000; txs = [tx('5550001', true, 30)];
  await cron.runSyncCheck();
  const iP0 = order.findIndex(o => o.startsWith('P0:')), iSave = order.indexOf('save'), iP1 = order.findIndex(o => o.startsWith('P1:'));
  check('P0 runs before the save that makes the trade collectible', iP0 >= 0 && iSave > iP0, order);
  check('P1 runs after the save', iP1 > iSave, order);
  check('P0 and P1 name the opening fill', order[iP0] === 'P0:5550001' && order[iP1] === 'P1:5550001', order);
  check('P3 sweeps the record as it is now', order.some(o => o.startsWith('P3:')), order);
  check('B13 the Pushcut "opened" alert is sent exactly as before', pushcut.length === 1 && pushcut[0] === '5550001', pushcut);

  // 2. A purchase and its sale in the same check.
  reset(); txs = [tx('5550002', true, 30), tx('5550003', false, 20)];
  await cron.runSyncCheck();
  check('B21 same-tick open and close: P0 still runs before the save', order.findIndex(o => o === 'P0:5550002') >= 0 && order.indexOf('save') > order.findIndex(o => o === 'P0:5550002'), order);
  const st = JSON.parse(store['trades:state']);
  check('B21 and the trade is queued as usual', st.pending.length === 1 && st.pending[0].fills[0] === '5550002', st.pending);

  // 3. The purchase store fails: the import is not blocked.
  reset(); purchasesFail = true; txs = [tx('5550004', true, 30), tx('5550005', false, 20)];
  await cron.runSyncCheck();
  const st2 = JSON.parse(store['trades:state']);
  check('a failing purchase store never blocks the trade import', st2.pending.length === 1 && st2.pending[0].fills[0] === '5550004', st2.pending);
  check('B13 and the Pushcut alert is still sent', pushcut.includes('5550004'));
  purchasesFail = false;

  // 4. The switch-on cannot be read: no purchase work at all, import as before.
  reset(); switchOn = null; txs = [tx('5550006', true, 30)];
  await cron.runSyncCheck();
  check('no switch-on moment: no purchase records are touched', !order.some(o => /^P[013]/.test(o)), order);
  check('and the purchase is still saved as an open leg', JSON.parse(store['trades:state']).openLegs.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASHED', e); process.exit(1); });
