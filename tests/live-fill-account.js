// AUDIT M-1, the auditor's code review (9 Oct 2026): prove that a LIVE fill
// carries its account, through the REAL path -- not through fixtures that
// already have one.
//
// Schwab-shaped transactions go in at the network (axios stubbed), through
// the REAL schwabClient.getOptionFills (account lookup, extractOptionFills,
// the stamp) and the REAL sync (matcher, store), and these are checked:
//   1. a normalized opening fill carries refOf(the account's hashValue);
//   2. the saved opening leg keeps that reference;
//   3. a sale from the same account pairs normally;
//   4. a sale from another account is not paired ("account-mismatch");
//   5. missing account references fail closed: no account returned -> no
//      fills at all; a fill read without the fetch's stamp (extractOptionFills
//      alone, as brokerInspect reads) and a leg with none -> "account-unknown".
// The test also proves itself: with the one stamping line removed from a copy
// of schwabClient.js, checks 1-3 must fail.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); } };
async function section(fn) { try { await fn(); } catch (e) { fail++; console.log('FAIL: this case threw:', e && e.message); } }

// ---- Stand-in storage.
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

// ---- Stand-in Schwab at the NETWORK: the account list and the transactions.
const schwab = { hashValue: 'HASH-ACCOUNT-A', txs: [], asked: [] };
const axios = {
  get: async (url) => {
    schwab.asked.push(url);
    if (/\/accounts\/accountNumbers$/.test(url)) {
      return { data: schwab.hashValue == null ? [] : [{ accountNumber: '000', hashValue: schwab.hashValue }] };
    }
    if (/\/accounts\/[^/]+\/transactions$/.test(url)) return { data: JSON.parse(JSON.stringify(schwab.txs)) };
    throw new Error('unexpected request ' + url);
  },
};
const tokens = { last_transaction_check: null };
const SCHWAB_CLIENT = process.env.M1_SCHWAB_CLIENT || path.join(BACKEND, 'schwabClient.js');
const stubs = {
  axios,
  '@upstash/redis': { Redis },
  'node-cron': { schedule: () => ({ stop(){} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
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
Module._load = function (request, parent) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  // The sync loads the real schwabClient (or, for the self-check, a copy).
  if (request === './schwabClient' && parent && parent.filename === path.join(BACKEND, 'cron.js')) return origLoad.call(this, SCHWAB_CLIENT, parent);
  return origLoad.apply(this, arguments);
};
const schwabClient = require(SCHWAB_CLIENT);
const cron = require(path.join(BACKEND, 'cron.js'));
const { refOf } = require(path.join(BACKEND, 'ledgerAccount.js'));

// ---- A Schwab transaction, as the transactions endpoint returns it.
const OCC = 'SPY   261231C00600000';
function tx(activityId, kind, minutesAgo, { price = 1.00, qty = 1, fee = 0.66 } = {}) {
  const gross = price * 100 * qty;
  const buy = kind === 'open';
  return {
    activityId, tradeDate: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    netAmount: buy ? -(gross + fee) : gross - fee,
    transferItems: [{
      instrument: { assetType: 'OPTION', symbol: OCC, underlyingSymbol: 'SPY', putCall: 'CALL' },
      amount: buy ? qty : -qty, price, cost: buy ? -gross : gross,
      positionEffect: buy ? 'OPENING' : 'CLOSING',
    }],
  };
}
const fresh = s => { for (const k of Object.keys(store)) delete store[k]; writeState(s); tokens.last_transaction_check = null; schwab.asked = []; };
const today = () => new Date().toISOString().slice(0, 10);
const REF_A = refOf('HASH-ACCOUNT-A'), REF_B = refOf('HASH-ACCOUNT-B');

(async () => {
  try {
    console.log('--- 1. a fill from the real fetch carries its account ---');
    await section(async () => {
      schwab.hashValue = 'HASH-ACCOUNT-A';
      schwab.txs = [tx(111000000001, 'open', 120)];
      const report = {};
      const fills = await schwabClient.getOptionFills('tok', today(), today(), report);
      check(`one opening fill, accountRef = refOf(hashValue) (${fills[0] && fills[0].accountRef})`,
        fills.length === 1 && fills[0].instruction === 'BUY_TO_OPEN' && fills[0].accountRef === REF_A && /^acct-[0-9a-f]{16}$/.test(REF_A), fills);
      // Schwab sends activityId as a JSON number; the fill keeps it as sent and
      // the matcher reads it with String() (plan v4, item 1: number or text,
      // the same id) -- shown by the trade's fills in case 3.
      check('the fill carries Schwab\'s activityId as sent (a number)', fills[0] && fills[0].transactionId === 111000000001);
      check('the account was asked for through the real lookup', schwab.asked.some(u => /accountNumbers$/.test(u)) && report.accountFound === true);
    });

    console.log('\n--- 2 & 3. through the real sync: the leg keeps it, the same-account sale pairs ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.hashValue = 'HASH-ACCOUNT-A';
      schwab.txs = [tx(111000000001, 'open', 120)];
      await cron.runSyncCheck();
      const st = readState();
      check('2. the saved opening leg holds the same reference', st.openLegs.length === 1 && st.openLegs[0].accountRef === REF_A, st.openLegs);
      schwab.txs = [tx(111000000001, 'open', 120), tx(111000000002, 'close', 60, { price: 1.20 })];
      await cron.runSyncCheck();
      const st2 = readState();
      const t = st2.pending[0];
      check('3. the sale from the same account pairs: one trade, the leg closed', st2.pending.length === 1 && st2.openLegs.length === 0, st2);
      check('   its id is the M-1 id from the pair, idBasis "fill-pair", accountRef carried',
        t && /-p[0-9a-f]{32}$/.test(t.id) && t.idBasis === 'fill-pair' && t.accountRef === REF_A && t.fills.join('+') === '111000000001+111000000002', t);
      check('   no exception recorded for either fill', Object.keys(st2.exceptions || {}).length === 0, st2.exceptions);
    });

    console.log('\n--- 4. a sale read from ANOTHER account is not paired ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.hashValue = 'HASH-ACCOUNT-A';
      schwab.txs = [tx(111000000011, 'open', 120)];
      await cron.runSyncCheck();
      schwab.hashValue = 'HASH-ACCOUNT-B';          // Schwab now returns another account first
      schwab.txs = [tx(111000000012, 'close', 60)];
      await cron.runSyncCheck();
      const st = readState();
      const r = Object.values(st.exceptions || {}).find(e => e.fillId === '111000000012');
      check('no trade; the sale recorded "account-mismatch"; the purchase still open in account A',
        st.pending.length === 0 && r && r.kind === 'account-mismatch' && st.openLegs.length === 1 && st.openLegs[0].accountRef === REF_A, st);
      check('the two references really differ', REF_A !== REF_B);
    });

    console.log('\n--- 5. missing account references fail closed ---');
    await section(async () => {
      schwab.hashValue = null;                      // Schwab returns no account
      schwab.txs = [tx(111000000021, 'open', 120)];
      const report = {};
      const fills = await schwabClient.getOptionFills('tok', today(), today(), report);
      check('no account returned: no fills at all, and the report says so', fills.length === 0 && report.accountFound === false && /No Schwab account/.test(report.error || ''), report);
      const bare = schwabClient.extractOptionFills(tx(111000000022, 'close', 60));
      check('a fill read WITHOUT the fetch (extractOptionFills alone) has no account', bare.length === 1 && bare[0].accountRef === undefined);
      fresh({ openLegs: [{ occ: OCC, ticker: 'SPY', dir: 'Long', openPrice: 1, openDate: today(), openTime: '10:00',
        openTimestamp: Date.now() - 3 * 3600e3, totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: '111000000020' }],
        pending: [], lastProcessedIds: [] });     // a leg saved before M-1: no account
      schwab.hashValue = 'HASH-ACCOUNT-A';
      schwab.txs = [tx(111000000023, 'close', 60)];
      await cron.runSyncCheck();
      const st = readState();
      const r = Object.values(st.exceptions || {}).find(e => e.fillId === '111000000023');
      check('a leg with no account: its live sale is "account-unknown", never paired, the leg kept',
        st.pending.length === 0 && r && r.kind === 'account-unknown' && st.openLegs.length === 1, st);
    });
  } catch (e) {
    fail++; console.log('FAIL: crashed', e && e.stack);
  }

  // ---- The test proves itself: without the stamp, 1-3 fail. ----------------
  if (!process.env.M1_SCHWAB_CLIENT) {
    console.log('\n--- self-check: a copy of schwabClient.js with the stamping line removed ---');
    const src = fs.readFileSync(path.join(BACKEND, 'schwabClient.js'), 'utf8');
    const without = src.replace(/^\s*fill\.accountRef = accountRef;\s*$/m, '');
    check('the stamping line exists exactly once and was removed in the copy', without !== src
      && (src.match(/fill\.accountRef = accountRef;/g) || []).length === 1);
    const copy = path.join(BACKEND, `.schwabClient-without-stamp-${process.pid}.js`);
    fs.writeFileSync(copy, without);
    const out = require('child_process').spawnSync(process.execPath, [__filename], { env: { ...process.env, M1_SCHWAB_CLIENT: copy }, encoding: 'utf8' });
    fs.unlinkSync(copy);
    const failed = (out.stdout.match(/^FAIL: .*$/gm) || []);
    check(`without the stamp the same checks fail (${failed.length} failed)`,
      failed.some(l => /accountRef = refOf/.test(l)) && failed.some(l => /^FAIL: 2\. /.test(l)) && failed.some(l => /^FAIL: 3\. /.test(l)), failed);
    void os;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
