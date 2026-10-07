// AUDIT STEP E, part E1: the offline preparation tool (tools/stepE-prepare.js).
// Authorized by the owner on 7 October 2026 ("I authorize Step E
// implementation"); plan v7, accepted by the auditor. Synthetic data only.
//
// The cases are the plan's E1 tests 1-12, 5b and 5c.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 600)); } };

// ---- 10. it loads nothing but crypto and tradeRebuild.js ------------------------
const orig = Module._load;
const loaded = [];
Module._load = function (req, parent) {
  if (parent && /tools[\\/]stepE-prepare\.js$/.test(parent.filename || '')) loaded.push(req);
  return orig.apply(this, arguments);
};
const E = require('../tools/stepE-prepare');
Module._load = orig;
check(`10. the tool loads only crypto and tradeRebuild.js (${loaded.join(', ')})`,
  loaded.length === 2 && loaded.includes('crypto') && loaded.includes('../tradeRebuild'), loaded);
const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'stepE-prepare.js'), 'utf8');
check('10. no clock, network or file access in its code', !/Date\.now\(|new Date\(\)|require\(['"](fs|http|https|net|axios)/.test(src));

// ---- 11. tradeRebuild.js is byte-identical to 09e4671 ----------------------------
const TR_SHA = 'aad5d778fb6829f602bcb745eeae7f88103ff3d87fa6bada3b172de3dc4f918e';   // git show 09e4671:tradeRebuild.js | sha256sum
const trNow = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'tradeRebuild.js'))).digest('hex');
check('11. tradeRebuild.js equals the approved 09e4671', trNow === TR_SHA, trNow);

const { record, entry } = require('./lib/ledgerFixture');
const backupOf = (raws, extraKeys) => ({
  exportedAt: '2026-10-07T12:00:00.000Z',
  keys: Object.assign({}, ...raws.map(r => ({ [`ledger:schwab:rec:${r.activityId}`]: { type: 'string', value: entry(r) } })), extraKeys || {}),
});
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ny = iso => { const p = {}; for (const x of NY.formatToParts(new Date(iso.replace(/\+0000$/, 'Z')))) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
// A journal trade as the live connection leaves one.
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
// A copy read from the broker file: invented references, no times.
function csvCopy(id, o, c, qty, extra) {
  const t = live(id, o, c, qty, extra);
  return Object.assign(t, { source: 'schwab-csv', fills: [`csv|${t.entryDate}|${t.occ}|B|${qty}|${t.optEntry}|#1`, `csv|${t.exitDate}|${t.occ}|S|${qty}|${t.optExit}|#1`],
    entryTime: null, exitTime: null, entryTimestamp: null, exitTimestamp: null, strat: null, stratConfidence: null, replayData: null, ftfc: {}, undEntry: null, undExit: null, stop: null }, extra || {});
}
const at = (d, hm, s = '00') => `${d}T${hm}:${s}+0000`;     // UTC

// ---- The base scenario --------------------------------------------------------
// June, SPY 740C:
//   P1 buy 1 @1.00 13:31   S1 sell 1 @1.20 13:40           (one plain trade)
//   A buy 1 @0.80 14:00, B buy 1 @0.90 14:01, C sell 1 @1.00 14:05, D sell 1 @1.10 14:06
//      fifo pairs A+C and B+D.
//   Twins: T1 buy 1 @0.50 15:00:00 id 7001, T2 buy 1 @0.50 15:00:00 id 7002,
//          U1 sell 1 @0.60 15:05:00 id 7003, U2 sell 1 @0.60 15:05:00 id 7004
//      fifo pairs 7001+7003 and 7002+7004 -- identical shapes, different fills.
const D = '2026-06-01';
const P1 = record({ id: 5001, at: at(D, '13:31'), buy: true, price: 1.00 });
const S1 = record({ id: 5002, at: at(D, '13:40'), buy: false, price: 1.20 });
const A = record({ id: 6001, at: at(D, '14:00'), buy: true, price: 0.80 });
const B = record({ id: 6002, at: at(D, '14:01'), buy: true, price: 0.90 });
const C = record({ id: 6003, at: at(D, '14:05'), buy: false, price: 1.00 });
const Dd = record({ id: 6004, at: at(D, '14:06'), buy: false, price: 1.10 });
const T1 = record({ id: 7001, at: at(D, '15:00'), buy: true, price: 0.50 });
const T2 = record({ id: 7002, at: at(D, '15:00'), buy: true, price: 0.50 });
const U1 = record({ id: 7003, at: at(D, '15:05'), buy: false, price: 0.60 });
const U2 = record({ id: 7004, at: at(D, '15:05'), buy: false, price: 0.60 });
const RAWS = [P1, S1, A, B, C, Dd, T1, T2, U1, U2];
const run = (journal, raws, opts) => {
  const j = JSON.parse(JSON.stringify(journal)), b = backupOf(raws || RAWS);
  const jBefore = JSON.stringify(j), bBefore = JSON.stringify(b);
  const r = E.prepare(Object.assign({ journal: j, backup: b }, opts || {}));
  r.inputsUnchanged = JSON.stringify(j) === jBefore && JSON.stringify(b) === bBefore;
  return r;
};
const byId = (r, id) => r.prepared && r.prepared.trades.find(t => String(t.id) === String(id));
const ledgerId = (r, o, c) => r.prepared && r.prepared.trades.find(t => t.stepE && t.stepE.openFillId === `F:${o.activityId}:1` && t.stepE.closeFillId === `F:${c.activityId}:1`);

console.log('--- 1. same pair: kept, his fields intact, broker facts from the ledger ---');
{
  const j = [live('j-plain', P1, S1, 1, { notes: 'my note', fees: 1.33, pnlNet: 18.67 }),
    live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j);
  check('not stopped', !r.stopped, r.stops);
  const t = byId(r, 'j-plain');
  check('the trade keeps its id and his note', t && t.notes === 'my note');
  check(`its fee comes from the ledger (${t && t.fees})`, t && t.fees === 1.32 && t.pnlNet === 18.68);
  check('the change is logged with both values', /KEPT j-plain .*fees: 1\.33 -> 1\.32/.test(r.log));
  check('every trade is kept, none added or removed', /KEPT 5, ADDED 0, REMOVED 0/.test(r.log), r.log.split('\n').slice(0, 9));
  check('its machine facts stay (replay)', t && t.replayData && t.replayData.candles.length === 3);
}

console.log('\n--- 2. a file copy is removed, with its reason ---');
{
  const j = [live('j-plain', P1, S1, 1), csvCopy('c-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j);
  check('not stopped', !r.stopped, r.stops);
  check('the copy is gone', !byId(r, 'c-plain'));
  check('removed with its reason', /REMOVED c-plain .*copy read from the broker file/.test(r.log));
}

console.log('\n--- 3. a lost twin (D2) is added ---');
{
  const j = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1)];
  const r = run(j);
  check('not stopped', !r.stopped, r.stops);
  const twin = ledgerId(r, T2, U2);
  check('the twin with the same shape but its own fills is added', twin && twin.fills.join('+') === '7002+7004');
  check('its id is the ledger trade id', twin && /^T:[0-9a-f]{24}$/.test(twin.id));
  check('the journal grows from 4 to 5', r.prepared && r.prepared.trades.length === 5);
}

console.log('\n--- 4. a re-paired trade is replaced; facts carried by FILL; replay blank ---');
{
  // The journal paired A+D and B+C; fifo-v1 pairs A+C and B+D.
  const j = [live('j-plain', P1, S1, 1), live('j-ad', A, Dd, 1, { ftfc: { '5m': 'from A' }, undExit: 601.1 }), live('j-bc', B, C, 1, { ftfc: { '5m': 'from B' }, undExit: 602.2 }),
    live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j);
  check('not stopped', !r.stopped, r.stops);
  check('both old pairings removed', !byId(r, 'j-ad') && !byId(r, 'j-bc') && /REMOVED j-ad .*paired differently/.test(r.log));
  const ac = ledgerId(r, A, C), bd = ledgerId(r, B, Dd);
  check('A+C and B+D added', !!ac && !!bd);
  check(`A+C takes the purchase facts of A (${ac && ac.ftfc['5m']}) and the sale facts of C (${ac && ac.undExit})`, ac && ac.ftfc['5m'] === 'from A' && ac.undExit === 602.2);
  check(`B+D takes B's purchase facts and D's sale facts`, bd && bd.ftfc['5m'] === 'from B' && bd.undExit === 601.1);
  check('no replay is carried to a new pair', ac && ac.replayData == null && bd.replayData == null && /replay: never carried/.test(r.log));
}

console.log('\n--- 5. his data moves only to the ONE trade citing the same purchase ---');
{
  const j = [live('j-plain', P1, S1, 1), live('j-ad', A, Dd, 1, { notes: 'A note' }), live('j-bc', B, C, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j);
  check('not stopped', !r.stopped, r.stops);
  const ac = ledgerId(r, A, C);
  check('the note on A+D moves to A+C (same purchase A)', ac && ac.notes === 'A note');
  check('the move is logged', /MOVED his data from removed j-ad to .* by opening fill 6001: notes/.test(r.log));
  // Ambiguous: a purchase of 2 sold in two pieces.
  const Q = record({ id: 8001, at: at(D, '16:00'), buy: true, qty: 2, price: 1.00 });
  const Q1 = record({ id: 8002, at: at(D, '16:05'), buy: false, qty: 1, price: 1.10 });
  const Q2 = record({ id: 8003, at: at(D, '16:06'), buy: false, qty: 1, price: 1.20 });
  const Z = record({ id: 8004, at: at(D, '16:07'), buy: false, qty: 1, price: 1.30 });   // a sale of another lot below
  const Zb = record({ id: 8005, at: at(D, '15:59'), buy: true, qty: 1, price: 1.00 });
  const raws = [...RAWS, Q, Q1, Q2, Zb, Z];
  const base = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  // fifo: Zb(15:59)+Q1, Q+Q2(1), Q+Z(1). The journal's (Q, Q1) pairing is gone; Q now feeds two rebuilt trades.
  const r2 = run([...base, live('j-q', Q, Q1, 1, { notes: 'which one?' })], raws);
  check('two rebuilt trades cite that purchase: STOP', r2.stopped && r2.stops.some(s => s.code === 'owner-data-no-single-destination'), r2.stops);
  check('no prepared journal', !r2.prepared);
  const r3 = run([...base.filter(t => t.id !== 'j-ac'), live('j-ad', A, Dd, 1, { shotEntry: 'data:image/png;base64,AAAA' })]);
  check('a picture never moves: STOP', r3.stopped && r3.stops.some(s => s.code === 'owner-data-picture'), r3.stops);
}

console.log('\n--- 5b. his data on a file copy with no genuine purchase fill: STOP ---');
{
  const base = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1)];
  // T2+U2 has the IDENTICAL shape of the file copy below; nothing may move to it.
  const kinds = {
    'a hand-set field (userSet)': { userSet: { stop: true }, stop: 598.25 },
    'notes': { notes: 'a lesson' },
    'a picture mark': { shotExit: 'data:image/png;base64,BBBB' },
    'chart drawings': { chartDrawings: [{ type: 'hline', price: 600 }] },
    'his formation toggle': { offBroadeningFormation: true },
    'his planned R:R': { rrPlanned: 2 },
    'his own setup tag (no AI confidence)': { strat: '2-2 Reversal', stratConfidence: null },
    'an unknown field': { myRating: 4 },
  };
  for (const [name, extra] of Object.entries(kinds)) {
    const r = run([...base, csvCopy('c-t2', T2, U2, 1, extra)]);
    const s = r.stops.find(x => x.code === 'owner-data-no-genuine-fill');
    check(`${name}: STOP, no prepared journal, inputs unchanged, says why`,
      r.stopped && !r.prepared && !r.restore && r.inputsUnchanged && !!s && /no valid fill-identity destination/.test(s.text) && /c-t2/.test(s.text), r.stops);
    check(`${name}: nothing is moved to the look-alike rebuilt trade`, !/^MOVED/m.test(r.log));
  }
}

console.log('\n--- 5c. two removed trades, one destination: STOP whatever the values ---');
{
  // The journal paired A+D and A+... cannot happen with a 1-lot A, so use the
  // purchase X of 1 that the journal holds twice under different sales (two
  // stale copies), both carrying his data. fifo pairs X+Y.
  const X = record({ id: 9001, at: at(D, '17:00'), buy: true, price: 1.00 });
  const Y = record({ id: 9002, at: at(D, '17:05'), buy: false, price: 1.10 });
  const W = record({ id: 9003, at: at(D, '17:06'), buy: false, price: 1.20 });
  const V = record({ id: 9004, at: at(D, '17:04'), buy: true, price: 1.00 });  // V+W
  const raws = [...RAWS, X, Y, W, V];
  const base = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1), live('j-vw', V, W, 1)];
  const diff = run([...base, live('j-x1', X, W, 1, { notes: 'first' }), live('j-x2', X, Dd, 1, { notes: 'second' })], raws);
  const col = diff.stops.find(s => s.code === 'destination-collision');
  check('different values: STOP', diff.stopped && !!col, diff.stops);
  check('it names both sources, the destination and the fields', col && /j-x1/.test(col.text) && /j-x2/.test(col.text) && /T:[0-9a-f]{24}/.test(col.text) && /notes/.test(col.text));
  check('no prepared journal, inputs unchanged, nothing moved', !diff.prepared && diff.inputsUnchanged && !/^MOVED/m.test(diff.log));
  const same = run([...base, live('j-x1', X, W, 1, { notes: 'same' }), live('j-x2', X, Dd, 1, { notes: 'same' })], raws);
  check('identical values: STOP as well', same.stopped && same.stops.some(s => s.code === 'destination-collision'), same.stops);
  const keptOwn = run([...base, live('j-xy', X, Y, 1, { notes: 'kept note' }), live('j-x1', X, W, 1, { notes: 'moving note' })], raws);
  check('destination is a kept trade with his own note: STOP', keptOwn.stopped && keptOwn.stops.some(s => s.code === 'destination-collision' && /already carries his data/.test(s.text)), keptOwn.stops);
  const control = run([...base, live('j-x1', X, W, 1, { notes: 'only one' })], raws);
  const xy = ledgerId(control, X, Y);
  check('control: one source, destination has none: it moves', !control.stopped && xy && xy.notes === 'only one', control.stops);
}

