// BLOCKER 3A: TRADES RECONSTRUCTED FROM THE IMMUTABLE BROKER LEDGER.
//
// Authorized by the owner on 30 Sept 2026 as Blocker 3A ONLY, after the
// auditor locked the rules below. This file is a pure calculation:
//
//     ledger records in  ->  fills, positions, trades, exceptions out
//
// B3-11 (mandatory): it reads nothing and writes nothing. It never touches
// Redis, the journal, openLegs, pending, lastProcessedIds, Schwab, the
// existing matcher, files or the server clock, and nothing in the running
// service calls it. The same records under the same rule version give the
// same answer, byte for byte, in any order, in any batches, and with any
// number of duplicate copies of a record.
//
// The existing matcher is a witness, not the authority. The current rule is
// modelled here only so the two can be compared (B3-5 is deliberately left
// open until the dry run has shown the evidence).
//
// THE RULES (as locked by the auditor, 30 Sept 2026)
//
// B3-1  FILL IDENTITY. One fill per qualifying OPTION line (non-zero amount)
//       of a ledger record. id = "F:" + activityId + ":" + n, n counting the
//       qualifying option lines 1, 2, ... in the immutable raw transferItems
//       order, so it is the same in every replay. A record with no activityId
//       gets "U-" + its fingerprint, marked uncertain. orderId is kept as
//       information and never takes part in any identity.
// B3-2  WHICH LINES BECOME FILLS. Type TRADE, status VALID, positionEffect
//       OPENING or CLOSING, a valid Schwab tradeDate, a positive price, and a
//       contract multiplier Schwab states and the cash confirms. Anything
//       else is an exception with its reason, never a guess:
//         - a missing or unreadable tradeDate is never replaced by any other
//           time (not "time", not the clock);
//         - SELL_TO_OPEN (and BUY_TO_CLOSE, which only closes one) is an
//           unsupported direction for this trader, reported, never treated
//           as a purchase;
//         - an option line in any other kind of record (an expiration,
//           assignment or exercise) is reported, never inferred.
// B3-3  ORDER. The UTC instant is the authoritative order. Equal instants are
//       ordered by activityId, then by n. New York date and time are for
//       presentation and the trading day only.
// B3-4  FEES. The original fee is the record's itemised fee (Schwab's fee
//       lines), never changed. It is allocated to the record's option lines
//       by gross value in whole cents, largest remainder, ties by n, so the
//       shares add back exactly. Unknown stays null, never 0. The
//       cash-derived fee is kept as evidence only; a disagreement is listed.
// B3-5  PAIRING. OPEN. Two rules are computed side by side:
//         "fifo-v1"          oldest lot first;
//         "current-rule-v1"  a model of the live matcher's choice
//                            (matcher.js pickLegForClose as it runs on the
//                            server): newest lot opened the same UTC calendar
//                            day, otherwise oldest; lots past 23:59:59 UTC on
//                            their expiration day or more than 45 days old
//                            are not eligible. It models the CHOICE only, not
//                            the matcher's batch-by-batch memory.
//       Under both, a lot is closed only by a later-or-equal fill of the same
//       contract in the same account, and under fifo-v1 only on or before its
//       expiration date (New York).
// B3-6  NOTHING DROPPED. Close without open, excess close, a lot past expiry
//       with no closing record, and a lot still open are all reported with
//       their evidence. No lot is ever deleted.
// B3-7  A TRADE is one (opening fill, closing fill) pairing, for the number of
//       contracts it covered.
// B3-8  TRADE ID = "T:" + first 24 hex of sha256(openFillId|closeFillId|rule),
//       rule being the literal "fifo-v1" or "current-rule-v1". Alternate
//       reconstructions are reported, never stored as revisions.
// B3-9  MONEY. Gross = (exit - entry) x multiplier x contracts, the multiplier
//       being Schwab's optionPremiumMultiplier confirmed by the line's cash.
//       A fill's fee is split across the trades (and any unclosed or excess
//       remainder) it feeds by contracts, whole cents, largest remainder,
//       ties by id, so it adds back exactly. Net = gross - fee, null when a
//       fee is unknown. Long/Short from CALL/PUT holds only because every
//       opening admitted is a purchase (B3-2).
// B3-10 HIS DATA. Nothing here reads or changes the journal.
// B3-11 PURE. See above.
const crypto = require('crypto');

