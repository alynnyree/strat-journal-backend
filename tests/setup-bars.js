// Step 1A: the bars into his entry, measured (setupBars.js is pure).
//   A1 labels in whole cents, and "too close to call" within 2 cents
//   A2 B0 is built only from prices up to the entry SECOND
//   A3 each of the seven bar combos, bullish and bearish
//   A4 his 1 Bar Rev Strat: break first, THEN the midpoint, by the entry second
//   A5 the direction gate      A6 overlaps recorded, longest first
//   A6b PMG is never read      A7 each timeframe's status is honoured
//   A8 1H/2H/4H built from 30m equal those built from 1m, half-days included
const S = require('../setupBars');
const { buildFromMinutes } = require('../barAudit');

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };

// 16 Nov 2026 is winter time: 09:30 New York = 14:30Z.
const OPEN = Date.UTC(2026, 10, 16, 14, 30);
const MIN = 60000;
// A 5-minute bar [open, high, low, close] as five 1-minute bars: high first, then low.
function fiveMinutes(start, [o, h, l, c]) {
  return [
    { datetime: start, open: o, high: o, low: o, close: o },
    { datetime: start + MIN, open: o, high: h, low: o, close: h },
    { datetime: start + 2 * MIN, open: h, high: h, low: l, close: l },
    { datetime: start + 3 * MIN, open: l, high: Math.max(l, c), low: l, close: c },
    { datetime: start + 4 * MIN, open: c, high: c, low: c, close: c },
  ];
}
// specs: whole 5m bars from 09:30; then B0 = the next bar, with `b0` minutes
// before the entry minute and entry trades in the entry minute.
function scenario(specs, b0, entryPrices, { direction = 'bullish', status, fullTape = true, entryTrades } = {}) {
  const minutes = [];
  specs.forEach((s, i) => minutes.push(...fiveMinutes(OPEN + i * 5 * MIN, s)));
  const b0Start = OPEN + specs.length * 5 * MIN;
  b0.forEach((m, k) => minutes.push({ datetime: b0Start + k * MIN, open: m[0], high: m[1], low: m[2], close: m[3] }));
  const entryMinute = b0Start + b0.length * MIN;
  const entryMs = entryMinute + 20000;
  const trades = entryTrades !== undefined ? entryTrades : entryPrices.map((p, k) => ({ t: entryMinute + (k + 1) * 1000, p }));
  return S.readSetups({ entryMs, direction, minutesBefore: minutes, entryTrades: trades, completedDaily: [],
    status: status || { '1m': 'input', '5m': 'confirmed' }, fullTape });
}
const on5 = r => r.timeframes['5m'].candidates;
const names = r => on5(r).map(c => c.combo);

// ===== A1 labels =========================================================
{
  const prev = { high: 101, low: 99 };
  check('A1 2U: took out the previous high only', S.labelBar(prev, { high: 101.5, low: 99.5 }).label === '2U');
  check('A1 2D: took out the previous low only', S.labelBar(prev, { high: 100.5, low: 98.5 }).label === '2D');
  check('A1 3: both sides', S.labelBar(prev, { high: 101.5, low: 98.5 }).label === '3');
  check('A1 1: neither side', S.labelBar(prev, { high: 100.5, low: 99.5 }).label === '1');
  check('A1 an equal high is not taken out', S.labelBar(prev, { high: 101, low: 99.5 }).label === '1');
  check('A1 whole cents: 101.004 is still 101.00', S.labelBar(prev, { high: 101.004, low: 99.5 }).label === '1');
  check('A1 one cent over is taken out', S.labelBar(prev, { high: 101.01, low: 99.5 }).label === '2U');
  check('A1 within 2 cents is "too close to call"', S.labelBar(prev, { high: 101.02, low: 99.5 }).borderline === true);
  check('A1 3 cents clear is not', S.labelBar(prev, { high: 101.03, low: 99.5 }).borderline === false);
}

