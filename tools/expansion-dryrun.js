'use strict';
// THE EXPANSION DRY RUN, with the IMPLEMENTED rules (Queue plan v14.1 rev 3.2,
// 5.8.4 "THE DRY RUN"; Deploy 2 plan v2, section 5).
//
// Input: a backup file from the existing read-only export (GET /backup/export).
// It runs the SAME validation (X1 to X5) and the SAME expansion the service
// runs at start-up (queueOps.js), on that copy, OFFLINE: it loads only 'fs',
// 'crypto' and queueOps.js, never opens a network connection, and writes
// nothing except its own log when asked to. Its output is checked by the
// accepted V-Q7 checker's thirteen output checks (A1 to A13), so its verdict
// can be compared with that checker's, line by line (tests/expansion-dryrun.js).
//
// The backup file is the owner's data: it is never committed to this
// repository. Run it where the file is: node tools/expansion-dryrun.js <file> [log]
const fs = require('fs');
const crypto = require('crypto');
const Q = require('../queueOps');

const QID = Q.QID;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : typeof v);
const bytes = s => Buffer.byteLength(s, 'utf8');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// The checker's canonical form (keys sorted at every level).
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// The service's own expansion, exactly as the store runs it: the update, then
// THE COMMIT's bookkeeping (stateVersion and the expansion's own record).
function implementedExpand(doc, fixed) {
  const out = Q.expandUpdate(doc, fixed);
  if (out.refuse) throw new Error('the expansion refused: ' + out.why);
  return Q.finalize(doc, out.next, out.result, 'expand', fixed).final;
}

