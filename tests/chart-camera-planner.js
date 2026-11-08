// THE CHART CAMERA'S PLANNER (chart-camera/src/planner.js): which pictures
// and which recording each trade is owed, and at what exact second. Pure:
// no clock, no files, no network.
const path = require('path');
const P = require(path.join(__dirname, '..', 'chart-camera', 'src', 'planner.js'));

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };
const MIN = 60000;
const T0 = Date.UTC(2026, 10, 9, 14, 31, 12); // 09:31:12 New York
const jobs = s => Object.values(s.jobs).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
const of = (s, moment) => jobs(s).filter(j => j.moment === moment);
let seq = 0;
const opened = (o = {}) => Object.assign({ seq: ++seq, type: 'opened', ticker: 'IWM', dir: 'Short', legKey: 'IWM-OCC-' + T0, entryTimestamp: T0 }, o);
const closed = (o = {}) => Object.assign({ seq: ++seq, type: 'closed', ticker: 'IWM', dir: 'Short', legKey: 'IWM-OCC-' + T0, entryTimestamp: T0, exitTimestamp: T0 + 22 * MIN + 5000, tradeId: 'T1', stillOpen: false }, o);

// ===== 1. A 22-minute trade =====
{
  const s = P.emptyState();
  P.applyEvents(s, [opened()], 1);
  check('an opening owes an ENTRY picture at the second of the buy', of(s, 'entry').length === 1 && of(s, 'entry')[0].at === T0);
  P.planDuring(s, T0 + 12 * MIN, {});
  check('while held, a DURING picture every 5 minutes up to now: +5, +10', of(s, 'during').map(j => (j.at - T0) / MIN).join() === '5,10');
  P.applyEvents(s, [closed()], 1);
  P.planDuring(s, T0 + 60 * MIN, {});
  const d = of(s, 'during').map(j => (j.at - T0) / MIN);
  check('after the sale at +22m05s: during pictures +5, +10, +15, +20 (+20 is over a minute before the exit, so kept)', d.join() === '5,10,15,20', d);
  check('an EXIT picture at the second of the sale', of(s, 'exit').length === 1 && of(s, 'exit')[0].at === T0 + 22 * MIN + 5000);
  const clip = jobs(s).find(j => j.kind === 'clip');
  check('a RECORDING from a minute before the buy to a minute after the sale, uncut', clip && clip.from === T0 - MIN && clip.to === T0 + 23 * MIN + 5000 && clip.parts.length === 1 && clip.cut === null, clip);
  check('the position is closed at the sale', s.positions['IWM-OCC-' + T0].open === false);
  P.planDuring(s, T0 + 600 * MIN, {});
  check('nothing more is owed after it closes, however long the camera runs', of(s, 'during').length === 4);
}

// ===== 2. The same moments again: nothing owed twice =====
{
  const s = P.emptyState();
  const o = opened(), c = closed();
  P.applyEvents(s, [o, c], 1);
  const n = Object.keys(s.jobs).length;
  s.cursor = 0;                           // a restart that forgot how far it had read
  P.applyEvents(s, [o, c], 1);
  P.applyEvent(s, c, {});
  check('hearing the same opening and closing again owes nothing new', Object.keys(s.jobs).length === n);
}

// ===== 3. A quick trade: the closing arrives alone =====
{
  const s = P.emptyState();
  P.applyEvents(s, [closed({ exitTimestamp: T0 + 90 * 1000 })], 1);
  check('a closing with no opening still owes the ENTRY picture, from its own entry time', of(s, 'entry').length === 1 && of(s, 'entry')[0].at === T0);
  P.planDuring(s, T0 + 10 * MIN, {});
  check('a 90-second trade has no during pictures', of(s, 'during').length === 0);
}

// ===== 4. Sold in pieces =====
{
  const s = P.emptyState();
  P.applyEvents(s, [opened(), closed({ tradeId: 'A', exitTimestamp: T0 + 7 * MIN, stillOpen: true })], 1);
  P.planDuring(s, T0 + 13 * MIN, {});
  check('a partial sale keeps the position open: during pictures continue past it', of(s, 'during').map(j => (j.at - T0) / MIN).join() === '5,10');
  P.applyEvents(s, [closed({ tradeId: 'B', exitTimestamp: T0 + 16 * MIN, stillOpen: false })], 1);
  P.planDuring(s, T0 + 60 * MIN, {});
  check('each sale owes its own exit picture and recording', of(s, 'exit').length === 2 && jobs(s).filter(j => j.kind === 'clip').length === 2);
  check('one entry picture for the one buy', of(s, 'entry').length === 1);
  check('during pictures stop at the last sale: +5, +10, +15 (and +15 is at least a minute before +16)', of(s, 'during').map(j => (j.at - T0) / MIN).join() === '5,10,15');
  P.applyEvents(s, [closed({ tradeId: 'C', exitTimestamp: T0 + 30 * MIN, stillOpen: null })], 1);
  check('"not known whether still held" closes it, never leaves it open for ever', s.positions['IWM-OCC-' + T0].open === false);
}

