const axios = require('axios');
const alpaca = require('./alpacaClient');

// Schwab's Market Data API lives under a different base path than the
// Trader API used elsewhere in this app.
const MARKET_DATA_BASE = 'https://api.schwabapi.com/marketdata/v1';

const TIMEFRAMES = ['6M', '3M', '1M', '1W', '1D', '4H', '2H', '1H', '30m', '15m', '5m', '3m', '1m'];

async function schwabMarketGet(pathname, accessToken, params = {}) {
  const resp = await axios.get(`${MARKET_DATA_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return resp.data;
}

// Confirmed Schwab price-history parameters (per developer.schwab.com):
// periodType 'day' only supports frequencyType 'minute', with frequency
// 1/5/10/15/30. periodType 'year' supports daily/weekly/monthly. There is
// no native 3-minute, hourly, or multi-month bar — those are built below
// by grouping smaller candles together.
// Alpaca first for INTRADAY candles, because Schwab keeps only about 35
// days of them. That ceiling is why an older trade's smaller timeframes
// come back empty and its timeframe alignment is judged on the daily and
// above alone -- a materially weaker answer than the one a recent trade
// gets, with nothing on screen saying so.
//
// Daily and longer stay with Schwab: it serves years of those already,
// and there is no reason to move something that works.
//
// Falls back to Schwab whenever Alpaca is not set up or cannot answer, so
// nothing here changes for someone without keys.
async function fetchCandles(accessToken, symbol, { periodType, period, frequencyType, frequency, endDate }) {
  if (frequencyType === 'minute' && alpaca.isConfigured()) {
    const days = Math.max(1, Number(period) || 1);
    const endMs = endDate || Date.now();
    const bars = await alpaca.fetchBars(symbol, {
      minutes: Number(frequency) || 1,
      startMs: endMs - days * 24 * 60 * 60 * 1000,
      endMs,
    });
    if (bars && bars.length) return bars;
  }
  const data = await schwabMarketGet('/pricehistory', accessToken, {
    symbol, periodType, period, frequencyType, frequency, endDate, needExtendedHoursData: false,
  });
  return data?.candles || [];
}

// Groups consecutive candles into one larger synthetic candle — e.g. three
// 1-minute candles become one 3-minute candle (open of the first, close of
// the last); eight 30-minute candles become one 4-hour candle.
function aggregateCandles(candles, groupSize) {
  const groups = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const chunk = candles.slice(i, i + groupSize);
    if (chunk.length < groupSize) continue; // incomplete trailing group — skip, not a full bar yet
    groups.push({ open: chunk[0].open, close: chunk[chunk.length - 1].close, datetime: chunk[chunk.length - 1].datetime });
  }
  return groups;
}

// The core rule: bullish if trading above that candle's own open, bearish
// if below. Flat (open === close) is left blank rather than guessed either way.
function bullBear(candle) {
  if (!candle) return undefined;
  if (candle.close > candle.open) return 'bull';
  if (candle.close < candle.open) return 'bear';
  return undefined;
}

function lastCandleBefore(candles, beforeMs) {
  const eligible = candles.filter(c => c.datetime <= beforeMs);
  return eligible.length ? eligible[eligible.length - 1] : null;
}

// Schwab's option transaction data never includes what the underlying
// stock itself was trading at — only the option's own price. This looks
// up the underlying's actual price at a specific moment (a trade's entry
// or exit).
//
// Schwab's price-history API only retains 1-minute candles for roughly
// 30-35 days — trades older than that will always come back empty at
// 1-minute resolution, that's a hard ceiling on Schwab's side, not a bug
// here. Rather than jumping straight from 1-minute to a daily candle (which
// gives every trade on the same day the exact same price and looks
// obviously wrong), this cascades through progressively coarser intraday
// bars first — 5-minute, then 30-minute — since Schwab retains those
// longer than raw 1-minute data. Daily is the last resort, only used once
// the trade is old enough that even 30-minute history is gone.
async function tryIntradayLookup(accessToken, ticker, timestampMs, frequency) {
  try {
    const candles = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency, endDate: timestampMs,
    }).catch(() => []);
    const candle = lastCandleBefore(candles, timestampMs);
    return candle ? candle.close : null;
  } catch (err) {
    console.log(`Underlying price lookup (${frequency}m) failed for ${ticker}:`, err.message);
    return null;
  }
}
async function getUnderlyingPriceAt(accessToken, ticker, timestampMs) {
  for (const frequency of [1, 5, 30]) {
    const price = await tryIntradayLookup(accessToken, ticker, timestampMs, frequency);
    if (price != null) return price;
  }
  try {
    const daily = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 2, frequencyType: 'daily', frequency: 1, endDate: timestampMs,
    }).catch(() => []);
    const candle = lastCandleBefore(daily, timestampMs);
    return candle ? candle.close : null;
  } catch (err) {
    console.log(`Underlying price lookup (daily) failed for ${ticker}:`, err.message);
    return null;
  }
}

// Full Time Frame Continuity rule: walk the timeframes in order (from the
// TIMEFRAMES list above — 6M down to 1m) and find the longest run of
// CONSECUTIVE timeframes that are all the same direction (all bull or all
// bear). The run can start at ANY timeframe in the sequence, not just the
// largest — e.g. 1M/1W/1D/4H bullish in a row confirms FTFC just as much
// as 30m/15m/5m/3m would. FTFC is confirmed when that longest run is 4 or
// more. A blank/missing timeframe breaks a run, same as a mismatched
// color would. timeframesInRun records exactly which timeframes formed
// the confirmed run (largest to smallest), which tells you how long the
// setup suggests holding — e.g. a run anchored on 1D/4H implies a longer
// hold than one anchored on 5m/3m.
function computeFtfcConfirmation(perTimeframe) {
  const sequence = TIMEFRAMES.map(tf => perTimeframe[tf]);
  let bestRun = 0, bestDirection = null, bestStartIdx = -1, bestEndIdx = -1;
  let currentRun = 0, currentDirection = null, currentStartIdx = -1;
  sequence.forEach((value, idx) => {
    if (value && value === currentDirection) {
      currentRun++;
    } else {
      currentRun = value ? 1 : 0;
      currentDirection = value || null;
      currentStartIdx = idx;
    }
    if (currentRun > bestRun) {
      bestRun = currentRun;
      bestDirection = currentDirection;
      bestStartIdx = currentStartIdx;
      bestEndIdx = idx;
    }
  });
  const timeframesInRun = bestRun >= 4 ? TIMEFRAMES.slice(bestStartIdx, bestEndIdx + 1) : [];
  return {
    confirmed: bestRun >= 4,
    runLength: bestRun,
    direction: bestRun >= 4 ? bestDirection : null,
    timeframesInRun,
  };
}

// Figures out bull/bear for every timeframe we can, for one ticker at one
// trade's entry time. A timeframe is left undefined (blank) if Schwab has
// no data that far back to check — most common for 1-minute-based
// timeframes on older trades, since Schwab doesn't retain minute data forever.
async function getFtfcForTrade(accessToken, ticker, entryTimestampMs) {
  const result = {};

  try {
    const oneMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    result['1m'] = bullBear(lastCandleBefore(oneMin, entryTimestampMs));
    result['3m'] = bullBear(lastCandleBefore(aggregateCandles(oneMin, 3), entryTimestampMs));

    const fiveMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 5, endDate: entryTimestampMs,
    }).catch(() => []);
    result['5m'] = bullBear(lastCandleBefore(fiveMin, entryTimestampMs));

    const fifteenMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 15, endDate: entryTimestampMs,
    }).catch(() => []);
    result['15m'] = bullBear(lastCandleBefore(fifteenMin, entryTimestampMs));

    const thirtyMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 30, endDate: entryTimestampMs,
    }).catch(() => []);
    result['30m'] = bullBear(lastCandleBefore(thirtyMin, entryTimestampMs));

    result['1H'] = bullBear(lastCandleBefore(aggregateCandles(thirtyMin, 2), entryTimestampMs));
    result['2H'] = bullBear(lastCandleBefore(aggregateCandles(thirtyMin, 4), entryTimestampMs));
    result['4H'] = bullBear(lastCandleBefore(aggregateCandles(thirtyMin, 8), entryTimestampMs));
  } catch (err) {
    console.log('FTFC minute-data fetch failed (trade may be too old for Schwab\'s minute-data retention):', err.message);
  }

  try {
    const daily = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 2, frequencyType: 'daily', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    result['1D'] = bullBear(lastCandleBefore(daily, entryTimestampMs));

    const weekly = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 5, frequencyType: 'weekly', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    result['1W'] = bullBear(lastCandleBefore(weekly, entryTimestampMs));

    const monthly = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 20, frequencyType: 'monthly', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    result['1M'] = bullBear(lastCandleBefore(monthly, entryTimestampMs));
    result['3M'] = bullBear(lastCandleBefore(aggregateCandles(monthly, 3), entryTimestampMs));
    result['6M'] = bullBear(lastCandleBefore(aggregateCandles(monthly, 6), entryTimestampMs));
  } catch (err) {
    console.log('FTFC daily/weekly/monthly fetch failed:', err.message);
  }

  return { timeframes: result, ...computeFtfcConfirmation(result) };
}

module.exports = { getFtfcForTrade, getUnderlyingPriceAt, fetchCandles, TIMEFRAMES };
