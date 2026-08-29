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

// Schwab's own timestamps are in UTC. Schwab's UI and exports (like order
// history) display everything in US Eastern time — so trades must be
// converted here too, or every displayed entry/exit time is off by 4-5
// hours (whatever the UTC/Eastern offset happens to be that day, since
// this shifts with daylight saving). Uses Node's built-in Intl support —
// no extra package needed — and handles the DST shift automatically.
function toEasternParts(dt) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(dt).map(p => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour; // some locales report midnight as '24'
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
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
    const { date, time } = toEasternParts(dt);
    fills.push({
      transactionId: transaction.activityId || transaction.orderId,
      occ: ti.instrument.symbol,
      ticker: ti.instrument.underlyingSymbol || ti.instrument.symbol,
      instruction,
      putCall: ti.instrument.putCall, // 'CALL' or 'PUT' — used for Long/Short, not buy/sell
      price: ti.price,
      quantity,
      date,
      time,
      timestamp: dt.getTime(), // kept as true UTC epoch ms for sorting/comparison
    });
  }
  return fills;
}

// Fetches option fills across the full [startDate, endDate] window by
// walking backward in CHUNK_DAYS-sized pieces, starting at endDate (today,
// for a normal backfill) and stepping toward startDate. Recent data is
// always fetched — and available to the app — before older data.
// `report`, if passed, is filled in with what actually happened: how many
// windows were asked for, how many came back, how many failed and why, and
// the oldest fill Schwab was willing to hand over. Without this a window
// Schwab refuses is caught, logged to a server log nobody reads, and
// silently skipped -- which looks identical to "you have no trades that
// far back". The two need telling apart.
async function getOptionFills(accessToken, startDate, endDate, report = null) {
  const accountNumber = await getAccountNumber(accessToken);
  if (!accountNumber) {
    if (report) { report.accountFound = false; report.error = 'No Schwab account returned.'; }
    return [];
  }
  if (report) {
    report.accountFound = true;
    report.windowsAsked = 0;
    report.windowsOk = 0;
    report.windowsFailed = 0;
    report.failures = [];
    report.oldestWindowWithData = null;
  }

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
    let failed = false;
    if (report) report.windowsAsked++;
    try {
      raw = await schwabGet(`/accounts/${accountNumber}/transactions`, accessToken, {
        startDate: chunkStartIso,
        endDate: chunkEndIso,
        types: 'TRADE',
      });
      if (report) report.windowsOk++;
    } catch (err) {
      failed = true;
      const why = err.response?.data
        ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
        : err.message;
      console.log(`Chunk ${chunkStartIso} → ${chunkEndIso} failed:`, why);
      if (report) {
        report.windowsFailed++;
        // Keep a handful, not every one -- enough to see the pattern.
        if (report.failures.length < 5) {
          report.failures.push({
            from: chunkStartIso.slice(0, 10),
            to: chunkEndIso.slice(0, 10),
            status: err.response?.status || null,
            why: String(why).slice(0, 200),
          });
        }
      }
    }

    console.log(`Chunk ${chunkStartIso} → ${chunkEndIso}: ${Array.isArray(raw) ? raw.length : 0} transaction(s)`);

    let addedHere = 0;
    for (const t of (raw || [])) {
      for (const fill of extractOptionFills(t)) {
        const dedupeKey = `${fill.transactionId}-${fill.occ}-${fill.instruction}-${fill.timestamp}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        allFills.push(fill);
        addedHere++;
      }
    }
    // Windows are walked newest-first, so the last one to yield anything
    // is the oldest date Schwab actually served.
    if (report && !failed && addedHere > 0) {
      report.oldestWindowWithData = chunkStartIso.slice(0, 10);
    }

    chunkEndMs = chunkStartMs;
  }

  return allFills.sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { getAccountNumber, getOptionFills };
