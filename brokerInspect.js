// BLOCKER 2A: a READ-ONLY look at what Schwab actually returns.
//
// Authorized by the owner on 30 Sept 2026 ("Authorize Blocker 2A"), at the
// auditor's request: before anything is written to a broker ledger, find
// out what Schwab really hands back -- how much, how far back, which kinds of
// record, which carry Schwab's own reference number, which cannot safely
// become fills -- and report it. ZERO WRITES: nothing here stores, pairs,
// queues, or changes anything, and it never renews the Schwab sign-in
// (renewing saves a new one; the five-minute sync already does that).
//
// It asks for EVERY kind of record, not just trades. The service has only
// ever asked Schwab for TRADE records, so fees, transfers and option
// expirations have never been looked at.
//
// The answer contains counts, dates, record kinds, Schwab reference numbers
// and sizes. It never contains account numbers, sign-in details or the
// records themselves -- the report goes to the auditor.
const crypto = require('crypto');
const axios = require('axios');
const { getTokens } = require('./tokenStore');
const { extractOptionFills } = require('./schwabClient');

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 3 * 365;   // probe up to three years back
const STOP_AFTER_REFUSED = 6;        // consecutive refused windows = past the limit
const MAX_RECORDS = 20000;           // a ceiling on what is held in memory
const PAUSE_MS = 250;                // gentle on Schwab's request allowance

