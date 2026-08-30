const { fetchCandles } = require('./ftfcCheck');
const alpaca = require('./alpacaClient');
const { buildBars, stopFromBars, TF_SPECS } = require('./stopRule');

// Mechanically finds the trader's own Strat setups in real Schwab candles
// and plays each one forward to see what it actually did.
//
// THE DIVISION OF LABOUR HERE IS THE WHOLE POINT. A language model cannot
// backtest: it has no access to price history and cannot count, so asked
// for a win rate it will invent one that looks entirely credible. Every
// number this file produces is counted from real candles by ordinary
// arithmetic. The model is handed those finished numbers afterwards and
// asked only to interpret them. It never generates a figure.

// ---- Strat bar classification ---------------------------------------
// Each bar is numbered by how it relates to the one before it:
//   1 = inside      (high lower AND low higher — neither side taken)
//   2 = directional (exactly ONE side taken out)
//   3 = outside     (BOTH sides taken out)
function stratNumber(bar, prev) {
  if (!prev) return { n: null, dir: null };
  const tookHigh = bar.high > prev.high;
  const tookLow = bar.low < prev.low;
  if (tookHigh && tookLow) return { n: 3, dir: bar.close >= bar.open ? 'up' : 'down' };
  if (tookHigh) return { n: 2, dir: 'up' };
  if (tookLow) return { n: 2, dir: 'down' };
  return { n: 1, dir: null };
}

function numberBars(bars) {
  return bars.map((b, i) => ({ ...b, strat: stratNumber(b, bars[i - 1]) }));
}

const opposite = d => (d === 'up' ? 'down' : 'up');

// ---- Setup detectors -------------------------------------------------
// Each returns the index of the TRIGGER bar (the one whose break is the
// entry) and the direction taken. Named exactly as the app's own setup
// list, so results line up with the trades in the Journal.
//
// The combos are read literally from their names — a "2-1-2" is a 2, then
// an inside bar, then a 2 — which is the standard Strat reading and the
// only one the name supports.
const DETECTORS = {
  '2-1-2 Continuation': (b, i) =>
    b[i - 2]?.strat.n === 2 && b[i - 1]?.strat.n === 1 && b[i].strat.n === 2 &&
    b[i].strat.dir === b[i - 2].strat.dir ? b[i].strat.dir : null,

  '2-1-2 Reversal': (b, i) =>
    b[i - 2]?.strat.n === 2 && b[i - 1]?.strat.n === 1 && b[i].strat.n === 2 &&
    b[i].strat.dir === opposite(b[i - 2].strat.dir) ? b[i].strat.dir : null,

  '3-1-2 Reversal': (b, i) =>
    b[i - 2]?.strat.n === 3 && b[i - 1]?.strat.n === 1 && b[i].strat.n === 2
      ? b[i].strat.dir : null,

  '2-2 Continuation': (b, i) =>
    b[i - 1]?.strat.n === 2 && b[i].strat.n === 2 &&
    b[i].strat.dir === b[i - 1].strat.dir ? b[i].strat.dir : null,

  '2-2 Reversal': (b, i) =>
    b[i - 1]?.strat.n === 2 && b[i].strat.n === 2 &&
    b[i].strat.dir === opposite(b[i - 1].strat.dir) ? b[i].strat.dir : null,

  '3-2-2 Reversal': (b, i) =>
    b[i - 2]?.strat.n === 3 && b[i - 1]?.strat.n === 2 && b[i].strat.n === 2 &&
    b[i].strat.dir === opposite(b[i - 1].strat.dir) ? b[i].strat.dir : null,

  '1-2-2 Rev Strat': (b, i) =>
    b[i - 2]?.strat.n === 1 && b[i - 1]?.strat.n === 2 && b[i].strat.n === 2 &&
    b[i].strat.dir === opposite(b[i - 1].strat.dir) ? b[i].strat.dir : null,

  // The 50% Rule: one candle trades back into the halfway point of the
  // previous candle's range, then reverses to take out its opposite side.
  '1 Bar Rev Strat': (b, i) => {
    const prev = b[i - 1];
    if (!prev) return null;
    const mid = (prev.high + prev.low) / 2;
    const bar = b[i];
    if (bar.low <= mid && bar.high > prev.high) return 'up';
    if (bar.high >= mid && bar.low < prev.low) return 'down';
    return null;
  },

  // Pivot Machine Gun: a reversal after 5+ consecutive lower highs (then a
  // break upward), or 5+ consecutive higher lows (then a break downward).
  PMG: (b, i) => {
    const RUN = 5;
    if (i < RUN + 1) return null;
    let lowerHighs = true, higherLows = true;
    for (let k = i - RUN; k < i; k++) {
      if (!(b[k].high < b[k - 1].high)) lowerHighs = false;
      if (!(b[k].low > b[k - 1].low)) higherLows = false;
    }
    if (lowerHighs && b[i].high > b[i - 1].high) return 'up';
    if (higherLows && b[i].low < b[i - 1].low) return 'down';
    return null;
  },
};

