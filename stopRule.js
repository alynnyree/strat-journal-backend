const { fetchCandles } = require('./ftfcCheck');

// Works out where the stop belongs from the trader's own rule, rather than
// leaving it blank the way an auto-imported trade does today.
//
// His rule, in his words: "the stop loss is the bottom of previous candle
// or most of the time the half way point (50% mark) of previous candle...
// If the candle is rather large instead of the stop loss being at the
// bottom of previous candle, the stop loss will most likely be at 50%
// mark." That is one rule with a size switch, not nine separate rules —
// so it is implemented once and applies to every combo.
//
// "Previous candle" means the candle immediately BEFORE the one the entry
// landed in: in the Strat you enter when price takes out the prior
// candle's high or low, so that prior candle is the trigger and the level
// underneath it is the risk.

// Which timeframes can be built, and how. Schwab serves 1/5/10/15/30
// minute bars natively; anything else has to be built by grouping them.
const TF_SPECS = {
  '1m':  { frequency: 1,  minutes: 1 },
  '3m':  { frequency: 1,  minutes: 3 },
  '5m':  { frequency: 5,  minutes: 5 },
  '10m': { frequency: 10, minutes: 10 },
  '15m': { frequency: 15, minutes: 15 },
  '30m': { frequency: 30, minutes: 30 },
  '1H':  { frequency: 30, minutes: 60 },
};
const TIMEFRAME_CHOICES = Object.keys(TF_SPECS);

const DEFAULTS = {
  enabled: true,
  timeframe: '5m',
  // How much bigger than usual a candle has to be before the stop moves up
  // to the halfway mark. Deliberately a setting rather than a constant:
  // "rather large" is the trader's judgement, and no number picked here
  // would be his.
  largeMultiple: 1.5,
  lookback: 20,
};

// Bars are grouped against the 9:30 ET session open, not against the clock
// or the epoch, because that is where a charting app draws them — an
// hourly bar on a US equity chart runs 9:30-10:30, not 9:00-10:00. Getting
// this wrong shifts every bar boundary and therefore every stop.
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const SESSION_OPEN_MINUTES = 9 * 60 + 30;

function etParts(ms) {
  const parts = {};
  for (const p of ET_FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Midnight comes back as "24" from some ICU builds; normalise it.
  const hour = parseInt(parts.hour, 10) % 24;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + parseInt(parts.minute, 10),
  };
}

// Groups smaller bars into larger ones, keeping the HIGH and LOW. The
// existing aggregateCandles() in ftfcCheck.js keeps only open/close, which
// is all a bull/bear check needs but is exactly the wrong shape here — the
// whole rule is about the top and bottom of a bar.
function buildBars(raw, minutes) {
  const buckets = new Map();
  for (const c of raw) {
    if (c == null || c.datetime == null) continue;
    const { day, minutes: mins } = etParts(c.datetime);
    const slot = Math.floor((mins - SESSION_OPEN_MINUTES) / minutes);
    const key = `${day}#${slot}`;
    const bar = buckets.get(key);
    if (!bar) {
      buckets.set(key, {
        datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close,
      });
    } else {
      bar.high = Math.max(bar.high, c.high);
      bar.low = Math.min(bar.low, c.low);
      bar.close = c.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.datetime - b.datetime);
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The candle the entry landed in is the last one starting at or before the
// entry; the trigger is the one before that.
function findTriggerIndex(bars, entryTimestampMs) {
  let entryIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].datetime <= entryTimestampMs) entryIdx = i; else break;
  }
  if (entryIdx <= 0) return -1;
  return entryIdx - 1;
}

const round2 = n => Math.round(n * 100) / 100;