const ENGINE = 'tradeRebuild v1';
const RULES = ['fifo-v1', 'current-rule-v1'];
// B3-5 is OPEN. Neither rule is approved for production. current-rule-v1 is
// a comparison model of matcher.js only and must never become the
// production rule; its expiry test (23:59:59 UTC) and fifo-v1's (the New
// York expiration date) are deliberately different and stay separate.
const RULE_STATUS = {
  'fifo-v1': 'candidate under evaluation -- B3-5 is open; not approved as the production rule',
  'current-rule-v1': 'comparison model of matcher.js (pickLegForClose, isLegDead) -- evidence only; never a production rule',
};
const DAY_MS = 86400000;
const CURRENT_RULE_MAX_LEG_AGE_DAYS = 45;   // matcher.js MAX_LEG_AGE_DAYS

// ---- Canonical form and fingerprint: identical to the ledger's -------------
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const fingerprint = raw => sha256(canonical(raw));

// ---- Time: strict, and never the clock ----------------------------------------
// Schwab writes "2025-10-17T14:14:06+0000". Anything else is not guessed at.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?(Z|[+-]\d{2}:?\d{2})$/;
function parseInstant(s) {
  if (typeof s !== 'string') return null;
  const m = STAMP.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, tz] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +se;
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 59) return null;
  let ms = Date.UTC(Y, M - 1, D, H, MI, S, frac ? +frac.padEnd(3, '0') : 0);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Y || back.getUTCMonth() !== M - 1 || back.getUTCDate() !== D) return null; // 31 Feb etc.
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    ms -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60000;
  }
  return ms;
}
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function nyParts(ms) {
  const p = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const iso = ms => new Date(ms).toISOString();

// ---- Money in whole cents -------------------------------------------------------
const roundHalfAway = x => (x < 0 ? -Math.round(-x) : Math.round(x));
const toCents = x => roundHalfAway(Number(x) * 100);
const MICRO = 1e6;
const toMicro = p => roundHalfAway(Number(p) * MICRO);

// Split `total` cents over `weights` (non-negative), largest remainder, ties
// by the order given (callers pass items already in their tie-break order).
// The pieces always add back to `total` exactly.
function allocate(total, weights) {
  if (total == null) return weights.map(() => null);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  if (!sum) { const out = weights.map(() => 0); out[0] = total; return out; }
  const base = weights.map(w => Math.floor((abs * w) / sum));
  let left = abs - base.reduce((s, b) => s + b, 0);
  const order = weights.map((w, i) => ({ i, rem: (abs * w) % sum })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i]++;
  return base.map(b => sign * b);
}

// activityIds are digit strings; compare them as numbers without losing digits.
function compareIds(a, b) {
  const da = /^\d+$/.test(a), db = /^\d+$/.test(b);
  if (da && db) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  if (da !== db) return da ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const byOrder = (a, b) => a.instantMs - b.instantMs || compareIds(a.recordId, b.recordId) || a.n - b.n;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- Reading what was supplied -------------------------------------------------
// Accepts ledger entries, the backup export's {type, value} wrapping, JSON
// text, or bare Schwab records.
function unwrap(item) {
  let v = item;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
  if (v && typeof v === 'object' && !v.raw && v.value && typeof v.value === 'object' && ('type' in v)) v = v.value;
  if (!v || typeof v !== 'object') return null;
  if (v.raw && typeof v.raw === 'object') return { raw: v.raw, entry: v };
  if (Array.isArray(v.transferItems) || v.activityId != null) return { raw: v, entry: null };
  return null;
}

function readInput(items) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map();
  const stats = { supplied: list.length, unreadable: 0, duplicateObservations: 0, distinctRecords: 0, conflictingIdentities: 0, fingerprintMismatches: 0 };
  const problems = [];
  for (const item of list) {
    const u = unwrap(item);
    if (!u) { stats.unreadable++; continue; }
    const fp = fingerprint(u.raw);
    if (u.entry && u.entry.fingerprint && u.entry.fingerprint !== fp) {
      stats.fingerprintMismatches++;
      problems.push({ kind: 'fingerprint-mismatch', recordId: u.entry.identity && u.entry.identity.value || null, reason: 'The ledger entry does not match its own fingerprint, so its content cannot be trusted. Left out.', evidence: { stored: u.entry.fingerprint, computed: fp } });
      continue;
    }
    const act = u.raw.activityId;
    const hasAct = act != null && String(act) !== '';
    // The RECORD id; a fill id is always "F:" + this + ":" + n (B3-1), so a
    // record without an activityId gives fills "F:U-<32 hex>:<n>".
    const recordId = hasAct ? String(act) : 'U-' + fp.slice(0, 32);
    const accountRef = (u.entry && u.entry.provenance && u.entry.provenance.accountRef) || null;
    const ledgerFee = u.entry && u.entry.normalized && u.entry.normalized.fees ? u.entry.normalized.fees.normalizedFee : undefined;
    const prev = byId.get(recordId);
    if (!prev) byId.set(recordId, { recordId, uncertain: !hasAct, raw: u.raw, fp, versions: new Set([fp]), accountRefs: new Set(accountRef ? [accountRef] : []), ledgerFee });
    else {
      if (prev.versions.has(fp)) stats.duplicateObservations++;
      prev.versions.add(fp);
      if (accountRef) prev.accountRefs.add(accountRef);
    }
  }
  const records = [];
  for (const r of byId.values()) {
    if (r.versions.size > 1) {
      stats.conflictingIdentities++;
      problems.push({ kind: 'conflicting-record', recordId: r.recordId, reason: `Schwab's record ${r.recordId} was supplied in ${r.versions.size} different versions. None is picked; the record is left out until a person resolves it.`, evidence: { fingerprints: [...r.versions].sort() } });
      continue;
    }
    if (r.accountRefs.size > 1) {
      problems.push({ kind: 'conflicting-record', recordId: r.recordId, reason: `Record ${r.recordId} is attributed to ${r.accountRefs.size} different accounts. Left out.`, evidence: { accounts: [...r.accountRefs].sort() } });
      stats.conflictingIdentities++;
      continue;
    }
    records.push({ recordId: r.recordId, uncertain: r.uncertain, raw: r.raw, fp: r.fp, accountRef: [...r.accountRefs][0] || 'account-not-stated', ledgerFee: r.ledgerFee });
  }
  records.sort((a, b) => compareIds(a.recordId, b.recordId));
  stats.distinctRecords = records.length;
  return { records, stats, problems };
}

// ---- Fees on a record (B3-4) ---------------------------------------------------
function recordFees(raw) {
  const items = raw.transferItems || [];
  const lines = items.filter(ti => ti && ti.feeType);
  const itemisedCents = lines.length ? -lines.reduce((s, l) => s + toCents(l.cost ?? l.amount ?? 0), 0) : null;
  return { itemisedCents, feeLines: lines.length };
}

// ---- Fills (B3-1, B3-2, B3-3) -----------------------------------------------------
function normalize(records) {
  const fills = [];
  const notFills = [];
  const flags = [];
  const optionRecordFees = [];   // every record with option lines, and its original fee
  for (const rec of records) {
    const raw = rec.raw;
    const items = Array.isArray(raw.transferItems) ? raw.transferItems : [];
    const optionLines = items.filter(ti => ti && ti.instrument && ti.instrument.assetType === 'OPTION' && Number(ti.amount) !== 0 && Number.isFinite(Number(ti.amount)));
    if (!optionLines.length) continue;
    const fees = recordFees(raw);
    optionRecordFees.push({ recordId: rec.recordId, feeCents: fees.itemisedCents });
    if (rec.ledgerFee !== undefined && (rec.ledgerFee == null ? null : toCents(rec.ledgerFee)) !== fees.itemisedCents) {
      flags.push({ kind: 'fee-normalization-disagreement', recordId: rec.recordId, reason: 'The fee worked out from the record\'s own fee lines differs from the ledger\'s stored figure. The record\'s own lines are used.', evidence: { fromFeeLines: fees.itemisedCents, ledgerStored: rec.ledgerFee } });
    }
    const instantMs = parseInstant(raw.tradeDate);
    const ny = instantMs == null ? null : nyParts(instantMs);

    // Gross value per line, for splitting the record's fee (by premium x size).
    const lineInfo = optionLines.map((ti, i) => {
      const inst = ti.instrument;
      const M = Number(inst.optionPremiumMultiplier);
      const qty = Math.abs(Number(ti.amount));
      const price = Number(ti.price);
      const grossMicro = Number.isFinite(M) && M > 0 && Number.isFinite(price) && price > 0 ? toMicro(price) * M * qty : 0;
      return { ti, inst, n: i + 1, M, qty, price, grossMicro };
    });
    const feeShares = allocate(fees.itemisedCents, lineInfo.map(l => l.grossMicro));

    // Cash-derived fee, evidence only (the ledger's definition).
    const net = Number(raw.netAmount);
    const grossCents = lineInfo.reduce((s, l) => s + Math.round(l.grossMicro / 1e4), 0);
    const allPriced = lineInfo.every(l => l.grossMicro > 0);
    const cashCents = allPriced && raw.netAmount != null && Number.isFinite(net) ? Math.abs(Math.abs(toCents(net)) - grossCents) : null;
    if (fees.itemisedCents != null && cashCents != null && cashCents !== fees.itemisedCents) {
      flags.push({ kind: 'fee-evidence-disagreement', recordId: rec.recordId, reason: 'Schwab\'s itemised fee and the fee implied by the cash differ. The itemised fee is used; this is recorded, not resolved.', evidence: { itemisedCents: fees.itemisedCents, cashDerivedCents: cashCents } });
    }

    lineInfo.forEach((l, i) => {
      const { ti, inst, n, M, qty, price } = l;
      const fillId = `F:${rec.recordId}:${n}`;
      const base = { fillId, recordId: rec.recordId, n, symbol: inst.symbol ?? null, tradeDate: raw.tradeDate ?? null, quantity: qty, recordFingerprint: rec.fp };
      const refuse = (code, reason, evidence) => notFills.push(Object.assign({ kind: 'not-a-fill', code, reason, feeShareCents: feeShares[i], evidence: evidence || null }, base));

      if (raw.type !== 'TRADE') return refuse('not-a-trade-record', `An option line in a ${raw.type || 'untyped'} record (possibly an expiration, assignment or exercise). Kept as evidence; nothing is inferred from it.`);
      if (raw.status !== 'VALID') return refuse('status-not-valid', `The record's status is ${raw.status == null ? 'missing' : raw.status}, not VALID.`);
      if (instantMs == null) return refuse('no-valid-timestamp', 'Schwab\'s tradeDate is missing or unreadable. No other time is substituted.', { tradeDate: raw.tradeDate ?? null, time: raw.time ?? null });
      if (!inst.symbol) return refuse('no-contract-symbol', 'The option line does not name its contract.');
      if (inst.putCall !== 'CALL' && inst.putCall !== 'PUT') return refuse('no-put-call', 'The option line does not say CALL or PUT.', { putCall: inst.putCall ?? null });
      const effect = ti.positionEffect;
      if (effect !== 'OPENING' && effect !== 'CLOSING') return refuse('unknown-position-effect', 'The option line does not say whether it opened or closed a position.', { positionEffect: effect ?? null });
      const bought = Number(ti.amount) > 0;
      const cost = ti.cost == null ? null : Number(ti.cost);
      if (cost == null || !Number.isFinite(cost) || cost === 0 || (cost < 0) !== bought) return refuse('direction-evidence-disagrees', 'The contract count and the cash on this line do not agree on whether it was a purchase or a sale.', { amount: ti.amount, cost: ti.cost ?? null });
      const instruction = (bought ? 'BUY' : 'SELL') + (effect === 'OPENING' ? '_TO_OPEN' : '_TO_CLOSE');
      if (instruction === 'SELL_TO_OPEN') return refuse('unsupported-opening-direction', 'SELL_TO_OPEN: selling to open is not part of this trader\'s model. Reported, never treated as a purchase.');
      if (instruction === 'BUY_TO_CLOSE') return refuse('unsupported-closing-direction', 'BUY_TO_CLOSE closes a sold-to-open position, which is not part of this trader\'s model.');
      if (!Number.isFinite(price) || price <= 0) return refuse('no-positive-price', 'The line has no positive price.', { price: ti.price ?? null });
      if (!Number.isFinite(M) || M <= 0) return refuse('multiplier-not-stated', 'Schwab does not state the contract multiplier, so none is assumed.', { optionPremiumMultiplier: inst.optionPremiumMultiplier ?? null });
      if (Math.abs(Math.abs(toMicro(cost)) - toMicro(price) * M * qty) > 0.01 * MICRO) return refuse('multiplier-not-confirmed', `The cash on the line does not match price x ${M} x contracts, so the multiplier is not established.`, { cost, price, quantity: qty, multiplier: M });
      // Every expirationDate in his ledger (587 of 587, checked 30 Sept 2026) is
      // a full timestamp at New York midnight: "2026-06-09T04:00:00+0000" in
      // summer, "2026-01-16T05:00:00+0000" in winter. That form is read
      // strictly and converted to the New York calendar date. Any other form
      // (a bare date included) is an exception with the raw value kept, never
      // guessed at; supporting another form is a decision for the auditor.
      const expMs = parseInstant(inst.expirationDate);
      if (expMs == null) return refuse('no-expiration', 'Schwab does not give an expiration date in the form this reads (a full timestamp, as every record in the ledger has).', { expirationDate: inst.expirationDate ?? null });
      // The contract symbol carries the date too (OCC: root, yymmdd, C/P,
      // strike). Two pieces of Schwab's own evidence must agree.
      const occ = /^.{1,6}?\s*(\d{2})(\d{2})(\d{2})([CP])\d{8}$/.exec(String(inst.symbol));
      const expNy = nyParts(expMs).date;
      if (occ && `20${occ[1]}-${occ[2]}-${occ[3]}` !== expNy) return refuse('expiration-evidence-disagrees', 'The expiration date and the contract symbol name different days.', { expirationDate: inst.expirationDate, symbol: inst.symbol });
      if (occ && (occ[4] === 'C') !== (inst.putCall === 'CALL')) return refuse('put-call-evidence-disagrees', 'The contract symbol and the CALL/PUT field disagree.', { symbol: inst.symbol, putCall: inst.putCall });

      const deliverables = Array.isArray(inst.optionDeliverables) ? inst.optionDeliverables : [];
      const standard = M === 100 && inst.type === 'VANILLA' && deliverables.length === 1 && deliverables[0].deliverableUnits === 100 && (deliverables[0].strikePercent == null || deliverables[0].strikePercent === 100);
      if (!standard) flags.push({ kind: 'unusual-contract', fillId, recordId: rec.recordId, reason: 'Not a standard 100-share contract (adjusted or non-standard). Its premium economics are confirmed by the cash, so it is used, and flagged.', evidence: { multiplier: M, type: inst.type ?? null, deliverables: deliverables.length } });
      if (rec.uncertain) flags.push({ kind: 'uncertain-identity', fillId, recordId: rec.recordId, reason: 'Schwab gave this record no activityId; its identity is built from its content and marked uncertain.' });

      fills.push({
        fillId, recordId: rec.recordId, n, identityUncertain: rec.uncertain, accountRef: rec.accountRef,
        symbol: inst.symbol, underlying: inst.underlyingSymbol ?? null, putCall: inst.putCall,
        expiration: expNy, expirationRaw: inst.expirationDate, instruction, effect, quantity: qty, price, multiplier: M,
        instantMs, instant: iso(instantMs), nyDate: ny.date, nyTime: ny.time,
        feeCents: feeShares[i], recordFeeCents: fees.itemisedCents,
        orderId: raw.orderId == null ? null : String(raw.orderId),          // information only (R1)
        positionId: raw.positionId == null ? null : String(raw.positionId), // information only
        recordFingerprint: rec.fp,
      });
    });
  }
  fills.sort(byOrder);
  return { fills, notFills, flags, optionRecordFees };
}

// ---- Pairing (B3-5, B3-6, B3-7) -------------------------------------------------------
function eligible(rule, lot, close) {
  if (lot.remaining <= 0 || lot.instantMs > close.instantMs) return false;
  if (rule === 'fifo-v1') return close.nyDate <= lot.expiration;
  // current-rule-v1: matcher.js isLegDead -- past 23:59:59 UTC on the
  // expiration day, or older than 45 days.
  const expEnd = Date.UTC(+lot.expiration.slice(0, 4), +lot.expiration.slice(5, 7) - 1, +lot.expiration.slice(8, 10), 23, 59, 59);
  if (close.instantMs > expEnd) return false;
  if (close.instantMs - lot.instantMs > CURRENT_RULE_MAX_LEG_AGE_DAYS * DAY_MS) return false;
  return true;
}
function pickLot(rule, lots, close) {
  const ok = lots.filter(l => eligible(rule, l, close));
  if (!ok.length) return null;
  if (rule === 'current-rule-v1') {
    const same = ok.filter(l => utcDate(l.instantMs) === utcDate(close.instantMs));
    if (same.length) return same.sort((a, b) => byOrder(b, a))[0];   // newest same-day
  }
  return ok.sort(byOrder)[0];                                         // oldest
}
const tradeIdOf = (openFillId, closeFillId, rule) => 'T:' + sha256(`${openFillId}|${closeFillId}|${rule}`).slice(0, 24);

function pair(fills, rule) {
  const lotsByPos = new Map();
  const pairings = [];          // { open, close, qty }
  const closeLeft = [];         // { close, qty, why }
  for (const f of fills) {
    const pos = f.accountRef + '|' + f.symbol;
    if (!lotsByPos.has(pos)) lotsByPos.set(pos, []);
    const lots = lotsByPos.get(pos);
    if (f.effect === 'OPENING') { lots.push(Object.assign({}, f, { remaining: f.quantity })); continue; }
    let need = f.quantity;
    let matchedAny = false;
    while (need > 0) {
      const lot = pickLot(rule, lots, f);
      if (!lot) break;
      const q = Math.min(need, lot.remaining);
      lot.remaining -= q; need -= q; matchedAny = true;
      pairings.push({ open: lot, close: f, qty: q });
    }
    if (need > 0) {
      const earlier = lots.filter(l => l.instantMs <= f.instantMs);
      let why;
      if (!earlier.length) why = 'No earlier purchase of this contract in this account is in the evidence (for example, opened before the ledger\'s history, or a different contract).';
      else if (earlier.every(l => l.remaining <= 0)) why = 'Every earlier purchase of this contract had already been closed.';
      else why = rule === 'fifo-v1' ? 'Earlier purchases remain open but cannot be closed by this sale: it is after their expiration date.' : 'Earlier purchases remain open but the current rule does not allow them to be closed by this sale (past expiry, or more than 45 days old).';
      closeLeft.push({ close: f, qty: need, kind: matchedAny ? 'excess-close' : 'close-without-open', why });
    }
  }
  const openLots = [];
  for (const lots of lotsByPos.values()) for (const l of lots) if (l.remaining > 0) openLots.push(l);
  return { pairings, closeLeft, openLots };
}

// ---- Money (B3-9) ------------------------------------------------------------------------
function money(fills, paired, rule, asOfMs) {
  const asOfNy = nyParts(asOfMs).date;
  const trades = paired.pairings.map(p => ({ p, tradeId: tradeIdOf(p.open.fillId, p.close.fillId, rule) }));
  // Pieces of each fill: the trades it feeds, plus whatever of it is left
  // unclosed (an open lot) or unmatched (an excess close / close without open).
  const pieces = new Map(fills.map(f => [f.fillId, []]));
  for (const t of trades) {
    pieces.get(t.p.open.fillId).push({ key: t.tradeId, qty: t.p.qty, side: 'entry', t });
    pieces.get(t.p.close.fillId).push({ key: t.tradeId, qty: t.p.qty, side: 'exit', t });
  }
  const lotRows = paired.openLots.map(l => ({ l, row: null }));
  for (const x of lotRows) pieces.get(x.l.fillId).push({ key: '~remainder', qty: x.l.remaining, side: 'lot', x });
  const leftRows = paired.closeLeft.map(c => ({ c, row: null }));
  for (const x of leftRows) pieces.get(x.c.close.fillId).push({ key: '~remainder', qty: x.c.qty, side: 'left', x });
  const feeOf = new Map();
  for (const f of fills) {
    const ps = pieces.get(f.fillId).sort((a, b) => cmpStr(a.key, b.key));
    const shares = allocate(f.feeCents, ps.map(p => p.qty));
    ps.forEach((p, i) => feeOf.set(p, shares[i]));
  }
  const out = [];
  for (const t of trades) {
    const { open, close, qty } = t.p;
    const entryFee = feeOf.get(pieces.get(open.fillId).find(p => p.key === t.tradeId && p.side === 'entry'));
    const exitFee = feeOf.get(pieces.get(close.fillId).find(p => p.key === t.tradeId && p.side === 'exit'));
    const grossCents = roundHalfAway(((toMicro(close.price) - toMicro(open.price)) * open.multiplier * qty) / 1e4);
    const feeCents = entryFee == null || exitFee == null ? null : entryFee + exitFee;
    out.push({
      tradeId: t.tradeId, rule, openFillId: open.fillId, closeFillId: close.fillId,
      accountRef: open.accountRef, symbol: open.symbol, underlying: open.underlying, putCall: open.putCall,
      direction: open.putCall === 'CALL' ? 'Long' : 'Short', contracts: qty, multiplier: open.multiplier,
      entryPrice: open.price, exitPrice: close.price,
      entryInstant: open.instant, exitInstant: close.instant, entryNy: `${open.nyDate} ${open.nyTime}`, exitNy: `${close.nyDate} ${close.nyTime}`,
      grossCents, entryFeeCents: entryFee, exitFeeCents: exitFee, feeCents, netCents: feeCents == null ? null : grossCents - feeCents,
      evidence: { openRecord: open.recordId, closeRecord: close.recordId, openFingerprint: open.recordFingerprint, closeFingerprint: close.recordFingerprint, openOrderId: open.orderId, closeOrderId: close.orderId },
    });
  }
  // Listed by when they closed, then by when they opened; ties by id.
  out.sort((a, b) => cmpStr(a.exitInstant, b.exitInstant) || cmpStr(a.entryInstant, b.entryInstant) || cmpStr(a.tradeId, b.tradeId));

  const lotsOut = lotRows.map(({ l }) => {
    const share = feeOf.get(pieces.get(l.fillId).find(p => p.side === 'lot'));
    const past = asOfNy > l.expiration;
    return {
      kind: past ? 'past-expiry-open' : 'still-open', fillId: l.fillId, recordId: l.recordId, accountRef: l.accountRef, symbol: l.symbol,
      openedInstant: l.instant, expiration: l.expiration, contractsRemaining: l.remaining, contractsOpened: l.quantity, feeShareCents: share,
      reason: past ? `Still open after its expiration (${l.expiration}) with no closing record in the evidence. Not assumed to have expired worthless.` : 'Still open as of the latest evidence.',
    };
  }).sort((a, b) => cmpStr(a.openedInstant, b.openedInstant) || cmpStr(a.fillId, b.fillId));
  const leftOut = leftRows.map(({ c }) => ({
    kind: c.kind, fillId: c.close.fillId, recordId: c.close.recordId, accountRef: c.close.accountRef, symbol: c.close.symbol,
    instant: c.close.instant, contractsUnmatched: c.qty, contractsInFill: c.close.quantity,
    feeShareCents: feeOf.get(pieces.get(c.close.fillId).find(p => p.side === 'left')), reason: c.why,
  })).sort((a, b) => cmpStr(a.instant, b.instant) || cmpStr(a.fillId, b.fillId));
  return { trades: out, lots: lotsOut, closeLeft: leftOut };
}

// ---- Totals and conservation --------------------------------------------------------
function totalsOf(fills, m, notFills, optionRecordFees) {
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const known = m.trades.filter(t => t.feeCents != null);
  const opened = sum(fills.filter(f => f.effect === 'OPENING'), f => f.quantity);
  const closed = sum(fills.filter(f => f.effect === 'CLOSING'), f => f.quantity);
  const paired = sum(m.trades, t => t.contracts);
  const lotLeft = sum(m.lots, l => l.contractsRemaining);
  const closeLeft = sum(m.closeLeft, c => c.contractsUnmatched);
  // Fees, every cent accounted for (auditor A2):
  //   original fee on every record with option lines
  //     = shares on admitted fills + shares on option lines that became exceptions
  //   shares on admitted fills
  //     = trades' entry and exit shares + open lots' shares + unmatched closes' shares
  const recordFeeCents = sum(optionRecordFees.filter(r => r.feeCents != null), r => r.feeCents);
  const fillFees = sum(fills.filter(f => f.feeCents != null), f => f.feeCents);
  const exceptionLineFees = sum(notFills.filter(x => x.feeShareCents != null), x => x.feeShareCents);
  const tradeFees = sum(m.trades, t => (t.entryFeeCents || 0) + (t.exitFeeCents || 0));
  const lotFees = sum(m.lots, l => l.feeShareCents || 0);
  const unmatchedFees = sum(m.closeLeft, c => c.feeShareCents || 0);
  const pieceFees = tradeFees + lotFees + unmatchedFees;
  return {
    totals: {
      trades: m.trades.length, contracts: paired,
      grossCents: sum(m.trades, t => t.grossCents),
      tradesWithKnownFee: known.length, tradesWithUnknownFee: m.trades.length - known.length,
      feeCentsKnownOnly: sum(known, t => t.feeCents), netCentsKnownOnly: sum(known, t => t.netCents),
    },
    conservation: {
      contractsOpened: opened, contractsClosed: closed, pairedContracts: paired, contractsStillInLots: lotLeft, closingContractsUnmatched: closeLeft,
      openingBalances: opened === paired + lotLeft, closingBalances: closed === paired + closeLeft,
      fees: {
        optionRecords: optionRecordFees.length,
        optionRecordsWithUnknownFee: optionRecordFees.filter(r => r.feeCents == null).length,
        originalFeeCentsOnOptionRecords: recordFeeCents,
        onAdmittedFillsCents: fillFees,
        onExceptionOptionLinesCents: exceptionLineFees,
        recordsReconcile: recordFeeCents === fillFees + exceptionLineFees,
        distributed: { toTradesCents: tradeFees, toOpenLotsCents: lotFees, toUnmatchedClosesCents: unmatchedFees, totalCents: pieceFees },
        fillsReconcile: fillFees === pieceFees,
      },
      feesBalance: recordFeeCents === fillFees + exceptionLineFees && fillFees === pieceFees,
    },
  };
}

// ---- Public ---------------------------------------------------------------------------
// rebuild(items, { rule, asOf }) -> { engine, input, reconstruction }
// `reconstruction` depends only on the distinct records supplied and the
// rule: never on their order, their batches or duplicate copies. `asOf` (an
// ISO instant) decides "past expiry"; when not given it is the latest
// tradeDate in the evidence -- never the clock.
function rebuild(items, options = {}) {
  const rule = options.rule || 'fifo-v1';
  if (!RULES.includes(rule)) throw new Error(`Unknown pairing rule "${rule}". Known: ${RULES.join(', ')}.`);
  const input = readInput(items);
  return { engine: ENGINE, input: input.stats, reconstruction: reconstruct(input, rule, options.asOf) };
}

function reconstruct(input, rule, asOf) {
  const { fills, notFills, flags, optionRecordFees } = normalize(input.records);
  let asOfMs, asOfSource;
  if (asOf != null) {
    asOfMs = parseInstant(asOf);
    if (asOfMs == null) throw new Error(`asOf "${asOf}" is not an instant this reads (for example 2026-09-30T12:00:00Z).`);
    asOfSource = 'given by the caller';
  } else {
    const stamps = input.records.map(r => parseInstant(r.raw.tradeDate)).filter(ms => ms != null);
    asOfMs = stamps.length ? Math.max(...stamps) : null;
    asOfSource = stamps.length ? 'the latest tradeDate in the evidence' : 'no readable tradeDate in the evidence';
  }
  const paired = pair(fills, rule);
  const m = asOfMs == null ? { trades: [], lots: [], closeLeft: [] } : money(fills, paired, rule, asOfMs);
  const { totals, conservation } = totalsOf(fills, m, notFills, optionRecordFees);
  const accounts = [...new Set(input.records.map(r => r.accountRef))].sort();
  return {
    rule, ruleStatus: RULE_STATUS[rule], asOf: asOfMs == null ? null : iso(asOfMs), asOfSource, accounts,
    fills: fills.map(f => { const o = Object.assign({}, f); delete o.instantMs; return o; }),
    trades: m.trades,
    openLots: m.lots,
    exceptions: {
      inputProblems: input.problems.slice().sort((a, b) => cmpStr(a.kind, b.kind) || compareIds(String(a.recordId), String(b.recordId))),
      notFills: notFills.sort((a, b) => compareIds(a.recordId, b.recordId) || a.n - b.n),
      closeWithoutOpen: m.closeLeft.filter(c => c.kind === 'close-without-open'),
      excessClose: m.closeLeft.filter(c => c.kind === 'excess-close'),
      pastExpiryOpen: m.lots.filter(l => l.kind === 'past-expiry-open'),
      stillOpen: m.lots.filter(l => l.kind === 'still-open'),
    },
    flags: flags.sort((a, b) => cmpStr(a.kind, b.kind) || compareIds(a.recordId, b.recordId) || cmpStr(a.fillId || '', b.fillId || '')),
    totals, conservation,
  };
}

// Both rules over the same evidence, and where they differ (B3-5 evidence).
function rebuildBoth(items, options = {}) {
  const input = readInput(items);
  const fifo = reconstruct(input, 'fifo-v1', options.asOf);
  const current = reconstruct(input, 'current-rule-v1', options.asOf);
  return { engine: ENGINE, input: input.stats, fifo, current, comparison: compare(fifo, current) };
}

function compare(a, b) {
  const pairingsBy = r => {
    const m = new Map();
    for (const t of r.trades) { if (!m.has(t.closeFillId)) m.set(t.closeFillId, []); m.get(t.closeFillId).push(`${t.openFillId} x${t.contracts}`); }
    for (const v of m.values()) v.sort();
    return m;
  };
  const pa = pairingsBy(a), pb = pairingsBy(b);
  const closes = [...new Set([...pa.keys(), ...pb.keys(), ...a.exceptions.closeWithoutOpen.map(c => c.fillId), ...a.exceptions.excessClose.map(c => c.fillId), ...b.exceptions.closeWithoutOpen.map(c => c.fillId), ...b.exceptions.excessClose.map(c => c.fillId)])].sort();
  const differingCloseFills = [];
  for (const c of closes) {
    const x = (pa.get(c) || []).join(', '), y = (pb.get(c) || []).join(', ');
    if (x !== y) differingCloseFills.push({ closeFillId: c, [a.rule]: pa.get(c) || [], [b.rule]: pb.get(c) || [] });
  }
  const shape = t => `${t.openFillId}|${t.closeFillId}|${t.contracts}`;
  const sa = new Set(a.trades.map(shape)), sb = new Set(b.trades.map(shape));
  const onlyA = [...sa].filter(s => !sb.has(s)).sort(), onlyB = [...sb].filter(s => !sa.has(s)).sort();
  const d = k => ({ [a.rule]: a.totals[k], [b.rule]: b.totals[k], difference: a.totals[k] - b.totals[k] });
  return {
    pairingsThatDiffer: differingCloseFills.length,
    tradesOnlyUnder: { [a.rule]: onlyA.length, [b.rule]: onlyB.length },
    trades: d('trades'), contracts: d('contracts'), grossCents: d('grossCents'), feeCentsKnownOnly: d('feeCentsKnownOnly'), netCentsKnownOnly: d('netCentsKnownOnly'),
    exceptionCounts: Object.fromEntries(['closeWithoutOpen', 'excessClose', 'pastExpiryOpen', 'stillOpen'].map(k => [k, { [a.rule]: a.exceptions[k].length, [b.rule]: b.exceptions[k].length }])),
    closeFillsThatDiffer: differingCloseFills,
    tradeShapesOnlyUnder: { [a.rule]: onlyA, [b.rule]: onlyB },
  };
}

module.exports = { rebuild, rebuildBoth, compare, fingerprint, canonical, parseInstant, allocate, tradeIdOf, RULES, ENGINE };
