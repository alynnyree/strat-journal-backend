// STEP C of the audit's remediation (F1 + H-5), authorized by the owner on
// 6 October 2026: "I authorize Step C implementation."
//
// F1: a fill with no Schwab activityId was named by its ORDER number, which
//     every execution of that order shares -- so a later piece of a partly
//     filled order looked "already handled" and was dropped. R1 says orderId
//     is never an identity: without an activityId the record gets "U-" plus
//     its own fingerprint, the same rule the broker ledger uses.
// H-5: a record with no tradeDate was quietly given Schwab's `time` instead.
//     The tradeDate is the only date; without one there is no fill, and the
//     reason is recorded.
//
// Runs the REAL fill reader (schwabClient.js) and the REAL sync (cron.js)
// with Schwab and storage stood in for. Nothing reaches the network.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.R2_ACCOUNT_ID = 'acct'; process.env.R2_ACCESS_KEY_ID = 'id'; process.env.R2_SECRET_ACCESS_KEY = 'secret';

let pass = 0, fail = 0;
const check = (label, ok) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } };

// ---- Stand-in storage (values through JSON, as on the wire).
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

// ---- Stand-in Schwab, at the level the real reader talks to it.
const schwab = { transactions: [] };
const axios = {
  get: async (url) => {
    if (url.endsWith('/accounts/accountNumbers')) return { data: [{ accountNumber: '1', hashValue: 'H' }] };
    if (url.includes('/transactions')) return { data: JSON.parse(JSON.stringify(schwab.transactions)) };
    throw new Error('unexpected request ' + url);
  },
  create: () => axios,
};

const tokens = { last_transaction_check: null };
const stubs = {
  '@upstash/redis': { Redis },
  axios,
  'node-cron': { schedule: () => ({ stop(){} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': {
    getTokens: async () => ({ ...tokens }),
    setLastCheck: async iso => { tokens.last_transaction_check = iso; },
  },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async () => 500,
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

const { extractOptionFills, getOptionFills } = require(path.join(BACKEND, 'schwabClient.js'));
const { identityOf } = require(path.join(BACKEND, 'brokerLedger.js'));
const cron = require(path.join(BACKEND, 'cron.js'));

// ---- Schwab transaction records, shaped as the trader API returns them.
const OCC = 'SPY   261231C00600000';
function tx(o){
  const legs = o.legs || [{ open: true, qty: 1, price: 1.00 }];
  const gross = legs.reduce((s, l) => s + l.price * 100 * l.qty, 0);
  const buying = legs[0].open;
  const t = {
    activityId: o.activityId,
    orderId: o.orderId,
    accountNumber: '1',
    type: o.type || 'TRADE',
    status: 'VALID',
    subAccount: 'CASH',
    tradeDate: o.tradeDate,
    time: o.time,
    description: o.description,
    netAmount: buying ? -(gross + 0.66) : gross - 0.66,
    transferItems: [
      ...legs.map(l => ({
        instrument: { assetType: 'OPTION', symbol: l.occ || OCC, underlyingSymbol: 'SPY', putCall: 'CALL' },
        amount: l.qty, price: l.price,
        cost: l.open ? -l.price * 100 * l.qty : l.price * 100 * l.qty,
        positionEffect: l.open ? 'OPENING' : 'CLOSING',
      })),
      ...(o.feeLine ? [{ feeType: 'COMMISSION', cost: -0.65, amount: 0 }] : []),
    ],
  };
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
}
// The same object with every key (nested ones too) inserted in reverse.
function reordered(v){
  if (Array.isArray(v)) return v.map(reordered);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).reverse()) out[k] = reordered(v[k]);
    return out;
  }
  return v;
}
const iso = ms => new Date(ms).toISOString().replace('Z', '+0000');
const NOW = Date.now();
const U = /^U-[0-9a-f]{32}$/;

