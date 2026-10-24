'use strict';
// THE QUEUE'S RULES, AS PURE FUNCTIONS (Queue Exact-Removal plan v14.1
// revision 3.2, "Deploy 2", generation 2). Owner, 24 Oct 2026: "I authorize
// Deploy 2 implementation: a new branch and pull request, local tests only,
// no merge."
//
// Everything here is ARITHMETIC ON A DOCUMENT. Nothing in this file reads a
// clock, a random source, the network or the database, and nothing changes
// the object it is given (plan 5.5, PURITY): each function returns a new
// value. The one module that talks to the database is tradeStore.js; it
// calls these.
//
// Why it matters: a save that may have to be tried again (another process
// saved first, or the answer was lost on the way back) must compute the SAME
// result from the same inputs every time. A function that read the clock or
// changed its input would make a second try differ from the first, and the
// whole protection against doing a thing twice rests on that not happening.
const crypto = require('crypto');

// ---- The nine fields the expansion adds (plan 5.8.4), in the order the
// accepted dry-run checker (V-Q7 version 4) writes them.
const NEW_NAMES = ['schemaVersion', 'stateVersion', 'queueEpoch', 'queueSeq', 'queueEvents',
  'opRecords', 'prunedThroughVersion', 'pendingStaged', 'removalEnabled'];
// The fields the document held before this plan (V-Q1 (i)), so the expansion
// can name any field it does NOT know (it keeps those untouched).
const KNOWN_OLD = ['openLegs', 'pending', 'lastProcessedIds', 'identityCutoverAt', 'exceptions',
  'lastSync', 'lastBackfill', 'ftfcRetry', 'ftfcUpdates'];
// 5.5 THE VALUE SIZE: the largest value the existing backup copy includes
// (backupExport.js), so a document the backup cannot copy is never written.
const SIZE_LIMIT = 5 * 1024 * 1024;
const OP_RETAIN = 60 * 60 * 1000;          // 5.5 (5): a trusted record is kept 1 hour
const SKEW = 5 * 60 * 1000;                // 5.5 (1a) and the clock guard
const JAN_2026 = 1767225600000;            // 5.5 (1a): the earliest committedAt
const RESET_KEEP = 200;                    // 5.9.3 (S-R5): reset-kind records kept by count
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// 4.2: 32 lower-case hex, "-", a positive whole number with no leading zero.
const QID = /^[0-9a-f]{32}-[1-9][0-9]*$/;

const KINDS = ['expand', 'staging', 'publication', 'poison-guard', 'qid-removal', 'legacy-removal',
  'reset', 'reset-cancel', 'sync-landing', 'progress', 'activate', 'deactivate'];
const RESET_KINDS = ['reset', 'reset-cancel'];

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
// The service's own looser rule for "an object", used where the older code
// used it (cron.js isPlainObject, and the dry-run checker's X4).
const isObjectish = v => v != null && typeof v === 'object' && !Array.isArray(v);
const safeInt = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const exactKeys = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length
  && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