const SETUP_KEYS = Object.keys(DETECTORS);

// ---- Playing a setup forward ----------------------------------------
// Entry is the level the trigger bar breaks — the previous bar's high for
// a long, its low for a short — which is where a Strat entry actually
// fires. The trade is then walked bar by bar until the stop or the target
// is reached.
//
// WHERE A SINGLE BAR CONTAINS BOTH the stop and the target, the stop is
// counted as hit first. Open/high/low/close cannot say which came first
// within a bar, and assuming the good outcome is exactly how a backtest
// flatters itself into uselessness.
function simulate(bars, triggerIdx, dir, entry, stop, targetR, maxBars) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const isLong = dir === 'up';
  const target = isLong ? entry + risk * targetR : entry - risk * targetR;
  const lastIdx = Math.min(bars.length - 1, triggerIdx + maxBars);

  for (let i = triggerIdx; i <= lastIdx; i++) {
    const bar = bars[i];
    const hitStop = isLong ? bar.low <= stop : bar.high >= stop;
    const hitTarget = isLong ? bar.high >= target : bar.low <= target;
    if (hitStop) return { outcome: 'stop', r: -1, exit: stop, barsHeld: i - triggerIdx + 1 };
    if (hitTarget) return { outcome: 'target', r: targetR, exit: target, barsHeld: i - triggerIdx + 1 };
  }

  // Ran out of room without reaching either. Closed at the last price seen
  // and scored at whatever it was actually worth, rather than thrown away.
  const close = bars[lastIdx].close;
  const r = (isLong ? close - entry : entry - close) / risk;
  return { outcome: 'timeout', r: Math.round(r * 100) / 100, exit: close, barsHeld: lastIdx - triggerIdx + 1 };
}

function summarise(trades, targetR) {
  const n = trades.length;
  if (!n) return { occurrences: 0, wins: 0, losses: 0, winRate: null, totalR: 0, avgR: null, expectancy: null };
  const wins = trades.filter(t => t.r > 0).length;
  const losses = trades.filter(t => t.r < 0).length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const round = v => Math.round(v * 100) / 100;
  return {
    occurrences: n,
    wins, losses,
    scratches: n - wins - losses,
    winRate: Math.round((wins / n) * 100),
    totalR: round(totalR),
    avgR: round(totalR / n),
    hitTarget: trades.filter(t => t.outcome === 'target').length,
    stoppedOut: trades.filter(t => t.outcome === 'stop').length,
    ranOut: trades.filter(t => t.outcome === 'timeout').length,
    targetR,
  };
}

// Runs one setup on one timeframe over a set of bars.
function backtestOne(rawBars, { setup, timeframe, targetR, largeMultiple, lookback, maxBars }) {
  const bars = numberBars(rawBars);
  const detect = DETECTORS[setup];
  const trades = [];
  for (let i = 2; i < bars.length; i++) {
    const dir = detect(bars, i);
    if (!dir) continue;
    const prev = bars[i - 1];
    const entry = dir === 'up' ? prev.high : prev.low;

    // The trader's own stop rule, reused rather than reinvented, so a
    // backtest is measured the same way his real trades are.
    const stopInfo = stopFromBars(bars.slice(0, i + 1), {
      entryTimestampMs: bars[i].datetime,
      dir: dir === 'up' ? 'Long' : 'Short',
      timeframe, largeMultiple, lookback,
    });
    if (stopInfo.stop == null) continue;

    const result = simulate(bars, i, dir, entry, stopInfo.stop, targetR, maxBars);
    if (!result) continue;
    trades.push({
      when: new Date(bars[i].datetime).toISOString(),
      dir: dir === 'up' ? 'Long' : 'Short',
      entry: Math.round(entry * 100) / 100,
      stop: stopInfo.stop,
      stopBasis: stopInfo.basis,
      ...result,
    });
  }
  return { setup, timeframe, trades, summary: summarise(trades, targetR) };
}

// ---- Getting the candles ---------------------------------------------
// Schwab serves at most 10 days of minute data per request, so a longer
// window is walked backwards in 10-day pages and stitched together — the
// same approach replayData.js uses, and for the same reason. Its minute
// data also only goes back about 30-35 days in total; past that there is
// nothing to fetch at any page size, which is a hard ceiling on how far
// an intraday backtest can reach.
const CHUNK_DAYS = 10;
const MAX_INTRADAY_DAYS = 35;

