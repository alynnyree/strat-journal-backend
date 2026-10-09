const axios = require('axios');
const crypto = require('crypto');
// The ledger's own account reference (audit M-1): every fill says which
// account it came from, in the same form the broker ledger records.
const { refOf } = require('./ledgerAccount');

// ---- Fill identity (audit Step C: F1 + R1) -------------------------------
// Schwab's activityId is the identity of a fill's record. A record without
// one is named by its own content: "U-" + the first 32 hex characters of the
// SHA-256 of its canonical form, marked uncertain. That is EXACTLY the broker
// ledger's rule (brokerLedger.identityOf, using brokerInspect's canonical and
// fingerprint), copied here because brokerInspect already loads this file and
// loading it back would be a loop. tests/fill-identity.js proves the two give
// the same id, character for character, on representative records.
//
// It used to be `activityId || orderId`. Every execution of one order shares
// the orderId, so a later piece of a partly filled order looked "already
// handled" and was dropped without a word. orderId is never an identity now;
// it is kept only as `legacyId`, for recognising fills an older version of
// this service recorded by it (see notYetProcessed in cron.js).
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
const fingerprint = rec => crypto.createHash('sha256').update(canonical(rec)).digest('hex');
function recordIdentity(t) {
  if (t && t.activityId != null) return { value: t.activityId, uncertain: false };
  return { value: 'U-' + fingerprint(t).slice(0, 32), uncertain: true };
}

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
// What the fills in this transaction cost in fees.
//
// Worked out from the cash rather than from Schwab's fee lines, because
// the cash is the figure that can be checked: for a buy the money leaving
// the account is the contracts' value PLUS fees, and for a sell the money
// arriving is the value MINUS fees. That arithmetic was verified against
// 480 real fills in the owner's own account statement and held exactly on
// every one. Falls back to adding up Schwab's own fee lines, and returns
// null rather than a guess when neither is available -- an unknown fee
// must never be shown as a fee of zero.
function feesForTransaction(transaction, optionItems) {
  const grossTotal = optionItems.reduce(
    (sum, ti) => sum + Math.abs(ti.price || 0) * 100 * Math.abs(ti.amount || 0), 0);
  if (!grossTotal) return null;

  const net = Math.abs(transaction.netAmount ?? NaN);
  if (Number.isFinite(net) && net > 0) {
    // A buy pays out more than the contracts are worth; a sell brings in
    // less. Either way the gap is the fees.
    const gap = Math.abs(net - grossTotal);
    // A gap larger than a fifth of the trade is not a fee -- something
    // else is going on, and a wrong number is worse than no number.
    if (gap <= grossTotal * 0.2) return Math.round(gap * 100) / 100;
  }

  // Schwab also itemises fees, each carrying a feeType. Only used when the
  // cash figure is missing or implausible.
  const itemised = (transaction.transferItems || [])
    .filter(ti => ti.feeType)
    .reduce((sum, ti) => sum + Math.abs(ti.cost ?? ti.amount ?? 0), 0);
  return itemised > 0 ? Math.round(itemised * 100) / 100 : null;
}

// `problems`, if passed, collects the records that could not become fills
// and why -- an unusable record is reported, never quietly skipped.
function extractOptionFills(transaction, problems = null) {
  const fills = [];
  const items = transaction.transferItems || [];
  const optionItems = items.filter(ti => ti.instrument?.assetType === 'OPTION' && Math.abs(ti.amount || 0));
  if (!optionItems.length) return fills;
  const identity = recordIdentity(transaction);

  // The tradeDate is the ONLY date a fill has (B3-2, audit Step C / H-5).
  // It used to fall back to Schwab's `time` when missing -- a different
  // moment, used silently. Missing or unreadable now means no fill, and the
  // reason goes back to whoever asked.
  const dt = transaction.tradeDate ? new Date(transaction.tradeDate) : null;
  if (!dt || Number.isNaN(dt.getTime())) {
    if (problems) problems.push({
      id: identity.value,
      kind: 'no-trade-date',
      tradeDate: transaction.tradeDate ?? null,
      reason: 'Schwab gave no usable tradeDate; no other time is substituted.',
    });
    return fills;
  }
  const txFees = feesForTransaction(transaction, optionItems);
  const grossTotal = optionItems.reduce(
    (sum, ti) => sum + Math.abs(ti.price || 0) * 100 * Math.abs(ti.amount || 0), 0);

  for (const ti of items) {
    if (ti.instrument?.assetType !== 'OPTION') continue;
    const quantity = Math.abs(ti.amount || 0);
    if (!quantity) continue;

    const isOpening = ti.positionEffect === 'OPENING';
    const receivedMoney = (ti.cost || 0) > 0;
    let instruction;
    if (isOpening) instruction = receivedMoney ? 'SELL_TO_OPEN' : 'BUY_TO_OPEN';
    else instruction = receivedMoney ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE';

    const { date, time } = toEasternParts(dt);
    fills.push({
      transactionId: identity.value,
      ...(identity.uncertain ? {
        identityUncertain: true,
        ...(transaction.orderId != null ? { legacyId: transaction.orderId } : {}),
      } : {}),
      occ: ti.instrument.symbol,
      ticker: ti.instrument.underlyingSymbol || ti.instrument.symbol,
      instruction,
      putCall: ti.instrument.putCall, // 'CALL' or 'PUT' — used for Long/Short, not buy/sell
      price: ti.price,
      quantity,
      // One transaction can hold more than one contract; each carries its
      // share of the fee, in proportion to its size.
      fees: txFees == null ? null : (() => {
        const legGross = Math.abs(ti.price || 0) * 100 * quantity;
        const share = grossTotal ? txFees * (legGross / grossTotal) : txFees;
        return Math.round(share * 100) / 100;
      })(),
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
    report.unusable = { count: 0, examples: [] };
  }
  const problems = [];
  // M-1: the account every fill below came from. Pairing requires the
  // purchase and the sale to carry the SAME reference; nothing is inferred.
  const accountRef = refOf(accountNumber);

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
      for (const fill of extractOptionFills(t, problems)) {
        const dedupeKey = `${fill.transactionId}-${fill.occ}-${fill.instruction}-${fill.timestamp}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        fill.accountRef = accountRef;
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

  if (report) {
    // The same record can come back in two windows; count it once.
    const unique = [...new Map(problems.map(p => [String(p.id), p])).values()];
    report.unusable = { count: unique.length, examples: unique.slice(0, 5) };
  }
  return allFills.sort((a, b) => a.timestamp - b.timestamp);
}

// extractOptionFills and toEasternParts are exported so the blind replay
// can run the REAL extraction over a rebuilt Schwab transaction, rather
// than a copy of it. The date/time conversion and the fee-from-cash
// arithmetic are two of the things being tested; a stand-in would test
// the stand-in.
module.exports = { getAccountNumber, getOptionFills, extractOptionFills, toEasternParts };