// Every transaction kind Schwab documents for this endpoint.
const ALL_TYPES = [
  'TRADE', 'RECEIVE_AND_DELIVER', 'DIVIDEND_OR_INTEREST', 'ACH_RECEIPT',
  'ACH_DISBURSEMENT', 'CASH_RECEIPT', 'CASH_DISBURSEMENT', 'ELECTRONIC_FUND',
  'WIRE_OUT', 'WIRE_IN', 'JOURNAL', 'MEMORANDUM', 'MARGIN_CALL',
  'MONEY_MARKET', 'SMA_ADJUSTMENT',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The same record always gives the same fingerprint, whatever order its
// fields arrived in.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
const fingerprint = rec => crypto.createHash('sha256').update(canonical(rec)).digest('hex');

// A plain reason for a failed request, never raw server text beyond 200 chars.
function whyFailed(err) {
  const d = err && err.response && err.response.data;
  const body = d ? (typeof d === 'string' ? d : JSON.stringify(d)) : (err && err.message) || String(err);
  return body.slice(0, 200);
}

const isOptionItem = ti => ti && ti.instrument && ti.instrument.assetType === 'OPTION';

// Why a record could NOT safely become normalized fills today. Empty list = fine.
function unsafeReasons(t) {
  const reasons = [];
  const optionItems = (t.transferItems || []).filter(isOptionItem);
  if (!optionItems.length) return reasons;                 // not an option record at all
  if (t.activityId == null) reasons.push('no Schwab activityId (R1: would need an uncertain composite identity)');
  if (t.type && t.type !== 'TRADE') reasons.push(`option record of kind ${t.type} -- e.g. an expiry, assignment or exercise (decision B: flag, never guess)`);
  if (t.status && t.status !== 'VALID') reasons.push(`status ${t.status}`);
  const traded = optionItems.filter(ti => Math.abs(ti.amount || 0));
  if (!traded.length) reasons.push('option lines with zero quantity');
  for (const ti of traded) {
    if (!ti.positionEffect) { reasons.push('an option line with no OPENING/CLOSING marker'); break; }
  }
  for (const ti of traded) {
    if (ti.price == null) { reasons.push('an option line with no price'); break; }
  }
  if (!(t.tradeDate || t.time)) reasons.push('no trade date or time');
  let fills = null;
  try { fills = extractOptionFills(t); }
  catch (e) { reasons.push('the current converter throws on it: ' + (e && e.message)); }
  if (fills && traded.length && !fills.length) reasons.push('the current converter produces no fill from it');
  if (fills && fills.some(f => f.fees == null)) reasons.push('fee cannot be worked out (stays unknown, never 0)');
  return reasons;
}

async function inspectBrokerHistory(options = {}) {
  const http = options.http || axios;
  const now = options.now ? new Date(options.now) : new Date();
  const report = {
    readOnly: true,
    ranAt: now.toISOString(),
    ok: false,
    reason: null,
    request: null,
    windows: [],
    totals: null,
  };

  // ---- The sign-in: read, never renewed ---------------------------------
  let store;
  try { store = await getTokens(); }
  catch (e) { report.reason = 'Could not read the Schwab sign-in from storage: ' + whyFailed(e); return report; }
  if (!store || !store.access_token) {
    report.reason = 'Not signed in to Schwab. Reconnect to Schwab, then run this again.';
    return report;
  }
  if (Date.now() > (store.expires_at || 0)) {
    report.reason = "Schwab's short-lived access pass has run out. This inspection does not renew it (renewing saves a new one, and this step writes nothing). The five-minute sync renews it by itself -- try again in a few minutes.";
    return report;
  }
  const headers = { Authorization: `Bearer ${store.access_token}` };
  const get = (path, params) => http.get(`${TRADER_BASE}${path}`, { headers, params }).then(r => r.data);

  // ---- The account (its number never leaves this function) --------------
  let account;
  try {
    const list = await get('/accounts/accountNumbers');
    account = Array.isArray(list) && list[0] && list[0].hashValue;
    report.accountsReturned = Array.isArray(list) ? list.length : 0;
  } catch (e) {
    report.reason = 'Schwab refused the account lookup: ' + whyFailed(e);
    return report;
  }
  if (!account) { report.reason = 'Schwab answered the account lookup with no account.'; return report; }

  // ---- Walk back through history, newest first ---------------------------
  const records = [];
  let typesParam = ALL_TYPES.join(',');
  let refusedInARow = 0;
  let end = now.getTime();
  const floor = end - MAX_LOOKBACK_DAYS * 86400000;
  let truncated = false;
  while (end > floor) {
    const start = Math.max(end - WINDOW_DAYS * 86400000, floor);
    const w = { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) };
    try {
      let raw;
      try {
        raw = await get(`/accounts/${account}/transactions`, {
          startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), types: typesParam,
        });
      } catch (e) {
        // Asking for every kind at once may be refused; if so, fall back to
        // trades only and SAY so -- the report then covers trades alone.
        if (typesParam !== 'TRADE' && e.response && e.response.status === 400 && records.length === 0 && report.windows.length === 0) {
          report.allKindsRefused = whyFailed(e);
          typesParam = 'TRADE';
          raw = await get(`/accounts/${account}/transactions`, {
            startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), types: typesParam,
          });
        } else throw e;
      }
      const list = Array.isArray(raw) ? raw : [];
      w.status = 'ok';
      w.records = list.length;
      refusedInARow = 0;
      for (const t of list) {
        if (records.length >= MAX_RECORDS) { truncated = true; break; }
        records.push({ t, window: w.from });
      }
    } catch (e) {
      w.status = 'refused';
      w.httpStatus = (e.response && e.response.status) || null;
      w.why = whyFailed(e);
      refusedInARow++;
    }
    report.windows.push(w);
    if (truncated || refusedInARow >= STOP_AFTER_REFUSED) break;
    end = start;
    if (PAUSE_MS && !options.noPause) await sleep(PAUSE_MS);
  }
  report.request = {
    kindsAsked: typesParam === 'TRADE' ? ['TRADE'] : ALL_TYPES,
    windowDays: WINDOW_DAYS,
    lookbackDaysProbed: Math.round((now.getTime() - end) / 86400000),
    stoppedBecause: truncated ? `held-record ceiling of ${MAX_RECORDS} reached`
      : refusedInARow >= STOP_AFTER_REFUSED ? `${STOP_AFTER_REFUSED} windows in a row refused (treated as the end of what Schwab serves)`
      : `reached the ${MAX_LOOKBACK_DAYS}-day probe limit`,
  };

  // ---- Describe what came back -------------------------------------------
  const byId = new Map();
  const kinds = {}, statuses = {}, feeTypes = {}, assetTypes = {};
  let noId = 0, optionRecords = 0, nonOptionRecords = 0, multiLeg = 0, multiContract = 0;
  let bytes = 0, optionBytes = 0, cashFeeTotal = 0, itemisedFeeTotal = 0, feeUnknown = 0;
  let minDate = null, maxDate = null;
  const unsafe = [];
  const exampleShape = {};
  for (const { t, window } of records) {
    const size = Buffer.byteLength(canonical(t));
    bytes += size;
    kinds[t.type || '(none)'] = (kinds[t.type || '(none)'] || 0) + 1;
    statuses[t.status || '(none)'] = (statuses[t.status || '(none)'] || 0) + 1;
    const d = String(t.tradeDate || t.time || '').slice(0, 10) || null;
    if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }
    for (const ti of t.transferItems || []) {
      const at = (ti.instrument && ti.instrument.assetType) || '(none)';
      assetTypes[at] = (assetTypes[at] || 0) + 1;
      if (ti.feeType) {
        feeTypes[ti.feeType] = feeTypes[ti.feeType] || { lines: 0, total: 0 };
        feeTypes[ti.feeType].lines++;
        feeTypes[ti.feeType].total = Math.round((feeTypes[ti.feeType].total + Math.abs(ti.cost ?? ti.amount ?? 0)) * 100) / 100;
      }
    }
    for (const k of Object.keys(t)) exampleShape[k] = typeof t[k] === 'object' && t[k] !== null ? (Array.isArray(t[k]) ? 'list' : 'object') : typeof t[k];
    if (t.activityId == null) noId++;
    else {
      const k = String(t.activityId);
      const fp = fingerprint(t);
      if (!byId.has(k)) byId.set(k, { fps: new Set(), windows: new Set(), seen: 0 });
      const e = byId.get(k); e.fps.add(fp); e.windows.add(window); e.seen++;
    }
    const opt = (t.transferItems || []).filter(isOptionItem);
    if (opt.length) {
      optionRecords++;
      optionBytes += size;
      const traded = opt.filter(ti => Math.abs(ti.amount || 0));
      if (traded.length > 1) multiLeg++;
      if (traded.some(ti => Math.abs(ti.amount || 0) > 1)) multiContract++;
      const gross = traded.reduce((s, ti) => s + Math.abs(ti.price || 0) * 100 * Math.abs(ti.amount || 0), 0);
      const net = Math.abs(t.netAmount ?? NaN);
      if (gross && Number.isFinite(net) && net > 0 && Math.abs(net - gross) <= gross * 0.2) cashFeeTotal += Math.abs(net - gross);
      else feeUnknown++;
      itemisedFeeTotal += (t.transferItems || []).filter(ti => ti.feeType).reduce((s, ti) => s + Math.abs(ti.cost ?? ti.amount ?? 0), 0);
      const why = unsafeReasons(t);
      if (why.length) unsafe.push({ activityId: t.activityId ?? null, date: d, kind: t.type || null, reasons: why });
    } else nonOptionRecords++;
  }
  const dupIds = [...byId.entries()].filter(([, e]) => e.seen > 1);
  const conflicting = dupIds.filter(([, e]) => e.fps.size > 1);
  const perRecordOverhead = 64 /* fingerprint */ + 120 /* key, first-seen time, source, identity */;

  report.ok = true;
  report.totals = {
    records: records.length,
    heldCeilingReached: truncated,
    dateRange: { oldest: minDate, newest: maxDate },
    windowsOk: report.windows.filter(w => w.status === 'ok').length,
    windowsRefused: report.windows.filter(w => w.status === 'refused').length,
    oldestWindowWithRecords: (report.windows.filter(w => w.status === 'ok' && w.records > 0).pop() || {}).from || null,
    kinds, statuses,
    optionRecords, nonOptionRecords,
    lineAssetTypes: assetTypes,
    withActivityId: records.length - noId,
    withoutActivityId: noId,
    uniqueActivityIds: byId.size,
    duplicateIds: {
      count: dupIds.length,
      identicalCopies: dupIds.length - conflicting.length,
      sameIdDifferentContent: conflicting.length,
      examples: dupIds.slice(0, 10).map(([id, e]) => ({ activityId: id, seen: e.seen, versions: e.fps.size, windows: [...e.windows] })),
    },
    multiLegOptionRecords: multiLeg,
    optionRecordsWithMoreThanOneContract: multiContract,
    fees: {
      fromCashOnOptionRecords: Math.round(cashFeeTotal * 100) / 100,
      itemisedOnOptionRecords: Math.round(itemisedFeeTotal * 100) / 100,
      optionRecordsWhereCashFeeUnknown: feeUnknown,
      itemisedLinesByFeeType: feeTypes,
    },
    cannotSafelyBecomeFills: { count: unsafe.length, records: unsafe.slice(0, 200), listTruncated: unsafe.length > 200 },
    storageEstimate: {
      rawBytesAllRecords: bytes,
      rawBytesOptionRecords: optionBytes,
      redisLedgerBytesAllRecords: bytes + records.length * perRecordOverhead,
      redisLedgerBytesOptionOnly: optionBytes + optionRecords * perRecordOverhead,
      archiveBytesAllRecords: bytes + records.length * (perRecordOverhead + 200 /* import information */),
      note: 'Estimates from the canonical JSON size of each record plus per-record metadata. Upstash counts stored bytes; this is the order of magnitude, not a quote.',
    },
    recordShape: exampleShape,   // field names and kinds only -- no values
  };
  report.proposedLedger = {
    oneEntryPer: 'Schwab activityId (R1). Records without one would get a deterministic composite identity marked uncertain.',
    wouldHold: `${byId.size} entries by activityId` + (noId ? ` + ${noId} uncertain composite entries` : '') +
      (conflicting.length ? ` + ${conflicting.length} later revisions kept beside their first version` : ''),
    eachEntry: ['the Schwab record exactly as received', 'its sha256 fingerprint', 'first-seen time', 'which path fetched it', 'the identity used (activityId, or composite marked uncertain)'],
    notIn: 'trades, pairings, derived fills or anything from the journal -- the ledger holds only what Schwab sent',
  };
  return report;
}

let running = null;
// One at a time: a second request while one runs gets the same answer.
function inspectOnce(options) {
  if (!running) running = inspectBrokerHistory(options).finally(() => { running = null; });
  return running;
}

module.exports = { inspectBrokerHistory, inspectOnce, unsafeReasons, fingerprint, canonical, ALL_TYPES };
