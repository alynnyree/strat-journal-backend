'use strict';
// V-Q7 -- READ-ONLY, OFFLINE expansion dry run (Queue plan v13, 5.8.4). Version 4
// (v4: X1 to X5 run in order and STOP at the first failure; every later rule,
// X6 and A1 to A13 are recorded NOT CHECKED, and NOT CHECKED never passes.)
// Version 3
// (v3, after the auditor's addendum review: the expansion's output is checked
// for structure and value in A1 to A13, and ANY failure fails the verdict.)
// Version 2
// (17 Oct 2026, after the auditor's V-Q7 review: backup envelope validated,
// an absent key is never a pass, preservation stated as canonical-JSON
// equality, unreached rules shown as NOT CHECKED, activation counts added).
// Input: a backup file from GET /api/backup/export. Output: a log, printed.
// It loads ONLY 'fs' and 'crypto'. It never opens a network connection and
// never writes anything except its own log file.
const fs = require('fs');
const crypto = require('crypto');

const NEW_NAMES = ['schemaVersion', 'stateVersion', 'queueEpoch', 'queueSeq', 'queueEvents',
  'opRecords', 'prunedThroughVersion', 'pendingStaged', 'removalEnabled'];
const KNOWN = ['openLegs', 'pending', 'lastProcessedIds', 'identityCutoverAt', 'exceptions',
  'lastSync', 'lastBackfill', 'ftfcRetry', 'ftfcUpdates'];
const LIMIT = 5 * 1024 * 1024;
const QID = /^[0-9a-f]{32}-[1-9][0-9]*$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// The service's own rule (cron.js:352), used by X4 for exceptions.
const isPlain = v => v != null && typeof v === 'object' && !Array.isArray(v);
const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : typeof v;
const bytes = s => Buffer.byteLength(s, 'utf8');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// The validation of 5.8.4, X1 to X6. Returns one verdict per rule.
// POLICY (v4): the rules run IN ORDER, X1 to X5, and evaluation STOPS at the
// first failure; every later rule is recorded NOT CHECKED. X6 (size) is
// decided in run(), and only when X1 to X5 all pass. A NOT CHECKED rule never
// counts as a pass.
function validate(doc) {
  const v = {};
  const ORDER = ['X1', 'X2', 'X3', 'X4', 'X5'];
  const rules = {
    X1: () => isObj(doc) ? { pass: true } : { pass: false, note: 'stored value is ' + typeOf(doc) + ', not an object' },
    X2: () => {
      const bad = ['openLegs', 'pending', 'lastProcessedIds'].filter(k => k in doc && !Array.isArray(doc[k]));
      return bad.length ? { pass: false, note: 'not a list: ' + bad.join(', ') } : { pass: true };
    },
    X3: () => {
      const pend = Array.isArray(doc.pending) ? doc.pending : [];
      const bad = pend.map((e, i) => (isObj(e) && typeof e.id === 'string' && e.id.length) ? null : i).filter(i => i !== null);
      return bad.length ? { pass: false, note: bad.length + ' entr(y/ies) without a non-empty text id, positions ' + bad.slice(0, 10).join(', ') } : { pass: true };
    },
    X4: () => {
      const p4 = [];
      if ('identityCutoverAt' in doc && !(typeof doc.identityCutoverAt === 'string' && !Number.isNaN(Date.parse(doc.identityCutoverAt)))) p4.push('identityCutoverAt');
      for (const k of ['lastSync', 'lastBackfill']) if (k in doc && !isObj(doc[k])) p4.push(k);
      if ('exceptions' in doc && doc.exceptions !== null && !isPlain(doc.exceptions)) p4.push('exceptions');
      if ('ftfcRetry' in doc && !isObj(doc.ftfcRetry)) p4.push('ftfcRetry');
      if ('ftfcUpdates' in doc && !Array.isArray(doc.ftfcUpdates)) p4.push('ftfcUpdates');
      return p4.length ? { pass: false, note: 'wrong type: ' + p4.join(', ') } : { pass: true };
    },
    X5: () => {
      const present = NEW_NAMES.filter(k => k in doc);
      return present.length ? { pass: false, note: 'already present: ' + present.join(', ') } : { pass: true };
    },
  };
  if (doc === undefined) {
    // The plan's absent-key case. run() never reaches this for a backup (an
    // absent key there is INCONCLUSIVE); kept for the plan's own wording.
    v.X1 = { pass: true, note: 'absent' };
    for (const k of ORDER.slice(1)) v[k] = { pass: false, notChecked: true, note: 'not applicable: absent document' };
    return v;
  }
  let failedAt = null;
  for (const k of ORDER) {
    if (failedAt) { v[k] = { pass: false, notChecked: true, note: 'not checked: ' + failedAt + ' failed' }; continue; }
    v[k] = rules[k]();
    if (!v[k].pass) failedAt = k;
  }
  return v;
}

