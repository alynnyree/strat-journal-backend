'use strict';
// Q-T25 (g) and (i), the dry-run half (Queue plan v14.1 rev 3.2, 5.8.4;
// Deploy 2 plan v2, section 5): the IMPLEMENTED dry run
// (tools/expansion-dryrun.js, which uses the service's own queueOps.js) gives
// the SAME verdict, rule by rule, as the ACCEPTED V-Q7 checker version 4, on
// every one of that checker's 40 fixture cases; it loads no network module and
// makes no store call.
//
// The checker is kept here byte for byte (tests/fixtures/vq7-checker-v4.js,
// SHA-256 pinned below). The fixtures are built from made-up values exactly as
// the checker's own suite builds them (vq7/test/run_fixtures.js, runner
// version 2), in a private temporary folder removed at the end. No owner data
// is involved anywhere.
//
// The other half of Q-T25 (g) -- the dry run's added fields equal what the
// expansion actually COMMITS on a real store, from the same input text -- is
// in tests/gen2-store.js.
const Module = require('module');
const BLOCKED = new Set(['net', 'http', 'https', 'http2', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', '@upstash/redis']);
const origLoad = Module._load;
const blockedTries = [];
Module._load = function (req, ...rest) {
  if (BLOCKED.has(String(req).replace(/^node:/, ''))) { blockedTries.push(req); throw new Error('BLOCKED: tried to load "' + req + '"'); }
  return origLoad.call(this, req, ...rest);
};
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };

const CHECKER = path.join(__dirname, 'fixtures', 'vq7-checker-v4.js');
const CHECKER_SHA256 = '75eb14bf1232be720ed3235a0a7af6d126dfcd49b847bfdbf3aadc7aea8be8ba';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-fixtures-'));

try {
  check('the accepted checker version 4 is byte-identical (SHA-256 pinned)',
    crypto.createHash('sha256').update(fs.readFileSync(CHECKER)).digest('hex') === CHECKER_SHA256);
  const d = require(CHECKER);
  const tool = require(path.join(__dirname, '..', 'tools', 'expansion-dryrun.js'));

  // ---- The fixtures, built exactly as the checker's own suite builds them.
  const clean = () => ({
    openLegs: [{ leg: 1 }],
    pending: [{ id: 't1', fills: ['1', '2'] }, { id: 't2', qid: 'ab', fills: ['3', '4'] }, { id: 't3', fills: ['5', '6'] }],
    lastProcessedIds: ['1', '2'],
    identityCutoverAt: '2026-10-01T00:00:00Z',
    exceptions: {},
    lastSync: {},
    lastBackfill: {},
    weird: 'ü café',
  });
  function backup(value, mut) {
    const keys = { 'other:key': { type: 'string', value: 'x' } };
    if (value !== undefined) keys['trades:state'] = { type: 'string', value };
    const b = { exportedAt: '2026-10-17T00:00:00Z', readOnly: true, keys, excluded: [{ key: 'schwab:tokens', why: 'secret' }], notCopied: [], totals: {} };
    b.totals = { copied: Object.keys(keys).length, excluded: 1, notCopied: 0, bytes: 1 };
    if (mut) mut(b);
    return JSON.stringify(b);
  }
  const write = (name, text) => { const f = path.join(DIR, name + '.json'); fs.writeFileSync(f, text, { flag: 'wx' }); return f; };
  const cases = [];
  const add = (name, file, aFault) => cases.push({ name, file, aFault });
  add('valid document', write('clean', backup(clean())));
  const xf = {
    X1: () => backup([1, 2]),
    X1b: () => backup('stored text that is not JSON'),
    X2: () => backup({ ...clean(), pending: 'no' }),
    X3: () => backup({ ...clean(), pending: [{ fills: [] }] }),
    X4: () => backup({ ...clean(), identityCutoverAt: 'nope' }),
    X4b: () => backup({ ...clean(), exceptions: [1] }),
    X5: () => backup({ ...clean(), queueSeq: 3 }),
  };
  for (const [n, mk] of Object.entries(xf)) add(n + ' broken', write('x_' + n, mk()));
  add('X2+X3+X4+X5 all broken', write('x_multi', backup({ ...clean(), pending: 'no', identityCutoverAt: 'nope', schemaVersion: 2 })));
  add('X3+X5 broken', write('x_multi2', backup({ ...clean(), pending: [{}], queueSeq: 1 })));
  add('X6 over 5,242,880 bytes', write('x_X6', backup({ ...clean(), big: 'a'.repeat(5.1 * 1024 * 1024) })));
  const env = {
    'not JSON': '{oops',
    'readOnly false (E3)': backup(clean(), b => { b.readOnly = false; }),
    'exportedAt missing (E2)': backup(clean(), b => { delete b.exportedAt; }),
    'totals missing (E6)': backup(clean(), b => { delete b.totals; }),
    'copied count wrong (E6)': backup(clean(), b => { b.totals.copied = 5; }),
    'another key not copied (E7)': backup(clean(), b => { b.notCopied.push({ key: 'ledger:x', why: 'too large' }); b.totals.notCopied = 1; }),
    'trades:state not copied (E7)': backup(undefined, b => { b.notCopied.push({ key: 'trades:state', why: 'too large' }); b.totals.notCopied = 1; }),
    'trades:state excluded (E7)': backup(undefined, b => { b.excluded.push({ key: 'trades:state', why: '?' }); b.totals.excluded = 2; }),
    'entry without value (E4)': backup(clean(), b => { delete b.keys['trades:state'].value; }),
    'keys not an object (E4)': backup(clean(), b => { b.keys = []; }),
    'lists missing (E5)': backup(clean(), b => { delete b.notCopied; }),
    'stored as a hash, not text': backup(clean(), b => { b.keys['trades:state'].type = 'hash'; }),
    'trades:state absent from a complete backup': backup(undefined),
  };
  for (const [n, text] of Object.entries(env)) add(n, write('env_' + n.replace(/[^a-z0-9]+/gi, '_'), text));
  const cleanFile = path.join(DIR, 'clean.json');
  const af = {
    A1: e => { e.surprise = 1; },
    A2: e => { e.lastProcessedIds = []; },
    A2b: e => { delete e.weird; },
    A3: e => { e.pending.reverse(); },
    A3b: e => { e.pending[0].qid = 'f'.repeat(32) + '-1'; },
    A4: e => { e.schemaVersion = '2'; },
    A5: e => { e.stateVersion = 0; },
    A6: e => { e.queueEpoch = 'F'.repeat(32); },
    A7: e => { e.queueSeq = 1; },
    A8: e => { e.queueEvents[0].counts.pending = 99; },
    A9: (e, f) => { e.opRecords[f.opId].extra = 1; },
    A10: (e, f) => { e.opRecords[f.opId].committedAt = 1000; },
    A11: (e, f) => { e.opRecords[f.opId].check = '0'.repeat(64); },
    A12: e => { e.prunedThroughVersion = 1; },
    A13: e => { e.removalEnabled = 'false'; },
    A13b: e => { e.pendingStaged = [{ id: 'x' }]; },
  };
  for (const [id, mut] of Object.entries(af)) add(id + ' fault in the expansion', cleanFile, mut);
  check(`40 fixture cases built (${cases.length})`, cases.length === 40);

  // ---- Both, case by case.
  const statusOf = (L, id) => {
    const line = L.find(x => x.trim().startsWith(id + ':'));
    if (!line) return 'ABSENT';
    return /: NOT CHECKED/.test(line) ? 'NOT CHECKED' : /: PASS/.test(line) ? 'PASS' : /: FAIL/.test(line) ? 'FAIL' : '?';
  };
  const category = L => {
    const v = L.find(x => x.startsWith('VERDICT') || x.startsWith('STOP')) || '(none)';
    if (v.includes('ALL CHECKS PASS')) return 'pass';
    if (v.includes('a rule on the stored document')) return 'STOP on the stored document';
    if (v.includes('a check on the expansion')) return 'STOP on the output';
    if (v.startsWith('STOP: the backup') || v.includes('single text value')) return 'STOP on the envelope';
    if (v.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
    return 'other: ' + v;
  };
  const IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', ...Array.from({ length: 13 }, (_, i) => 'A' + (i + 1))];
  const wrapC = mut => (doc, fixed) => { const e = JSON.parse(JSON.stringify(d.expand(doc, fixed))); mut(e, fixed); return e; };
  const wrapT = mut => (doc, fixed) => { const e = JSON.parse(JSON.stringify(tool.implementedExpand(doc, fixed))); mut(e, fixed); return e; };
  const cats = {};
  for (const c of cases) {
    const Lc = d.run(c.file, c.aFault ? { expand: wrapC(c.aFault) } : undefined);
    const Lt = tool.run(c.file, c.aFault ? { expand: wrapT(c.aFault) } : undefined);
    const cc = category(Lc), ct = category(Lt);
    cats[ct] = (cats[ct] || 0) + 1;
    const diff = IDS.filter(id => statusOf(Lc, id) !== statusOf(Lt, id)).map(id => `${id}: checker ${statusOf(Lc, id)}, implemented ${statusOf(Lt, id)}`);
    check(`${c.name}: the same verdict (${ct}) and the same status for every rule`, cc === ct && !diff.length, { checker: cc, implemented: ct, diff });
  }
  console.log('     verdict categories:', JSON.stringify(cats));
  check('the valid document passes in both, and a faulty case never passes', cats.pass === 1);

  // ---- On the valid document: the implemented expansion adds the checker's
  // nine fields with the same values, field for field.
  const doc = clean();
  const fixed = { opId: '0'.repeat(32), at: Date.parse('2026-10-17T00:00:00Z'), candidateEpoch: 'f'.repeat(32) };
  check('the implemented expansion equals the checker\'s, as canonical JSON, on the valid document',
    d.canon(tool.implementedExpand(doc, fixed)) === d.canon(d.expand(doc, fixed)));
  check('...and as the same text, in the same field order', JSON.stringify(tool.implementedExpand(doc, fixed)) === JSON.stringify(d.expand(doc, fixed)));
  check('no network module and no storage client was even asked for while both ran', blockedTries.length === 0, blockedTries);
} catch (e) {
  fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
