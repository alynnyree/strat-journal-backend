// Blocker 2A: the broker-history inspection is READ-ONLY, never renews the
// Schwab sign-in, never leaks the account number, and reports every awkward
// kind of record the auditor asked about -- including the two follow-ups:
// the fee compared record by record (Q2) and how far back Schwab really
// goes, with a check for capped answers (Q5).
//
// The pretend Schwab answers by the records' own DATES, the way Schwab does,
// so asking for two halves of a window returns exactly what the whole window
// holds. An earlier version answered by when the request was made, which
// would have made the cap check report a cap that was not there.
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

// ---- The pretend Schwab ------------------------------------------------
const ACCOUNT_HASH = 'HASHVALUE-THAT-MUST-NOT-LEAK';
const DAY = 86400000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const BOUNDARY = new Date(NOW - 30 * DAY).toISOString();      // where windows 1 and 2 meet
const TOO_OLD = NOW - 400 * DAY;                               // Schwab refuses anything older
let gets = 0, posts = 0, lastTypes = null, refuseAllKinds = false, capAt = null;

const opt = (o) => Object.assign({ instrument: { assetType: 'OPTION', symbol: 'SPY   260609C00740000', underlyingSymbol: 'SPY', putCall: 'CALL' } }, o);
const fee = (feeType, cost) => ({ instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, feeType, cost, amount: 0 });
const rec = (o) => Object.assign({ accountNumber: '12345678', type: 'TRADE', status: 'VALID', tradeDate: '2026-09-09T13:31:00+0000' }, o);
const data = [
  // itemised 0.65 + 0.01 = 0.66 = the cash gap (111.66 - 111): they AGREE
  rec({ activityId: 1, netAmount: -111.66, transferItems: [opt({ amount: 1, price: 1.11, cost: -111, positionEffect: 'OPENING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
  // no fee lines, cash gap 0.66: they DISAGREE by 0.66
  rec({ activityId: 2, netAmount: 121.34, tradeDate: '2026-09-09T13:36:00+0000', transferItems: [opt({ amount: -1, price: 1.22, cost: 122, positionEffect: 'CLOSING' })] }),
  // two legs in one transaction
  rec({ activityId: 3, netAmount: -300.65, transferItems: [
    opt({ amount: 1, price: 1.5, cost: -150, positionEffect: 'OPENING' }),
    opt({ instrument: { assetType: 'OPTION', symbol: 'SPY   260609P00730000', underlyingSymbol: 'SPY', putCall: 'PUT' }, amount: 1, price: 1.5, cost: -150, positionEffect: 'OPENING' }),
    fee('COMMISSION', -0.65)] }),
  rec({ activityId: 4, type: 'CASH_RECEIPT', netAmount: 500, transferItems: [{ instrument: { assetType: 'CURRENCY' }, amount: 500 }] }),
  rec({ activityId: undefined, netAmount: -205.33, transferItems: [opt({ amount: 2, price: 1.02, cost: -204, positionEffect: 'OPENING' }), fee('COMMISSION', -1.30), fee('OPT_REG_FEE', -0.03)] }),
  rec({ activityId: 5, type: 'RECEIVE_AND_DELIVER', netAmount: 0, transferItems: [opt({ amount: -1, price: 0, cost: 0, positionEffect: 'CLOSING' })] }),
  // a fee CREDIT: itemised-as-charges 0.70, signed -0.60, cash gap 0.60
  rec({ activityId: 7, netAmount: -100.60, tradeDate: '2026-09-10T14:00:00+0000', transferItems: [opt({ amount: 1, price: 1.0, cost: -100, positionEffect: 'OPENING' }), fee('COMMISSION', -0.65), fee('TAF_FEE', 0.05)] }),
  // exactly on the window boundary: every window touching it returns it
  rec({ activityId: 8, tradeDate: BOUNDARY, netAmount: 55.34, transferItems: [opt({ amount: -1, price: 0.56, cost: 56, positionEffect: 'CLOSING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
  // an old record, well inside Schwab's history
  rec({ activityId: 6, tradeDate: '2026-07-01T14:00:00+0000', netAmount: 55.34, transferItems: [opt({ amount: -1, price: 0.56, cost: 56, positionEffect: 'CLOSING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
];
const http = {
  async get(url, cfg) {
    gets++;
    if (url.endsWith('/accounts/accountNumbers')) return { data: [{ accountNumber: '12345678', hashValue: ACCOUNT_HASH }] };
    const p = cfg.params;
    lastTypes = p.types;
    if (refuseAllKinds && p.types !== 'TRADE') { const e = new Error('bad'); e.response = { status: 400, data: { message: 'types invalid' } }; throw e; }
    const start = Date.parse(p.startDate), end = Date.parse(p.endDate);
    if (start < TOO_OLD) { const e = new Error('too old'); e.response = { status: 400, data: { message: 'date range too old' } }; throw e; }
    let out = data.filter(t => { const d = Date.parse(t.tradeDate); return d >= start && d <= end; })
      .sort((a, b) => Date.parse(b.tradeDate) - Date.parse(a.tradeDate));
    if (capAt != null) out = out.slice(0, capAt);
    return { data: JSON.parse(JSON.stringify(out)) };
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
  const run = (o) => inspectBrokerHistory(Object.assign({ http, now: NOW, noPause: true }, o || {}));

  // ---- 1. Not signed in / pass expired: stops, asks nobody, renews nothing
  db.clear();
  let r = await run();
  check('not signed in: stops with a plain reason', !r.ok && /Not signed in/.test(r.reason), r.reason);
  signIn(Date.now() - 1000);
  r = await run();
  check('pass expired: stops and says why', !r.ok && /run out/.test(r.reason) && /does not renew/.test(r.reason), r.reason);
  check('...having asked Schwab nothing', gets === 0, gets);
  check('...and renewed nothing', posts === 0, posts);

  // ---- 2. A full run ------------------------------------------------------
  signIn(Date.now() + 3600000);
  r = await run();
  const T = r.totals;
  const out = JSON.stringify(r);
  check('the run succeeds', r.ok === true, r.reason);
  check('it asked for EVERY kind of record, not just trades', /RECEIVE_AND_DELIVER/.test(lastTypes) && /CASH_RECEIPT/.test(lastTypes), lastTypes);
  check('it stops only after 6 REFUSED windows in a row', /6 windows in a row refused/.test(r.request.stoppedBecause) && T.windowsRefused === 6, r.request);
  check('empty windows did NOT stop it (it walked on to the refusals)', T.windowsOk >= 13, T.windowsOk);
  check('the first refusal is reported', T.firstRefusedWindow && T.firstRefusedWindow.status === 'refused' && /too old/.test(T.firstRefusedWindow.why), T.firstRefusedWindow);
  check('the oldest date successfully queried is reported', T.oldestDateSuccessfullyQueried && Date.parse(T.oldestDateSuccessfullyQueried) >= TOO_OLD - DAY, T.oldestDateSuccessfullyQueried);
  check('records counted, the boundary repeat included', T.records === 10, T.records);
  check('option vs non-option', T.optionRecords === 9 && T.nonOptionRecords === 1, [T.optionRecords, T.nonOptionRecords]);
  check('records with and without a Schwab activityId', T.withActivityId === 9 && T.withoutActivityId === 1, [T.withActivityId, T.withoutActivityId]);
  check('the boundary repeat is seen as an identical duplicate', T.duplicateIds.count === 1 && T.duplicateIds.identicalCopies === 1 && T.duplicateIds.sameIdDifferentContent === 0, T.duplicateIds);
  check('multi-leg transactions counted', T.multiLegOptionRecords === 1, T.multiLegOptionRecords);
  check('record kinds counted', T.kinds.TRADE === 8 && T.kinds.CASH_RECEIPT === 1 && T.kinds.RECEIVE_AND_DELIVER === 1, T.kinds);
  check('date range', T.dateRange.oldest === '2026-07-01' && T.dateRange.newest === '2026-09-10', T.dateRange);
  const unsafeWhy = T.cannotSafelyBecomeFills.records.map(x => x.reasons.join(' | ')).join(' || ');
  check('flags the record with no activityId', /no Schwab activityId/.test(unsafeWhy), unsafeWhy);
  check('flags the expiry-type record (decision B)', /RECEIVE_AND_DELIVER/.test(unsafeWhy), unsafeWhy);

  // ---- 2b. Fee, record by record (Q2) -------------------------------------
  const F = T.feeByRecord;
  const byId = Object.fromEntries(F.records.map(x => [String(x.activityId), x]));
  check('records where itemised and cash agree are counted, not listed', F.agree >= 3 && !byId['1'] && !byId['6'], F);
  check('a record with no fee lines is listed with both figures and the difference',
    byId['2'] && byId['2'].itemisedFee === 0 && byId['2'].cashDerivedFee === 0.66 && byId['2'].difference === 0.66, byId['2']);
  check('a fee CREDIT is noticed and said so', byId['7'] && byId['7'].itemisedFee === 0.7 && byId['7'].itemisedSigned === -0.6 && byId['7'].cashDerivedFee === 0.6
    && byId['7'].observations.some(o => /CREDITS/.test(o)), byId['7']);
  check('each listed record keeps its original fee lines', byId['7'] && byId['7'].feeLines.length === 2 && byId['7'].feeLines.some(l => l.type === 'TAF_FEE' && l.cost === 0.05), byId['7']);
  check('a record with no contract value says why its cash fee is unknown', F.records.some(x => x.activityId === 5 && x.cashDerivedFee === null && x.observations.some(o => /no contract value/.test(o))), F.records);
  check('both totals are over the SAME records', typeof F.itemisedTotal === 'number' && typeof F.cashTotal === 'number' && /SAME records/.test(F.note), F);

  // ---- 2c. Cap check (Q5) --------------------------------------------------
  check('an uncapped history shows no cap', r.capCheck.done && r.capCheck.recordsInHalvesMissingFromWhole === 0 && /no sign of a cap/.test(r.capCheck.verdict), r.capCheck);
  capAt = 2;
  const capped = await run();
  capAt = null;
  check('a capped answer IS caught (the halves find records the whole left out)', capped.capCheck.done && capped.capCheck.recordsInHalvesMissingFromWhole > 0 && /CAPPED/.test(capped.capCheck.verdict), capped.capCheck);
  check('the largest single answer is reported', capped.totals.largestSingleAnswer === 2, capped.totals.largestSingleAnswer);

  // ---- 2d. How far back it is allowed to look ----------------------------
  const deep = await run({ lookbackDays: 99999 });
  check('the lookback is capped at 10 years however far is asked', deep.windows.length <= Math.ceil(3650 / 30) + 1, deep.windows.length);

  // ---- 2e. What must never appear -----------------------------------------
  check('the report NEVER contains the account number or its hash', !out.includes('12345678') && !out.includes(ACCOUNT_HASH), 'leak');
  check('...nor the sign-in', !out.includes('ACCESS-TOKEN-THAT-MUST-NOT-LEAK'));
  check('...nor any record\'s net amount or price, only field names and kinds',
    !['-111.66', '121.34', '-300.65', '-205.33', '-100.6', '"price"'].some(v => out.includes(':' + v) || out.includes(v + ',')) && T.recordShape.netAmount === 'number', T.recordShape);
  check('it renewed nothing (no POST to Schwab)', posts === 0, posts);

  // ---- 3. If Schwab refuses "every kind" at once, it says so -------------
  refuseAllKinds = true;
  r = await run();
  refuseAllKinds = false;
  check('refusal of "every kind" is reported, and it falls back to trades only', r.ok && r.allKindsRefused && r.request.kindsAsked.length === 1, [r.allKindsRefused, r.request && r.request.kindsAsked]);

  // ---- 4. Through the real route, behind the key ------------------------
  const { buildApp } = require('../server');
  const app = buildApp();
  const server = app.listen(0);
  await new Promise(x => server.once('listening', x));
  const base = 'http://127.0.0.1:' + server.address().port;
  const noKey = await fetch(base + '/api/broker/inspect?years=5');
  check('the route refuses a caller without the key', noKey.status === 403, noKey.status);
  const withKey = await fetch(base + '/api/broker/inspect?years=1', { headers: { Authorization: 'Bearer right-key' } });
  const body = await withKey.json();
  check('with the key it answers a report, honouring ?years', withKey.status === 200 && body.readOnly === true && body.request && body.request.lookbackDaysProbed <= 366, body.request);
  server.close();

  // ---- 5. The one that matters -------------------------------------------
  check('ZERO writes to storage across every run above', writes.length === 0, writes);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