// The expansion of 5.8.4, as a pure function of the document and fixed inputs.
function expand(doc, fixed) {
  const base = doc === undefined ? { openLegs: [], pending: [], lastProcessedIds: [] } : doc;
  const counts = { pending: (base.pending || []).length, openLegs: (base.openLegs || []).length };
  const record = { opId: fixed.opId, kind: 'expand', committedAt: fixed.at, committedVersion: 1,
    result: { added: NEW_NAMES.slice(), unknownFields: Object.keys(base).filter(k => !KNOWN.includes(k)) } };
  record.check = sha256(canon({ opId: record.opId, kind: record.kind, committedAt: record.committedAt,
    committedVersion: record.committedVersion, result: record.result }));
  return Object.assign({}, base, {
    schemaVersion: 2, stateVersion: 1, queueEpoch: fixed.candidateEpoch, queueSeq: 0,
    queueEvents: [{ case: 'expand', at: fixed.at, counts }],
    opRecords: { [fixed.opId]: record }, prunedThroughVersion: 0, pendingStaged: [], removalEnabled: false,
  });
}

function run(file, opts) {
  const L = [];
  const raw = fs.readFileSync(file, 'utf8');
  L.push('V-Q7 EXPANSION DRY RUN -- READ-ONLY, OFFLINE');
  L.push('Run at: ' + new Date().toISOString());
  L.push('Input file: ' + bytes(raw) + ' bytes; SHA-256 ' + sha256(raw));
  let backup;
  try { backup = JSON.parse(raw); } catch (e) { L.push('STOP: the backup file is not valid JSON (' + e.message + ').'); return L; }
  L.push('Backup taken at: ' + backup.exportedAt + '; readOnly: ' + backup.readOnly);
  L.push('Backup totals: ' + JSON.stringify(backup.totals));
  // BACKUP ENVELOPE (E1 to E7). An export that cannot be shown complete and
  // self-consistent is not evidence of anything, least of all of an absent key.
  const E = [];
  const chk = (id, ok, what) => E.push({ id, ok: !!ok, what });
  chk('E1', isObj(backup), 'the file is a JSON object');
  chk('E2', backup && typeof backup.exportedAt === 'string' && !Number.isNaN(Date.parse(backup.exportedAt)), 'exportedAt is a date');
  chk('E3', backup && backup.readOnly === true, 'readOnly is true');
  chk('E4', backup && isObj(backup.keys) && Object.values(backup.keys).every(e => isObj(e) && typeof e.type === 'string' && 'value' in e), 'keys is an object of {type, value} entries');
  chk('E5', backup && Array.isArray(backup.excluded) && Array.isArray(backup.notCopied), 'excluded and notCopied are lists');
  const t = (backup && backup.totals) || {};
  chk('E6', isObj(backup && backup.totals) && E[3].ok && E[4].ok
    && t.copied === Object.keys(backup.keys).length && t.excluded === backup.excluded.length && t.notCopied === backup.notCopied.length,
    'totals agree with the lists (copied, excluded, notCopied)');
  chk('E7', E[4].ok && !backup.excluded.some(x => x && x.key === 'trades:state') && !backup.notCopied.some(x => x && x.key === 'trades:state') && backup.notCopied.length === 0,
    'nothing was left uncopied, and "trades:state" is neither excluded nor uncopied');
  L.push('BACKUP ENVELOPE:');
  for (const e of E) L.push('  ' + e.id + ': ' + (e.ok ? 'PASS' : 'FAIL') + ' -- ' + e.what);
  if (!E.every(e => e.ok)) { L.push('STOP: the backup cannot be shown complete and consistent; no verdict is given on the document.'); return L; }
  const entry = backup.keys['trades:state'];
  if (!entry) {
    L.push('"trades:state" is ABSENT from a complete, consistent backup. A running service is not expected to have no queue record, so this is NOT treated as a pass.');
    L.push('VERDICT: INCONCLUSIVE -- STOP for review.');
    return L;
  }
  L.push('"trades:state": stored type "' + entry.type + '"; value type ' + typeOf(entry.value) + '.');
  if (entry.type !== 'string') { L.push('VERDICT: STOP -- the record is not stored as a single text value, which every rule assumes.'); return L; }
  const doc = entry.value;
  const text = doc === undefined ? '' : JSON.stringify(doc);
  L.push('Document size as re-serialised by the backup: ' + bytes(text) + ' bytes (' + (bytes(text) / 1048576).toFixed(3) + ' MB); canonical SHA-256 ' + (doc === undefined ? '-' : sha256(canon(doc))));
  L.push('LIMITATION: the backup holds the document as the service read and rebuilt it, not the exact stored text; exact-text checks belong to Q-T23 on the real store.');
  L.push('');
  if (isObj(doc)) {
    L.push('TOP-LEVEL FIELDS (name: type, size):');
    for (const k of Object.keys(doc)) {
      const val = doc[k];
      const n = Array.isArray(val) ? val.length + ' items' : isObj(val) ? Object.keys(val).length + ' keys' : JSON.stringify(val).slice(0, 40);
      L.push('  ' + k + ': ' + typeOf(val) + ', ' + n + ', ' + bytes(JSON.stringify(val)) + ' bytes' + (KNOWN.includes(k) ? '' : '  <-- UNKNOWN to the plan (kept byte-identical)'));
    }
    const pend = Array.isArray(doc.pending) ? doc.pending : [];
    const tagged = pend.filter(e => isObj(e) && typeof e.qid === 'string' && QID.test(e.qid)).length;
    L.push('Waiting entries (pending): ' + pend.length + '; with a usable qid: ' + tagged + '; UNTAGGED (no qid or a malformed one): ' + (pend.length - tagged));
    const st = Array.isArray(doc.pendingStaged) ? doc.pendingStaged : null;
    L.push('Staged entries (pendingStaged): ' + (st ? st.length + '; UNTAGGED: ' + st.filter(e => !(isObj(e) && typeof e.qid === 'string' && QID.test(e.qid))).length : 'field absent (expected before expansion; 0 entries)'));
    L.push('Activation gate (plan 5.7) on this copy: untagged in pending + pendingStaged = ' + ((pend.length - tagged) + (st ? st.filter(e => !(isObj(e) && typeof e.qid === 'string' && QID.test(e.qid))).length : 0)) + ' (it must be 0 at the moment of activation, which is later; this is only today\'s figure)');
    const ids = pend.filter(isObj).map(e => e.id);
    L.push('Waiting entries sharing an id with another waiting entry: ' + (ids.length - new Set(ids).size));
    L.push('');
  }
  const v = validate(doc);
  const fixed = { opId: '0'.repeat(32), at: Date.parse('2026-10-17T00:00:00Z'), candidateEpoch: 'f'.repeat(32) };
  const doExpand = (opts && opts.expand) || expand;
  let expanded = null;
  if (['X1', 'X2', 'X3', 'X4', 'X5'].every(k => v[k].pass)) {
    expanded = doExpand(doc, fixed);
    const n = bytes(JSON.stringify(expanded));
    v.X6 = n < LIMIT ? { pass: true, note: 'expanded size ' + n + ' bytes (limit 5,242,880)' } : { pass: false, note: 'expanded size ' + n + ' bytes, not under 5,242,880' };
  } else v.X6 = { pass: false, notChecked: true, note: 'not checked: ' + ['X1', 'X2', 'X3', 'X4', 'X5'].find(k => !v[k].pass && !v[k].notChecked) + ' failed' };
  L.push('VALIDATION OF THE STORED DOCUMENT (plan 5.8.4):');
  for (const k of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']) L.push('  ' + k + ': ' + (v[k].notChecked ? 'NOT CHECKED' : v[k].pass ? 'PASS' : 'FAIL') + (v[k].note ? ' -- ' + v[k].note : ''));
  const xPass = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'].every(k => v[k].pass && !v[k].notChecked);
  // THE EXPANSION'S OUTPUT (A1 to A13), each a required check: any failure
  // fails the whole verdict. Structure AND value, against plan 5.8.4 and the
  // record rule of 5.5 (1a).
  const A = [];
  if (expanded) {
    const ex = expanded, has = k => Object.prototype.hasOwnProperty.call(ex, k);
    const keysEq = (o, ks) => isObj(o) && Object.keys(o).length === ks.length && ks.every(k => Object.prototype.hasOwnProperty.call(o, k));
    const added = Object.keys(ex).filter(k => !(isObj(doc) && k in doc));
    const unknown = Object.keys(doc).filter(k => !KNOWN.includes(k));
    const pendN = Array.isArray(doc.pending) ? doc.pending.length : 0, legN = Array.isArray(doc.openLegs) ? doc.openLegs.length : 0;
    const ev = Array.isArray(ex.queueEvents) && ex.queueEvents.length === 1 ? ex.queueEvents[0] : null;
    const rec = isObj(ex.opRecords) ? ex.opRecords[fixed.opId] : null;
    const add = (id, ok, what) => A.push({ id, ok: !!ok, what });
    add('A1', added.length === NEW_NAMES.length && NEW_NAMES.every(k => added.includes(k)), 'exactly the nine new fields are added, no more and no fewer (added: ' + added.join(', ') + ')');
    add('A2', Object.keys(doc).every(k => has(k) && canon(doc[k]) === canon(ex[k])), 'every existing field is present and SEMANTICALLY unchanged under canonical-JSON comparison (not a byte-for-byte claim)');
    add('A3', canon(doc.pending) === canon(ex.pending), 'waiting entries untouched: none tagged, none reordered');
    add('A4', ex.schemaVersion === 2, 'schemaVersion is the number 2');
    add('A5', ex.stateVersion === 1, 'stateVersion is the number 1');
    add('A6', typeof ex.queueEpoch === 'string' && /^[0-9a-f]{32}$/.test(ex.queueEpoch) && ex.queueEpoch === fixed.candidateEpoch, 'queueEpoch is the fixed candidate, 32 lower-case hex characters');
    add('A7', ex.queueSeq === 0, 'queueSeq is the number 0');
    add('A8', ev && keysEq(ev, ['case', 'at', 'counts']) && ev.case === 'expand' && ev.at === fixed.at && keysEq(ev.counts, ['pending', 'openLegs']) && ev.counts.pending === pendN && ev.counts.openLegs === legN, 'queueEvents is exactly one event {case "expand", at = the fixed timestamp, counts = {pending, openLegs} found}');
    add('A9', keysEq(ex.opRecords, [fixed.opId]) && keysEq(rec, ['opId', 'kind', 'committedAt', 'committedVersion', 'result', 'check']), 'opRecords holds exactly its own record, with exactly the six fields of 5.5 (1)');
    add('A10', rec && /^[0-9a-f]{32}$/.test(rec.opId) && rec.opId === fixed.opId && rec.kind === 'expand' && Number.isSafeInteger(rec.committedAt) && rec.committedAt >= 1767225600000 && rec.committedAt <= fixed.at + 300000 && rec.committedAt === fixed.at && rec.committedVersion === 1 && rec.committedVersion <= ex.stateVersion, 'the record is VALID under 5.5 (1a): opId 32 hex, kind "expand", committedAt in range and equal to the fixed timestamp, committedVersion 1');
    add('A11', rec && keysEq(rec.result, ['added', 'unknownFields']) && canon(rec.result.added) === canon(NEW_NAMES) && canon(rec.result.unknownFields) === canon(unknown) && rec.check === sha256(canon({ opId: rec.opId, kind: rec.kind, committedAt: rec.committedAt, committedVersion: rec.committedVersion, result: rec.result })), 'the record\'s result names the added and unknown fields, and its check is the SHA-256 of the canonical record');
    add('A12', ex.prunedThroughVersion === 0, 'prunedThroughVersion is the number 0');
    add('A13', Array.isArray(ex.pendingStaged) && ex.pendingStaged.length === 0 && ex.removalEnabled === false, 'pendingStaged is an empty list, and removalEnabled is the value false');
    L.push('');
    L.push('THE EXPANSION\'S OUTPUT, each check required (plan 5.8.4; record rule 5.5 (1a)):');
    for (const a of A) L.push('  ' + a.id + ': ' + (a.ok ? 'PASS' : 'FAIL') + ' -- ' + a.what);
    L.push('  (The epoch, opId and timestamp are placeholders for the dry run only; a real expansion uses fresh ones.)');
  }
  if (!expanded) { L.push(''); L.push('THE EXPANSION\'S OUTPUT: A1 to A13 NOT CHECKED -- a rule on the stored document failed, so no expansion was computed.'); }
  const aPass = !!expanded && A.length === 13 && A.every(a => a.ok);
  L.push('');
  L.push('VERDICT: ' + (xPass && aPass ? 'ALL CHECKS PASS (X1 to X6 and A1 to A13)'
    : 'STOP -- ' + (!xPass ? 'a rule on the stored document fails' : 'a check on the expansion\'s output fails') + '; the plan does not proceed to Deploy 2'));
  return L;
}

if (require.main === module) {
  const out = run(process.argv[2]).join('\n') + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], out);
  process.stdout.write(out);
}
module.exports = { validate, expand, run, canon };
