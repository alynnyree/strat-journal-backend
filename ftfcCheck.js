const axios = require('axios');

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
async function fetchCandles(accessToken, symbol, { periodType, period, frequencyType, frequency, endDate }) {
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

// Full Time Frame Continuity rule: walk the timeframes in order (from the
// TIMEFRAMES list above — 6M down to 1m) and find the longest run of
// CONSECUTIVE timeframes that are all the same direction (all bull or all
// bear). FTFC is confirmed when that longest run is 4 or more — e.g.
// 1m/3m/5m/15m all bullish in a row, or 1H/2H/4H/1D all bearish in a row.
// A blank/missing timeframe breaks a run, same as a mismatched color would.
function computeFtfcConfirmation(perTimeframe) {
  const sequence = TIMEFRAMES.map(tf => perTimeframe[tf]);
  let bestRun = 0, bestDirection = null;
  let currentRun = 0, currentDirection = null;
  for (const value of sequence) {
    if (value && value === currentDirection) {
      currentRun++;
    } else {
      currentRun = value ? 1 : 0;
      currentDirection = value || null;
    }
    if (currentRun > bestRun) {
      bestRun = currentRun;
      bestDirection = currentDirection;
    }
  }
  return {
    confirmed: bestRun >= 4,
    runLength: bestRun,
    direction: bestRun >= 4 ? bestDirection : null,
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

module.exports = { getFtfcForTrade, TIMEFRAMES };
