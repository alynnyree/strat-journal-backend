const axios = require('axios');

// Schwab Trader API base, per developer.schwab.com. Verify exact paths
// against current docs if a call starts 404ing — Schwab has changed these before.
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// How many days per request. Schwab may cap how many transactions a single
// request returns; fetching in smaller windows makes it far less likely any
// one request hits that cap, and — critically — we fetch the MOST RECENT
// window first, then step backward. That way, if a cap is ever hit, it's
// always the oldest data that's missing, never the newest.
const CHUNK_DAYS = 30;

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

// Turns one raw Schwab transaction into flat option fills. Each transaction
// has a `transferItems` ARRAY (not a single `transactionItem` object). Fee
// lines have instrument.assetType 'CURRENCY'; the actual option leg has
// instrument.assetType 'OPTION', plus `positionEffect` ('OPENING' or
// 'CLOSING'), `price`, and a signed `cost` (positive = money received,
// negative = money paid) — combining those two gives the full
// BUY/SELL_TO_OPEN/CLOSE instruction.
function extractOptionFills(transaction) {
  const fills = [];
  const items = transaction.transferItems || [];
  for (const ti of items) {
    if (ti.instrument?.assetType !== 'OPTION') continue;
    const quantity = Math.abs(ti.amount || 0);
    if (!quantity) continue;

    const isOpening = ti.positionEffect === 'OPENING';
    const receivedMoney = (ti.cost || 0) > 0;
    let instruction;
    if (isOpening) instruction = receivedMoney ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';
    else instruction = receivedMoney ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE';

    const dt = new Date(transaction.tradeDate || transaction.time);
    fills.push({
      transactionId: transaction.activityId || transaction.orderId,
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
  return fills;
}

// Fetches option fills across the full [startDate, endDate] window by
// walking backward in CHUNK_DAYS-sized pieces, starting at endDate (today,
// for a normal backfill) and stepping toward startDate. Recent data is
// always fetched — and available to the app — before older data.
async function getOptionFills(accessToken, startDate, endDate) {
  const accountNumber = await getAccountNumber(accessToken);
  if (!accountNumber) return [];

  const rangeEndMs = new Date(toSchwabTimestamp(endDate, true)).getTime();
  const rangeStartMs = new Date(toSchwabTimestamp(startDate, false)).getTime();

  const allFills = [];
  const seen = new Set();

  let chunkEndMs = rangeEndMs;
  while (chunkEndMs > rangeStartMs) {
    let chunkStartMs = chunkEndMs - CHUNK_DAYS * 24 * 60 * 60 * 1000;
    if (chunkStartMs < rangeStartMs) chunkStartMs = rangeStartMs;

    const chunkStartIso = new Date(chunkStartMs).toISOString();
    const chunkEndIso = new Date(chunkEndMs).toISOString();

    let raw = [];
    try {
      raw = await schwabGet(`/accounts/${accountNumber}/transactions`, accessToken, {
        startDate: chunkStartIso,
        endDate: chunkEndIso,
        types: 'TRADE',
      });
    } catch (err) {
      console.log(`Chunk ${chunkStartIso} → ${chunkEndIso} failed:`, err.response?.data || err.message);
    }

    console.log(`Chunk ${chunkStartIso} → ${chunkEndIso}: ${Array.isArray(raw) ? raw.length : 0} transaction(s)`);

    for (const t of (raw || [])) {
      for (const fill of extractOptionFills(t)) {
        const dedupeKey = `${fill.transactionId}-${fill.occ}-${fill.instruction}-${fill.timestamp}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        allFills.push(fill);
      }
    }

    chunkEndMs = chunkStartMs;
  }

  return allFills.sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { getAccountNumber, getOptionFills };