// Decides the level from a set of bars. Split out from the fetching so it
// can be tested against hand-built candles with no network anywhere.
function stopFromBars(bars, { entryTimestampMs, dir, timeframe, largeMultiple, lookback }) {
  const triggerIdx = findTriggerIndex(bars, entryTimestampMs);
  if (triggerIdx < 0) {
    return { stop: null, reason: `No ${timeframe} candle before the entry to measure from.` };
  }
  const trigger = bars[triggerIdx];
  const range = trigger.high - trigger.low;

  const priorRanges = bars.slice(Math.max(0, triggerIdx - lookback), triggerIdx)
    .map(b => b.high - b.low)
    .filter(r => r > 0);
  const typical = median(priorRanges);

  // Too little history to say what "typical" even is. Falling back to the
  // full candle is the conservative half of his rule — a wider stop risks
  // more per trade but does not invent a tighter one from no evidence.
  const enoughHistory = priorRanges.length >= 5 && typical > 0;
  // Rounded BEFORE the comparison, deliberately. Floating-point makes a
  // candle that is exactly 1.5x measure as 1.4999999999999987, so a
  // candle the app displays as "1.5x typical" would be judged normal
  // against a 1.5 setting — the shown number and the decision have to
  // agree or the setting is untunable.
  const sizeRatio = enoughHistory ? Math.round((range / typical) * 100) / 100 : null;
  const isLarge = enoughHistory && sizeRatio >= largeMultiple;

  const isShort = String(dir).toLowerCase() === 'short';
  const midpoint = (trigger.high + trigger.low) / 2;
  const stop = isLarge ? midpoint : (isShort ? trigger.high : trigger.low);

  const edge = isShort ? 'top' : 'bottom';
  const basis = isLarge ? 'half' : 'full';
  const when = new Date(trigger.datetime).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  });

  let reason;
  if (isLarge) {
    reason = `Halfway point of the ${timeframe} trigger candle (${when} ET), because that candle was ${sizeRatio.toFixed(1)}x the size of a typical recent one.`;
  } else if (!enoughHistory) {
    reason = `${edge === 'top' ? 'Top' : 'Bottom'} of the ${timeframe} trigger candle (${when} ET). Not enough earlier candles to judge whether it was a large one, so the full candle was used.`;
  } else {
    reason = `${edge === 'top' ? 'Top' : 'Bottom'} of the ${timeframe} trigger candle (${when} ET) — a normal-sized candle at ${sizeRatio.toFixed(1)}x typical.`;
  }

  return {
    stop: round2(stop),
    basis,
    timeframe,
    reason,
    sizeRatio,
    typicalRange: round2(typical),
    triggerCandle: {
      datetime: trigger.datetime,
      open: round2(trigger.open), high: round2(trigger.high),
      low: round2(trigger.low), close: round2(trigger.close),
    },
  };
}

async function computeStopForTrade(accessToken, trade, settings = {}) {
  const cfg = { ...DEFAULTS, perSetup: {}, ...settings };
  const timeframe = timeframeForTrade(trade, cfg);
  const spec = TF_SPECS[timeframe];
  if (!spec) return { stop: null, reason: `Unknown timeframe "${timeframe}".` };
  if (!trade.entryTimestamp) return { stop: null, reason: 'This trade has no entry time to measure from.' };

  const raw = await fetchCandles(accessToken, trade.ticker, {
    periodType: 'day', period: 10, frequencyType: 'minute',
    frequency: spec.frequency, endDate: trade.entryTimestamp,
  });
  if (!raw.length) {
    return { stop: null, reason: 'Schwab has no candle data left for that date (it keeps minute data about 30-35 days).' };
  }
  const bars = buildBars(raw, spec.minutes);
  return stopFromBars(bars, {
    entryTimestampMs: trade.entryTimestamp,
    dir: trade.dir,
    timeframe,
    largeMultiple: cfg.largeMultiple,
    lookback: cfg.lookback,
  });
}

// ---- Settings -------------------------------------------------------
// Kept on the server rather than only in the phone's browser, because the
// automatic sync runs here with no phone involved — settings the server
// cannot read would never be applied to an auto-imported trade, which is
// the whole point of the feature.
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();
const SETTINGS_KEY = 'stopRule:settings';

async function loadSettings() {
  try {
    const raw = await redis.get(SETTINGS_KEY);
    const saved = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return { ...DEFAULTS, perSetup: {}, ...saved };
  } catch (err) {
    console.log('Could not read stop-rule settings (using defaults):', err.message);
    return { ...DEFAULTS, perSetup: {} };
  }
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await redis.set(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// Which timeframe a given trade should be measured on. The trader said his
// timeframe varies, so this goes most-specific first: a timeframe he set on
// this one trade, then one he set for this setup, then his general default.
// Per-setup defaults matter because the timeframe plausibly varies WITH the
// setup rather than at random — a 1 Bar Rev Strat and a 2-1-2 are not
// usually taken on the same chart.
function timeframeForTrade(trade, settings) {
  return trade.stopTimeframe
    || (settings.perSetup && settings.perSetup[trade.strat])
    || settings.timeframe;
}

module.exports = {
  computeStopForTrade, stopFromBars, buildBars, median, findTriggerIndex,
  loadSettings, saveSettings, timeframeForTrade,
  TF_SPECS, TIMEFRAME_CHOICES, DEFAULTS,
};
