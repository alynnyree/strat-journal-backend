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
  // isReady(), not isConfigured() -- see alpacaClient.isReady.
  if (frequencyType === 'minute' && await alpaca.isReady()) {
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
// ---------------------------------------------------------------------
// Reading a timeframe's direction at the moment of entry.
//
// Two faults were found here on 2026-08-30 and both are fixed below.
// They are recorded because the numbers they produced were shown to the
// owner as fact for weeks.
//
// FAULT 1 — it used information from AFTER the trade. Direction was read
// as "did this candle close above its own open", using the candle that
// CONTAINS the entry. For the 1-minute candle that is up to a minute of
// hindsight; for the daily it is the whole rest of the day; for the
// monthly it is the rest of the month. Demonstrated: a day that opened at
// 100, was trading at 101.8 when he entered, and closed at 98 was
// reported BEARISH at entry, when at that moment it was plainly bullish.
// That makes alignment look more predictive than it was.
//
// FAULT 2 — the built-up timeframes (3m, 1H, 2H, 4H, 3M, 6M) were made by
// grouping smaller candles by POSITION IN THE LIST, not by the clock. So
// a "4-hour bar" could open on Thursday afternoon and close on Friday
// morning, spanning the overnight gap; and every bar was stamped with its
// LAST sub-candle rather than its first, so the wrong bar was picked.
//
// Both are replaced by one rule, used for all thirteen timeframes:
//     the price at the moment of entry, against the OPEN of the bar that
//     was forming at that moment.
// That is what The Strat actually means by a timeframe being bullish or
// bearish, and it uses nothing he could not have seen at the time.

// The New York calendar date for a moment in time. Timeframe boundaries
// inside a day are anchored to the session, and the session is a New York
// thing -- doing this in UTC puts the boundary in the middle of the
// afternoon.
function easternDate(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// The candle whose period contains this moment: the last one that started
// at or before it. (A candle's datetime is the START of its period, for
// both Schwab and Alpaca.)
function candleContaining(candles, atMs) {
  return lastCandleBefore(candles, atMs);
}

// The open of the intraday bar of length `minutes` that was forming at
// `atMs`, anchored to that day's first candle -- so a 4-hour bar starts
// when the session starts, never mid-afternoon, and never runs across a
// night. Returns null when the day's data does not reach that far.
function intradayBarOpen(candles, atMs, minutes) {
  if (!candles || !candles.length) return null;
  const day = easternDate(atMs);
  const sameDay = candles.filter(c => easternDate(c.datetime) === day);
  if (!sameDay.length) return null;
  const sessionStart = sameDay[0].datetime;
  if (atMs < sessionStart) return null;                 // before the session opened
  const len = minutes * 60 * 1000;
  const barStart = sessionStart + Math.floor((atMs - sessionStart) / len) * len;
  const first = sameDay.find(c => c.datetime >= barStart);
  return first ? first.open : null;
}

// The open of the calendar quarter (3) or half-year (6) containing this
// moment, taken from the monthly candles. Grouped by the actual calendar,
// not by counting three along the list.
function monthGroupOpen(monthly, atMs, groupMonths) {
  if (!monthly || !monthly.length) return null;
  const at = new Date(atMs);
  const y = at.getUTCFullYear();
  const startMonth = Math.floor(at.getUTCMonth() / groupMonths) * groupMonths;
  const groupStart = Date.UTC(y, startMonth, 1);
  // The first monthly candle at or after the group's first day, but still
  // inside the group.
  const groupEnd = Date.UTC(y, startMonth + groupMonths, 1);
  const inGroup = monthly.filter(c => c.datetime >= groupStart - 5 * 24 * 3600e3 && c.datetime < groupEnd);
  return inGroup.length ? inGroup[0].open : null;
}

// Bullish if the price at entry was above the forming bar's open, bearish
// if below. Exactly level is left blank rather than guessed, same as
// before.
function directionFrom(barOpen, priceAtEntry) {
  if (barOpen == null || priceAtEntry == null) return undefined;
  if (priceAtEntry > barOpen) return 'bull';
  if (priceAtEntry < barOpen) return 'bear';
  return undefined;
}

// The price at the moment of entry — the one number every timeframe is
// judged against.
//
// Best is a price the caller has already established as the actual trade
// that printed at that second (Alpaca), because that sits INSIDE the
// entry minute and is still something that had happened by then. It is
// only accepted when the caller says it is exact; a reconstructed one
// could be the close of the candle containing the entry, which is the
// very hindsight this whole change exists to remove.
//
// Otherwise: the close of the most recent one-minute candle that had
// FINISHED by the entry. That is real and safe, but at minute resolution
// it lands on the entry minute's own open — so the 1-minute reading comes
// back blank rather than pretending to know. Blank breaks a run, which is
// the conservative way to be wrong.
function priceAtEntryFrom(oneMin, atMs, exactPrice, daily) {
  if (exactPrice != null && Number.isFinite(exactPrice)) return exactPrice;
  const finished = (oneMin || []).filter(c => c.datetime + 60000 <= atMs);
  if (finished.length) return finished[finished.length - 1].close;
  const finishedDay = (daily || []).filter(c => c.datetime < atMs);
  return finishedDay.length ? finishedDay[finishedDay.length - 1].close : null;
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
// exactPriceAtEntry: only pass a price KNOWN to be a real print at or
// before the fill (Alpaca). Anything reconstructed must be left null.
async function getFtfcForTrade(accessToken, ticker, entryTimestampMs, exactPriceAtEntry = null) {
  const result = {};
  let oneMin = [], thirtyMin = [], fiveMin = [], fifteenMin = [], daily = [], weekly = [], monthly = [];

  try {
    oneMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    fiveMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 5, endDate: entryTimestampMs,
    }).catch(() => []);
    fifteenMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 15, endDate: entryTimestampMs,
    }).catch(() => []);
    thirtyMin = await fetchCandles(accessToken, ticker, {
      periodType: 'day', period: 10, frequencyType: 'minute', frequency: 30, endDate: entryTimestampMs,
    }).catch(() => []);
  } catch (err) {
    console.log('FTFC minute-data fetch failed (trade may be too old for Schwab\'s minute-data retention):', err.message);
  }

  try {
    daily = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 2, frequencyType: 'daily', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    weekly = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 5, frequencyType: 'weekly', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
    monthly = await fetchCandles(accessToken, ticker, {
      periodType: 'year', period: 20, frequencyType: 'monthly', frequency: 1, endDate: entryTimestampMs,
    }).catch(() => []);
  } catch (err) {
    console.log('FTFC daily/weekly/monthly fetch failed:', err.message);
  }

  // The one price every timeframe is judged against — the last price he
  // could actually have seen when he entered.
  const price = priceAtEntryFrom(oneMin, entryTimestampMs, exactPriceAtEntry, daily);

  // Intraday bars, each anchored to the start of that day's session so a
  // bar never runs across a night and never starts mid-afternoon. Built
  // from the finest data available for that length.
  const openOf = (series, mins) => intradayBarOpen(series, entryTimestampMs, mins);
  result['1m']  = directionFrom(openOf(oneMin, 1), price);
  result['3m']  = directionFrom(openOf(oneMin, 3), price);
  result['5m']  = directionFrom(openOf(fiveMin.length ? fiveMin : oneMin, 5), price);
  result['15m'] = directionFrom(openOf(fifteenMin.length ? fifteenMin : oneMin, 15), price);
  result['30m'] = directionFrom(openOf(thirtyMin.length ? thirtyMin : oneMin, 30), price);
  result['1H']  = directionFrom(openOf(thirtyMin.length ? thirtyMin : oneMin, 60), price);
  result['2H']  = directionFrom(openOf(thirtyMin.length ? thirtyMin : oneMin, 120), price);
  result['4H']  = directionFrom(openOf(thirtyMin.length ? thirtyMin : oneMin, 240), price);

  // Day, week and month come with their own correct boundaries from the
  // data provider, so the bar containing the entry is taken straight from
  // the series and only its OPEN is used.
  const openOfContaining = (series) => {
    const c = candleContaining(series, entryTimestampMs);
    return c ? c.open : null;
  };
  result['1D'] = directionFrom(openOfContaining(daily), price);
  result['1W'] = directionFrom(openOfContaining(weekly), price);
  result['1M'] = directionFrom(openOfContaining(monthly), price);
  result['3M'] = directionFrom(monthGroupOpen(monthly, entryTimestampMs, 3), price);
  result['6M'] = directionFrom(monthGroupOpen(monthly, entryTimestampMs, 6), price);

  return { timeframes: result, priceAtEntry: price, ...computeFtfcConfirmation(result) };
}

module.exports = { getFtfcForTrade, getUnderlyingPriceAt, fetchCandles, TIMEFRAMES };