// ===== A2 nothing after the entry second ================================
{
  const em = S.entryMinuteBar(Date.UTC(2026, 10, 16, 16, 8, 34), [
    { t: Date.UTC(2026, 10, 16, 16, 8, 2), p: 100 }, { t: Date.UTC(2026, 10, 16, 16, 8, 34), p: 100.4 },
    { t: Date.UTC(2026, 10, 16, 16, 8, 35), p: 105 }, { t: Date.UTC(2026, 10, 16, 16, 7, 59), p: 90 }]);
  check('A2 the entry minute holds trades up to and AT the entry second only', em.high === 100.4 && em.low === 100 && em.open === 100 && em.close === 100.4, em);
  // B0 that would be 2U one second after the entry, but is not at it.
  const r = scenario([[100, 101, 99, 100.5], [100.5, 101.5, 100, 101], [101, 102, 100.5, 101.5]], [[101.5, 101.8, 101.2, 101.6]], [101.7, 101.9],
    { entryTrades: [{ t: 0, p: 0 }] });
  check('A2 trades outside the entry minute are not used', r.notes.includes('entry minute missing'));
  const before = scenario([[100, 101, 99, 100.5], [100.5, 101.5, 100, 101], [101, 102, 100.5, 101.5]], [[101.5, 101.8, 101.2, 101.6]], [101.7, 101.9]);
  const late = scenario([[100, 101, 99, 100.5], [100.5, 101.5, 100, 101], [101, 102, 100.5, 101.5]], [[101.5, 101.8, 101.2, 101.6]], [101.7, 101.9],
    { entryTrades: [{ t: OPEN + 16 * MIN + 1000, p: 101.7 }, { t: OPEN + 16 * MIN + 19000, p: 101.9 }, { t: OPEN + 16 * MIN + 21000, p: 102.5 }] });
  const b0 = x => x.timeframes['5m'].bars.slice(-1)[0];
  check('A2 a price one second after the entry changes nothing', b0(before).label === '1' && b0(late).label === '1' && b0(late).high === 101.9, [b0(before), b0(late)]);
}

// ===== A3 the seven bar combos, both directions =========================
// prev bars: P (reference), then the pattern bars; B0 is the last.
const BAR = {
  base: [100, 101, 99, 100],
  '2U': prev => [prev[3], prev[1] + 0.5, prev[2] + 0.3, prev[1] + 0.3],
  '2D': prev => [prev[3], prev[1] - 0.3, prev[2] - 0.5, prev[2] - 0.3],
  '3': prev => [prev[3], prev[1] + 0.5, prev[2] - 0.5, prev[3]],
  '1': prev => [prev[3], prev[1] - 0.2, prev[2] + 0.2, (prev[1] + prev[2]) / 2],
};
function build(seq) {
  const specs = [BAR.base];
  for (const l of seq.slice(0, -1)) specs.push(BAR[l](specs[specs.length - 1]));
  const prev = specs[specs.length - 1];
  const last = BAR[seq[seq.length - 1]](prev);
  // B0 so far: three minutes, then the entry minute reaching its extremes.
  return { specs, b0: [[last[0], last[0], last[0], last[0]]], entry: [last[1], last[2], last[3]] };
}
for (const c of S.COMBOS) {
  for (const dir of ['bullish', 'bearish']) {
    const seq = dir === 'bullish' ? c.bull : c.bull.map(l => (l === '2U' ? '2D' : l === '2D' ? '2U' : l));
    const { specs, b0, entry } = build(seq);
    const r = scenario(specs, b0, entry, { direction: dir });
    const got = on5(r).find(x => x.combo === c.name);
    check(`A3 ${c.name} ${dir} (${seq.join('-')}) is found on the 5m`, got && got.notation === seq.join('-') && got.direction === dir, on5(r));
  }
}

// ===== A5 the direction gate ===========================================
{
  const { specs, b0, entry } = build(['2U', '2D']);       // bearish 2-2 Reversal
  check('A5 a bearish combo on a call is not a candidate', !names(scenario(specs, b0, entry, { direction: 'bullish' })).includes('2-2 Reversal'));
  check('A5 and is one on a put', names(scenario(specs, b0, entry, { direction: 'bearish' })).includes('2-2 Reversal'));
}

