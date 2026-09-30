// BLOCKER 2: THE IMMUTABLE BROKER LEDGER.
//
// Authorized by the owner on 30 Sept 2026 after the auditor closed Blocker
// 2A. Every Schwab transaction record, of EVERY kind, kept exactly as Schwab
// sent it, with where and when it was seen -- the evidence layer everything
// later is checked against. This file does NOT pair trades, rebuild
// positions, touch the journal, or change a single number he sees (auditor
// J, K). It writes only under "ledger:schwab:" in the operational store and
// under "broker-ledger-archive/" in the independent archive.
//
// ONE ENTRY, WRITTEN ONCE. Each record is a single entry created with
// "only if it does not exist yet" (SET NX). The DATABASE decides who wins, so
// two imports seeing the same record at the same moment cannot both create
// it -- no in-memory lock is relied on (auditor L). An entry is complete the
// moment it exists, so an import that fails part-way leaves only whole
// records behind (auditor M9).
//
// SAME ID, DIFFERENT CONTENT is never written over the original (auditor C,
// R19): it is kept as a revision entry beside it, also create-only.
//
// "Exactly as received": the operational entry holds Schwab's record with
// every value exactly as Schwab sent it (parsed and re-serialized, so
// spacing may differ); the ARCHIVE also holds Schwab's answers byte for
// byte as they arrived.
const crypto = require('crypto');
const axios = require('axios');
const { getTokens } = require('./tokenStore');
const { canonical, fingerprint, ALL_TYPES } = require('./brokerInspect');
const archive = require('./ledgerArchive');
const ledgerAccount = require('./ledgerAccount');

const SCHEMA = 'broker-ledger/v1';
const CODE = 'brokerLedger v1';
const PREFIX = 'ledger:schwab:';
const REC = id => `${PREFIX}rec:${id}`;
const REV = (id, fp) => `${PREFIX}rev:${id}:${fp}`;
const IMPORTS = `${PREFIX}imports`;

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const WINDOW_DAYS = 30;
const DEFAULT_YEARS = 10;
const STOP_AFTER_REFUSED = 6;
const PAUSE_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round(x * 100) / 100;

let redis = null;
function store() {
  if (redis) return redis;
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  return redis;
}
const asObject = v => (typeof v === 'string' ? JSON.parse(v) : v);

function whyFailed(err) {
  const d = err && err.response && err.response.data;
  const body = d ? (typeof d === 'string' ? d : JSON.stringify(d)) : (err && err.message) || String(err);
  return body.slice(0, 200);
}

// R1: Schwab's activityId is the identity. Without one, a deterministic
// composite of the record's own content, marked uncertain. orderId is never
// used.
function identityOf(t) {
  if (t && t.activityId != null) return { kind: 'activityId', value: String(t.activityId), uncertain: false };
  return { kind: 'composite', value: 'U-' + fingerprint(t).slice(0, 32), uncertain: true };
}

// R12 as the auditor worded it: the itemised Schwab fee lines are the
// normalized fee; the cash-derived fee and the difference are kept beside it
// as a check. No plausibility guard. Unknown is null, never 0. The original
// lines and netAmount stay in the raw record untouched; these are copies.
function feesOf(t) {
  const items = (t.transferItems || []);
  const lines = items.filter(ti => ti.feeType).map(ti => ({ feeType: ti.feeType, cost: ti.cost ?? null, amount: ti.amount ?? null }));
  const itemised = lines.length ? r2(-lines.reduce((s, l) => s + (l.cost ?? l.amount ?? 0), 0)) : null;
  const traded = items.filter(ti => ti.instrument && (ti.instrument.assetType === 'OPTION' || ti.instrument.assetType === 'EQUITY') && Math.abs(ti.amount || 0));
  const gross = traded.reduce((s, ti) => s + Math.abs(ti.price || 0) * (ti.instrument.assetType === 'OPTION' ? 100 : 1) * Math.abs(ti.amount || 0), 0);
  const hasNet = t.netAmount != null && Number.isFinite(Number(t.netAmount));
  const cashDerived = traded.length && gross && hasNet ? r2(Math.abs(Math.abs(Number(t.netAmount)) - gross)) : null;
  return {
    lines,
    normalizedFee: itemised,                 // authoritative: Schwab's own itemised lines
    netAmount: hasNet ? Number(t.netAmount) : null,
    cashDerivedFee: cashDerived,             // a check only
    difference: itemised != null && cashDerived != null ? r2(cashDerived - itemised) : null,
    provenance: 'normalizedFee = charges on Schwab fee lines (credits reduce it); cashDerivedFee = | |netAmount| - price x multiplier x quantity |, options x100, stock x1, no plausibility guard; null = unknown, never 0',
  };
}