// Alpaca first, because its minute history goes back years and Schwab's
// stops at about 35 days. That ceiling is the reason a backtest could
// only ever look at the last month, which is not long enough to say
// anything about a strategy.
//
// Falls back to Schwab whenever Alpaca is not set up or cannot answer, so
// this is purely additive: without keys the behaviour is what it was.
async function fetchWindow(accessToken, ticker, frequency, days) {
  if (alpaca.isConfigured()) {
    const startMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const bars = await alpaca.fetchBars(ticker, { minutes: frequency, startMs, endMs: Date.now() });
    // null means Alpaca could not answer; an empty list means it answered
    // and there genuinely is nothing. Only the first is worth falling
    // back from -- retrying an honest "no data" against Schwab would just
    // reintroduce the 35-day ceiling for no reason.
    if (bars && bars.length) return bars;
    if (bars) return bars;
  }
  const wanted = Math.min(days, MAX_INTRADAY_DAYS);
  const seen = new Set();
  const out = [];
  let endMs = Date.now();
  for (let fetched = 0; fetched < wanted; fetched += CHUNK_DAYS) {
    const chunk = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: CHUNK_DAYS, frequencyType: 'minute',
      frequency, endDate: endMs,
    });
    if (!chunk.length) break;
    for (const c of chunk) {
      if (seen.has(c.datetime)) continue;
      seen.add(c.datetime);
      out.push(c);
    }
    endMs = chunk[0].datetime - 60000; // step back past the oldest we just got
  }
  return out.sort((a, b) => a.datetime - b.datetime);
}

async function fetchDaily(accessToken, ticker, years) {
  if (alpaca.isConfigured()) {
    const startMs = Date.now() - Math.max(1, years) * 365 * 24 * 60 * 60 * 1000;
    const bars = await alpaca.fetchBars(ticker, { daily: true, startMs, endMs: Date.now() });
    if (bars) return bars;
  }
  return fetchCandles(accessToken, ticker, {
    periodType: 'year', period: Math.max(1, Math.min(20, years)),
    frequencyType: 'daily', frequency: 1, endDate: Date.now(),
  });
}

const DAILY_TF = '1D';
const TIMEFRAME_OPTIONS = [...Object.keys(TF_SPECS), DAILY_TF];

// How many bars forward a trade is allowed to run before it is closed at
// whatever it is worth. Roughly a session on each timeframe — a Strat
// intraday trade that has gone nowhere in that long is over, and letting
// it run indefinitely would let one lucky drift dominate the results.
const MAX_BARS_FORWARD = { '1m': 120, '3m': 60, '5m': 48, '10m': 30, '15m': 26, '30m': 13, '1H': 12, '1D': 10 };

// Runs every requested setup on every requested timeframe. Returns the
// counted results only — no interpretation, no opinion.
async function runBacktest(accessToken, { ticker, setups, timeframes, days = 30, targetR = 2, largeMultiple = 1.5, lookback = 20 }) {
  const results = [];
  const notes = [];

  const usingAlpaca = alpaca.isConfigured();
  if (!usingAlpaca) {
    notes.push(`Intraday history is limited to about ${MAX_INTRADAY_DAYS} days because Alpaca is not connected — connect it to test over years instead of weeks.`);
  }

  for (const tf of timeframes) {
    let raw, bars;
    if (tf === DAILY_TF) {
      const years = Math.max(1, Math.ceil(days / 365));
      raw = await fetchDaily(accessToken, ticker, years);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      bars = raw.filter(c => c.datetime >= cutoff);
    } else {
      const spec = TF_SPECS[tf];
      if (!spec) { notes.push(`Skipped "${tf}" — not a timeframe this can build.`); continue; }
      if (days > MAX_INTRADAY_DAYS) {
        notes.push(`${tf}: Schwab only keeps about ${MAX_INTRADAY_DAYS} days of minute data, so this covers the last ${MAX_INTRADAY_DAYS} days rather than ${days}.`);
      }
      raw = await fetchWindow(accessToken, ticker, spec.frequency, days);
      bars = buildBars(raw, spec.minutes);
    }

    if (bars.length < 30) {
      notes.push(`${tf}: only ${bars.length} candles came back — not enough to test anything on.`);
      continue;
    }

    const first = bars[0].datetime, last = bars[bars.length - 1].datetime;
    for (const setup of setups) {
      if (!DETECTORS[setup]) { notes.push(`Skipped "${setup}" — not one of the nine setups.`); continue; }
      const r = backtestOne(bars, {
        setup, timeframe: tf, targetR, largeMultiple, lookback,
        maxBars: MAX_BARS_FORWARD[tf] || 30,
      });
      results.push({
        ...r,
        barsSearched: bars.length,
        from: new Date(first).toISOString(),
        to: new Date(last).toISOString(),
        // The individual trades are kept but trimmed — enough to look at
        // and enough for the model to reason over, without shipping
        // thousands of rows to a phone.
        trades: r.trades.slice(0, 40),
        tradeCount: r.trades.length,
      });
    }
  }
  return { ticker, targetR, days, results, notes };
}

module.exports = {
  stratNumber, numberBars, DETECTORS, SETUP_KEYS,
  simulate, summarise, backtestOne,
  runBacktest, fetchWindow, TIMEFRAME_OPTIONS, MAX_INTRADAY_DAYS, DAILY_TF,
};
