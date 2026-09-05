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

// One shape, every path. This function used to hand back a bare LIST of
// bars when Alpaca answered and a labelled package when Schwab did — and
// every reader asks for `.candles`, so an Alpaca-served replay read as
// empty while 36 perfectly good bars sat in the return value. Bar Replay
// had therefore never once worked on Alpaca data. Any function with more
// than one way out returns the same shape from all of them.
//
// It also never comes back with a bare null. An empty answer now carries
// the REASON it is empty, in plain words, so whatever shows it can say
// which part refused instead of inventing a cause — the caller decides
// whether to display it, but it never has to guess at it.
function shapeReplay(candles, entryMs, exitMs, stepMinutes, source) {
  const stepMs = Math.max(1, stepMinutes || 1) * 60 * 1000;
  const at = (ms) => {
    if (ms == null || !candles.length) return null;
    const i = findClosestIndex(candles, ms);
    if (i != null) return i;
    // A bigger candle can begin after the moment it ought to mark, or end
    // before it — the moment is still inside that bar's stretch of time,
    // so it belongs on that bar rather than being dropped.
    if (ms >= candles[0].datetime - stepMs) return 0;
    if (ms <= candles[candles.length - 1].datetime + stepMs) return candles.length - 1;
    return null;
  };
  const entryIndex = at(entryMs);
  if (!candles.length) {
    return { candles: [], entryIndex: null, exitIndex: null, source, reason: null };
  }
  if (entryIndex == null) {
    return {
      candles: [], entryIndex: null, exitIndex: null, source,
      reason: `${source} sent ${candles.length} bars for that day, but none of them covers the minute you entered.`,
    };
  }
  return { candles, entryIndex, exitIndex: at(exitMs), source, reason: null };
}

function emptyReplay(reason) {
  return { candles: [], entryIndex: null, exitIndex: null, source: null, reason };
}

// Pulls the candle window covering a trade's entry through exit (plus
// padding on both sides) for the bar-replay feature, no matter how long the
// hold. Alpaca is asked first — its minute history goes back years, where
// Schwab keeps about 30-35 days, which is why older trades used to come
// back with nothing at all.
//
// For a still-open trade (no exitTimestampMs yet), pads around the entry
// only.
async function getReplayCandles(accessToken, ticker, entryTimestampMs, exitTimestampMs) {
  if (!entryTimestampMs) return emptyReplay('That trade has no entry time on file, so there is no window to replay.');
  const paddingMs = PADDING_MINUTES * 60 * 1000;

  const exitMs = exitTimestampMs || entryTimestampMs;
  const windowStart = entryTimestampMs - paddingMs;
  const windowEnd = exitMs + paddingMs;

  // isReady(), not isConfigured() -- see alpacaClient.isReady.
  let alpacaReason = null;
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

    const feed = (alpaca.feedState && alpaca.feedState()) || {};
    const grade = feed.feed === 'iex' ? 'Alpaca, on the free market data'
                : feed.feed === 'sip' ? 'Alpaca, on the full market data'
                : 'Alpaca';

    let bars = null;
    let failed = null;
    try {
      bars = await alpaca.fetchBars(ticker, { minutes: step, startMs: windowStart, endMs: windowEnd });
    } catch (err) {
      failed = err && err.message ? err.message : 'the request did not complete';
    }

    if (failed) {
      // Not silent, and not fatal: Schwab still gets its turn below, but
      // the reason survives so it can be reported if Schwab has nothing
      // either.
      console.log(`Replay for ${ticker}: Alpaca refused the bars request (${failed}); falling back to Schwab.`);
      alpacaReason = `${grade}, could not complete the request for those minutes.`;
    } else if (bars && bars.length) {
      if (step > 1) {
        console.log(`Replay for ${ticker}: held ${Math.round(spanMinutes / 60 / 24)} day(s), so built from ${step}-minute candles (${bars.length} bars) rather than ${spanMinutes.toLocaleString()} one-minute ones.`);
      }
      const trimmed = bars.slice(0, MAX_REPLAY_BARS).map(c => ({
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0, datetime: c.datetime,
      }));
      return shapeReplay(trimmed, entryTimestampMs, exitTimestampMs, step, grade);
    } else {
      alpacaReason = `${grade}, answered but has no bars for those minutes.`;
    }
  }

  const seen = new Set();
  const candles = [];
  let chunkEndMs = windowEnd;
  let chunks = 0;
  let refusedChunks = 0;   // a swallowed failure in a loop is an invisible failure
  let lastRefusal = null;
  while (chunkEndMs > windowStart && chunks < MAX_CHUNKS) {
    chunks++;
    let raw;
    try {
      raw = await fetchCandles(accessToken, ticker, {
        periodType: 'day', period: CHUNK_DAYS, frequencyType: 'minute', frequency: 1, endDate: chunkEndMs,
      });
    } catch (e) {
      raw = [];
      refusedChunks++;
      lastRefusal = e && e.message ? e.message : null;
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

  if (candles.length) {
    candles.sort((a, b) => a.datetime - b.datetime);
    return shapeReplay(candles, entryTimestampMs, exitTimestampMs, 1, 'Schwab');
  }

  // Nothing anywhere. Say which part came up empty and why, rather than
  // leaving whoever shows this to invent a cause.
  const ageDays = Math.floor((Date.now() - entryTimestampMs) / 86400000);
  if (refusedChunks) {
    console.log(`Replay for ${ticker}: Schwab refused ${refusedChunks} of ${chunks} requests (${lastRefusal || 'no reason given'}).`);
  }
  const schwabPart = refusedChunks === chunks
    ? `Schwab turned down all ${chunks} request${chunks === 1 ? '' : 's'} for those minutes.`
    : refusedChunks
      ? `Schwab turned down ${refusedChunks} of ${chunks} requests and had nothing for the rest.`
      : `Schwab has no minute-by-minute data left for that day — it keeps about 35 days, and this trade is ${ageDays} days old.`;
  return emptyReplay(alpacaReason ? `${alpacaReason} ${schwabPart}` : schwabPart);
}

module.exports = { getReplayCandles, shapeReplay };