function entryFor(t, fp, ctx) {
  const id = identityOf(t);
  return {
    schema: SCHEMA,
    identity: id,
    fingerprint: fp,
    raw: t,
    normalized: { kind: t.type ?? null, status: t.status ?? null, tradeDate: t.tradeDate ?? null, fees: feesOf(t) },
    provenance: {
      firstSeenAt: ctx.at,
      importId: ctx.importId,
      source: 'schwab-api GET /trader/v1/accounts/{account}/transactions',
      window: ctx.window,
      accountRef: ctx.accountRef,
      code: CODE,
      archiveRecordKey: archive.recordKey(id.value, fp),
      archiveResponseKey: ctx.responseKey,
    },
  };
}

// ---- Fetch: every kind, 30 days at a time, keeping each answer's bytes ----
async function fetchHistory({ r, http, now, years, noPause, onResponse, tieAs }) {
  const tokens = await getTokens();
  if (!tokens || !tokens.access_token) throw Object.assign(new Error('Not signed in to Schwab. Reconnect to Schwab, then import again.'), { plain: true });
  if (Date.now() > (tokens.expires_at || 0)) throw Object.assign(new Error("Schwab's short-lived access pass has run out. The import does not renew it; the five-minute sync does. Try again in a few minutes."), { plain: true });
  const headers = { Authorization: `Bearer ${tokens.access_token}` };
  const getText = async (path, params) => {
    const res = await http.get(`${TRADER_BASE}${path}`, { headers, params, responseType: 'text', transformResponse: [d => d] });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  };
  // Which account: an explicit, deterministic rule (ledgerAccount.js),
  // never "whichever Schwab lists first". Settled, and the ledger tied to it,
  // BEFORE a single transaction is asked for.
  const list = JSON.parse(await getText('/accounts/accountNumbers'));
  let chosen, tie;
  try {
    chosen = await ledgerAccount.resolveAccount(r, list);
    if (chosen.ok) tie = await ledgerAccount.writeTie(r, chosen, Object.assign({ basis: chosen.tieSource }, tieAs));
  } catch (e) {
    if (e && e.plain) throw e;
    throw Object.assign(new Error('Could not read or record which account the ledger is for, so nothing was fetched: ' + whyFailed(e)), { plain: true });
  }
  if (!chosen.ok) throw Object.assign(new Error(chosen.reason), { plain: true });
  const account = chosen.hashValue;
  const accountRef = chosen.ref;
  const accountChoice = { ref: chosen.ref, how: chosen.how, basis: chosen.tieSource, accountsReturned: chosen.accountsReturned, tie };

  const windows = [];
  const got = [];
  let end = now, refusedInARow = 0;
  const floor = now - Math.min(Math.max(years || DEFAULT_YEARS, 1), 10) * 365 * 86400000;
  while (end > floor) {
    const start = Math.max(end - WINDOW_DAYS * 86400000, floor);
    const w = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    try {
      const text = await getText(`/accounts/${account}/transactions`, { startDate: w.from, endDate: w.to, types: ALL_TYPES.join(',') });
      const parsed = JSON.parse(text);
      w.status = 'ok'; w.records = Array.isArray(parsed) ? parsed.length : 0;
      w.responseKey = await onResponse(w, text);           // archived BEFORE anything is written to the ledger
      for (const t of (Array.isArray(parsed) ? parsed : [])) got.push({ t, window: { from: w.from, to: w.to }, responseKey: w.responseKey });
      refusedInARow = 0;
    } catch (e) {
      if (e && e.archiveFailed) throw e;
      w.status = 'refused'; w.httpStatus = (e.response && e.response.status) || null; w.why = whyFailed(e);
      refusedInARow++;
    }
    windows.push(w);
    if (refusedInARow >= STOP_AFTER_REFUSED) break;
    end = start;
    if (!noPause) await sleep(PAUSE_MS);
  }
  return { windows, got, accountRef, accountChoice };
}

