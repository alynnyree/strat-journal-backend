// AUDIT STEP E: stepE-compare (tools/stepE-compare.js and its command-line
// tool). Plan approved by the auditor; implementation authorized by the owner
// on 7 October 2026 ("I authorize step E-compare implementation").
// Synthetic data only, from the same ledger fixture as E1's tests. Each case
// asserts PASS or STOP, the rule named, and that the inputs are unchanged; each
// STOP rule is also shown to disappear when that rule is switched off.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 900)); } };
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// ---- 21. it loads nothing but crypto and stepE-prepare.js ----------------------------
const orig = Module._load;
const loaded = [];
Module._load = function (req, parent) {
  if (parent && /tools[\\/]stepE-compare\.js$/.test(parent.filename || '')) loaded.push(req);
  return orig.apply(this, arguments);
};
const C = require('../tools/stepE-compare');
Module._load = orig;
check(`21. it loads only crypto and stepE-prepare.js (${loaded.join(', ')})`,
  loaded.length === 2 && loaded.includes('crypto') && loaded.includes('./stepE-prepare'), loaded);
const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'stepE-compare.js'), 'utf8');
check('21. no clock, network or file access in its code', !/Date\.now\(|new Date\(|require\(['"](fs|http|https|net|axios|child_process)/.test(src));
const E = require('../tools/stepE-prepare');
const TR_SHA = 'aad5d778fb6829f602bcb745eeae7f88103ff3d87fa6bada3b172de3dc4f918e';   // 09e4671
const codeHashes = {
  'stepE-prepare.js': sha256(fs.readFileSync(path.join(__dirname, '..', 'tools', 'stepE-prepare.js'))),
  'tradeRebuild.js': sha256(fs.readFileSync(path.join(__dirname, '..', 'tradeRebuild.js'))),
};
check('tradeRebuild.js is still the approved 09e4671', codeHashes['tradeRebuild.js'] === TR_SHA, codeHashes['tradeRebuild.js']);

// ---- Synthetic ledger and journal (as in tests/stepE-prepare.js) -------------------
const { record, entry } = require('./lib/ledgerFixture');
const backupOf = raws => ({ exportedAt: '2026-10-07T12:00:00.000Z', keys: Object.assign({}, ...raws.map(r => ({ [`ledger:schwab:rec:${r.activityId}`]: { type: 'string', value: entry(r) } }))) });
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ny = iso => { const p = {}; for (const x of NY.formatToParts(Date.parse(iso.replace(/\+0000$/, 'Z')))) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
function live(id, o, c, qty, extra) {
  const ol = o.transferItems[0], cl = c.transferItems[0];
  const e = ny(o.tradeDate), x = ny(c.tradeDate);
  const pnl = Math.round((cl.price - ol.price) * 100 * qty * 100) / 100;
  return Object.assign({
    id, source: 'schwab-auto', fills: [String(o.activityId), String(c.activityId)],
    ticker: ol.instrument.underlyingSymbol, occ: ol.instrument.symbol, dir: ol.instrument.putCall === 'CALL' ? 'Long' : 'Short',
    contracts: qty, contractsOpened: Math.abs(ol.amount), closeQuantity: Math.abs(cl.amount), fillStatus: 'Closed',
    entryDate: e.date, entryTime: e.time, entryTimestamp: Date.parse(o.tradeDate.replace(/\+0000$/, 'Z')),
    exitDate: x.date, exitTime: x.time, exitTimestamp: Date.parse(c.tradeDate.replace(/\+0000$/, 'Z')),
    optEntry: ol.price, optExit: cl.price, pnlDollar: pnl, pnlPercent: 0, entryFees: 0.66, exitFees: 0.66, fees: 1.32, pnlNet: Math.round((pnl - 1.32) * 100) / 100,
    winLoss: pnl >= 0 ? 'Win' : 'Loss', notes: '', shotEntry: null, shotMid: null, shotExit: null, chartDrawings: [],
    strat: '2-1-2 Continuation', stratConfidence: 'high', play: null, ftfc: { '5m': 'bullish' }, ftfcConfirmed: false,
    undEntry: 600.1, undEntrySource: 'alpaca', undExit: 600.5, undExitSource: 'alpaca', stop: 599.5, stopAuto: true,
    replayData: { candles: [1, 2, 3] }, settled: true, fillAttempts: 1,
  }, extra || {});
}
function csvCopy(id, o, c, qty) {
  const t = live(id, o, c, qty);
  return Object.assign(t, { source: 'schwab-csv', fills: [`csv|${t.entryDate}|${t.occ}|B|${qty}|${t.optEntry}|#1`, `csv|${t.exitDate}|${t.occ}|S|${qty}|${t.optExit}|#1`],
    entryTime: null, exitTime: null, entryTimestamp: null, exitTimestamp: null, replayData: null, undEntry: null, undExit: null, stop: null });
}
const at = (d, hm) => `${d}T${hm}:00+0000`;
const D = '2026-06-01';
const P1 = record({ id: 5001, at: at(D, '13:31'), buy: true, price: 1.00 });
const S1 = record({ id: 5002, at: at(D, '13:40'), buy: false, price: 1.20 });
const A = record({ id: 6001, at: at(D, '14:00'), buy: true, price: 0.80 });
const B = record({ id: 6002, at: at(D, '14:01'), buy: true, price: 0.90 });
const Cc = record({ id: 6003, at: at(D, '14:05'), buy: false, price: 1.00 });
const Dd = record({ id: 6004, at: at(D, '14:06'), buy: false, price: 1.10 });
const T1 = record({ id: 7001, at: at(D, '15:00'), buy: true, price: 0.50 });
const T2 = record({ id: 7002, at: at(D, '15:00'), buy: true, price: 0.50 });
const U1 = record({ id: 7003, at: at(D, '15:05'), buy: false, price: 0.60 });
const U2 = record({ id: 7004, at: at(D, '15:05'), buy: false, price: 0.60 });
const LONE = record({ id: 4003, at: at('2026-06-02', '13:35'), buy: false, price: 1.10, exp: '2026-06-10' });   // a sale with no purchase: an exception
const RAWS = [P1, S1, A, B, Cc, Dd, T1, T2, U1, U2, LONE];
// X0: fifo-v1 re-pairs A+D / B+C into A+C / B+D (the note on A+D moves to A+C,
// the approved transfer), and adds the twin T2+U2.
const X0 = [live('j-plain', P1, S1, 1), live('j-ad', A, Dd, 1, { notes: 'A note' }), live('j-bc', B, Cc, 1), live('j-t1', T1, U1, 1)];
const B0 = backupOf(RAWS);
const REF = { name: 'test reference', window: { from: D, to: '2026-06-02' }, expect: null };
// The reference is what the ledger itself says for the window (as Schwab's file
// did for the real run), taken once from E1 and then fixed.
{
  const r = E.prepare({ journal: X0, backup: B0, reference: { name: 'x', window: REF.window, expect: { contracts: -1, grossCents: 0, feeCents: 0, netCents: 0 } } });
  const m = /= (\d+) contracts, (-?)\$([\d.]+) gross, \$([\d.]+) fees, (-?)\$([\d.]+) net; Schwab/.exec(r.log);
  const c = (s, v) => Math.round(Number(v) * 100) * (s ? -1 : 1);
  REF.expect = { contracts: Number(m[1]), grossCents: c(m[2], m[3]), feeCents: c('', m[4]), netCents: c(m[5], m[6]) };
}
const bytes = v => Buffer.from(JSON.stringify(v), 'utf8');
const X0B = bytes(X0), B0B = bytes(B0);
const R0 = E.prepare({ journal: X0, backup: B0, reference: REF });
check('the base scenario prepares without a stop, with one transfer and one exception', !R0.stopped && /his data moved 1\./.test(R0.log) && /close without open/.test(R0.log), R0.stops);
const APPROVAL = {
  kind: C.KIND_APPROVAL, x0Fingerprint: E.journalFingerprint(X0), p0Fingerprint: R0.prepared.fingerprint, l0Sha256: sha256(R0.log),
  b0Sha256: sha256(B0B), rangeStart: D, reference: REF, code: codeHashes,
};
const APPROVAL_B = bytes(APPROVAL);
// P_n exactly as the unchanged stepE-cli.js writes it, with the range given.
const pnOf = (xn, b0) => { const r = E.prepare({ journal: xn, backup: b0 || B0, rangeStart: D, reference: REF }); return r.stopped ? Buffer.from('null') : bytes(r.prepared); };
function run(xn, o) {
  o = o || {};
  const xnB = o.xnBytes || bytes(xn);
  const ins = { approval: JSON.parse(JSON.stringify(o.approval || APPROVAL)), approvalBytes: o.approvalBytes || APPROVAL_B, x0Bytes: X0B, b0Bytes: o.b0Bytes || B0B, xnBytes: xnB, pnBytes: o.pnBytes || pnOf(xn), codeHashes: o.codeHashes || codeHashes };
  const before = [ins.x0Bytes, ins.b0Bytes, ins.xnBytes, ins.pnBytes].map(sha256).join() + JSON.stringify(ins.approval);
  const r = C.compare(ins);
  r.inputsUnchanged = [ins.x0Bytes, ins.b0Bytes, ins.xnBytes, ins.pnBytes].map(sha256).join() + JSON.stringify(ins.approval) === before;
  r.rules = [...new Set(r.stops.map(s => s.rule))].sort();
  return r;
}
const stopsWith = (r, rule) => r.stops.filter(s => s.rule === rule);
const copy = v => JSON.parse(JSON.stringify(v));
// A case that must STOP under `rule`; then the same case with that rule
// switched off must not report it (the check depends on that rule).
const disabledShown = {};
function mustStop(name, xn, rule, o, more) {
  const r = run(xn, o);
  check(`${name}: STOP under ${rule}, inputs unchanged`, r.result === 'STOP' && stopsWith(r, rule).length > 0 && r.inputsUnchanged, { rules: r.rules, stops: r.stops.slice(0, 4) });
  if (more) more(r);
  const keep = C.RULES[rule];
  C.RULES[rule] = () => {};
  const off = run(xn, o);
  C.RULES[rule] = keep;
  check(`${name}: with ${rule} switched off, no ${rule} STOP is reported`, stopsWith(off, rule).length === 0, off.rules);
  disabledShown[rule] = true;
  return r;
}

console.log('\n--- 1. X_n = X0: PASS, P_n = P0 byte for byte ---');
const R1 = run(copy(X0));
check('PASS', R1.result === 'PASS', R1.stops);
check('P_n is byte-identical to P0', Buffer.compare(pnOf(copy(X0)), bytes(R0.prepared)) === 0);
check('the report names the approved transfer and the result', /RESULT: PASS/.test(R1.report) && /MOVED his data from removed j-ad to T:/.test(R1.report) && /STOPS \(0\)/.test(R1.report));
check('inputs unchanged', R1.inputsUnchanged);

console.log('\n--- 2. a machine fact changed on a kept trade: PASS, listed under C8 ---');
{
  const xn = copy(X0); xn.find(t => t.id === 'j-plain').undEntry = 601.25;
  const r = run(xn);
  check('PASS', r.result === 'PASS', r.stops);
  check('listed under C8 with both values', /MACHINE FACTS THAT DIFFER \(C8, listed, never blocking\) \(1\)\n {2}j-plain \(T:[0-9a-f]{24}\) undEntry: 600\.1 -> 601\.25/.test(r.report), r.report.split('MACHINE')[1]);
}

console.log('\n--- 3 and 4. a new genuine twin: PASS; its own note stays on it ---');
{
  const r = run([...copy(X0), live('j-t2', T2, U2, 1)]);
  check('3. without owner data: PASS, listed as a C5 trade kept on its own fills', r.result === 'PASS' && /j-t2: KEPT on its own fills 7002\+7004/.test(r.report), r.stops);
  const xn = [...copy(X0), live('j-t2', T2, U2, 1, { notes: 'twin note' })];
  const r2 = run(xn);
  check('4. with its own note: PASS', r2.result === 'PASS', r2.stops);
  const pn = JSON.parse(pnOf(xn).toString());
  check('4. the note stays on the new trade, under its own id', pn.trades.find(t => t.id === 'j-t2').notes === 'twin note' && /its own data stays: notes/.test(r2.report));
}

console.log('\n--- 5 and 6. a new copy of an existing pair ---');
{
  const r = run([...copy(X0), live('j-plain-copy', P1, S1, 1)]);
  check('5. no owner data: PASS, removed as the same broker pair saved again', r.result === 'PASS' && /j-plain-copy: REMOVED, the same broker pair saved again/.test(r.report), r.stops);
  mustStop('6. with owner data', [...copy(X0), live('j-plain-copy', P1, S1, 1, { notes: 'mine' })], 'C5');
  mustStop('6b. a new copy that would be kept in place of the X0 trade', [...copy(X0), live('j-a-plain', P1, S1, 1)], 'C4');
}

console.log('\n--- 7 and 8. a new file copy; a new live trade paired differently ---');
mustStop('7. a new file copy', [...copy(X0), csvCopy('c-new', T1, U1, 1)], 'C5');
mustStop('8. a new live trade paired differently', [...copy(X0), live('j-new', T2, U1, 1)], 'C5');

console.log('\n--- 9. an X0 trade deleted ---');
mustStop('9. j-t1 deleted', copy(X0).filter(t => t.id !== 'j-t1'), 'C6');

console.log('\n--- 10, 11, 12. owner data ---');
{
  const xn = copy(X0); xn.find(t => t.id === 'j-plain').notes = 'edited';
  mustStop('10. a note edited on an X0 trade', xn, 'C7');
}
mustStop('11. a transfer TO a new trade', [...copy(X0), live('j-ac', A, Cc, 1)], 'C7', null,
  r => check('11. it says the new trade would receive his data', r.stops.some(s => s.rule === 'C7' && /RECEIVE/.test(s.text)), r.stops));
mustStop('12. a transfer FROM a new trade', [...copy(X0), live('j-new2', T2, U1, 1, { notes: 'n' })], 'C7', null,
  r => check('12. it says the new trade would give his data', r.stops.some(s => s.rule === 'C7' && /GIVE/.test(s.text)), r.stops));

console.log('\n--- 13-16. the approved ledger, code, range and reference ---');
mustStop('13. B0 altered (one more record)', copy(X0), 'C1', { b0Bytes: bytes(backupOf([...RAWS, record({ id: 9101, at: at(D, '19:00'), buy: true, price: 1.00 })])) });
mustStop('14. a wrong code hash', copy(X0), 'C1', { codeHashes: Object.assign({}, codeHashes, { 'stepE-prepare.js': '0'.repeat(64) }) });
mustStop('15. a different range', copy(X0), 'C1', { approval: Object.assign({}, APPROVAL, { rangeStart: '2026-05-31' }) });
mustStop('16. a different reference (same figures, another name)', copy(X0), 'C1', { approval: Object.assign({}, APPROVAL, { reference: Object.assign({}, REF, { name: 'another file' }) }) });

console.log('\n--- 17, 18. the P_n file ---');
{
  const p = JSON.parse(pnOf(copy(X0)).toString());
  p.trades.find(t => t.id === 'j-plain').fees = Math.round((p.trades.find(t => t.id === 'j-plain').fees + 0.01) * 100) / 100;
  mustStop('17. P_n altered by one cent', copy(X0), 'FILE', { pnBytes: bytes(p) });
  mustStop('18. P_n made from a different X_n', [...copy(X0), live('j-t2', T2, U2, 1)], 'FILE', { pnBytes: pnOf(copy(X0)) });
}

console.log('\n--- 19. E1 stops on X_n ---');
{
  const ghostO = record({ id: 9901, at: at(D, '18:00'), buy: true, price: 1.00 }), ghostC = record({ id: 9902, at: at(D, '18:05'), buy: false, price: 1.10 });
  mustStop('19. a trade the ledger does not cover', [...copy(X0), live('j-ghost', ghostO, ghostC, 1)], 'C9');
}

console.log('\n--- C2 and C3, by a fault put into E1\'s result (the same ledger cannot produce one) ---');
function withFault(fault, fn) {
  const real = E.prepare;
  E.prepare = args => {
    const r = real(args);
    if (args.rangeStart && args.journal[0] && args.journal[0].id !== 'stepE-compare-class-probe' && !r.stopped) fault(r);
    return r;
  };
  try { return fn(); } finally { E.prepare = real; }
}
withFault(r => { r.log = r.log.replace(/(close without open: \S+ +\S+ )(\S+)/, '$12026-06-02T13:36:00.000Z'); }, () => {
  mustStop('C2. an exception that differs in its detail only (same count, same totals)', copy(X0), 'C2', { pnBytes: pnOf(copy(X0)) });
});
withFault(r => { r.prepared.trades.find(t => t.id === 'j-plain').fees = 9.99; }, () => {
  const pn = pnOf(copy(X0));
  const r = mustStop('C3/C8. a broker fact (fees) that differs', copy(X0), 'C3', { pnBytes: pn });
  check('C8 never lists a broker fact', !/j-plain fees:/.test(r.report.split('MACHINE FACTS')[1]), r.report.split('MACHINE FACTS')[1]);
});

console.log('\n--- 20. the same inputs in a different order: a byte-identical report ---');
{
  const r = run(copy(X0).reverse());
  check('X_n in reverse order gives the same report, byte for byte', r.report === R1.report);
  const xn = [...copy(X0), live('j-t2', T2, U2, 1)];
  check('and with a new trade too', run(xn).report === run(xn.slice().reverse()).report);
}

console.log('\n--- every STOP rule was shown to depend on its own check ---');
for (const rule of ['C1', 'FILE', 'C9', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) check(`${rule}: shown`, !!disabledShown[rule]);

console.log('\n--- 22. the command-line tool: inputs read-only, only the report written ---');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepE-compare-'));
  const put = (n, b) => { fs.writeFileSync(path.join(dir, n), b); return path.join(dir, n); };
  const files = [put('approval.json', APPROVAL_B), put('x0.json', X0B), put('b0.json', B0B), put('xn.json', bytes(copy(X0))), put('pn.json', pnOf(copy(X0)))];
  const before = files.map(f => sha256(fs.readFileSync(f)) + fs.statSync(f).mtimeMs).join();
  const cli = path.join(__dirname, '..', 'tools', 'stepE-compare-cli.js');
  const report = path.join(dir, 'report.txt');
  const a = spawnSync(process.execPath, [cli, ...files, report], { encoding: 'utf8' });
  check('exit 0 (PASS) and the report is written', a.status === 0 && fs.existsSync(report) && /RESULT: PASS/.test(fs.readFileSync(report, 'utf8')), [a.status, a.stdout, a.stderr]);
  check('the inputs are unchanged', files.map(f => sha256(fs.readFileSync(f)) + fs.statSync(f).mtimeMs).join() === before);
  check('nothing else was written', fs.readdirSync(dir).sort().join() === ['approval.json', 'b0.json', 'pn.json', 'report.txt', 'x0.json', 'xn.json'].join());
  const kept = fs.readFileSync(report, 'utf8');
  const b = spawnSync(process.execPath, [cli, ...files, report], { encoding: 'utf8' });
  check('it refuses to write over an existing report', b.status === 2 && fs.readFileSync(report, 'utf8') === kept, [b.status, b.stdout]);
  const c = spawnSync(process.execPath, [cli, ...files, files[4]], { encoding: 'utf8' });
  check('it refuses to write the report over an input', c.status === 2 && sha256(fs.readFileSync(files[4])) === sha256(pnOf(copy(X0))), [c.status, c.stdout]);
  const p = JSON.parse(pnOf(copy(X0)).toString()); p.trades[0].fees += 0.01;
  fs.writeFileSync(files[4], bytes(p));
  const d = spawnSync(process.execPath, [cli, ...files, path.join(dir, 'report2.txt')], { encoding: 'utf8' });
  check('a STOP exits 1, with the report written', d.status === 1 && /RESULT: STOP/.test(fs.readFileSync(path.join(dir, 'report2.txt'), 'utf8')), [d.status, d.stdout, d.stderr]);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