(async () => {
  try {
    // =====================================================================
    console.log('--- identity: an activityId record is unchanged ---');
    {
      const f = extractOptionFills(tx({ activityId: 123456789, orderId: 55, tradeDate: iso(NOW - 3600e3) }))[0];
      check('a numeric activityId is the id, same value and same type', f && f.transactionId === 123456789);
      const g = extractOptionFills(tx({ activityId: '987', orderId: 55, tradeDate: iso(NOW - 3600e3) }))[0];
      check('a text activityId is the id, unchanged', g && g.transactionId === '987');
      check('and it is not marked uncertain', f && !f.identityUncertain);
    }

    // =====================================================================
    console.log('\n--- identity: no activityId means "U-" + fingerprint, never the order number ---');
    {
      const t = tx({ orderId: 555, tradeDate: iso(NOW - 3600e3) });
      const f = extractOptionFills(t)[0];
      check(`the id is "U-" + 32 hex (${f && f.transactionId})`, !!f && U.test(String(f.transactionId)));
      check('it is not the order number', f && f.transactionId !== 555 && f.transactionId !== '555');
      check('it is marked uncertain', f && f.identityUncertain === true);
      check('the order number is kept only as legacyId', f && f.legacyId === 555);
    }

    // =====================================================================
    console.log('\n--- identity: exactly the broker ledger\'s identityOf, on representative records ---');
    {
      const base = NOW - 7200e3;
      const records = [
        ['a normal record', tx({ orderId: 1001, tradeDate: iso(base), time: iso(base) })],
        ['optional fields null', tx({ orderId: 1002, tradeDate: iso(base), time: iso(base), description: null })],
        ['no orderId, no time', tx({ tradeDate: iso(base + 1000) })],
        ['a fee line among the items', tx({ orderId: 1003, tradeDate: iso(base), feeLine: true })],
        ['a closing sale', tx({ orderId: 1004, tradeDate: iso(base), legs: [{ open: false, qty: 2, price: 1.25 }] })],
        ['several option lines', tx({ orderId: 1005, tradeDate: iso(base),
          legs: [{ open: true, qty: 1, price: 1.10 }, { open: true, qty: 3, price: 1.12, occ: 'SPY   261231P00590000' }] })],
        ['another record type', tx({ orderId: 1006, tradeDate: iso(base), type: 'RECEIVE_AND_DELIVER' })],
      ];
      for (const [name, t] of records) {
        const live = (extractOptionFills(t)[0] || {}).transactionId;
        const ledger = identityOf(t).value;
        check(`${name}: live id equals the ledger's, in full (${live})`, live === ledger && U.test(String(live)));
        const swapped = (extractOptionFills(reordered(t))[0] || {}).transactionId;
        check(`${name}: the same with every field in a different order`, swapped === ledger);
      }
      const multi = extractOptionFills(records[5][1]);
      check('every line of one record carries that record\'s one id', multi.length === 2 && multi[0].transactionId === multi[1].transactionId);
    }

    // =====================================================================
    console.log('\n--- identity: two executions of one order are two fills ---');
    {
      const a = extractOptionFills(tx({ orderId: 4242, tradeDate: iso(NOW - 3000e3), legs: [{ open: true, qty: 1, price: 1.00 }] }))[0];
      const b = extractOptionFills(tx({ orderId: 4242, tradeDate: iso(NOW - 2990e3), legs: [{ open: true, qty: 2, price: 1.02 }] }))[0];
      check('they get different ids', a && b && a.transactionId !== b.transactionId);
    }

    // =====================================================================
    console.log('\n--- trade date: never replaced by Schwab\'s time ---');
    {
      const problems = [];
      const none = extractOptionFills(tx({ activityId: 77, time: iso(NOW - 3600e3) }), problems);
      check('no tradeDate: no fill at all', none.length === 0);
      check('and the reason is recorded', problems.length === 1 && /tradeDate/.test(problems[0].reason) && problems[0].id === 77);
      let bad;
      try { bad = extractOptionFills(tx({ activityId: 78, tradeDate: 'not a date', time: iso(NOW - 3600e3) }), []); }
      catch (e) { bad = { threw: e.message }; }
      check(`an unreadable tradeDate: no fill, and no crash (${JSON.stringify(bad)})`, Array.isArray(bad) && bad.length === 0);
      const td = Date.parse('2026-05-04T13:31:00Z');
      const f = extractOptionFills(tx({ activityId: 79, tradeDate: '2026-05-04T13:31:00+0000', time: '2026-05-04T19:45:00+0000' }))[0];
      check('a tradeDate is used even when time differs', f && f.timestamp === td && f.time === '09:31');
    }

    // =====================================================================
    const run = async () => { await cron.runSyncCheck(); return readState(); };
    const fresh = (s) => { for (const k of Object.keys(store)) delete store[k]; writeState(s); tokens.last_transaction_check = null; };
    const ids = st => (st.lastProcessedIds || []).map(String);

    console.log('\n--- changeover: an unusable record is reported, and the checkpoint still moves ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      tokens.last_transaction_check = new Date(NOW - 86400e3).toISOString();
      const before = tokens.last_transaction_check;
      schwab.transactions = [tx({ activityId: 3001, time: iso(NOW - 3600e3) })];
      const st = await run();
      const u = st.lastSync && st.lastSync.unusable;
      check('the record with no tradeDate is listed with its reason', !!u && u.count === 1 && JSON.stringify(u).includes('tradeDate'));
      check('the checkpoint still moves (Schwab answered; the record is unusable)', tokens.last_transaction_check !== before);
      check('the record was not processed', !ids(st).includes('3001'));
    }

    console.log('\n--- changeover: execution B of an order the old code recorded by number IS processed ---');
    {
      // The old code processed execution A of order 777 and wrote down "777".
      fresh({ openLegs: [], pending: [], lastProcessedIds: [777] });
      schwab.transactions = [];
      await run();                                   // the new code's first run notes the changeover
      const st0 = readState();
      check('the changeover moment is recorded once', !!st0.identityCutoverAt);
      // (Without a recorded moment -- the old code -- the test carries on from now.)
      const cut = st0.identityCutoverAt ? Date.parse(st0.identityCutoverAt) : Date.now();
      const B = tx({ orderId: 777, tradeDate: iso(cut + 60e3), legs: [{ open: true, qty: 2, price: 1.05 }] });
      const bId = extractOptionFills(B)[0].transactionId;
      schwab.transactions = [B];
      const st = await run();
      check('execution B is processed under its own U- id, not suppressed by the order number', U.test(String(bId)) && ids(st).includes(String(bId)));
      check('its position is open', (st.openLegs || []).some(l => l.openFillId === String(bId)));
      check('the order number is never written again', ids(st).filter(x => x === '777').length === 1);
      check('the changeover moment did not move', st.identityCutoverAt === st0.identityCutoverAt);
    }

    console.log('\n--- changeover: the old fill itself is not processed twice ---');
    {
      const cut = NOW;
      fresh({ openLegs: [], pending: [], lastProcessedIds: [888], identityCutoverAt: new Date(cut).toISOString() });
      const A = tx({ orderId: 888, tradeDate: iso(cut - 3600e3) });
      const aId = extractOptionFills(A)[0].transactionId;
      schwab.transactions = [A];
      const st = await run();
      check('the one pre-changeover record of order 888 is taken as the one already handled', !ids(st).includes(String(aId)));
      check('no open position was created for it a second time', !(st.openLegs || []).length);
    }

    console.log('\n--- changeover: when it cannot be established, nothing is guessed and nothing is silent ---');
    {
      const cut = NOW;
      fresh({ openLegs: [], pending: [], lastProcessedIds: [999], identityCutoverAt: new Date(cut).toISOString() });
      const A = tx({ orderId: 999, tradeDate: iso(cut - 7200e3), legs: [{ open: true, qty: 1, price: 1.00 }] });
      const B = tx({ orderId: 999, tradeDate: iso(cut - 7100e3), legs: [{ open: true, qty: 1, price: 1.01 }] });
      schwab.transactions = [A, B];
      const st = await run();
      const amb = st.lastSync && st.lastSync.legacyAmbiguous;
      check('neither of the two is processed', !(st.openLegs || []).length && ids(st).length === 1);
      check('both are listed as exceptions, with the reason', !!amb && amb.count === 2 && /order number/.test(JSON.stringify(amb)));
    }

    console.log('\n--- an activityId fill already handled stays handled ---');
    {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [123], identityCutoverAt: new Date(NOW).toISOString() });
      schwab.transactions = [tx({ activityId: 123, orderId: 9, tradeDate: iso(NOW - 600e3) })];
      const st = await run();
      check('not processed again', !(st.openLegs || []).length && ids(st).length === 1);
    }
  } catch (err) {
    console.log('FAIL: TEST CRASHED', err && err.stack || err);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
