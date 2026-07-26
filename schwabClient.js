const axios = require('axios');

// Schwab Trader API base, per developer.schwab.com. Verify exact paths
// against current docs if a call starts 404ing — Schwab has changed these before.
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

async function schwabGet(pathname, accessToken, params = {}) {
  const resp = await axios.get(`${TRADER_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return resp.data;
}

async function getAccountNumber(accessToken) {
  const accountsHash = await schwabGet('/accounts/accountNumbers', accessToken);
  return accountsHash?.[0]?.hashValue || null;
}

// Schwab's transaction history endpoint requires full ISO-8601 timestamps
// (e.g. 2024-07-26T00:00:00.000Z), not bare dates (e.g. 2024-07-26) — a
// plain date string gets rejected with "is not a valid value for startDate".
function toSchwabTimestamp(dateStr, endOfDay = false) {
  return endOfDay
    ? `${dateStr}T23:59:59.000Z`
    : `${dateStr}T00:00:00.000Z`;
}

// Normalizes Schwab's transaction shape into flat option fills.
//
// Confirmed real shape (as of July 2026): each transaction has a
// `transferItems` ARRAY (not a single `transactionItem` object). Fee lines
// have instrument.assetType 'CURRENCY'; the actual option leg has
// instrument.assetType 'OPTION', plus `positionEffect` ('OPENING' or
// 'CLOSING'), `price`, and a signed `cost` (positive = money received,
// negative = money paid). Combining positionEffect + cost sign gives the
// full BUY/SELL_TO_OPEN/CLOSE instruction.
async function getOptionFills(accessToken, startDate, endDate) {
  const accountNumber = await getAccountNumber(accessToken);
  if (!accountNumber) return [];

  const raw = await schwabGet(`/accounts/${accountNumber}/transactions`, accessToken, {
    startDate: toSchwabTimestamp(startDate, false),
    endDate: toSchwabTimestamp(endDate, true),
    types: 'TRADE',
  });

  const fills = [];
  for (const t of (raw || [])) {
    const items = t.transferItems || [];
    for (const ti of items) {
      if (ti.instrument?.assetType !== 'OPTION') continue;
      const quantity = Math.abs(ti.amount || 0);
      if (!quantity) continue;

      const isOpening = ti.positionEffect === 'OPENING';
      const receivedMoney = (ti.cost || 0) > 0;
      let instruction;
      if (isOpening) instruction = receivedMoney ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';
      else instruction = receivedMoney ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE';

      const dt = new Date(t.tradeDate || t.time);
      fills.push({
        transactionId: t.activityId || t.orderId,
        occ: ti.instrument.symbol,
        ticker: ti.instrument.underlyingSymbol || ti.instrument.symbol,
        instruction,
        price: ti.price,
        quantity,
        date: dt.toISOString().slice(0, 10),
        time: dt.toISOString().slice(11, 16),
        timestamp: dt.getTime(),
      });
    }
  }

  return fills.sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { getAccountNumber, getOptionFills };
