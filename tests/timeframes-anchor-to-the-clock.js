// He asked, after the 5 and 15 minute replay bars turned out to be wrong:
// "How do we make sure that this is correct..now and moving forward?"
//
// The sweep that question forced up found the SAME fault in the thirteen-
// timeframe reading -- the numbers behind every FTFC figure on his
// Dashboard. Not guessed: measured by running the real functions.
//
// intradayBarOpen took "the first candle I happen to have for this day"
// as the session start. sessionCandles filtered by DATE only. Schwab is
// asked with needExtendedHoursData:false so its candles begin at 09:30 --
// but Alpaca is asked FIRST for minute data and has no such setting, so
// pre-market bars arrive with everything else.
//
// Measured, for an entry at 10:42:
//   candles from 09:30 -> 1-hour bar opens 10:30   (right)
//   candles from 04:00 -> 1-hour bar opens 10:00   (wrong)
//   candles from 06:07 -> 3m, 5m, 15m, 30m AND 1H all wrong
//
// 06:07 is the realistic one: Alpaca returns a bar only where a trade
// happened, and IWM before dawn is thin.
//
// WHAT THIS FILE CANNOT DO: reach Alpaca. There are no keys here, so it
// cannot prove what his key returns. It proves the other half -- that
// whatever arrives, the answer is now the same. That is the half that
// makes the question moot.
const fs = require('fs');
const path = require('path');

// The REAL functions, lifted out of the file that runs rather than
// rewritten here. A stand-in would test itself.
const src = fs.readFileSync(path.join(__dirname, '..', 'ftfcCheck.js'), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
};
const EASTERN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
});
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;
eval(grab('easternDate'));
// Written so this file still RUNS against the version before the fix. A
// test that falls over on a missing name proves only that the name is
// missing -- it never reaches the behaviour, which is the thing worth
// proving it catches.
if (src.includes('function easternMinutesOfDay(')) {
  eval(grab('easternMinutesOfDay'));
} else {
  global.easternMinutesOfDay = function (ms) {
    const p = Object.fromEntries(EASTERN_CLOCK.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    let hour = Number(p.hour); if (hour === 24) hour = 0;
    return hour * 60 + Number(p.minute);
  };
}
eval(grab('sessionCandles'));
eval(grab('intradayBarOpen'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };
const et = ms => new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour12:false,
  hour:'2-digit', minute:'2-digit' }).format(new Date(ms));

// Minute candles from a given New York time. June, so New York is UTC-4.
// Each candle's `open` is its own minute-of-day, which makes it trivial to
// say WHICH candle an answer came from.
const from = (h, m, count) => {
  const out = []; let t = Date.UTC(2026, 5, 24, h + 4, m);
  for (let i = 0; i < count; i++) {
    out.push({ datetime: t, open: (h * 60 + m + i), high: 0, low: 0, close: 0 });
    t += 60000;
  }
  return out;
};
const asClock = mins => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
// Where a bar containing `atMin` SHOULD start: session open plus a whole
// number of periods. Derived, not copied off what the code says.
const shouldOpenAt = (atMin, period) => SESSION_OPEN_MIN + Math.floor((atMin - SESSION_OPEN_MIN) / period) * period;

const ENTRY_MIN = 10 * 60 + 42;                       // 10:42
const entry = Date.UTC(2026, 5, 24, 10 + 4, 42);

console.log('--- the answer must not depend on when the data happens to start ---');
{
  // Four days that differ ONLY in what the provider sent back.
  const starts = [
    ['regular hours only (Schwab)', from(9, 30, 390)],
    ['pre-market from 04:00 (Alpaca)', from(4, 0, 17 * 60)],
    ['pre-market from 07:00', from(7, 0, 14 * 60)],
    ['thin pre-market, first trade 06:07', from(6, 7, 15 * 60)],
  ];
  for (const period of [1, 3, 5, 15, 30, 60, 120, 240]) {
    const want = shouldOpenAt(ENTRY_MIN, period);
    const got = starts.map(([, candles]) => intradayBarOpen(sessionCandles(candles, entry), entry, period));
    const allRight = got.every(v => v === want);
    const label = period < 60 ? period + 'm' : (period / 60) + 'H';
    check(`${label}: every one of the four says ${asClock(want)} (got ${got.map(asClock).join(' ')})`, allRight);
  }
}

console.log('\n--- after-hours bars are left out too, not just pre-market ---');
{
  // A day running 09:30 to 20:00. An entry at 15:50 must read the 16:00
  // close as the end of the session, not 20:00.
  const day = from(9, 30, (20 - 9) * 60 + 30);
  const kept = sessionCandles(day, entry);
  const last = kept[kept.length - 1];
  check(`the last candle kept is before 16:00 (${et(last.datetime)})`, last.open < SESSION_CLOSE_MIN);
  check(`and the first is 09:30 (${et(kept[0].datetime)})`, kept[0].open === SESSION_OPEN_MIN);
  check(`nothing outside the session survived (${kept.length} candles, 390 in a session)`, kept.length === 390);
}

console.log('\n--- a missing 09:30 candle must not shift anything ---');
{
  // A halt, a late open, or simply no trade in that minute. Taking the
  // first candle in hand as the anchor would move every bar; anchoring to
  // the clock cannot.
  const late = from(9, 30, 390).filter(c => c.open > 9 * 60 + 33);
  for (const period of [5, 15, 30, 60]) {
    const want = shouldOpenAt(ENTRY_MIN, period);
    const got = intradayBarOpen(sessionCandles(late, entry), entry, period);
    const label = period < 60 ? period + 'm' : (period / 60) + 'H';
    check(`${label}: still ${asClock(want)} with the first four minutes missing (got ${asClock(got)})`, got === want);
  }
}

console.log('\n--- an entry before the open still refuses rather than guessing ---');
{
  const pre = Date.UTC(2026, 5, 24, 8 + 4, 15);        // 08:15 New York
  const got = intradayBarOpen(sessionCandles(from(4, 0, 17 * 60), pre), pre, 15);
  check('a pre-market moment answers "not known", never a made-up bar', got === null);
}

console.log('\n--- and the answers are the RIGHT ones, not merely consistent ---');
{
  // Consistency alone would pass if every case were wrong the same way.
  // These are the bar starts a 10:42 entry belongs in, worked out from the
  // session open by hand.
  const want = { 1:'10:42', 3:'10:42', 5:'10:40', 15:'10:30', 30:'10:30', 60:'10:30', 120:'09:30', 240:'09:30' };
  const day = from(9, 30, 390);
  for (const period of Object.keys(want).map(Number)) {
    const got = intradayBarOpen(sessionCandles(day, entry), entry, period);
    const label = period < 60 ? period + 'm' : (period / 60) + 'H';
    check(`${label} bar containing 10:42 starts ${want[period]} (got ${asClock(got)})`, asClock(got) === want[period]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