// ---- Write one record: create-only, database-decided ---------------------
async function writeOne(r, t, fp, ctx) {
  const id = identityOf(t).value;
  const entry = entryFor(t, fp, ctx);
  const created = await r.set(REC(id), entry, { nx: true });
  if (created === 'OK') return { result: 'inserted', id };
  // Someone got there first -- this import earlier, another import, or a
  // previous run. Compare, never overwrite.
  const existing = asObject(await r.get(REC(id)));
  if (existing && existing.fingerprint === fp) return { result: 'identical', id };
  const rev = Object.assign({}, entry, { revisionOf: { identity: id, originalFingerprint: existing ? existing.fingerprint : null } });
  const revCreated = await r.set(REV(id, fp), rev, { nx: true });
  return { result: revCreated === 'OK' ? 'revision' : 'revision-already-known', id };
}

// ---- The import -------------------------------------------------------------
async function importLedger(options = {}) {
  const r = options.redis || store();
  const http = options.http || axios;
  const nowMs = options.now || Date.now();
  const at = new Date(nowMs).toISOString();
  const importId = at.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const summary = {
    importId, startedAt: at, finishedAt: null, status: 'failed', reason: null, code: CODE, schema: SCHEMA,
    source: 'schwab-api, all transaction kinds', years: options.years || DEFAULT_YEARS,
    windows: { asked: 0, ok: 0, refused: 0 },
    records: { fetched: 0, distinctInThisImport: 0, inserted: 0, identical: 0, revisions: 0, revisionsAlreadyKnown: 0, uncertainIdentity: 0 },
    archive: { responses: 0, recordsWritten: 0, recordsAlreadyPresent: 0, recordsFailed: 0, manifestKey: null },
  };
  const finish = async (status, reason) => {
    summary.status = status; summary.reason = reason || null; summary.finishedAt = new Date().toISOString();
    try { await r.lpush(IMPORTS, summary); } catch (e) { summary.logWriteFailed = whyFailed(e); }
    return summary;
  };

  // The archive is required: the operational store may never be the only copy.
  if (!archive.ready()) return finish('failed', 'The independent archive (Cloudflare storage) is not set up on the server, so nothing was imported. Redis may not be the only copy.');

  let fetched;
  try {
    fetched = await fetchHistory({
      r, http, now: nowMs, years: options.years, noPause: options.noPause, tieAs: { importId, at },
      onResponse: async (w, text) => {
        try { const key = await archive.putResponse(importId, w, text); summary.archive.responses++; return key; }
        catch (e) { throw Object.assign(new Error('The archive refused Schwab\'s answer, so nothing was written to the ledger: ' + whyFailed(e)), { archiveFailed: true, plain: true }); }
      },
    });
  } catch (e) {
    return finish('failed', (e && e.plain) ? e.message : 'Fetching from Schwab failed: ' + whyFailed(e));
  }
  summary.account = fetched.accountChoice;
  summary.windows.asked = fetched.windows.length;
  summary.windows.ok = fetched.windows.filter(w => w.status === 'ok').length;
  summary.windows.refused = fetched.windows.filter(w => w.status === 'refused').length;
  summary.refusedWindows = fetched.windows.filter(w => w.status === 'refused').slice(0, 10).map(w => ({ from: w.from, to: w.to, httpStatus: w.httpStatus, why: w.why }));

  // Distinct within this import: the same record from two overlapping windows is one record.
  const distinct = new Map();
  for (const g of fetched.got) {
    summary.records.fetched++;
    const fp = fingerprint(g.t);
    const key = identityOf(g.t).value + '|' + fp;
    if (!distinct.has(key)) distinct.set(key, Object.assign({ fp }, g));
  }
  summary.records.distinctInThisImport = distinct.size;

  // Write, record by record. A failure stops the run; every entry already
  // written is whole, and a re-run carries on where this one stopped.
  const seenIds = [];
  try {
    for (const d of distinct.values()) {
      const idn = identityOf(d.t);
      if (idn.uncertain) summary.records.uncertainIdentity++;
      const out = await writeOne(r, d.t, d.fp, { at, importId, window: d.window, accountRef: fetched.accountRef, responseKey: d.responseKey });
      if (out.result === 'inserted') summary.records.inserted++;
      else if (out.result === 'identical') summary.records.identical++;
      else if (out.result === 'revision') summary.records.revisions++;
      else summary.records.revisionsAlreadyKnown++;
      seenIds.push({ id: out.id, fingerprint: d.fp, result: out.result });
    }
  } catch (e) {
    return finish('failed', `Writing to the ledger stopped after ${seenIds.length} of ${distinct.size} records: ${whyFailed(e)}. Every entry already written is complete; importing again carries on safely.`);
  }

  // Archive each record, content-addressed. This reads nothing from and
  // writes nothing to the operational ledger (auditor M11).
  try {
    const present = await archive.listRecordKeys();
    for (const d of distinct.values()) {
      const key = archive.recordKey(identityOf(d.t).value, d.fp);
      if (present.has(key)) { summary.archive.recordsAlreadyPresent++; continue; }
      try {
        const res = await archive.putRecord(key, { schema: SCHEMA, identity: identityOf(d.t), fingerprint: d.fp, raw: d.t, observedAt: at, importId, window: d.window, accountRef: fetched.accountRef, archiveResponseKey: d.responseKey, code: CODE });
        if (res === 'exists') summary.archive.recordsAlreadyPresent++; else summary.archive.recordsWritten++;
      } catch (e) { summary.archive.recordsFailed++; summary.archive.lastFailure = whyFailed(e); }
    }
    summary.archive.manifestKey = await archive.putManifest(importId, { summary: Object.assign({}, summary, { status: 'writing manifest' }), windows: fetched.windows, records: seenIds });
  } catch (e) {
    return finish('incomplete', 'The ledger is written, but the archive copy did not finish: ' + whyFailed(e) + '. Importing again completes it.');
  }
  if (summary.archive.recordsFailed) return finish('incomplete', `${summary.archive.recordsFailed} record(s) could not be copied to the archive; importing again completes it.`);
  if (summary.windows.refused) return finish('incomplete', `${summary.windows.refused} period(s) were refused by Schwab; what was returned is recorded.`);
  return finish('complete');
}

