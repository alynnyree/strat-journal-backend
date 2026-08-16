const { fetchCandles } = require('./ftfcCheck');

// How much extra time to grab on either side of the trade itself, so the
// replay shows a bit of lead-in and lead-out context instead of starting
// exactly on the entry candle with no setup visible beforehand.
const PADDING_MINUTES = 15;

// Hard ceiling on how much of the trade window the replay will cover.
// Without this, a mis-paired trade (an entry matched to an exit days or
// weeks later) produces a replay of thousands of candles spanning the
// whole gap — which is unusable, and is what caused a NIO "trade" dated
// Jun 24 to load ~3,700 candles running through Jul 23.
//
// These are scalps/day-trades, so anything beyond a few hours is a
// pairing problem, not a real hold. Capping here keeps the replay useful
// no matter what the matcher hands us.
const MAX_WINDOW_MINUTES = 240; // 4 hours

// Finds the index of the last candle at or before a given timestamp — used
// to place the entry/exit markers on the exact right bar in the replay.
// Returns null when the timestamp falls outside the candle range entirely,
// so a marker is left off rather than being pinned to the wrong bar.
function findClosestIndex(candles, timestampMs) {
  if (!candles.length) return null;
  if (timestampMs < candles[0].datetime) return null;
  if (timestampMs > candles[candles.length - 1].datetime) return null;
  let closest = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].datetime <= timestampMs) closest = i;
    else break;
  }
  return closest;
}

// Pulls the 1-minute candle window covering a trade's entry through exit
// (plus padding on both sides) for the bar-replay feature. Returns null if
// Schwab has no minute data for that window (same ~30-35 day retention
// limit as the underlying-price lookup) so the frontend can skip showing
// a replay player rather than showing a broken one.
//
// For a still-open trade (no exitTimestampMs yet), pads around the entry
// only.
async function getReplayCandles(accessToken, ticker, entryTimestampMs, exitTimestampMs) {
  if (!entryTimestampMs) return null;
  const paddingMs = PADDING_MINUTES * 60 * 1000;
  const maxSpanMs = MAX_WINDOW_MINUTES * 60 * 1000;

  let exitMs = exitTimestampMs || entryTimestampMs;
  // Clamp an implausibly long entry-to-exit span down to the cap. The
  // replay then covers the entry and the hours after it, which is the part
  // actually worth reviewing, instead of every candle up to a far-off exit.
  const spanWasClamped = exitMs - entryTimestampMs > maxSpanMs;
  if (spanWasClamped) exitMs = entryTimestampMs + maxSpanMs;

  const windowStart = entryTimestampMs - paddingMs;
  const windowEnd = exitMs + paddingMs;

  // A trade's entry-to-exit window is always well under Schwab's 10-day
  // per-request cap for minute data, so one call anchored at windowEnd
  // covers the whole thing.
  const raw = await fetchCandles(accessToken, ticker, {
    periodType: 'day', period: 10, frequencyType: 'minute', frequency: 1, endDate: windowEnd,
  }).catch(() => []);

  const candles = raw
    .filter(c => c.datetime >= windowStart && c.datetime <= windowEnd)
    .map(c => ({
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume || 0, datetime: c.datetime,
    }));

  if (!candles.length) return null;

  const entryIndex = findClosestIndex(candles, entryTimestampMs);
  // If the exit was clamped away, there's no real exit bar inside this
  // window — leave the marker off rather than pointing at the wrong candle.
  const exitIndex = (exitTimestampMs && !spanWasClamped)
    ? findClosestIndex(candles, exitTimestampMs)
    : null;

  // entryIndex null means the entry itself fell outside whatever Schwab
  // returned — the replay would have no anchor, so it isn't worth showing.
  if (entryIndex == null) return null;

  return { candles, entryIndex, exitIndex, windowClamped: spanWasClamped };
}

module.exports = { getReplayCandles };