// ===== A6 overlaps =====================================================
{
  const { specs, b0, entry } = build(['1', '2D', '2U']);
  const n = names(scenario(specs, b0, entry));
  check('A6 a 1-2-2 Rev Strat also holds a 2-2 Reversal: both recorded', n.includes('1-2-2 Rev Strat') && n.includes('2-2 Reversal'), n);
  check('A6 the longer one first', n.indexOf('1-2-2 Rev Strat') < n.indexOf('2-2 Reversal'), n);
}

// ===== A6b PMG is never read ============================================
{
  const specs = [[110, 111, 109, 110]];
  for (let i = 1; i <= 6; i++) specs.push([110 - i * 0.5, 111 - i * 0.5, 109 - i * 0.6, 110 - i * 0.5]);   // six lower highs
  const prev = specs[specs.length - 1];
  const r = scenario(specs, [[prev[3], prev[3], prev[3], prev[3]]], [prev[1] + 0.4, prev[3]]);
  check('A6b five-plus lower highs then a break: no PMG', !r.candidates.some(c => c.combo === 'PMG'), r.candidates.map(c => c.combo));
  check('A6b PMG is not among the automatic combos', !S.AUTO_COMBOS.includes('PMG') && S.AUTO_COMBOS.length === 8);
}

// ===== A4 1 Bar Rev Strat ==============================================
{
  const P = [100.5, 102, 100, 101];             // B-1: high 102, low 100, midpoint 101
  const base = [[100, 101, 99, 100.5]];
  // Bullish: breaks below 100 first, then climbs to 101 by the entry.
  let r = scenario([...base, P], [[101, 101, 99.6, 99.7], [99.7, 100.4, 99.6, 100.3]], [100.6, 101.05]);
  let c8 = on5(r).find(c => c.combo === '1 Bar Rev Strat');
  check('A4 break below the low, THEN up to the midpoint: a 1 Bar Rev Strat', c8 && !c8.orderUnknown, on5(r));
  check('A4 the high is the target, not a condition (B0 never reached 102)', c8 && on5(r) && r.timeframes['5m'].bars.slice(-1)[0].high < 102);
  // Midpoint first, then the break: not one.
  r = scenario([...base, P], [[101, 101.2, 100.6, 100.7], [100.7, 100.8, 99.6, 99.7]], [99.8]);
  check('A4 midpoint first, break after: not a 1 Bar Rev Strat', !on5(r).some(c => c.combo === '1 Bar Rev Strat'), on5(r));
  // Break but never back to the midpoint by the entry second.
  r = scenario([...base, P], [[100.5, 100.6, 99.6, 99.7]], [100.2, 100.9]);
  check('A4 never back to the midpoint by the entry: not one', !on5(r).some(c => c.combo === '1 Bar Rev Strat'));
  // Both inside ONE earlier minute: order unknown, and that minute is asked for.
  r = scenario([...base, P], [[100.5, 101.2, 99.6, 100.8], [100.8, 100.9, 100.6, 100.7]], [100.7]);
  c8 = on5(r).find(c => c.combo === '1 Bar Rev Strat');
  const theMinute = OPEN + 10 * MIN;
  check('A4 break and midpoint in one minute: "order unknown", never guessed', c8 && c8.orderUnknown === true && c8.confirmed === false, c8);
  check('A4 and that minute is named so its trades can be fetched', r.needsMinutes.includes(theMinute), r.needsMinutes);
  // Given that minute's trades, the order is settled either way.
  const again = (trades) => S.readSetups({ entryMs: OPEN + 12 * MIN + 20000, direction: 'bullish',
    minutesBefore: [...fiveMinutes(OPEN, base[0]), ...fiveMinutes(OPEN + 5 * MIN, P),
      { datetime: theMinute, open: 100.5, high: 101.2, low: 99.6, close: 100.8 }, { datetime: theMinute + MIN, open: 100.8, high: 100.9, low: 100.6, close: 100.7 }],
    entryTrades: [{ t: OPEN + 12 * MIN + 5000, p: 100.7 }], completedDaily: [], status: { '5m': 'confirmed' }, fullTape: true,
    minuteTrades: { [theMinute]: trades } });
  let g = again([{ t: theMinute + 1000, p: 100.5 }, { t: theMinute + 2000, p: 99.6 }, { t: theMinute + 3000, p: 101.2 }, { t: theMinute + 4000, p: 100.8 }]);
  check('A4 trades show the break came first: a 1 Bar Rev Strat, order known', on5(g).some(c => c.combo === '1 Bar Rev Strat' && !c.orderUnknown), on5(g));
  g = again([{ t: theMinute + 1000, p: 100.5 }, { t: theMinute + 2000, p: 101.2 }, { t: theMinute + 3000, p: 99.6 }, { t: theMinute + 4000, p: 100.8 }]);
  check('A4 trades show the midpoint came first: not one', !on5(g).some(c => c.combo === '1 Bar Rev Strat'), on5(g));
  // Bearish mirror.
  r = scenario([...base, P], [[101, 102.3, 101, 102.2], [102.2, 102.2, 101.5, 101.6]], [101.2, 100.95], { direction: 'bearish' });
  check('A4 bearish: above the high first, then down to the midpoint', on5(r).some(c => c.combo === '1 Bar Rev Strat' && c.direction === 'bearish'), on5(r));
}