// ---- Read-only: counts and integrity ----------------------------------------
// Listing keys lives in ledgerAccount.js, shared with the account rule.
const { scanKeys } = ledgerAccount;

async function ledgerStatus(options = {}) {
  const r = options.redis || store();
  const recs = await scanKeys(r, `${PREFIX}rec:*`);
  const revs = await scanKeys(r, `${PREFIX}rev:*`);
  const imports = (await r.lrange(IMPORTS, 0, 9) || []).map(asObject);
  let archived = null, archiveError = null;
  try { archived = archive.ready() ? (await archive.listRecordKeys()).size : null; } catch (e) { archiveError = whyFailed(e); }
  const account = asObject(await r.get(ledgerAccount.TIE_KEY)) || null;
  return { readOnly: true, account, ledgerRecords: recs.length, ledgerRevisions: revs.length, archiveRecordFiles: archived, archiveError, recentImports: imports };
}

// Every entry: does its raw record still produce its fingerprint, and does
// the identity match? And is each one in the archive? Reads only.
async function verifyLedger(options = {}) {
  const r = options.redis || store();
  const keys = (await scanKeys(r, `${PREFIX}rec:*`)).sort();
  const tie = asObject(await r.get(ledgerAccount.TIE_KEY));
  const out = { readOnly: true, account: tie ? tie.ref : null, checked: 0, fingerprintMatches: 0, fingerprintMismatches: [], identityMismatches: [], accountMismatches: [], missingFromArchive: [], kinds: {} };
  let present = null;
  try { present = archive.ready() ? await archive.listRecordKeys() : null; } catch (e) { out.archiveError = whyFailed(e); }
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const vals = await r.mget(...batch);
    vals.forEach((v, j) => {
      const e = asObject(v);
      out.checked++;
      if (!e || !e.raw) { out.fingerprintMismatches.push(batch[j] + ' (entry unreadable)'); return; }
      out.kinds[e.raw.type || '(none)'] = (out.kinds[e.raw.type || '(none)'] || 0) + 1;
      if (fingerprint(e.raw) === e.fingerprint) out.fingerprintMatches++; else out.fingerprintMismatches.push(batch[j]);
      if (REC(identityOf(e.raw).value) !== batch[j]) out.identityMismatches.push(batch[j]);
      if (tie && (!e.provenance || e.provenance.accountRef !== tie.ref)) out.accountMismatches.push(batch[j]);
      if (present && !present.has(archive.recordKey(e.identity.value, e.fingerprint))) out.missingFromArchive.push(batch[j]);
    });
  }
  return out;
}

let running = null;
function importOnce(options) {
  if (!running) running = importLedger(options).finally(() => { running = null; });
  return running;
}

module.exports = { importLedger, importOnce, ledgerStatus, verifyLedger, identityOf, feesOf, entryFor, PREFIX, REC, REV, IMPORTS, SCHEMA, canonical };