function run(file, opts) {
  const L = [];
  const raw = fs.readFileSync(file, 'utf8');
  L.push('EXPANSION DRY RUN, IMPLEMENTED RULES -- READ-ONLY, OFFLINE');
  L.push('Run at: ' + new Date().toISOString());
  L.push('Input file: ' + bytes(raw) + ' bytes; SHA-256 ' + sha256(raw));
  let backup;
  try { backup = JSON.parse(raw); } catch (e) { L.push('STOP: the backup file is not valid JSON (' + e.message + ').'); return L; }
  L.push('Backup taken at: ' + backup.exportedAt + '; readOnly: ' + backup.readOnly);
  // BACKUP ENVELOPE (E1 to E7), the accepted checker's rules.
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
  L.push('Document size as re-serialised by the backup: ' + bytes(text) + ' bytes; canonical SHA-256 ' + (doc === undefined ? '-' : sha256(canon(doc))));
  L.push('Fingerprint (SHA-1) of the backup\'s re-serialised text: ' + (doc === undefined ? '-' : Q.sha1(text)) + ' -- RE-SERIALISED BY THE BACKUP; NOT THE STORED TEXT.');
  L.push('LIMITATION: the backup holds the document as the service read and rebuilt it, not the exact stored text; the expansion validates again on the real text inside its own commit.');
  L.push('');
  if (isObj(doc)) {
    L.push('TOP-LEVEL FIELDS (name: type, size):');
    for (const k of Object.keys(doc)) {
      const val = doc[k];
      const n = Array.isArray(val) ? val.length + ' items' : isObj(val) ? Object.keys(val).length + ' keys' : JSON.stringify(val).slice(0, 40);
      L.push('  ' + k + ': ' + typeOf(val) + ', ' + n + ', ' + bytes(JSON.stringify(val)) + ' bytes' + (Q.KNOWN_OLD.includes(k) ? '' : '  <-- UNKNOWN to the plan (kept unchanged)'));
    }
    const pend = Array.isArray(doc.pending) ? doc.pending : [];
    const tagged = pend.filter(e => isObj(e) && typeof e.qid === 'string' && QID.test(e.qid)).length;
    L.push('Waiting entries (pending): ' + pend.length + '; with a usable qid: ' + tagged + '; UNTAGGED: ' + (pend.length - tagged));
    L.push('');
  }
  // THE IMPLEMENTED VALIDATION, X1 to X5 in order (queueOps.expansionRefusal),
  // then X6 on the text the expansion would write.
  const ORDER = ['X1', 'X2', 'X3', 'X4', 'X5'];
  const v = {};
  const bad = Q.expansionRefusal(doc);
  for (const k of ORDER) {
    if (!bad) v[k] = { pass: true };
    else if (ORDER.indexOf(k) < ORDER.indexOf(bad.rule)) v[k] = { pass: true };
    else if (k === bad.rule) v[k] = { pass: false, note: bad.why };
    else v[k] = { pass: false, notChecked: true, note: 'not checked: ' + bad.rule + ' failed' };
  }
  const fixed = { opId: '0'.repeat(32), at: Date.parse('2026-10-17T00:00:00Z'), candidateEpoch: 'f'.repeat(32) };
  const doExpand = (opts && opts.expand) || implementedExpand;
  let expanded = null;
  if (!bad) {
    expanded = doExpand(doc, fixed);
    const n = bytes(JSON.stringify(expanded));
    v.X6 = n < Q.SIZE_LIMIT ? { pass: true, note: 'expanded size ' + n + ' bytes (limit 5,242,880)' } : { pass: false, note: 'expanded size ' + n + ' bytes, not under 5,242,880' };
  } else v.X6 = { pass: false, notChecked: true, note: 'not checked: ' + bad.rule + ' failed' };
  L.push('VALIDATION OF THE STORED DOCUMENT (implemented rules, queueOps.js):');
  for (const k of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']) L.push('  ' + k + ': ' + (v[k].notChecked ? 'NOT CHECKED' : v[k].pass ? 'PASS' : 'FAIL') + (v[k].note ? ' -- ' + v[k].note : ''));
  const xPass = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'].every(k => v[k].pass && !v[k].notChecked);
  // THE OUTPUT CHECKS A1 to A13: the accepted checker's, on the implemented
  // expansion's output.
  const A = [];
  if (expanded) {
    const ex = expanded, has = k => Object.prototype.hasOwnProperty.call(ex, k);
    const keysEq = (o, ks) => isObj(o) && Object.keys(o).length === ks.length && ks.every(k => Object.prototype.hasOwnProperty.call(o, k));
    const added = Object.keys(ex).filter(k => !(isObj(doc) && k in doc));
    const unknown = Object.keys(doc).filter(k => !Q.KNOWN_OLD.includes(k));
    const pendN = Array.isArray(doc.pending) ? doc.pending.length : 0, legN = Array.isArray(doc.openLegs) ? doc.openLegs.length : 0;
    const ev = Array.isArray(ex.queueEvents) && ex.queueEvents.length === 1 ? ex.queueEvents[0] : null;
    const rec = isObj(ex.opRecords) ? ex.opRecords[fixed.opId] : null;
    const add = (id, ok, what) => A.push({ id, ok: !!ok, what });
    add('A1', added.length === Q.NEW_NAMES.length && Q.NEW_NAMES.every(k => added.includes(k)), 'exactly the nine new fields are added (added: ' + added.join(', ') + ')');
    add('A2', Object.keys(doc).every(k => has(k) && canon(doc[k]) === canon(ex[k])), 'every existing field is present and SEMANTICALLY unchanged (canonical JSON)');
    add('A3', canon(doc.pending) === canon(ex.pending), 'waiting entries untouched: none tagged, none reordered');
    add('A4', ex.schemaVersion === 2, 'schemaVersion is the number 2');
    add('A5', ex.stateVersion === 1, 'stateVersion is the number 1');
    add('A6', typeof ex.queueEpoch === 'string' && /^[0-9a-f]{32}$/.test(ex.queueEpoch) && ex.queueEpoch === fixed.candidateEpoch, 'queueEpoch is the fixed candidate, 32 lower-case hex characters');
    add('A7', ex.queueSeq === 0, 'queueSeq is the number 0');
    add('A8', ev && keysEq(ev, ['case', 'at', 'counts']) && ev.case === 'expand' && ev.at === fixed.at && keysEq(ev.counts, ['pending', 'openLegs']) && ev.counts.pending === pendN && ev.counts.openLegs === legN, 'queueEvents is exactly one event {case "expand", at, counts}');
    add('A9', keysEq(ex.opRecords, [fixed.opId]) && keysEq(rec, ['opId', 'kind', 'committedAt', 'committedVersion', 'result', 'check']), 'opRecords holds exactly its own record, with exactly the six fields');
    add('A10', rec && /^[0-9a-f]{32}$/.test(rec.opId) && rec.opId === fixed.opId && rec.kind === 'expand' && Number.isSafeInteger(rec.committedAt) && rec.committedAt >= 1767225600000 && rec.committedAt <= fixed.at + 300000 && rec.committedAt === fixed.at && rec.committedVersion === 1 && rec.committedVersion <= ex.stateVersion, 'the record is VALID under 5.5 (1a)');
    add('A11', rec && keysEq(rec.result, ['added', 'unknownFields']) && canon(rec.result.added) === canon(Q.NEW_NAMES) && canon(rec.result.unknownFields) === canon(unknown) && rec.check === sha256(canon({ opId: rec.opId, kind: rec.kind, committedAt: rec.committedAt, committedVersion: rec.committedVersion, result: rec.result })), 'the record\'s result names the added and unknown fields, and its check matches');
    add('A12', ex.prunedThroughVersion === 0, 'prunedThroughVersion is the number 0');
    add('A13', Array.isArray(ex.pendingStaged) && ex.pendingStaged.length === 0 && ex.removalEnabled === false, 'pendingStaged is an empty list, and removalEnabled is false');
    L.push('');
    L.push('THE EXPANSION\'S OUTPUT, each check required:');
    for (const a of A) L.push('  ' + a.id + ': ' + (a.ok ? 'PASS' : 'FAIL') + ' -- ' + a.what);
    L.push('  (The epoch, opId and timestamp are placeholders for the dry run only; the real expansion uses fresh ones.)');
    L.push('Fields the expansion would ADD: ' + added.join(', '));
  }
  if (!expanded) { L.push(''); L.push('THE EXPANSION\'S OUTPUT: A1 to A13 NOT CHECKED -- a rule on the stored document failed, so no expansion was computed.'); }
  const aPass = !!expanded && A.length === 13 && A.every(a => a.ok);
  L.push('');
  L.push('VERDICT: ' + (xPass && aPass ? 'ALL CHECKS PASS (X1 to X6 and A1 to A13)'
    : 'STOP -- ' + (!xPass ? 'a rule on the stored document fails' : 'a check on the expansion\'s output fails') + '; the plan does not proceed to Deploy 2'));
  return L;
}

if (require.main === module) {
  if (!process.argv[2]) { console.log('usage: node tools/expansion-dryrun.js <backup file> [log file]'); process.exit(2); }
  const out = run(process.argv[2]).join('\n') + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], out, { flag: 'wx' });
  process.stdout.write(out);
}
module.exports = { run, implementedExpand };
