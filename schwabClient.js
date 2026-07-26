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
async function getOptionFills(accessToken, startDate, endDate) {
  const accountNumber = await getAccountNumber(accessToken);
  if (!accountNumber) return [];

  const raw = await schwabGet(`/accounts/${accountNumber}/transactions`, accessToken, {
    startDate: toSchwabTimestamp(startDate, false),
    endDate: toSchwabTimestamp(endDate, true),
    types: 'TRADE',
  });

  // Temporary diagnostic — remove once we confirm the real shape of Schwab's response.
  console.log(`Schwab returned ${Array.isArray(raw) ? raw.length : 'non-array: ' + typeof raw} transaction(s) for account ${accountNumber}`);
  if (Array.isArray(raw) && raw.length > 0) {
    console.log('Sample transaction shape:', JSON.stringify(raw[0]).slice(0, 500));
  }

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
