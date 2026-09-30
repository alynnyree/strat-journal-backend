// BLOCKER 3A: the reconstruction from the immutable ledger (tradeRebuild.js).
// Every locked rule (B3-1 .. B3-11) and every amendment is checked here,
// against records shaped exactly like the ones in the ledger (the same
// fields Schwab sends: optionPremiumMultiplier, expirationDate,
// optionDeliverables, positionEffect, signed amount and cost, fee lines).
const Module = require('module');
const fs = require('fs');
const path = require('path');

setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 120000).unref();

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 500)); } };

// ---- B3-11: loading it may use nothing but crypto ----------------------------
const orig = Module._load;
const loaded = [];
Module._load = function (req, parent) {
  if (parent && /tradeRebuild\.js$/.test(parent.filename || '')) {
    loaded.push(req);
    if (req !== 'crypto') throw new Error('tradeRebuild.js may not load ' + req);
  }
  return orig.apply(this, arguments);
};
const R = require('../tradeRebuild');
Module._load = orig;
check('B3-11 it loads nothing but the hashing library (no storage, no network, no files, no matcher)', loaded.length === 1 && loaded[0] === 'crypto', loaded);

const ROOT = path.join(__dirname, '..');
const callers = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'tradeRebuild.js')
  .filter(f => /tradeRebuild/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
check('B3-11 nothing in the running service calls it', callers.length === 0, callers);

// ---- Records shaped like the ledger's ------------------------------------------
const opt = (symbol, putCall, extra) => Object.assign({
  assetType: 'OPTION', status: 'ACTIVE', symbol, uniformSymbol: symbol, description: symbol, instrumentId: 1, closingPrice: 1,
  expirationDate: '2026-06-09T04:00:00+0000',
  optionDeliverables: [{ rootSymbol: 'SPY', strikePercent: 100, deliverableNumber: 1, deliverableUnits: 100, deliverable: { assetType: 'EQUITY', symbol: 'SPY' } }],
  optionPremiumMultiplier: 100, putCall, strikePrice: 740, type: 'VANILLA', underlyingSymbol: 'SPY', underlyingCusip: 'X',
}, extra || {});
const CALL = 'SPY   260609C00740000';
const PUT = 'SPY   260609P00730000';
const feeLine = (feeType, cost) => ({ instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, feeType, cost, amount: 0 });
let nextId = 100000000000;
function trade({ id, at, buy, qty = 1, price, symbol = CALL, putCall, effect, fees = [0.65, 0.01], orderId = 555, instExtra, lineExtra, recExtra }) {
  const bought = buy;
  const cost = Math.round(price * 100 * qty * 100) / 100 * (bought ? -1 : 1);
  const feeTotal = fees ? fees.reduce((s, f) => s + f, 0) : 0;
  const t = Object.assign({
    activityId: id == null ? nextId++ : id, time: at, type: 'TRADE', status: 'VALID', subAccount: 'CASH', tradeDate: at,
    positionId: 9001, orderId, netAmount: Math.round((cost - feeTotal) * 100) / 100,
    transferItems: [
      Object.assign({ instrument: opt(symbol, putCall || (symbol === PUT ? 'PUT' : 'CALL'), instExtra), amount: bought ? qty : -qty, cost, price, positionEffect: effect || (bought ? 'OPENING' : 'CLOSING') }, lineExtra || {}),
      ...(fees ? [feeLine('COMMISSION', -fees[0]), ...(fees[1] != null ? [feeLine('OPT_REG_FEE', -fees[1])] : [])] : []),
    ],
  }, recExtra || {});
  if (id === null) delete t.activityId;
  return t;
}
const entry = (raw, accountRef = 'acct-aaaaaaaaaaaaaaaa') => ({
  schema: 'broker-ledger/v1', identity: { kind: 'activityId', value: String(raw.activityId), uncertain: false },
  fingerprint: R.fingerprint(raw), raw, normalized: { fees: { normalizedFee: null } }, provenance: { accountRef },
});
const wrap = e => ({ type: 'string', value: e });   // as the backup export holds them
const J = x => JSON.stringify(x);
const shuffle = (a, seed) => { const b = a.slice(); let s = seed; for (let i = b.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const withLedgerFee = e => { e.normalized.fees.normalizedFee = -e.raw.transferItems.filter(t => t.feeType).reduce((s, t) => s + t.cost, 0); e.normalized.fees.normalizedFee = Math.round(e.normalized.fees.normalizedFee * 100) / 100; return e; };

(async () => {
  // ---- A realistic ledger --------------------------------------------------------
  const raws = [
    // a plain round trip: buy 1 at 1.11, sell 1 at 1.22
    trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1.11 }),
    trade({ at: '2026-06-01T13:36:00+0000', buy: false, price: 1.22 }),
    // bought 3 in one go, sold one at a time: three trades share one purchase fee
    trade({ at: '2026-06-02T14:00:00+0000', buy: true, qty: 3, price: 2.00, fees: [1.95, 0.05] }),
    trade({ at: '2026-06-02T14:05:00+0000', buy: false, qty: 1, price: 2.10 }),
    trade({ at: '2026-06-02T14:06:00+0000', buy: false, qty: 1, price: 2.20 }),
    trade({ at: '2026-06-02T14:07:00+0000', buy: false, qty: 1, price: 1.90 }),
    // a put
    trade({ at: '2026-06-03T15:00:00+0000', buy: true, price: 0.80, symbol: PUT }),
    trade({ at: '2026-06-03T15:10:00+0000', buy: false, price: 1.00, symbol: PUT }),
    // non-option records are evidence only
    { activityId: nextId++, time: '2026-06-04T04:00:00+0000', type: 'DIVIDEND_OR_INTEREST', status: 'VALID', tradeDate: '2026-06-04T04:00:00+0000', netAmount: 0.06, transferItems: [{ instrument: { assetType: 'CURRENCY' }, amount: 0.06 }] },
  ];
  const ledgerA = raws.map(r => withLedgerFee(entry(r)));

  let out = R.rebuild(ledgerA);
  let rc = out.reconstruction;
  check('builds trades from the ledger (1 + 3 + 1 = 5)', rc.trades.length === 5 && rc.fills.length === 8, { trades: rc.trades.length, fills: rc.fills.length });
  check('the dividend record is evidence only: no fill, no exception', rc.exceptions.notFills.length === 0 && rc.fills.every(f => f.symbol));
  check('nothing is left open or unmatched', rc.openLots.length === 0 && rc.exceptions.closeWithoutOpen.length === 0 && rc.exceptions.excessClose.length === 0);
  check('contracts balance: opened = paired + still in lots; closed = paired + unmatched', rc.conservation.openingBalances && rc.conservation.closingBalances && rc.conservation.pairedContracts === 5, rc.conservation);   // 1 + 3 + 1
  check('fees balance to the cent: every cent on a fill lands on a trade or a remainder', rc.conservation.feesBalance && rc.conservation.feeCentsOnFills === 66 * 7 + 200, rc.conservation);   // seven 66c fills and one $2.00

  const first = rc.trades.find(t => t.entryPrice === 1.11);
  check('B3-9 gross = (1.22 - 1.11) x 100 x 1 = $11.00', first.grossCents === 1100, first);
  check('B3-9 fee = entry 66c + exit 66c; net = gross - fee', first.feeCents === 132 && first.netCents === 968 && first.entryFeeCents === 66 && first.exitFeeCents === 66, first);
  const three = rc.trades.filter(t => t.entryPrice === 2.00).map(t => t.entryFeeCents);
  check('B3-9 a $2.00 purchase fee over three partial closes: 67 + 67 + 66 = 200, never 201 or 199', three.length === 3 && three.reduce((s, x) => s + x, 0) === 200 && J(three.slice().sort()) === J([66, 67, 67]), three);
  const put = rc.trades.find(t => t.putCall === 'PUT');
  check('Long/Short from CALL/PUT (every opening admitted is a purchase)', put.direction === 'Short' && first.direction === 'Long');

  // ---- B3-1 fill identity ------------------------------------------------------------
  check('B3-1 fill ids are F:<activityId>:<n>', rc.fills.every(f => /^F:\d+:1$/.test(f.fillId)), rc.fills.map(f => f.fillId));
  check('B3-1 orderId is kept as information but appears in no id', rc.fills.every(f => f.orderId === '555') && !J(rc.fills.map(f => f.fillId)).includes('555') && !J(rc.trades.map(t => t.tradeId)).includes('555'));

  const multi = trade({ at: '2026-06-05T14:00:00+0000', buy: true, price: 1.50, fees: [0.65, 0.35] });
  multi.transferItems.splice(1, 0, { instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, amount: 0 });            // a non-option line between
  multi.transferItems.splice(2, 0, Object.assign(JSON.parse(J(multi.transferItems[0])), { instrument: opt(PUT, 'PUT') }));  // a second leg
  multi.transferItems.splice(3, 0, Object.assign(JSON.parse(J(multi.transferItems[0])), { instrument: opt('SPY   260609C00750000', 'CALL'), price: 0.75, cost: -75 }));
  multi.netAmount = -(150 + 150 + 75 + 1);
  out = R.rebuild([entry(multi)]);
  const mf = out.reconstruction.fills;
  check('B3-1 several legs of one broker transaction get distinct ids, numbered in Schwab\'s own line order', J(mf.map(f => [f.fillId.split(':')[2], f.symbol])) === J([['1', CALL], ['2', PUT], ['3', 'SPY   260609C00750000']]), mf.map(f => [f.fillId, f.symbol]));
  check('B3-4 a $1.00 fee over legs worth 150/150/75 splits 40 + 40 + 20 and adds back exactly', J(mf.map(f => f.feeCents)) === J([40, 40, 20]), mf.map(f => f.feeCents));
  const odd = trade({ at: '2026-06-05T14:00:00+0000', buy: true, price: 1.00, fees: [1.00, null] });
  odd.transferItems.splice(1, 0, JSON.parse(J(odd.transferItems[0])), JSON.parse(J(odd.transferItems[0])));
  odd.transferItems[1].instrument = opt(PUT, 'PUT'); odd.transferItems[2].instrument = opt('SPY   260609C00750000', 'CALL');
  odd.netAmount = -301;
  const of = R.rebuild([entry(odd)]).reconstruction.fills.map(f => f.feeCents);
  check('B3-4 $1.00 over three equal legs: 34 + 33 + 33, the extra cent to the first line (ties by n)', J(of) === J([34, 33, 33]), of);

  const noAct = trade({ id: null, at: '2026-06-06T14:00:00+0000', buy: true, price: 1, orderId: 777 });
  out = R.rebuild([{ raw: noAct }]);
  const uf = out.reconstruction.fills[0];
  check('B3-1 no activityId: a content-built id marked uncertain, never the orderId', /^F:U-[0-9a-f]{32}:1$/.test(uf.fillId) && uf.identityUncertain === true && !uf.fillId.includes('777') && out.reconstruction.flags.some(f => f.kind === 'uncertain-identity'), uf);

  // ---- B3-2 what becomes a fill (and its amendments) ------------------------------------
  const refusedAs = (raw, code) => { const r = R.rebuild([entry(raw)]).reconstruction; return r.fills.length === 0 && r.exceptions.notFills.length === 1 && r.exceptions.notFills[0].code === code ? r.exceptions.notFills[0] : { got: r.exceptions.notFills.map(x => x.code), fills: r.fills.length }; };
  let x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, recExtra: { tradeDate: undefined } }), 'no-valid-timestamp');
  check('amendment: no tradeDate -> an exception, and the "time" field is NOT substituted', x.code === 'no-valid-timestamp' && x.evidence && x.evidence.time === '2026-06-01T13:31:00+0000', x);
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, recExtra: { tradeDate: '2026-02-31T10:00:00Z' } }), 'no-valid-timestamp');
  check('amendment: an impossible date (31 Feb) is an exception, not rolled into March', x.code === 'no-valid-timestamp', x);
  x = refusedAs(trade({ at: 'yesterday', buy: true, price: 1 }), 'no-valid-timestamp');
  check('amendment: an unreadable tradeDate is an exception', x.code === 'no-valid-timestamp', x);
  const realNow = Date.now;
  Date.now = () => { throw new Error('the clock was read'); };
  let clockRead = false;
  try { R.rebuild(ledgerA); R.rebuildBoth(ledgerA); R.rebuild([entry(trade({ at: 'bad', buy: true, price: 1 }))]); } catch (e) { clockRead = true; }
  Date.now = realNow;
  const RealDate = global.Date;
  let bareDate = false;
  global.Date = class extends RealDate { constructor(...a) { if (!a.length) { bareDate = true; } super(...a); } static now() { bareDate = true; return RealDate.now(); } };
  R.rebuildBoth(ledgerA);
  global.Date = RealDate;
  check('B3-11 the server clock is never read (Date.now and new Date() untouched)', !clockRead && !bareDate);

  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: false, price: 1, effect: 'OPENING' }), 'unsupported-opening-direction');
  check('amendment: SELL_TO_OPEN is reported as an unsupported opening direction, not treated as a purchase', x.code === 'unsupported-opening-direction' && /SELL_TO_OPEN/.test(x.reason), x);
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, effect: 'CLOSING' }), 'unsupported-closing-direction');
  check('BUY_TO_CLOSE (closing a short) is reported, not used', x.code === 'unsupported-closing-direction', x);
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, recExtra: { type: 'RECEIVE_AND_DELIVER' } }), 'not-a-trade-record');
  check('B3-2 an option line in a non-trade record (expiration/assignment) is reported, never inferred', x.code === 'not-a-trade-record');
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, recExtra: { status: 'CANCELED' } }), 'status-not-valid');
  check('B3-2 a record that is not VALID is reported', x.code === 'status-not-valid');
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, lineExtra: { positionEffect: 'AUTOMATIC' } }), 'unknown-position-effect');
  check('B3-2 an unknown opening/closing marker is reported', x.code === 'unknown-position-effect');
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, lineExtra: { cost: 100 } }), 'direction-evidence-disagrees');
  check('B3-2 contract count and cash disagreeing on buy/sell is reported', x.code === 'direction-evidence-disagrees');
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, lineExtra: { price: 0 } }), 'no-positive-price');
  check('B3-2 a zero price is reported', x.code === 'no-positive-price');

  // ---- B3-9 amendment: the multiplier is established, never assumed ---------------------
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, instExtra: { optionPremiumMultiplier: undefined } }), 'multiplier-not-stated');
  check('amendment: no stated multiplier -> exception; 100 is never assumed', x.code === 'multiplier-not-stated', x);
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, instExtra: { optionPremiumMultiplier: 10 } }), 'multiplier-not-confirmed');
  check('amendment: a stated multiplier the cash contradicts -> exception', x.code === 'multiplier-not-confirmed', x);
  const adj = trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, instExtra: { optionPremiumMultiplier: 10, type: 'VANILLA' } });
  adj.transferItems[0].cost = -10; adj.netAmount = -10.66;
  const adjSell = trade({ at: '2026-06-01T13:40:00+0000', buy: false, price: 2, instExtra: { optionPremiumMultiplier: 10 } });
  adjSell.transferItems[0].cost = 20; adjSell.netAmount = 19.34;
  const ar = R.rebuild([entry(adj), entry(adjSell)]).reconstruction;
  check('amendment: an adjusted contract whose multiplier the cash confirms is used at ITS multiplier ((2-1) x 10 = $10) and flagged', ar.trades.length === 1 && ar.trades[0].grossCents === 1000 && ar.flags.some(f => f.kind === 'unusual-contract'), { trades: ar.trades, flags: ar.flags });
  x = refusedAs(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, instExtra: { expirationDate: '2026-06-10T04:00:00+0000' } }), 'expiration-evidence-disagrees');
  check('the expiration date and the contract symbol must name the same day', x.code === 'expiration-evidence-disagrees', x);

  // ---- B3-4 fees -------------------------------------------------------------------------
  const nofee1 = trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1.11, fees: null });
  const nofee2 = trade({ at: '2026-06-01T13:36:00+0000', buy: false, price: 1.22 });
  let fr = R.rebuild([entry(nofee1), entry(nofee2)]).reconstruction;
  check('B3-4 a record with no fee lines has an UNKNOWN fee (null), never 0', fr.fills[0].feeCents === null && fr.trades[0].feeCents === null && fr.trades[0].netCents === null && fr.trades[0].grossCents === 1100, fr.trades[0]);
  check('...and totals say how many trades have no known fee instead of counting it as 0', fr.totals.tradesWithUnknownFee === 1 && fr.totals.feeCentsKnownOnly === 0, fr.totals);
  const cashOff = trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1.11 });
  cashOff.netAmount = -112.00;                       // cash implies $1.00, itemised says $0.66
  fr = R.rebuild([withLedgerFee(entry(cashOff))]).reconstruction;
  check('B3-4 itemised fee is used; the cash-derived fee is recorded as a disagreement, never used', fr.fills[0].feeCents === 66 && fr.flags.some(f => f.kind === 'fee-evidence-disagreement' && f.evidence.cashDerivedCents === 100), fr.flags);
  const credit = trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1, fees: [0.65, -0.05] });
  fr = R.rebuild([entry(credit)]).reconstruction;
  check('B3-4 a fee credit reduces the fee (65c charge - 5c credit = 60c)', fr.fills[0].feeCents === 60, fr.fills[0].feeCents);

  // ---- B3-6 nothing dropped --------------------------------------------------------------
  const lone = trade({ at: '2026-06-01T13:36:00+0000', buy: false, price: 1.22 });
  const big1 = trade({ at: '2026-06-02T13:30:00+0000', buy: true, qty: 1, price: 1 });
  const big2 = trade({ at: '2026-06-02T13:35:00+0000', buy: false, qty: 3, price: 1.5 });
  const leftOpen = trade({ at: '2026-06-03T13:30:00+0000', buy: true, qty: 2, price: 1, symbol: PUT });
  const later = { activityId: nextId++, type: 'DIVIDEND_OR_INTEREST', status: 'VALID', tradeDate: '2026-06-20T04:00:00+0000', netAmount: 0.01, transferItems: [] };
  fr = R.rebuild([entry(lone), entry(big1), entry(big2), entry(leftOpen), entry(later)]).reconstruction;
  check('B3-6 a sale with no earlier purchase is a close-without-open, with its reason', fr.exceptions.closeWithoutOpen.length === 1 && /No earlier purchase/.test(fr.exceptions.closeWithoutOpen[0].reason), fr.exceptions.closeWithoutOpen);
  check('B3-6 selling 3 against 1 bought: one trade of 1, and an excess close of 2', fr.trades.filter(t => t.closeFillId === `F:${big2.activityId}:1`).length === 1 && fr.exceptions.excessClose.length === 1 && fr.exceptions.excessClose[0].contractsUnmatched === 2, fr.exceptions.excessClose);
  check('B3-6 a lot never closed, after its expiry in the evidence: past-expiry-open, NOT assumed worthless', fr.exceptions.pastExpiryOpen.length === 1 && fr.exceptions.pastExpiryOpen[0].contractsRemaining === 2 && /Not assumed/.test(fr.exceptions.pastExpiryOpen[0].reason), fr.exceptions.pastExpiryOpen);
  check('"past expiry" is judged against the evidence\'s own latest date, never the clock', fr.asOf === '2026-06-20T04:00:00.000Z' && /latest tradeDate/.test(fr.asOfSource), [fr.asOf, fr.asOfSource]);
  const early = R.rebuild([entry(leftOpen)], { asOf: '2026-06-05T00:00:00Z' }).reconstruction;
  check('...and with an earlier asOf the same lot is still-open', early.exceptions.stillOpen.length === 1 && early.exceptions.pastExpiryOpen.length === 0 && early.asOfSource === 'given by the caller');
  check('B3-6 contracts and fees still balance with every exception present', fr.conservation.openingBalances && fr.conservation.closingBalances && fr.conservation.feesBalance, fr.conservation);
  const afterExp = trade({ at: '2026-06-10T14:00:00+0000', buy: false, price: 0.05, symbol: PUT });
  fr = R.rebuild([entry(leftOpen), entry(afterExp)]).reconstruction;
  check('B3-5 under fifo-v1 a sale after the contract\'s expiration closes nothing, and the lot is kept', fr.trades.length === 0 && fr.exceptions.closeWithoutOpen.length === 1 && /after their expiration/.test(fr.exceptions.closeWithoutOpen[0].reason) && fr.exceptions.pastExpiryOpen.length === 1, fr.exceptions);

  // ---- B3-3 order, and ties --------------------------------------------------------------
  const sameA = trade({ id: 200000000002, at: '2026-06-01T13:31:00+0000', buy: true, price: 1.00 });
  const sameB = trade({ id: 200000000001, at: '2026-06-01T13:31:00+0000', buy: true, price: 2.00 });
  const sellOne = trade({ id: 200000000003, at: '2026-06-01T13:40:00+0000', buy: false, price: 3.00 });
  fr = R.rebuild([entry(sameA), entry(sameB), entry(sellOne)]).reconstruction;
  check('B3-3 two purchases at the SAME instant: the lower activityId is the older (FIFO takes the $2.00 lot)', fr.trades.length === 1 && fr.trades[0].entryPrice === 2.00, fr.trades.map(t => t.entryPrice));
  check('B3-3 UTC is the order; New York date/time are shown alongside', fr.trades[0].entryInstant === '2026-06-01T13:31:00.000Z' && fr.trades[0].entryNy === '2026-06-01 09:31:00', fr.trades[0]);
  const wide = R.rebuild([entry(trade({ id: 999, at: '2026-06-01T13:31:00+0000', buy: true, price: 1 })), entry(trade({ id: 1000, at: '2026-06-01T13:31:00+0000', buy: true, price: 2 })), entry(trade({ id: 1001, at: '2026-06-01T13:32:00+0000', buy: false, price: 3 }))]).reconstruction;
  check('B3-3 activityIds compare as numbers (999 before 1000), not as text', wide.trades[0].entryPrice === 1, wide.trades.map(t => t.entryPrice));

  // ---- B3-8 trade ids --------------------------------------------------------------------
  const t0 = R.rebuild(ledgerA).reconstruction.trades;
  check('B3-8 trade ids are T: + 24 hex characters', t0.every(t => /^T:[0-9a-f]{24}$/.test(t.tradeId)));
  check('B3-8 the id is sha256(openFillId|closeFillId|rule) with the literal rule name', t0[0].tradeId === 'T:' + require('crypto').createHash('sha256').update(`${t0[0].openFillId}|${t0[0].closeFillId}|fifo-v1`).digest('hex').slice(0, 24));
  const c0 = R.rebuild(ledgerA, { rule: 'current-rule-v1' }).reconstruction.trades;
  check('B3-8 the same pairing under another rule has a different id (ids never imply the same reconstruction)', t0.every(a => !c0.some(b => b.tradeId === a.tradeId)) && t0[0].tradeId === R.tradeIdOf(t0[0].openFillId, t0[0].closeFillId, 'fifo-v1'));
  check('B3-8 ids are unique', new Set(t0.map(t => t.tradeId)).size === t0.length);

  // ---- Determinism: order, batches, duplicates (the auditor's Ledger A / Ledger B) -------
  const base = J(R.rebuild(ledgerA).reconstruction);
  let allSame = true;
  for (let s = 1; s <= 25; s++) if (J(R.rebuild(shuffle(ledgerA, s)).reconstruction) !== base) allSame = false;
  check('the same ledger in 25 different orders gives a byte-identical reconstruction', allSame);
  const batches = [ledgerA.slice(0, 3), ledgerA.slice(3, 6), ledgerA.slice(6)];
  check('...and fed as batches joined in any order, byte-identical', J(R.rebuild([...batches[2], ...batches[0], ...batches[1]]).reconstruction) === base);
  const reordered = e => JSON.parse(J(e), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  const ledgerB = [...ledgerA, ...ledgerA.slice(0, 5).map(e => JSON.parse(J(e))), ...ledgerA.slice(2, 4).map(reordered), ...ledgerA.slice(0, 2).map(wrap), J(ledgerA[3])];
  const outB = R.rebuild(shuffle(ledgerB, 7));
  check('AUDITOR: Ledger B (the same records plus duplicate copies, some re-serialized, wrapped or as text) gives EXACTLY the same reconstruction as Ledger A', J(outB.reconstruction) === base);
  check('...and the duplicates are counted in the input summary, not hidden', outB.input.duplicateObservations === 10 && outB.input.distinctRecords === ledgerA.length, outB.input);
  const bothA = R.rebuildBoth(ledgerA), bothB = R.rebuildBoth(shuffle(ledgerB, 3));
  check('...for both pairing rules and their comparison', J([bothA.fifo, bothA.current, bothA.comparison]) === J([bothB.fifo, bothB.current, bothB.comparison]));
  check('two runs give the same answer', J(R.rebuildBoth(ledgerA)) === J(R.rebuildBoth(ledgerA)));

  // ---- Input that cannot be trusted --------------------------------------------------------
  const v1 = trade({ id: 300000000001, at: '2026-06-01T13:31:00+0000', buy: true, price: 1 });
  const v2 = JSON.parse(J(v1)); v2.netAmount = -999;
  fr = R.rebuild([entry(v1), entry(v2)]).reconstruction;
  check('R19: one record in two different versions is left out and reported, never picked between', fr.fills.length === 0 && fr.exceptions.inputProblems.some(p => p.kind === 'conflicting-record' && p.recordId === '300000000001'), fr.exceptions.inputProblems);
  const bad = entry(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1 }));
  bad.raw.netAmount = -1;   // content changed after the fingerprint was taken
  fr = R.rebuild([bad]).reconstruction;
  check('an entry that does not match its own fingerprint is left out and reported', fr.fills.length === 0 && fr.exceptions.inputProblems.some(p => p.kind === 'fingerprint-mismatch'));
  const twoAcc = [entry(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1 }), 'acct-1111111111111111'), entry(trade({ at: '2026-06-01T13:36:00+0000', buy: false, price: 2 }), 'acct-2222222222222222')];
  fr = R.rebuild(twoAcc).reconstruction;
  check('a purchase in one account is never closed by a sale in another', fr.trades.length === 0 && fr.exceptions.closeWithoutOpen.length === 1 && fr.accounts.length === 2);
  const withMismatchFee = withLedgerFee(entry(trade({ at: '2026-06-01T13:31:00+0000', buy: true, price: 1 })));
  withMismatchFee.normalized.fees.normalizedFee = 0.99;
  fr = R.rebuild([withMismatchFee]).reconstruction;
  check('the record\'s own fee lines are the evidence; a different stored figure is flagged', fr.fills[0].feeCents === 66 && fr.flags.some(f => f.kind === 'fee-normalization-disagreement'));

  // ---- B3-11 the input is never changed -------------------------------------------------------
  const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const frozen = deepFreeze(JSON.parse(J(ledgerA)));
  let threw = null;
  try { R.rebuildBoth(frozen); } catch (e) { threw = e.message; }
  check('B3-11 the supplied records are never modified (deep-frozen input works)', threw === null, threw);
  check('B3-11 the ledger\'s fingerprint recipe and this one agree', (() => { const bi = require('crypto'); const can = v => Array.isArray(v) ? '[' + v.map(can).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + can(v[k])).join(',') + '}' : JSON.stringify(v); return ledgerA.every(e => bi.createHash('sha256').update(can(e.raw)).digest('hex') === R.fingerprint(e.raw)); })());

  // ---- B3-5 FIFO vs the current rule --------------------------------------------------------
  // Monday: buy at 1.00 and keep it. Tuesday: buy at 2.00, sell one at 2.50.
  // FIFO sells Monday's lot; the current rule sells Tuesday's (same day, newest).
  const mon = trade({ at: '2026-06-01T14:00:00+0000', buy: true, price: 1.00 });
  const tue = trade({ at: '2026-06-02T14:00:00+0000', buy: true, price: 2.00 });
  const sellTue = trade({ at: '2026-06-02T14:30:00+0000', buy: false, price: 2.50 });
  const both = R.rebuildBoth([entry(mon), entry(tue), entry(sellTue)], { asOf: '2026-06-02T20:00:00Z' });
  check('B3-5 FIFO pairs the sale with Monday\'s purchase', both.fifo.trades[0].openFillId === `F:${mon.activityId}:1` && both.fifo.trades[0].grossCents === 15000);   // (2.50 - 1.00) x 100
  check('B3-5 the current rule pairs it with Tuesday\'s (newest same-day)', both.current.trades[0].openFillId === `F:${tue.activityId}:1` && both.current.trades[0].grossCents === 5000);   // (2.50 - 2.00) x 100
  check('B3-5 the comparison names the sale that differs, and the gross difference ($100.00)', both.comparison.pairingsThatDiffer === 1 && both.comparison.closeFillsThatDiffer[0].closeFillId === `F:${sellTue.activityId}:1` && both.comparison.grossCents.difference === 10000, both.comparison);
  check('B3-5 ...and which lot each rule leaves open', both.fifo.exceptions.stillOpen[0].fillId === `F:${tue.activityId}:1` && both.current.exceptions.stillOpen[0].fillId === `F:${mon.activityId}:1`);
  const old = trade({ at: '2026-04-01T14:00:00+0000', buy: true, price: 1.00, symbol: 'SPY   260609C00700000', putCall: 'CALL' });
  const late = trade({ at: '2026-05-20T14:00:00+0000', buy: false, price: 1.50, symbol: 'SPY   260609C00700000', putCall: 'CALL' });
  const b2 = R.rebuildBoth([entry(old), entry(late)]);
  check('B3-5 the current rule\'s 45-day limit is modelled: FIFO closes a 49-day-old lot, the current rule reports close-without-open and keeps the lot', b2.fifo.trades.length === 1 && b2.current.trades.length === 0 && b2.current.exceptions.closeWithoutOpen.length === 1 && b2.current.exceptions.stillOpen.length === 1, { f: b2.fifo.trades.length, c: b2.current.exceptions });
  check('an unknown rule name is refused, not guessed', (() => { try { R.rebuild(ledgerA, { rule: 'lifo' }); return false; } catch (e) { return /Unknown pairing rule/.test(e.message); } })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: crashed', e && e.stack); process.exit(1); });