// ===== A7 statuses and notes ==========================================
{
  const { specs, b0, entry } = build(['2U', '2U']);
  let r = scenario(specs, b0, entry, { status: { '5m': 'unconfirmed' } });
  check('A7 an unconfirmed timeframe gives unconfirmed candidates', on5(r).length && on5(r).every(c => c.confirmed === false));
  r = scenario(specs, b0, entry, { status: { '5m': 'confirmed' } });
  check('A7 a confirmed one gives confirmed candidates', on5(r).length && on5(r).every(c => c.confirmed === true));
  r = scenario(specs, b0, entry, { status: { '5m': 'confirmed' }, fullTape: false });
  check('A7 single-exchange prices: noted, and nothing confirmed', r.notes.includes('single-exchange prices') && on5(r).every(c => !c.confirmed));
  r = scenario(specs, b0, entry, { status: { '5m': 'confirmed' }, entryTrades: null });
  check('A7 the entry minute could not be fetched: noted, nothing confirmed', r.notes.includes('entry minute missing') && on5(r).every(c => !c.confirmed));
  check('A7 3 Month, 6 Month and Yearly default to unconfirmed unless marked', S.TIMEFRAME_KEYS.length === 14);
}

// ===== A8 1H/2H/4H from 30m equal those from 1m (half-days included) ====
{
  const mins = [];
  // Five sessions: Wed 25 Nov, Fri 27 Nov (half day to 13:00), Mon 30 Nov, Tue 1 Dec, Wed 2 Dec.
  const days = [[2026, 10, 25, 390], [2026, 10, 27, 210], [2026, 10, 30, 390], [2026, 11, 1, 390], [2026, 11, 2, 390]];
  let px = 500;
  for (const [y, m, d, len] of days) {
    const open = Date.UTC(y, m, d, 14, 30);
    for (let k = 0; k < len; k++) {
      const o = px, c = px + Math.sin(k / 7 + d) * 0.3;
      mins.push({ datetime: open + k * MIN, open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c });
      px = c;
    }
  }
  const thirty = buildFromMinutes(mins, 30);
  let same = true;
  for (const size of [60, 120, 240]) {
    const a = buildFromMinutes(mins, size), b = buildFromMinutes(thirty, size);
    if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; console.log('differs at', size); }
  }
  check('A8 1H, 2H and 4H built from 30m equal those built from 1m, across five sessions', same);
  const four = buildFromMinutes(mins, 240);
  check('A8 a half-day is not merged into the next morning (4H: 2+1+2+2+2 bars)', four.length === 9, four.length);
}

// ===== periods ========================================================
check('weeks start on Monday', S.periodKey('2026-11-16', 'week') === S.periodKey('2026-11-20', 'week') && S.periodKey('2026-11-15', 'week') !== S.periodKey('2026-11-16', 'week'));
check('quarters and halves follow the calendar', S.periodKey('2026-03-31', 'quarter') === '2026-Q1' && S.periodKey('2026-04-01', 'quarter') === '2026-Q2' && S.periodKey('2026-07-01', 'half') === '2026-H2');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
