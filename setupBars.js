// STEP 1A: READ HIS COMBOS FROM THE BARS, WITH NOTHING AFTER THE ENTRY SECOND.
//
// Authorised 15 Nov 2026 ("I authorize Step 1 implementation"; plan v4).
//
// The old reading handed the AI the last fifteen candles of the replay
// window -- and for 110 of his 111 trades every one of those was AFTER his
// entry. It was asked what setup he took while being shown what happened
// next. This module measures instead, and it is PURE: bars in, labels and
// candidates out. No network, no storage, no clock. setupReader.js does the
// fetching; this decides nothing it was not handed.
//
// His rules (15 Nov 2026):
//  - B0, the bar forming when he bought, is ALWAYS the last candle of the
//    combo (Q3). It is built only from prices up to the entry SECOND.
//  - Longest combo first (Q4).
//  - Eight combos are read automatically. PMG is never read automatically
//    ("Forget about PMG"); he can still pick it by hand.
//  - 1 Bar Rev Strat, in his words: "I take my entry at 50% level of
//    previous candle and target the high of previous candle." Bullish: B0
//    first trades below B-1's low, THEN reaches B-1's midpoint by the entry
//    second. The high is the target, not a condition. Bearish is the mirror.
//  - Labels in whole cents: 2U took out the previous high, 2D the previous
//    low, 3 both, 1 neither. Within 2 cents of a high or low is "too close
//    to call" (borderline) and says so -- his chart (Cboe One) can differ
//    from the full tape by about that much.
//
// Every timeframe carries a status saying how far its bars can be trusted:
//   input          the 1-minute bars themselves
//   confirmed      matched the data provider's own bars (the referee)
//   derived        built only from confirmed bars (1H/2H/4H from 30m;
//                  Weekly/Monthly from Daily)
//   unconfirmed    the referee could not check it, or disagreed
//   reconstruction 3 Month / 6 Month / Yearly: the app's own grouping
// A candidate is "confirmed" only on an input/confirmed/derived timeframe,
// from full-tape prices, with the entry minute rebuilt.
const { buildFromMinutes, minutesOfDay, easternDateOf, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } = require('./barAudit');

const RULE_VERSION = 1;
const BORDERLINE_CENTS = 2;

const TIMEFRAMES = [
  { key: '1m', minutes: 1 }, { key: '3m', minutes: 3 }, { key: '5m', minutes: 5 },
  { key: '15m', minutes: 15 }, { key: '30m', minutes: 30 }, { key: '1H', minutes: 60 },
  { key: '2H', minutes: 120 }, { key: '4H', minutes: 240 },
  { key: 'Daily', period: 'day' }, { key: 'Weekly', period: 'week' }, { key: 'Monthly', period: 'month' },
  { key: '3 Month', period: 'quarter' }, { key: '6 Month', period: 'half' }, { key: 'Yearly', period: 'year' },
];
const TIMEFRAME_KEYS = TIMEFRAMES.map(t => t.key);

// Written bullish, oldest bar first, ending at B0. Bearish swaps U and D.
const COMBOS = [
  { id: 'C1', name: '2-1-2 Continuation', bull: ['2U', '1', '2U'] },
  { id: 'C2', name: '2-1-2 Reversal', bull: ['2D', '1', '2U'] },
  { id: 'C3', name: '3-1-2 Reversal', bull: ['3', '1', '2U'] },
  { id: 'C4', name: '2-2 Continuation', bull: ['2U', '2U'] },
  { id: 'C5', name: '2-2 Reversal', bull: ['2D', '2U'] },
  { id: 'C6', name: '3-2-2 Reversal', bull: ['3', '2D', '2U'] },
  { id: 'C7', name: '1-2-2 Rev Strat', bull: ['1', '2D', '2U'] },
];
const C8 = { id: 'C8', name: '1 Bar Rev Strat' };
const AUTO_COMBOS = [...COMBOS.map(c => c.name), C8.name];
const flip = l => (l === '2U' ? '2D' : l === '2D' ? '2U' : l);

const cents = x => Math.round(Number(x) * 100);

// One bar against the one before it.
function labelBar(prev, cur) {
  const hp = cents(prev.high), lp = cents(prev.low), h = cents(cur.high), l = cents(cur.low);
  const up = h > hp, down = l < lp;
  return {
    label: up && down ? '3' : up ? '2U' : down ? '2D' : '1',
    borderline: Math.abs(h - hp) <= BORDERLINE_CENTS || Math.abs(l - lp) <= BORDERLINE_CENTS,
  };
}

