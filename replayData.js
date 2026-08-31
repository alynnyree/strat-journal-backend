const { fetchCandles } = require('./ftfcCheck');
const alpaca = require('./alpacaClient');

// How much extra time to grab on either side of the trade itself, so the
// replay shows a bit of lead-in and lead-out context instead of starting
// exactly on the entry candle with no setup visible beforehand.
const PADDING_MINUTES = 15;

// Schwab's day+minute price-history endpoint caps out at 10 days of
// 1-minute candles per request. A hold longer than that needs multiple
// requests walked backward from the window's end and stitched together —
// same chunking approach getOptionFills() uses in schwabClient.js, and for
// the same reason (a per-request cap on Schwab's side, not a limit on how
// long a real trade can run).
const CHUNK_DAYS = 10;

// Sanity ceiling on how many chunk requests one replay build will make —
// not a limit on real trade duration (options always expire, so a
// legitimate hold is bounded on its own), just a guard against looping
// forever if a caller ever passes a corrupt/nonsensical timestamp pair.
const MAX_CHUNKS = 500;

// The candle sizes Alpaca can serve, smallest first, and the most bars any
// one replay may hold. A day trade stays at one minute; only a long hold
// steps up.
const REPLAY_STEPS = [1, 3, 5, 15, 30, 60];
const MAX_REPLAY_BARS = 1200;

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

// Pulls the full 1-minute candle window covering a trade's entry through
// exit (plus padding on both sides) for the bar-replay feature, no matter
// how long the hold — walking backward in Schwab-sized pages to cover the
// whole span. Returns null if Schwab has none of that window left at
// 1-minute resolution (its ~30-35 day retention limit, the same one the
// underlying-price lookup runs into) — that's a hard ceiling on Schwab's
// side once the data has aged out; no request pattern gets it back. A long
// hold that straddles the edge of that window will come back with
// whatever portion of it Schwab still has, rather than nothing at all.
//
// For a still-open trade (no exitTimestampMs yet), pads around the entry
// only.
async function getReplayCandles(accessToken, ticker, entryTimestampMs, exitTimestampMs) {
  if (!entryTimestampMs) return null;
  const paddingMs = PADDING_MINUTES * 60 * 1000;

  const exitMs = exitTimestampMs || entryTimestampMs;
  const windowStart = entryTimestampMs - paddingMs;
  const windowEnd = exitMs + paddingMs;

  // Alpaca first. Its minute history goes back years, so a trade from
  // March can be replayed candle by candle — Schwab keeps about 35 days,
  // which is why older trades have always come back with nothing.
  // isReady(), not isConfigured() -- see alpacaClient.isReady.
  if (await alpaca.isReady()) {
    // The candle size is chosen so a replay is always a sensible NUMBER of
    // bars, however long the position was held.
    //
    // At one minute a day trade is about eighty bars, but the position he
    // held from 24 June to 23 July is nearly twenty-eight THOUSAND -- two
    // megabytes stored on that one trade, and nobody steps through
    // twenty-eight thousand bars one at a time. Held in memory for every
    // trade at once during a rebuild, that is a real part of why the
    // server kept running out of memory.
    //
    // A longer hold simply gets a bigger candle, so the whole trade is
    // still visible end to end and the replay stays a few hundred bars.
    const spanMinutes = Math.max(1, Math.round((windowEnd - windowStart) / 60000));
    const step = REPLAY_STEPS.find(m => spanMinutes / m <= MAX_REPLAY_BARS) || REPLAY_STEPS[REPLAY_STEPS.length - 1];
    const bars = await alpaca.fetchBars(ticker, { minutes: step, startMs: windowStart, endMs: windowEnd });
    if (bars && bars.length) {
      if (step > 1) {
        console.log(`Replay for ${ticker}: held ${Math.round(spanMinutes / 60 / 24)} day(s), so built from ${step}-minute candles (${bars.length} bars) rather than ${spanMinutes.toLocaleString()} one-minute ones.`);
      }
      return bars.slice(0, MAX_REPLAY_BARS).map(c => ({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0, datetime: c.datetime,
      }));
    }
  }

  const seen = new Set();
  const candles = [];
  let chunkEndMs = windowEnd;
  let chunks = 0;
  while (chunkEndMs > windowStart && chunks < MAX_CHUNKS) {
    chunks++;
    let raw;
    try {
      raw = await fetchCandles(accessToken, ticker, {
        periodType: 'day', period: CHUNK_DAYS, frequencyType: 'minute', frequency: 1, endDate: chunkEndMs,
      });
    } catch (e) {
      raw = [];
    }
    for (const c of raw) {
      if (c.datetime < windowStart || c.datetime > windowEnd) continue;
      if (seen.has(c.datetime)) continue;
      seen.add(c.datetime);
      candles.push({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0, datetime: c.datetime,
      });
    }
    chunkEndMs -= CHUNK_DAYS * 24 * 60 * 60 * 1000;
  }

  if (!candles.length) return null;
  candles.sort((a, b) => a.datetime - b.datetime);

  const entryIndex = findClosestIndex(candles, entryTimestampMs);
  const exitIndex = exitTimestampMs ? findClosestIndex(candles, exitTimestampMs) : null;

  // entryIndex null means the entry itself fell outside whatever Schwab
  // returned — the replay would have no anchor, so it isn't worth showing.
  if (entryIndex == null) return null;

  return { candles, entryIndex, exitIndex };
}

module.exports = { getReplayCandles };
