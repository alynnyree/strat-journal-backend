// Synthetic broker records shaped exactly like the ledger's (the same fields
// Schwab sends), for checks that compare the live matcher or the Step E
// preparation tool with tradeRebuild.js. Copied from tests/trade-rebuild.js's
// builders; nothing here is real data. Not a check itself (run-all reads only
// the files directly inside tests/).
const { fingerprint } = require('../../tradeRebuild');

const opt = (symbol, putCall, expirationDate, underlying) => ({
  assetType: 'OPTION', status: 'ACTIVE', symbol, uniformSymbol: symbol, description: symbol, instrumentId: 1, closingPrice: 1,
  expirationDate,
  optionDeliverables: [{ rootSymbol: underlying, strikePercent: 100, deliverableNumber: 1, deliverableUnits: 100, deliverable: { assetType: 'EQUITY', symbol: underlying } }],
  optionPremiumMultiplier: 100, putCall, strikePrice: 740, type: 'VANILLA', underlyingSymbol: underlying, underlyingCusip: 'X',
});
const feeLine = (feeType, cost) => ({ instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, feeType, cost, amount: 0 });

// OCC symbol for an underlying, expiry (YYYY-MM-DD) and side.
const occOf = (und, exp, putCall) => `${und.padEnd(6)}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${putCall === 'PUT' ? 'P' : 'C'}00740000`;
// New York midnight of the expiry day, in Schwab's form (summer offset; the
// fixtures stay in summer).
const expStamp = exp => `${exp}T04:00:00+0000`;

let nextId = 200000000000;
// One Schwab TRADE record with one option line.
function record({ id, at, buy, qty = 1, price, und = 'SPY', exp = '2026-06-09', putCall = 'CALL', fees = [0.65, 0.01], orderId = 555, tradeDate }) {
  const symbol = occOf(und, exp, putCall);
  const cost = Math.round(price * 100 * qty * 100) / 100 * (buy ? -1 : 1);
  const feeTotal = fees ? fees.reduce((s, f) => s + f, 0) : 0;
  return {
    activityId: id == null ? nextId++ : id, time: at, type: 'TRADE', status: 'VALID', subAccount: 'CASH', tradeDate: tradeDate || at,
    positionId: 9001, orderId, netAmount: Math.round((cost - feeTotal) * 100) / 100,
    transferItems: [
      { instrument: opt(symbol, putCall, expStamp(exp), und), amount: buy ? qty : -qty, cost, price, positionEffect: buy ? 'OPENING' : 'CLOSING' },
      ...(fees ? [feeLine('COMMISSION', -fees[0]), ...(fees[1] != null ? [feeLine('OPT_REG_FEE', -fees[1])] : [])] : []),
    ],
  };
}
// The ledger entry around a record, as brokerLedger.js stores it.
const entry = (raw, accountRef = 'acct-aaaaaaaaaaaaaaaa') => ({
  schema: 'broker-ledger/v1', identity: { kind: 'activityId', value: String(raw.activityId), uncertain: false },
  fingerprint: fingerprint(raw), raw, normalized: { fees: { normalizedFee: null } }, provenance: { accountRef },
});
// The backup export's wrapping of a ledger entry.
const wrapped = e => ({ type: 'string', value: e });

// The same record as the live sync hands it to the matcher (schwabClient's
// extractOptionFills shape).
function fillOf(raw) {
  const line = raw.transferItems[0];
  const ms = Date.parse(raw.tradeDate.replace(/\+0000$/, 'Z'));
  const d = new Date(ms);
  const buy = line.amount > 0;
  const fees = raw.transferItems.filter(t => t.feeType).reduce((s, t) => s - t.cost, 0);
  return {
    transactionId: String(raw.activityId), occ: line.instrument.symbol, ticker: line.instrument.underlyingSymbol,
    putCall: line.instrument.putCall, instruction: buy ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
    price: line.price, quantity: Math.abs(line.amount), fees: Math.round(fees * 100) / 100,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ms,
  };
}

module.exports = { record, entry, wrapped, fillOf, occOf };