// ===== 5. Longer than 45 minutes: the first 40 and the last 5 =====
{
  const exit = T0 + 70 * MIN;
  const plan = P.clipPlan(T0, exit, {});
  check('a 70-minute trade is cut: first 40 minutes from a minute before the buy', plan.parts[0][0] === T0 - MIN && plan.parts[0][1] === T0 - MIN + 40 * MIN);
  check('...and the last 5 minutes up to a minute after the sale (the exit is always in it)', plan.parts[1][0] === exit + MIN - 5 * MIN && plan.parts[1][1] === exit + MIN);
  check('...saying exactly which minutes were left out', plan.cut.skippedFrom === plan.parts[0][1] && plan.cut.skippedTo === plan.parts[1][0]);
  const total = plan.parts.reduce((t, [a, b]) => t + (b - a), 0);
  check('...45 minutes kept in all', total === 45 * MIN, total / MIN);
  const exact = P.clipPlan(T0, T0 + 43 * MIN, {});
  check('a trade whose recording is exactly 45 minutes is kept whole', exact.parts.length === 1 && exact.cut === null && exact.to - exact.from === 45 * MIN);
  const longer = P.clipPlan(T0, T0 + 43 * MIN + 1, {});
  check('one millisecond longer is cut', longer.parts.length === 2);
  const custom = P.clipPlan(T0, T0 + 120 * MIN, { maxVideoMinutes: 30, keepHeadMinutes: 20, keepTailMinutes: 10 });
  check('the lengths are settings', custom.parts[0][1] - custom.parts[0][0] === 20 * MIN && custom.parts[1][1] - custom.parts[1][0] === 10 * MIN);
}

// ===== 6. Held for days: a ceiling on during pictures =====
{
  const s = P.emptyState();
  P.applyEvents(s, [opened()], 1);
  P.planDuring(s, T0 + 3 * 24 * 60 * MIN, {});
  check('a position held for days owes at most 30 during pictures', of(s, 'during').length === 30);
  const s2 = P.emptyState();
  P.applyEvents(s2, [opened()], 1);
  P.planDuring(s2, T0 + 60 * MIN, { intervalMinutes: 15 });
  check('the interval is a setting (every 15 minutes: +15, +30, +45, +60)', of(s2, 'during').map(j => (j.at - T0) / MIN).join() === '15,30,45,60');
}

// ===== 7. Practice trades stay labelled =====
{
  const s = P.emptyState();
  P.applyEvents(s, [opened({ test: true, legKey: 'TEST-SPY', ticker: 'SPY' }), closed({ test: true, legKey: 'TEST-SPY', ticker: 'SPY', tradeId: null, exitTimestamp: T0 + 6 * MIN })], 1);
  P.planDuring(s, T0 + 10 * MIN, {});
  check('every job from a practice trade is marked test (entry, during, exit, recording)', jobs(s).length === 4 && jobs(s).every(j => j.test === true), jobs(s).map(j => [j.moment || j.kind, j.test]));
}

// ===== 8. The cursor, and moments lost while away =====
{
  const s = P.emptyState();
  const a = opened(), b = closed();
  P.applyEvents(s, [b, a], a.seq);
  check('moments are taken in their numbered order, whatever order they arrive in', s.cursor === b.seq && of(s, 'exit').length === 1);
  P.applyEvents(s, [opened({ seq: s.cursor + 50, legKey: 'later' })], s.cursor + 50);
  check('a gap in the numbers (moments dropped off the service\'s list while away) is recorded, not passed over', s.missedEvents.length === 1 && s.missedEvents[0].from === b.seq + 1, s.missedEvents);
  const before = s.missedEvents.length;
  P.applyEvents(s, [], s.cursor + 1);
  check('and recorded once, not on every read', s.missedEvents.length === before);
}

// ===== 9. Odd input never breaks it =====
{
  const s = P.emptyState();
  P.applyEvents(s, [null, { seq: 'x' }, { seq: ++seq, type: 'opened' }, { seq: ++seq, type: 'closed', legKey: 'k', entryTimestamp: T0 }, { seq: ++seq, type: 'mystery' }], 1);
  check('missing fields, unknown kinds and nonsense owe nothing and throw nothing', Object.keys(s.jobs).length === 0);
}

// ===== 10. Finished positions are let go =====
{
  const s = P.emptyState();
  P.applyEvents(s, [opened(), closed()], 1);
  for (const j of Object.values(s.jobs)) { j.status = 'done'; j.settledAt = T0 + 23 * MIN; }
  P.prune(s, T0 + 2 * 24 * 60 * MIN);
  check('a closed position with every job settled is let go after a day', Object.keys(s.positions).length === 0);
  const s2 = P.emptyState();
  P.applyEvents(s2, [opened(), closed()], 1);
  P.prune(s2, T0 + 2 * 24 * 60 * MIN);
  check('...but never while a picture for it is still owed', Object.keys(s2.positions).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
