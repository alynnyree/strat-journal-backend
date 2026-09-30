// Blocker 2A: the broker-history inspection is READ-ONLY, never renews the
// Schwab sign-in, never leaks the account number, and reports every awkward
// kind of record the auditor asked about. A pretend Schwab stands in for the
// real one, holding one of each awkward case.
const Module = require('module');
process.env.APP_SECRET = 'right-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';

setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 120000).unref();

// Storage: reads allowed, every write counted.
const db = new Map();
const writes = [];
class FakeRedis {
  constructor() {}
  async get(k) { return db.has(k) ? JSON.parse(JSON.stringify(db.get(k))) : null; }
  async hgetall() { return null; }
}
for (const m of ['set', 'del', 'hset', 'hdel', 'lpush', 'rpush', 'rpop', 'lpop', 'ltrim', 'lrem', 'incr', 'expire', 'sadd', 'zadd', 'setnx', 'hsetnx', 'mset', 'append']) {
  FakeRedis.prototype[m] = async function (...a) { writes.push(m + ' ' + a[0]); return 'OK'; };
}
FakeRedis.fromEnv = () => new FakeRedis();

// The pretend Schwab. Anything that is not a GET is counted: a sign-in
// renewal is a POST.
const ACCOUNT_HASH = 'HASHVALUE-THAT-MUST-NOT-LEAK';
const DAY = 86400000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
let gets = 0, posts = 0, lastTypes = null, refuseAllKinds = false;
const opt = (o) => Object.assign({ instrument: { assetType: 'OPTION', symbol: 'SPY   260609C00740000', underlyingSymbol: 'SPY', putCall: 'CALL' } }, o);
const fee = (feeType, cost) => ({ instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, feeType, cost, amount: 0 });
const rec = (o) => Object.assign({ accountNumber: '12345678', type: 'TRADE', status: 'VALID', tradeDate: '2026-09-09T13:31:00+0000' }, o);
const recent = [
  rec({ activityId: 1, netAmount: -111.66, transferItems: [opt({ amount: 1, price: 1.11, cost: -111, positionEffect: 'OPENING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
  rec({ activityId: 2, netAmount: 121.34, tradeDate: '2026-09-09T13:36:00+0000', transferItems: [opt({ amount: -1, price: 1.22, cost: 122, positionEffect: 'CLOSING' })] }),
  rec({ activityId: 3, netAmount: -300.65, transferItems: [   // two legs in one transaction
    opt({ amount: 1, price: 1.5, cost: -150, positionEffect: 'OPENING' }),
    opt({ instrument: { assetType: 'OPTION', symbol: 'SPY   260609P00730000', underlyingSymbol: 'SPY', putCall: 'PUT' }, amount: 1, price: 1.5, cost: -150, positionEffect: 'OPENING' }),
  ] }),
  rec({ activityId: 4, type: 'CASH_RECEIPT', netAmount: 500, transferItems: [{ instrument: { assetType: 'CURRENCY' }, amount: 500 }] }),
  rec({ activityId: undefined, netAmount: -205.33, transferItems: [opt({ amount: 2, price: 1.02, cost: -204, positionEffect: 'OPENING' })] }),
  rec({ activityId: 5, type: 'RECEIVE_AND_DELIVER', netAmount: 0, transferItems: [opt({ amount: -1, price: 0, cost: 0, positionEffect: 'CLOSING' })] }),
];
const older = [
  recent[0],                                                             // same id, identical: a window-edge repeat
  rec({ activityId: 2, netAmount: 121.00, tradeDate: '2026-09-09T13:36:00+0000', transferItems: [opt({ amount: -1, price: 1.22, cost: 122, positionEffect: 'CLOSING' })] }), // same id, DIFFERENT content
  rec({ activityId: 6, tradeDate: '2026-07-01T14:00:00+0000', netAmount: 55, transferItems: [opt({ amount: -1, price: 0.56, cost: 56, positionEffect: 'CLOSING' })] }),
];
const http = {
  async get(url, cfg) {
    gets++;
    if (url.endsWith('/accounts/accountNumbers')) return { data: [{ accountNumber: '12345678', hashValue: ACCOUNT_HASH }] };
    const p = cfg.params;
    lastTypes = p.types;
    if (refuseAllKinds && p.types !== 'TRADE') { const e = new Error('bad'); e.response = { status: 400, data: { message: 'types invalid' } }; throw e; }
    const end = Date.parse(p.endDate), start = Date.parse(p.startDate);
    const ageDays = (NOW - end) / DAY;
    if (ageDays > 400) { const e = new Error('too old'); e.response = { status: 400, data: { message: 'date range too old' } }; throw e; }
    if (ageDays < 1) return { data: recent };
    if (ageDays < 40) return { data: older };
    return { data: [] };
  },
  async post() { posts++; return { data: {} }; },
};

const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') return { Redis: FakeRedis };
  if (req === 'axios') return Object.assign(http, { create: () => http });
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d)); } };

(async () => {
  const { inspectBrokerHistory } = require('../brokerInspect');
  const signIn = (expiresAt) => db.set('schwab:tokens', { access_token: 'ACCESS-TOKEN-THAT-MUST-NOT-LEAK', refresh_token: 'R', expires_at: expiresAt });

  // ---- 1. Not signed in / pass expired: stops, asks nobody, renews nothing
  db.clear();
  let r = await inspectBrokerHistory({ http, now: NOW, noPause: true });
  check('not signed in: stops with a plain reason', !r.ok && /Not signed in/.test(r.reason), r.reason);
  signIn(Date.now() - 1000);
  r = await inspectBrokerHistory({ http, now: NOW, noPause: true });
  check('pass expired: stops and says why', !r.ok && /run out/.test(r.reason) && /does not renew/.test(r.reason), r.reason);
  check('...having asked Schwab nothing', gets === 0, gets);
  check('...and renewed nothing', posts === 0, posts);

  // ---- 2. A full run ------------------------------------------------------
  signIn(Date.now() + 3600000);
  r = await inspectBrokerHistory({ http, now: NOW, noPause: true });
  const T = r.totals;
  const out = JSON.stringify(r);
  check('the run succeeds', r.ok === true, r.reason);
  check('it asked for EVERY kind of record, not just trades', /RECEIVE_AND_DELIVER/.test(lastTypes) && /CASH_RECEIPT/.test(lastTypes), lastTypes);
  check('it stops after 6 refused windows in a row (the end of what Schwab serves)', /6 windows in a row refused/.test(r.request.stoppedBecause) && T.windowsRefused === 6, r.request);
  check('records counted, repeats included', T.records === 9, T.records);
  check('option vs non-option', T.optionRecords === 8 && T.nonOptionRecords === 1, [T.optionRecords, T.nonOptionRecords]);
  check('records with and without a Schwab activityId', T.withActivityId === 8 && T.withoutActivityId === 1, [T.withActivityId, T.withoutActivityId]);
  check('duplicate ids found, identical vs different content told apart',
    T.duplicateIds.count === 2 && T.duplicateIds.identicalCopies === 1 && T.duplicateIds.sameIdDifferentContent === 1, T.duplicateIds);
  check('multi-leg transactions counted', T.multiLegOptionRecords === 1, T.multiLegOptionRecords);
  check('record kinds counted', T.kinds.TRADE === 7 && T.kinds.CASH_RECEIPT === 1 && T.kinds.RECEIVE_AND_DELIVER === 1, T.kinds);
  check('itemised fee lines by fee type', T.fees.itemisedLinesByFeeType.COMMISSION && T.fees.itemisedLinesByFeeType.COMMISSION.lines === 2, T.fees);
  check('date range', T.dateRange.oldest === '2026-07-01' && T.dateRange.newest === '2026-09-09', T.dateRange);
  const unsafeWhy = T.cannotSafelyBecomeFills.records.map(x => x.reasons.join(' | ')).join(' || ');
  check('flags the record with no activityId', /no Schwab activityId/.test(unsafeWhy), unsafeWhy);
  check('flags the expiry-type record (decision B)', /RECEIVE_AND_DELIVER/.test(unsafeWhy), unsafeWhy);
  check('storage estimates are given', T.storageEstimate.redisLedgerBytesAllRecords > T.storageEstimate.rawBytesAllRecords && T.storageEstimate.archiveBytesAllRecords > T.storageEstimate.redisLedgerBytesAllRecords, T.storageEstimate);
  check('the proposed ledger is described', /entries by activityId/.test(r.proposedLedger.wouldHold), r.proposedLedger);
  check('the report NEVER contains the account number or its hash', !out.includes('12345678') && !out.includes(ACCOUNT_HASH), 'leak');
  check('...nor the sign-in', !out.includes('ACCESS-TOKEN-THAT-MUST-NOT-LEAK'));
  check('...nor the records themselves: no money figure from any record appears, only field names and kinds',
    !['-111.66', '121.34', '-300.65', '-205.33', '121'].some(v => out.includes(':' + v)) && r.totals.recordShape.netAmount === 'number', r.totals.recordShape);
  check('it renewed nothing (no POST to Schwab)', posts === 0, posts);

  // ---- 3. If Schwab refuses "every kind" at once, it says so -------------
  refuseAllKinds = true;
  r = await inspectBrokerHistory({ http, now: NOW, noPause: true });
  refuseAllKinds = false;
  check('refusal of "every kind" is reported, and it falls back to trades only', r.ok && r.allKindsRefused && r.request.kindsAsked.length === 1, [r.allKindsRefused, r.request && r.request.kindsAsked]);

  // ---- 4. Through the real route, behind the key ------------------------
  const { buildApp } = require('../server');
  const app = buildApp();
  const server = app.listen(0);
  await new Promise(x => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const noKey = await fetch(base + '/api/broker/inspect');
  check('the route refuses a caller without the key', noKey.status === 403, noKey.status);
  const withKey = await fetch(base + '/api/broker/inspect', { headers: { Authorization: 'Bearer right-key' } });
  const body = await withKey.json();
  check('with the key it answers a report', withKey.status === 200 && body.readOnly === true && 'ok' in body, body);
  server.close();

  // ---- 5. The one that matters -------------------------------------------
  check('ZERO writes to storage across every run above', writes.length === 0, writes);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
