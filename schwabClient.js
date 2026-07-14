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

// Normalizes Schwab's transaction shape into flat option fills.
async function getOptionFills(accessToken, startDate, endDate) {
  const accountNumber = await getAccountNumber(accessToken);
  if (!accountNumber) return [];

  const raw = await schwabGet(`/accounts/${accountNumber}/transactions`, accessToken, {
    startDate,
    endDate,
    types: 'TRADE',
  });

  return (raw || [])
    .filter(t => t.transactionItem?.instrument?.assetType === 'OPTION')
    .map(t => {
      const item = t.transactionItem;
      const dt = new Date(t.transactionDate);
      return {
        transactionId: t.activityId || t.transactionId,
        occ: item.instrument?.symbol,
        ticker: item.instrument?.underlyingSymbol || item.instrument?.symbol,
        instruction: item.instruction, // BUY_TO_OPEN / SELL_TO_OPEN / BUY_TO_CLOSE / SELL_TO_CLOSE
        price: item.price,
        quantity: Math.abs(item.amount || item.quantity || 1),
        date: dt.toISOString().slice(0, 10),
        time: dt.toISOString().slice(11, 16),
        timestamp: dt.getTime(),
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { getAccountNumber, getOptionFills };
