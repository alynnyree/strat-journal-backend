const { fetchCandles } = require('./ftfcCheck');

// How much extra time to grab on either side of the trade itself, so the
// replay shows a bit of lead-in and lead-out context instead of starting
// exactly on the entry candle with no setup visible beforehand.
const PADDING_MINUTES = 15;

// Finds the index of the last candle at or before a given timestamp — used
// to place the entry/exit markers on the exact right bar in the replay.
function findClosestIndex(candles, timestampMs) {
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
  const exitMs = exitTimestampMs || entryTimestampMs;
  const paddingMs = PADDING_MINUTES * 60 * 1000;
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
  const exitIndex = exitTimestampMs ? findClosestIndex(candles, exitTimestampMs) : null;

  return { candles, entryIndex, exitIndex };
}

module.exports = { getReplayCandles };