// Keys sorted at every level, no spaces; a number that is not finite, or a
// value that is not plain JSON data, is refused rather than written oddly.
function canonicalJson(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (isPlain(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  throw new Error('not JSON data');
}
// 5.5 (1), v12: the check covers every field used for trust, recovery or
// pruning.
const recordCheck = r => sha256(canonicalJson({ opId: r.opId, kind: r.kind, committedAt: r.committedAt,
  committedVersion: r.committedVersion, result: r.result }));

const isQid = q => typeof q === 'string' && QID.test(q);
const isTagged = e => isPlain(e) && isQid(e.qid);
const strList = a => Array.isArray(a) && a.every(x => typeof x === 'string');
const idQidList = a => Array.isArray(a) && a.every(x => exactKeys(x, ['id', 'qid']) && typeof x.id === 'string' && isQid(x.qid));

// ---- 5.5 (1a) "result has the shape its kind defines". One rule per kind.
// A record whose result does not have its kind's exact shape is UNTRUSTED.
const RESULT_SHAPES = {
  expand: r => exactKeys(r, ['added', 'unknownFields']) && canonicalJson(r.added) === canonicalJson(NEW_NAMES) && strList(r.unknownFields),
  staging: r => exactKeys(r, ['staged', 'fillsProcessed']) && idQidList(r.staged) && safeInt(r.fillsProcessed, 0),
  'sync-landing': r => exactKeys(r, ['landed', 'fillsProcessed']) && idQidList(r.landed) && safeInt(r.fillsProcessed, 0),
  publication: r => exactKeys(r, ['published', 'notStaged', 'abandoned']) && strList(r.published) && strList(r.notStaged) && strList(r.abandoned),
  'poison-guard': r => exactKeys(r, ['items']) && Array.isArray(r.items) && r.items.every(i =>
    exactKeys(i, ['qid', 'outcome', 'stagedTries']) && typeof i.qid === 'string'
    && ['counted', 'abandoned', 'skipped'].includes(i.outcome) && (i.stagedTries === null || safeInt(i.stagedTries, 0))),
  'qid-removal': r => exactKeys(r, ['status', 'reason', 'removedQid']) && r.status === 200 && r.reason === 'removed' && isQid(r.removedQid),
  'legacy-removal': r => exactKeys(r, ['status', 'removed']) && r.status === 200 && safeInt(r.removed, 1),
  reset: r => exactKeys(r, ['emptied', 'resetSeq']) && exactKeys(r.emptied, ['pending', 'pendingStaged', 'openLegs', 'lastProcessedIds'])
    && Object.values(r.emptied).every(n => safeInt(n, 0)) && safeInt(r.resetSeq, 1),
  'reset-cancel': r => exactKeys(r, ['resetSeq']) && safeInt(r.resetSeq, 1),
  progress: r => exactKeys(r, ['fields']) && strList(r.fields),
  activate: r => exactKeys(r, ['removalEnabled']) && r.removalEnabled === true,
  deactivate: r => exactKeys(r, ['removalEnabled']) && r.removalEnabled === false,
};

// Why a stored record cannot be trusted, or null if it can (5.5 (1a)).
// `key` is the key it is stored under; `nowMs` is the CURRENT operation's
// fixed timestamp.
function untrustedWhy(rec, key, stateVersion, nowMs) {
  if (!exactKeys(rec, ['opId', 'kind', 'committedAt', 'committedVersion', 'result', 'check'])) return 'not exactly the six record fields';
  if (typeof rec.opId !== 'string' || !HEX32.test(rec.opId)) return 'opId is not 32 lower-case hex';
  if (rec.opId !== key) return 'opId does not match the key it is stored under';
  if (!KINDS.includes(rec.kind)) return 'kind is not one of this plan\'s operation kinds';
  if (!safeInt(rec.committedAt, JAN_2026, nowMs + SKEW)) return 'committedAt out of range';
  if (!safeInt(rec.committedVersion, 1, stateVersion)) return 'committedVersion out of range';
  let shapeOk = false;
  try { shapeOk = RESULT_SHAPES[rec.kind](rec.result); } catch (e) { shapeOk = false; }
  if (!shapeOk) return 'result does not have its kind\'s shape';
  if (typeof rec.check !== 'string' || !HEX64.test(rec.check)) return 'check is not 64 lower-case hex';
  let want;
  try { want = recordCheck(rec); } catch (e) { return 'record cannot be canonicalised'; }
  if (rec.check !== want) return 'check does not match';
  return null;
}

// ---- 5.5 MALFORMED STATE, for an EXPANDED document. A list of what is
// wrong; empty means usable. The queue identity (queueEpoch, queueSeq) is
// deliberately NOT here: a bad one is handled by 4.1's case table (a new
// epoch), not by refusing everything.
function docProblems(doc) {
  const p = [];
  if (!isPlain(doc)) return ['the document is not an object'];
  if (doc.schemaVersion !== 2) p.push('schemaVersion is not 2');
  if (!safeInt(doc.stateVersion, 1)) p.push('stateVersion is not a whole number from 1');
  if (!Array.isArray(doc.queueEvents)) p.push('queueEvents is not a list');
  if (!isPlain(doc.opRecords)) p.push('opRecords is not an object');
  if (!safeInt(doc.prunedThroughVersion, 0)) p.push('prunedThroughVersion is not a whole number');
  if (typeof doc.removalEnabled !== 'boolean') p.push('removalEnabled is not true or false');
  for (const k of ['pending', 'pendingStaged']) {
    if (!Array.isArray(doc[k])) p.push(k + ' is not a list');
    else if (!doc[k].every(isPlain)) p.push(k + ' holds an entry that is not an object');
  }
  for (const k of ['openLegs', 'lastProcessedIds']) if (has(doc, k) && !Array.isArray(doc[k])) p.push(k + ' is not a list');
  if (has(doc, 'identityCutoverAt') && !(typeof doc.identityCutoverAt === 'string' && !Number.isNaN(Date.parse(doc.identityCutoverAt)))) p.push('identityCutoverAt is not a date');
  for (const k of ['lastSync', 'lastBackfill']) if (has(doc, k) && !isObjectish(doc[k])) p.push(k + ' is not an object');
  if (has(doc, 'exceptions') && doc.exceptions !== null && !isObjectish(doc.exceptions)) p.push('exceptions is not an object');
  if (has(doc, 'ftfcRetry') && !isObjectish(doc.ftfcRetry)) p.push('ftfcRetry is not an object');
  if (has(doc, 'ftfcUpdates') && !Array.isArray(doc.ftfcUpdates)) p.push('ftfcUpdates is not a list');
  // 5.9.3 counters. ABSENT is read as 0: the expansion adds exactly the nine
  // fields of 5.8.4 (the accepted checker's A1), and these two first appear
  // with the first reset-kind record.
  for (const k of ['resetCounter', 'prunedResetThrough']) if (has(doc, k) && !safeInt(doc[k], 0)) p.push(k + ' is not a whole number');
  return p;
}
const resetCounterOf = doc => (has(doc, 'resetCounter') ? doc.resetCounter : 0);
const prunedResetThroughOf = doc => (has(doc, 'prunedResetThrough') ? doc.prunedResetThrough : 0);

// ---- 5.8.4 THE SCHEMA EXPANSION.
// The validation X1 to X5, IN ORDER, stopping at the first failure (the
// accepted checker version 4's policy). X6, the size, is the store's own
// check on the text actually written (tradeStore). Returns null when the
// document passes, or {rule, why}.
function expansionRefusal(doc) {
  if (doc === undefined) return null;                                    // X1: absent is allowed
  if (!isObjectish(doc)) return { rule: 'X1', why: 'the stored value is not an object' };
  const notList = ['openLegs', 'pending', 'lastProcessedIds'].filter(k => k in doc && !Array.isArray(doc[k]));
  if (notList.length) return { rule: 'X2', why: 'not a list: ' + notList.join(', ') };
  const pend = Array.isArray(doc.pending) ? doc.pending : [];
  const badIds = pend.map((e, i) => (isObjectish(e) && typeof e.id === 'string' && e.id.length ? null : i)).filter(i => i !== null);
  if (badIds.length) return { rule: 'X3', why: badIds.length + ' waiting entr(y/ies) without a non-empty text id' };
  const wrong = [];
  if ('identityCutoverAt' in doc && !(typeof doc.identityCutoverAt === 'string' && !Number.isNaN(Date.parse(doc.identityCutoverAt)))) wrong.push('identityCutoverAt');
  for (const k of ['lastSync', 'lastBackfill']) if (k in doc && !isObjectish(doc[k])) wrong.push(k);
  if ('exceptions' in doc && doc.exceptions !== null && !isObjectish(doc.exceptions)) wrong.push('exceptions');
  if ('ftfcRetry' in doc && !isObjectish(doc.ftfcRetry)) wrong.push('ftfcRetry');
  if ('ftfcUpdates' in doc && !Array.isArray(doc.ftfcUpdates)) wrong.push('ftfcUpdates');
  if (wrong.length) return { rule: 'X4', why: 'wrong type: ' + wrong.join(', ') };
  const present = NEW_NAMES.filter(k => k in doc);
  if (present.length) return { rule: 'X5', why: 'already present: ' + present.join(', ') };
  return null;
}

// The expansion's update function. `fixed` carries at (ms) and
// candidateEpoch. An expanded document (schemaVersion 2) is left alone: no
// write and no record. stateVersion and opRecords are placed here so the
// field order matches the checker's; the store fills in their values.
function expandUpdate(doc, fixed) {
  if (isPlain(doc) && doc.schemaVersion === 2) return { next: null, result: null };
  const bad = expansionRefusal(doc);
  if (bad) return { refuse: 'state-invalid', why: bad.rule + ': ' + bad.why };
  if (!HEX32.test(String(fixed.candidateEpoch))) return { refuse: 'state-invalid', why: 'the candidate epoch is not 32 lower-case hex' };
  // AN ABSENT KEY: today's default document (tradeStore's DEFAULT_STATE).
  const base = doc === undefined ? { openLegs: [], pending: [], lastProcessedIds: [] } : doc;
  const counts = { pending: (base.pending || []).length, openLegs: (base.openLegs || []).length };
  const next = Object.assign({}, base, {
    schemaVersion: 2, stateVersion: 1, queueEpoch: fixed.candidateEpoch, queueSeq: 0,
    queueEvents: [{ case: 'expand', at: fixed.at, counts }],
    opRecords: {}, prunedThroughVersion: 0, pendingStaged: [], removalEnabled: false,
  });
  return { next, result: { added: NEW_NAMES.slice(), unknownFields: Object.keys(base).filter(k => !KNOWN_OLD.includes(k)) } };
}

// ---- THE COMMIT's bookkeeping, as a pure function: stateVersion + 1, the
// operation's own record, and pruning (5.5 (1), (5); 5.9.3 S-R5).
// `doc` is the document read (undefined if absent); `next` the update's new
// document. Returns {final, pruned: n, skew: bool}.
function finalize(doc, next, result, kind, fixed) {
  const V0 = isPlain(doc) && safeInt(doc.stateVersion, 1) ? doc.stateVersion : 0;
  const at = fixed.at;
  const records = Object.assign({}, isPlain(next.opRecords) ? next.opRecords : {});
  let prunedThrough = safeInt(next.prunedThroughVersion, 0) ? next.prunedThroughVersion : 0;
  let prunedReset = prunedResetThroughOf(next);
  // CLOCK GUARD: a record from more than 5 minutes in the future means some
  // clock is wrong; nothing is pruned in this write.
  const skew = Object.values(records).some(r => isPlain(r) && Number.isSafeInteger(r.committedAt) && r.committedAt > at + SKEW);
  const record = { opId: fixed.opId, kind, committedAt: at, committedVersion: V0 + 1, result };
  record.check = recordCheck(record);
  let pruned = 0;
  if (!skew) {
    const resetRecs = [];
    for (const [k, r] of Object.entries(records)) {
      if (untrustedWhy(r, k, V0, at)) continue;                        // untrusted: NEVER pruned
      if (RESET_KINDS.includes(r.kind)) { resetRecs.push([k, r]); continue; }
      if (r.committedAt < at - OP_RETAIN) {
        delete records[k]; pruned++;
        prunedThrough = Math.max(prunedThrough, r.committedVersion);    // never lowered
      }
    }
    // Reset-kind records: the newest RESET_KEEP by resetSeq are kept (the new
    // record, if it is one, counts among them). A pruned one raises
    // prunedResetThrough AND prunedThroughVersion: "a record leaves only by
    // pruning, which raises it past that record" (A2 (B4)) must hold for
    // resets as for every other kind, or R4 could wrongly prove non-commit.
    if (RESET_KINDS.includes(kind)) resetRecs.push([fixed.opId, record]);
    resetRecs.sort((a, b) => b[1].result.resetSeq - a[1].result.resetSeq);
    for (const [k, r] of resetRecs.slice(RESET_KEEP)) {
      if (k === fixed.opId) continue;
      delete records[k]; pruned++;
      prunedReset = Math.max(prunedReset, r.result.resetSeq);
      prunedThrough = Math.max(prunedThrough, r.committedVersion);
    }
  }
  records[fixed.opId] = record;
  const final = Object.assign({}, next);
  final.stateVersion = V0 + 1;
  final.opRecords = records;
  final.prunedThroughVersion = prunedThrough;
  if (prunedReset !== prunedResetThroughOf(next) || has(next, 'prunedResetThrough')) final.prunedResetThrough = prunedReset;
  return { final, pruned, skew };
}

// ---- 4.1 THE QUEUE IDENTITY.
const epochValid = e => typeof e === 'string' && HEX32.test(e);
const seqValid = s => Number.isSafeInteger(s) && s >= 0 && s < Number.MAX_SAFE_INTEGER;
function identityCase(doc) {
  const e = epochValid(doc.queueEpoch), s = seqValid(doc.queueSeq);
  return e && s ? 'C1' : e ? 'C2' : s ? 'C3' : 'C4';
}
// Issues n new qids on `doc` (an expanded document, not changed). Returns
// {ok: true, fields: {queueEpoch, queueSeq, queueEvents}, qids} or
// {ok: false, reason: 'epoch-collision'}. The counter is NEVER rebuilt from
// surviving qids.
function issueQids(doc, n, candidateEpoch, at) {
  let epoch = doc.queueEpoch, seq = doc.queueSeq, events = doc.queueEvents;
  const kase = identityCase(doc);
  if (kase !== 'C1') {
    const c = String(candidateEpoch);
    const prefix = c + '-';
    const used = (Array.isArray(doc.queueEvents) ? doc.queueEvents : [])
      .flatMap(ev => (isPlain(ev) ? [ev.epoch, ev.oldEpoch, ev.newEpoch] : []));
    const anyQidHas = ['pending', 'pendingStaged'].some(k => (doc[k] || []).some(x => isPlain(x) && typeof x.qid === 'string' && x.qid.startsWith(prefix)));
    if (!epochValid(c) || (epochValid(doc.queueEpoch) && c === doc.queueEpoch) || used.includes(c) || anyQidHas) {
      return { ok: false, reason: 'epoch-collision' };
    }
    events = [...events, { case: kase, at, oldEpoch: doc.queueEpoch === undefined ? null : doc.queueEpoch,
      oldSeq: doc.queueSeq === undefined ? null : doc.queueSeq, newEpoch: c,
      counts: { staged: (doc.pendingStaged || []).length, visible: (doc.pending || []).length } }];
    epoch = c; seq = 0;
  }
  const qids = [];
  for (let i = 0; i < n; i++) { seq += 1; qids.push(epoch + '-' + seq); }
  return { ok: true, fields: { queueEpoch: epoch, queueSeq: seq, queueEvents: events }, qids };
}
const untaggedCounts = doc => ({
  visible: (doc.pending || []).filter(e => !isTagged(e)).length,
  staged: (doc.pendingStaged || []).filter(e => !isTagged(e)).length,
});

// ---- The writers that need nothing from the matcher (each returns
// {next, result}, or {next: null, result} for "no change", or {refuse}).

// 4.2 REMOVAL BY EXACT qid. Checks in the plan's order, on the document the
// commit will compare against.
function qidRemoval(doc, fixed) {
  const { id, pair, qid } = fixed.payload;
  const pending = doc.pending || [];
  const same = e => String(e.id) === String(id);
  const samePair = e => JSON.stringify((e.fills || []).map(String)) === JSON.stringify(pair.map(String));
  const hit = pending.filter(e => isPlain(e) && e.qid === qid);
  if (hit.length) {
    const e = hit[0];
    const mismatch = [];
    if (!same(e)) mismatch.push('id');
    const f = (e.fills || []).map(String);
    if (f[0] !== String(pair[0])) mismatch.push('open');
    if (f[1] !== String(pair[1]) || f.length !== 2) mismatch.push('close');
    if (mismatch.length) return { next: null, result: { status: 409, removed: 0, reason: 'qid-mismatch', mismatch } };
    const idx = pending.indexOf(e);
    return { next: Object.assign({}, doc, { pending: pending.filter((_, i) => i !== idx) }),
      result: { status: 200, reason: 'removed', removedQid: qid } };
  }
  const others = pending.filter(e => isPlain(e) && same(e) && samePair(e));
  if (others.length) return { next: null, result: { status: 409, removed: 0, reason: 'other-qids', queuedQids: others.map(e => (e.qid === undefined ? null : e.qid)).slice(0, 10) } };
  return { next: null, result: { status: 200, removed: 0, reason: 'not-found' } };
}

// 4.3 THE LEGACY FORMS, exactly as before Deploy 2 (tradeStore.js at
// eb3880b, removePendingTrade and removePendingTradeIfPair).
function legacyRemovalById(doc, fixed) {
  const id = fixed.payload.id;
  const pending = doc.pending || [];
  const keep = pending.filter(t => t.id !== id);
  if (keep.length === pending.length) return { next: null, result: { status: 200, removed: 0 } };
  return { next: Object.assign({}, doc, { pending: keep }), result: { status: 200, removed: pending.length - keep.length } };
}
function legacyRemovalByPair(doc, fixed) {
  const { id, pair } = fixed.payload;
  const want = JSON.stringify(pair.map(String));
  let removed = 0; const kept = [];
  const pending = (doc.pending || []).filter(t => {
    if (!t || t.id !== id) return true;
    if (JSON.stringify((t.fills || []).map(String)) === want) { removed++; return false; }
    kept.push(t.fills || []);
    return true;
  });
  // `kept` is the answer's extra detail, never part of the record.
  return removed ? { next: Object.assign({}, doc, { pending }), result: { status: 200, removed }, kept }
    : { next: null, result: { status: 200, removed: 0 }, kept };
}

// 3.8 THE PROTECTED RESET, with 5.9.3 (S-R2): openLegs, pending,
// lastProcessedIds and pendingStaged emptied; exceptions kept, as before;
// every other OLDER field dropped exactly as the generation-1 reset dropped
// it (it wrote a new object holding only the three lists and exceptions);
// every NEW-schema field kept, and resetCounter + 1.
function resetUpdate(doc) {
  const seq = resetCounterOf(doc) + 1;
  const next = { openLegs: [], pending: [], lastProcessedIds: [],
    ...(doc && doc.exceptions ? { exceptions: doc.exceptions } : {}) };
  for (const k of NEW_NAMES) if (has(doc, k)) next[k] = doc[k];
  next.pendingStaged = [];
  next.resetCounter = seq;
  if (has(doc, 'prunedResetThrough')) next.prunedResetThrough = doc.prunedResetThrough;
  const len = k => (Array.isArray(doc[k]) ? doc[k].length : 0);
  return { next, result: { emptied: { pending: len('pending'), pendingStaged: len('pendingStaged'),
    openLegs: len('openLegs'), lastProcessedIds: len('lastProcessedIds') }, resetSeq: seq } };
}
// 5.9.3 (S-R6) CANCEL: a tombstone, so a late copy of the reset finds it and
// does nothing. A record for this id is answered by the store before this
// runs (tradeStore's record check), so reaching here means there is none.
// Each reset-kind record takes its own resetSeq, so the counter moves for a
// tombstone too (S-R5 prunes by resetSeq, which must not repeat).
function resetCancelUpdate(doc) {
  const seq = resetCounterOf(doc) + 1;
  return { next: Object.assign({}, doc, { resetCounter: seq }), result: { resetSeq: seq } };
}

// 5.7 ACTIVATION, counted inside the commit that sets the flag.
function activateUpdate(doc) {
  const c = untaggedCounts(doc);
  if (c.visible || c.staged) return { next: null, result: { status: 'refused', untagged: c } };
  if (doc.removalEnabled === true) return { next: null, result: { status: 'already-enabled' } };
  return { next: Object.assign({}, doc, { removalEnabled: true }), result: { removalEnabled: true } };
}
function deactivateUpdate(doc) {
  // "It always commits": the record is the evidence it ran.
  return { next: Object.assign({}, doc, { removalEnabled: false }), result: { removalEnabled: false } };
}

// W3, backfill progress: a merge into lastBackfill.
function progressUpdate(doc, fixed) {
  const patch = fixed.payload;
  return { next: Object.assign({}, doc, { lastBackfill: Object.assign({}, isObjectish(doc.lastBackfill) ? doc.lastBackfill : {}, patch) }),
    result: { fields: Object.keys(patch) } };
}

// 3.11 THE POISON GUARD, before a batch's enrichment starts. `qids` is the
// batch. An item tried twice already is published unmeasured ("abandoned")
// in this same write; every other item still staged has stagedTries + 1.
function poisonGuardUpdate(doc, fixed) {
  const qids = fixed.payload.qids;
  const staged = doc.pendingStaged || [];
  const byQid = new Map(staged.filter(isPlain).map(e => [e.qid, e]));
  const items = [];
  const abandon = new Set(), count = new Map();
  for (const q of qids) {
    const e = byQid.get(q);
    if (!e) { items.push({ qid: q, outcome: 'skipped', stagedTries: null }); continue; }
    const tries = safeInt(e.stagedTries, 0) ? e.stagedTries : 0;
    if (tries >= 2) { abandon.add(q); items.push({ qid: q, outcome: 'abandoned', stagedTries: tries }); continue; }
    count.set(q, tries + 1); items.push({ qid: q, outcome: 'counted', stagedTries: tries + 1 });
  }
  if (!abandon.size && !count.size) return { next: null, result: { items } };
  const nextStaged = [];
  const published = [];
  for (const e of staged) {
    if (isPlain(e) && abandon.has(e.qid)) { published.push(withoutStagingFields(e)); continue; }
    if (isPlain(e) && count.has(e.qid)) { nextStaged.push(Object.assign({}, e, { stagedTries: count.get(e.qid) })); continue; }
    nextStaged.push(e);
  }
  const next = Object.assign({}, doc, { pendingStaged: nextStaged });
  if (published.length) {
    next.pending = [...published, ...(doc.pending || [])];
    next.lastBackfill = withUnmeasured(doc.lastBackfill, published.map(e => ({ qid: e.qid, id: e.id, reason: 'abandoned' })));
  }
  return { next, result: { items } };
}
const withoutStagingFields = e => { const o = Object.assign({}, e); delete o.stagedAt; delete o.stagedTries; return o; };
// 3.5: lastBackfill.unmeasured, a count per reason and up to 10 examples.
function withUnmeasured(lastBackfill, list) {
  const lb = Object.assign({}, isObjectish(lastBackfill) ? lastBackfill : {});
  const u = isObjectish(lb.unmeasured) ? lb.unmeasured : {};
  const counts = Object.assign({}, isObjectish(u.counts) ? u.counts : {});
  for (const x of list) counts[x.reason] = (safeInt(counts[x.reason], 0) ? counts[x.reason] : 0) + 1;
  const examples = [...list, ...(Array.isArray(u.examples) ? u.examples : [])].slice(0, 10);
  lb.unmeasured = { counts, examples };
  return lb;
}

// 3.3 PUBLICATION, matched by qid ONLY. `items` is
// [{qid, trade, unmeasured: null | 'failed' | 'invalid-reading' | 'timed-out'}],
// each trade being the copy to publish (enriched, or as staged when
// unmeasured). A qid no longer staged publishes NOTHING ("not-staged").
function publicationUpdate(doc, fixed) {
  const items = fixed.payload.items;
  const staged = doc.pendingStaged || [];
  const stagedQids = new Set(staged.filter(isPlain).map(e => e.qid));
  const publish = [], notStaged = [], unmeasured = [];
  for (const it of items) {
    if (!stagedQids.has(it.qid)) { notStaged.push(it.qid); continue; }
    publish.push(Object.assign(withoutStagingFields(it.trade), { qid: it.qid }));
    if (it.unmeasured) unmeasured.push({ qid: it.qid, id: it.trade.id, reason: it.unmeasured });
  }
  if (!publish.length) return { next: null, result: { published: [], notStaged, abandoned: [] } };
  const pubSet = new Set(publish.map(e => e.qid));
  const next = Object.assign({}, doc, {
    pendingStaged: staged.filter(e => !(isPlain(e) && pubSet.has(e.qid))),
    pending: [...publish, ...(doc.pending || [])],
  });
  let lb = Object.assign({}, isObjectish(doc.lastBackfill) ? doc.lastBackfill : {});
  if (unmeasured.length) lb = withUnmeasured(lb, unmeasured);
  if (notStaged.length) lb.notStaged = notStagedNote(lb.notStaged, notStaged);
  lb.stagedCount = next.pendingStaged.length;
  next.lastBackfill = lb;
  return { next, result: { published: publish.map(e => e.qid), notStaged, abandoned: [] } };
}
// 3.3: "not-staged", a count and up to 10 examples.
function notStagedNote(prev, qids) {
  const p = isObjectish(prev) ? prev : {};
  return { count: (safeInt(p.count, 0) ? p.count : 0) + qids.length,
    examples: [...qids, ...(Array.isArray(p.examples) ? p.examples : [])].slice(0, 10) };
}

// 5.9.3 (S-R6) THE RESET STATUS, decided from one exact read (tradeStore's
// readDocument, whose fingerprint was already checked against its text). It
// fails CLOSED: anything it cannot fully trust is "unknown", never "applied"
// or "cancelled". A record naming this request under ANY other key is
// "unknown" too, so a misfiled record can never fall through to "not-yet".
function resetStatus(read, requestId, base, nowMs) {
  const unknown = why => ({ status: 'unknown', why });
  if (!read || read.kind === 'absent') return unknown('there is no record');
  if (read.kind !== 'present' || !isPlain(read.doc)) return unknown('the record could not be read');
  const doc = read.doc;
  if (doc.schemaVersion !== 2) return unknown('the record has not been expanded');
  const problems = docProblems(doc);
  if (problems.length) return unknown('the record is not in the expected form');
  for (const [k, r] of Object.entries(doc.opRecords)) {
    if (k !== requestId && isPlain(r) && r.opId === requestId) return unknown('a record naming this request is stored under another key');
  }
  if (has(doc.opRecords, requestId)) {
    const rec = doc.opRecords[requestId];
    const why = untrustedWhy(rec, requestId, doc.stateVersion, nowMs) || (RESET_KINDS.includes(rec.kind) ? null : 'it is not a reset record');
    if (why) return unknown('untrusted record: ' + why);
    return { status: rec.kind === 'reset' ? 'applied' : 'cancelled' };
  }
  // No record: not applied SO FAR, unless one this new could have been
  // pruned. Written as "<= base" (the same rule as "< base + 1" for whole
  // numbers, with no addition at the largest safe value).
  return prunedResetThroughOf(doc) <= base ? { status: 'not-yet' } : unknown('a record this new could have been pruned');
}

module.exports = {
  resetStatus,
  NEW_NAMES, KNOWN_OLD, SIZE_LIMIT, OP_RETAIN, SKEW, JAN_2026, RESET_KEEP, KINDS, RESET_KINDS, QID, HEX32,
  isPlain, isObjectish, safeInt, exactKeys, sha1, sha256, canonicalJson, recordCheck, isQid, isTagged,
  RESULT_SHAPES, untrustedWhy, docProblems, resetCounterOf, prunedResetThroughOf,
  expansionRefusal, expandUpdate, finalize, identityCase, issueQids, untaggedCounts,
  qidRemoval, legacyRemovalById, legacyRemovalByPair, resetUpdate, resetCancelUpdate,
  activateUpdate, deactivateUpdate, progressUpdate, poisonGuardUpdate, publicationUpdate,
  withUnmeasured, notStagedNote, withoutStagingFields,
};