// The entry minute, rebuilt ONLY from trades at or before the entry second.
// null when there is nothing to build it from.
function entryMinuteBar(entryMs, entryTrades) {
  const minuteStart = Math.floor(entryMs / 60000) * 60000;
  const ts = (entryTrades || []).filter(t => Number.isFinite(t.t) && t.t >= minuteStart && t.t <= entryMs && Number.isFinite(t.p))
    .sort((a, b) => a.t - b.t);
  if (!ts.length) return null;
  return { datetime: minuteStart, open: ts[0].p, high: Math.max(...ts.map(t => t.p)), low: Math.min(...ts.map(t => t.p)), close: ts[ts.length - 1].p, rebuilt: true };
}

// Which calendar period a New York date (YYYY-MM-DD) belongs to.
function periodKey(date, period) {
  const [y, m, d] = date.split('-').map(Number);
  if (period === 'day') return date;
  if (period === 'week') {
    const t = Date.UTC(y, m - 1, d), dow = new Date(t).getUTCDay();
    return 'W' + new Date(t - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);   // the Monday
  }
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  if (period === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`;
  if (period === 'half') return `${y}-H${m <= 6 ? 1 : 2}`;
  return String(y);
}

function groupDaily(days, period) {
  const out = [];
  let cur = null, key = null;
  for (const d of days) {
    const k = periodKey(d.date, period);
    if (k !== key) { cur = { datetime: d.datetime, date: d.date, open: d.open, high: d.high, low: d.low, close: d.close }; out.push(cur); key = k; continue; }
    cur.high = Math.max(cur.high, d.high); cur.low = Math.min(cur.low, d.low); cur.close = d.close;
  }
  return out;
}

// The 1 Bar Rev Strat path: did B0 break the far side FIRST, and only then
// reach B-1's midpoint, by the entry second? Read minute by minute; when the
// break and the midpoint fall in the SAME minute, that minute's trades
// settle the order, and without them the order is unknown (never guessed).
function readC8(prev, path, bullish, minuteTrades) {
  const mid = (cents(prev.high) + cents(prev.low)) / 2;
  const breaks = c => (bullish ? cents(c.low) < cents(prev.low) : cents(c.high) > cents(prev.high));
  const reaches = c => (bullish ? cents(c.high) >= mid : cents(c.low) <= mid);
  const i = path.findIndex(breaks);
  if (i < 0) return null;
  const nearMid = path.slice(i).some(c => Math.abs((bullish ? cents(c.high) : cents(c.low)) - mid) <= BORDERLINE_CENTS);
  const nearBreak = Math.abs((bullish ? cents(path[i].low) - cents(prev.low) : cents(path[i].high) - cents(prev.high))) <= BORDERLINE_CENTS;
  // A later minute reaching the midpoint: the order is plain.
  if (path.slice(i + 1).some(reaches)) return { orderUnknown: false, borderline: nearMid || nearBreak, needs: null };
  if (!reaches(path[i])) return null;
  // Break and midpoint inside one minute: ask that minute's trades.
  const trades = minuteTrades && minuteTrades[path[i].datetime];
  if (!trades) return { orderUnknown: true, borderline: nearMid || nearBreak, needs: path[i].datetime };
  let broke = false;
  for (const t of [...trades].sort((a, b) => a.t - b.t)) {
    const p = cents(t.p);
    if (!broke && (bullish ? p < cents(prev.low) : p > cents(prev.high))) broke = true;
    else if (broke && (bullish ? p >= mid : p <= mid)) return { orderUnknown: false, borderline: nearMid || nearBreak, needs: null };
  }
  return null;   // the trades show the midpoint came first, or never after the break
}

// input = { entryMs, direction: 'bullish'|'bearish',
//           minutesBefore: 1m bars that START before the entry minute,
//           entryTrades: trades in the entry minute (null = could not fetch),
//           completedDaily: daily bars of whole sessions before the entry day,
//           minuteTrades: { [minuteStartMs]: [{t,p}] } (optional, for C8 order),
//           status: { [timeframe]: 'input'|'confirmed'|'derived'|'unconfirmed'|'reconstruction' },
//           fullTape: true when every price came from the full market tape }
function readSetups(input) {
  const entryMs = Number(input.entryMs);
  const bullish = input.direction === 'bullish';
  const status = input.status || {};
  const notes = [];
  const minuteStart = Math.floor(entryMs / 60000) * 60000;
  const before = (input.minutesBefore || []).filter(c => c.datetime < minuteStart).sort((a, b) => a.datetime - b.datetime);
  const em = input.entryTrades === null ? null : entryMinuteBar(entryMs, input.entryTrades);
  if (!em) notes.push('entry minute missing');
  if (input.fullTape === false) notes.push('single-exchange prices');
  const minutes = em ? [...before, em] : before;
  const entryDate = easternDateOf(entryMs);
  const entryMin = minutesOfDay(entryMs);
  const inSession = entryMin >= SESSION_OPEN_MIN && entryMin < SESSION_CLOSE_MIN;

  const out = { ruleVersion: RULE_VERSION, timeframes: {}, candidates: [], notes, needsMinutes: [] };
  const needs = new Set();

  for (const tf of TIMEFRAMES) {
    const st = status[tf.key] || (tf.key === '1m' ? 'input' : 'unconfirmed');
    const entry = { status: st, bars: [], candidates: [], why: null };
    out.timeframes[tf.key] = entry;
    let bars, b0Start;
    if (tf.minutes) {
      if (!inSession) { entry.why = 'the entry was outside the regular session'; continue; }
      bars = buildFromMinutes(minutes, tf.minutes);
      const last = bars[bars.length - 1];
      if (!last || easternDateOf(last.datetime) !== entryDate || last.datetime > minuteStart || last.datetime + tf.minutes * 60000 <= minuteStart) {
        entry.why = 'no bar was forming at the entry'; continue;
      }
      b0Start = last.datetime;
    } else {
      const today = minutes.filter(c => easternDateOf(c.datetime) === entryDate && minutesOfDay(c.datetime) >= SESSION_OPEN_MIN && minutesOfDay(c.datetime) < SESSION_CLOSE_MIN);
      if (!today.length) { entry.why = 'no prices from the entry day'; continue; }
      const days = (input.completedDaily || []).map(d => ({ ...d, date: easternDateOf(d.datetime + 12 * 3600000) }))
        .filter(d => d.date < entryDate).sort((a, b) => a.datetime - b.datetime);
      days.push({ datetime: today[0].datetime, date: entryDate, open: today[0].open,
        high: Math.max(...today.map(c => c.high)), low: Math.min(...today.map(c => c.low)), close: today[today.length - 1].close });
      bars = groupDaily(days, tf.period);
      const k = periodKey(entryDate, tf.period);
      const firstOfB0 = days.find(d => periodKey(d.date, tf.period) === k);
      b0Start = firstOfB0.datetime;
    }
    if (bars.length < 2) { entry.why = 'not enough bars before the entry'; continue; }
    // Labels for the last four (B0 last).
    const labelled = [];
    for (let i = Math.max(1, bars.length - 4); i < bars.length; i++) labelled.push({ ...bars[i], ...labelBar(bars[i - 1], bars[i]) });
    entry.bars = labelled;
    const seq = labelled.map(b => b.label);
    const confirmed = ['input', 'confirmed', 'derived'].includes(st) && input.fullTape !== false && !notes.includes('entry minute missing');

    for (const c of COMBOS) {
      const want = bullish ? c.bull : c.bull.map(flip);
      if (seq.length < want.length) continue;
      const tail = labelled.slice(-want.length);
      if (!tail.every((b, j) => b.label === want[j])) continue;
      entry.candidates.push({ timeframe: tf.key, direction: bullish ? 'bullish' : 'bearish', combo: c.name,
        notation: want.join('-'), length: want.length, borderline: tail.some(b => b.borderline), orderUnknown: false, confirmed });
    }
    // C8 needs B0's own path: every minute of it must be on hand.
    const prev = bars[bars.length - 2];
    const path = minutes.filter(c => c.datetime >= b0Start);
    const covered = before.length && before[0].datetime <= b0Start;
    if (covered && path.length) {
      const r = readC8(prev, path, bullish, input.minuteTrades);
      if (r) {
        if (r.needs != null) needs.add(r.needs);
        const b0 = labelled[labelled.length - 1];
        entry.candidates.push({ timeframe: tf.key, direction: bullish ? 'bullish' : 'bearish', combo: C8.name,
          notation: `${prev === bars[bars.length - 2] && labelled.length > 1 ? labelled[labelled.length - 2].label : '?'}-${b0.label}`,
          length: 2, borderline: r.borderline, orderUnknown: r.orderUnknown, confirmed: confirmed && !r.orderUnknown });
      }
    } else if (!covered) {
      entry.why = entry.why || '1 Bar Rev Strat not read: the bar\'s whole path is not in the minutes on hand';
    }
    entry.candidates.sort((a, b) => b.length - a.length);   // longest first (Q4)
    out.candidates.push(...entry.candidates);
  }
  out.needsMinutes = [...needs].sort((a, b) => a - b);
  return out;
}

module.exports = { readSetups, labelBar, entryMinuteBar, periodKey, readC8, TIMEFRAMES, TIMEFRAME_KEYS, COMBOS, AUTO_COMBOS, C8, RULE_VERSION, BORDERLINE_CENTS };