console.log('\n--- 6. range applied; exceptions listed ---');
{
  const may = record({ id: 4001, at: at('2026-05-20', '13:31'), buy: true, price: 1.00 });
  const mayS = record({ id: 4002, at: at('2026-05-20', '13:35'), buy: false, price: 1.10 });
  const lone = record({ id: 4003, at: at('2026-06-02', '13:35'), buy: false, price: 1.10, exp: '2026-06-10' });   // a sale with no purchase
  const j = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j, [...RAWS, may, mayS, lone]);
  check('not stopped', !r.stopped, r.stops);
  check('a trade closed before the range (20 May) is not added', !ledgerId(r, may, mayS));
  check('the range is the earliest close in the journal', /closing on or after 2026-06-01 \(the earliest close/.test(r.log));
  check('the sale with no purchase is listed as an exception', /close without open: SPY {3}260610C00740000/.test(r.log));
  const early = live('j-may', may, mayS, 1);
  const r2 = run([...j, early], [...RAWS, may, mayS], { rangeStart: '2026-06-01' });
  check('with a given range, a journal trade before it is untouched', !r2.stopped && byId(r2, 'j-may') && /UNTOUCHED \(before range\) j-may/.test(r2.log), r2.stops);
}

console.log('\n--- 7. a midnight-dated sale stays an exception ---');
{
  const buy = record({ id: 4101, at: at(D, '13:42', '25'), buy: true, price: 1.00, exp: '2026-06-05' });
  const sell = record({ id: 4102, at: at(D, '13:45', '09'), buy: false, price: 1.22, exp: '2026-06-05', tradeDate: `${D}T04:00:00+0000` });
  const j = [live('j-plain', P1, S1, 1), live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run(j, [...RAWS, buy, sell]);
  check('not stopped', !r.stopped, r.stops);
  check('no trade pairs them (time is never used for tradeDate)', !ledgerId(r, buy, sell));
  check('the sale is listed as a close without open', /close without open: SPY {3}260605C00740000 2026-06-01T04:00:00\.000Z/.test(r.log));
  check('the purchase is listed as still open past or before expiry', /(open past expiry|still open): SPY {3}260605C00740000/.test(r.log));
}

console.log('\n--- 8. ledger faults, multi-line records and an uncovered trade: STOP ---');
{
  const j = [live('j-plain', P1, S1, 1)];
  const b = JSON.parse(JSON.stringify(backupOf(RAWS)));
  b.keys['ledger:schwab:rec:5001'].value.raw.transferItems[0].price = 9.99;     // content no longer matches its fingerprint
  const r = E.prepare({ journal: j, backup: b });
  check('fingerprint mismatch: STOP', r.stopped && r.stops.some(s => s.code === 'ledger-input-problem'), r.stops);
  const Rb = require('../tradeRebuild');
  const real = Rb.rebuild;
  Rb.rebuild = (...args) => { const x = real(...args); x.reconstruction.conservation.feesBalance = false; return x; };
  const r2 = run([live('j-plain', P1, S1, 1)]);
  Rb.rebuild = real;
  check('conservation failure: STOP', r2.stopped && r2.stops.some(s => s.code === 'ledger-conservation'), r2.stops);
  const two = record({ id: 4201, at: at(D, '18:00'), buy: true, price: 1.00 });
  two.transferItems.splice(1, 0, JSON.parse(JSON.stringify(two.transferItems[0])));    // two option lines
  two.transferItems[1].instrument.symbol = 'SPY   260609P00740000'; two.transferItems[1].instrument.putCall = 'PUT';
  two.netAmount = Math.round((two.netAmount - 100) * 100) / 100;
  const twoS = record({ id: 4202, at: at(D, '18:05'), buy: false, price: 1.10 });
  const r3 = run([live('j-plain', P1, S1, 1)], [...RAWS, two, twoS]);
  check('a record with two option lines in range: STOP', r3.stopped && r3.stops.some(s => s.code === 'multi-line-record'), r3.stops);
  const extra = record({ id: 4301, at: at(D, '19:00'), buy: true, price: 1.00 });
  const extraS = record({ id: 4302, at: at(D, '19:05'), buy: false, price: 1.10 });
  const r4 = run([live('j-plain', P1, S1, 1), live('j-new', extra, extraS, 1)]);   // the ledger lacks 4301/4302
  check('a live trade the ledger does not cover: STOP', r4.stopped && r4.stops.some(s => s.code === 'ledger-does-not-cover'), r4.stops);
  const r5 = run([live('j-plain', P1, S1, 1)], RAWS, { reference: { name: 'test file', window: { from: D, to: D }, expect: { contracts: 999, grossCents: 0, feeCents: 0, netCents: 0 } } });
  check('the outside reference disagrees: STOP', r5.stopped && r5.stops.some(s => s.code === 'reference-mismatch'), r5.stops);
}

console.log('\n--- 9. the same inputs in any order give byte-identical outputs ---');
{
  const j = [live('j-plain', P1, S1, 1), csvCopy('c-plain', P1, S1, 1), live('j-ad', A, Dd, 1), live('j-bc', B, C, 1), live('j-t1', T1, U1, 1)];
  const a = run(j);
  const b = run(j.slice().reverse(), RAWS.slice().reverse());
  check('not stopped', !a.stopped && !b.stopped, [a.stops, b.stops]);
  check('prepared journals identical', JSON.stringify(a.prepared) === JSON.stringify(b.prepared));
  check('logs identical except the journal listing order', a.prepared && a.prepared.fingerprint === b.prepared.fingerprint && a.prepared.checksum === b.prepared.checksum);
  check('the restore file holds the journal exactly', a.restore && a.restore.fingerprint === E.journalFingerprint(j) && a.prepared.basedOn === a.restore.fingerprint);
}

console.log('\n--- 12. hand corrections are never overwritten or copied ---');
{
  const base = [live('j-ac', A, C, 1), live('j-bd', B, Dd, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)];
  const r = run([...base, live('j-plain', P1, S1, 1, { optEntry: 0.95, userSet: { optEntry: true } })]);
  check('a hand-corrected price differs from the ledger: STOP', r.stopped && r.stops.some(s => s.code === 'hand-correction-conflict' && /optEntry/.test(s.text)), r.stops);
  const r2 = run([live('j-plain', P1, S1, 1), live('j-ad', A, Dd, 1, { ftfc: { '5m': 'his' }, userSet: { ftfc: true } }), live('j-bc', B, C, 1), live('j-t1', T1, U1, 1), live('j-t2', T2, U2, 1)]);
  // j-ad's data (userSet ftfc) moves to A+C as HIS data, not as a machine fact; B+D must not get it.
  const bd = ledgerId(r2, B, Dd), ac = ledgerId(r2, A, C);
  check('not stopped', !r2.stopped, r2.stops);
  check('his timeframes are not copied as a machine fact to another trade', bd && bd.ftfc && bd.ftfc['5m'] !== 'his');
  check('they travel only as his data, to the one trade with the same purchase', ac && ac.ftfc['5m'] === 'his' && ac.userSet && ac.userSet.ftfc === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
