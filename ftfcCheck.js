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
// Built ONCE. Building an Intl formatter is expensive and allocates
// heavily, and this is called for every candle: doing it inside the
// function meant roughly 23,000 formatters per trade, and measured 476MB
// of memory churn across a batch of twenty-five -- while the memory
// actually being held was 27MB. That gap is what Render was killing the
// server for, because a process never hands that memory back to the
// machine even after it is finished with it.
const EASTERN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
function easternDate(ms) {
  const p = Object.fromEntries(EASTERN_DATE.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
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
// The entry day's candles, worked out ONCE per trade rather than once per
// timeframe. Eight timeframes each re-scanning the whole series was eight
// times the work and eight times the memory for one answer.
// How many minutes into the New York day is this moment? Built on the
// shared formatter, never a fresh one per call.
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
});
function easternMinutesOfDay(ms) {
  const p = Object.fromEntries(EASTERN_CLOCK.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  let hour = Number(p.hour);
  if (hour === 24) hour = 0;
  return hour * 60 + Number(p.minute);
}
// The regular session, in New York minutes. 09:30 to 16:00.
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

// REGULAR HOURS ONLY, and it must be filtered HERE rather than trusted to
// arrive that way.
//
// Schwab is asked with needExtendedHoursData:false, so its candles start
// at 09:30. Alpaca is asked FIRST for minute data and has no such setting
// -- fetchBars sends only a timeframe and a date range -- so pre-market
// and after-hours bars come back with everything else. Nothing downstream
// filtered them, and this function only ever filtered by DATE.
//
// That mattered because intradayBarOpen below took "the first candle I
// happen to have for this day" as the session start. Measured by running
// these very functions, for an entry at 10:42:
//
//   candles from 09:30  ->  the 1-hour bar opens 10:30   (right)
//   candles from 04:00  ->  the 1-hour bar opens 10:00   (wrong)
//   candles from 06:07  ->  3m, 5m, 15m, 30m AND 1H all wrong
//
// 06:07 is the realistic case: Alpaca returns a bar only where a trade
// happened, and IWM before dawn is thin, so the first bar of the day
// lands on an arbitrary minute. Every intraday timeframe then anchors to
// that arbitrary minute. The direction is read from the bar's OPEN, so a
// wrong bar is a possibly-wrong BULLISH or BEARISH -- and FTFC is four of
// those in a row.
//
// This is the same fault as bars grouped by position in a list, arriving
// by a different door: an anchor taken from whatever the data happened to
// start with, rather than from the clock.
function sessionCandles(candles, atMs) {
  if (!candles || !candles.length) return [];
  const day = easternDate(atMs);
  return candles.filter(c => {
    if (easternDate(c.datetime) !== day) return false;
    const m = easternMinutesOfDay(c.datetime);
    return m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN;
  });
}

// ANCHORED TO THE CLOCK, never to the first candle in hand.
//
// Even with the filter above, taking sameDay[0] would still be wrong on a
// day whose 09:30 bar is missing -- a halt, a late open, or simply no
// trade in that minute. The anchor is 09:30 itself, worked out from the
// moment being asked about, so a missing first bar shifts nothing.
function intradayBarOpen(sameDay, atMs, minutes) {
  if (!sameDay || !sameDay.length) return null;
  const minsIntoDay = easternMinutesOfDay(atMs);
  if (minsIntoDay < SESSION_OPEN_MIN) return null;      // before the session opened
  const sinceOpen = minsIntoDay - SESSION_OPEN_MIN;
  const barStartMin = SESSION_OPEN_MIN + Math.floor(sinceOpen / minutes) * minutes;
  // Back to a real instant on that same day, counted from the START of the
  // fill's minute. minsIntoDay drops the seconds, so subtracting whole
  // minutes from the exact fill instant kept them: a fill at 10:31:30 put
  // the 10:30 bar's start at 10:30:30, the 10:30 candle was skipped and
  // the bar's open was read one minute late. Real fills almost always carry
  // seconds, so every intraday bar was affected; just after a bar boundary
  // the late open equalled the entry price and the timeframe read blank
  // (measured 11 Oct 2026: a 10:31:30 entry lost 3m, 5m, 15m, 30m and 1H).
  const atMinuteMs = atMs - (atMs % 60000);
  const barStartMs = atMinuteMs - (minsIntoDay - barStartMin) * 60000;
  const first = sameDay.find(c => c.datetime >= barStartMs);
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


// The price at entry is now chosen by priceEvidence (FTFC Fix 1, below).
// The old helper here fell back to the entry day's own DAILY candle when
// there was no exact print and no finished minute -- a candle whose close
// is the day's close or the latest price, i.e. a price from after the
// entry. It was removed rather than left unused, so nothing can call it.

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

// ---------------------------------------------------------------------
// FTFC Fix 1 (13 Oct 2026; owner's authorisation: "I authorize FTFC Fix 1
// implementation"). Plan v1-v14, consolidated spec section A.
//
// What was wrong before:
//   * Every daily/weekly/monthly request ended in `.catch(() => [])`, so a
//     Schwab refusal, an empty answer and a dropped connection all became
//     "nothing", and the reason was thrown away.
//   * A blank timeframe meant three different things -- the price exactly
//     at the bar's open (a real answer), data that never arrived, data that
//     did not contain the bar -- and nothing could tell them apart.
//   * With no exact print and no finished minute, the price at entry fell
//     back to the entry day's own daily candle -- whose close is the day's
//     close, or the latest price: a number from AFTER the entry (hindsight).
//
// Now each of the 13 timeframes has exactly one status -- bull, bear, level
// or missing -- and every missing one carries ONE reason, chosen by a fixed
// precedence. A reading is COMPLETE only when nothing is missing, and only
// a complete reading has a verdict. The price at entry is either the exact
// print inside the entry second or the close of the minute that ended when
// the entry minute began; anything else is no price at all.
// ---------------------------------------------------------------------

const INTRADAY_MINUTES = { '4H': 240, '2H': 120, '1H': 60, '30m': 30, '15m': 15, '5m': 5, '3m': 3, '1m': 1 };
const REASON_NO_PRICE = 'no price at entry';
const REASON_BEFORE_SESSION = 'entry before the session opened';
const REASON_NO_BAR = 'data did not contain this bar';

// "<Provider> refused (status N)" / "<Provider> answered with nothing" /
// "could not reach <Provider>": three faults with three different fixes,
// never one answer.
function describeFailure(o) {
  if (!o) return 'no answer was recorded';
  if (o.kind === 'refused') return `${o.provider} refused (status ${o.status})`;
  if (o.kind === 'empty') return `${o.provider} answered with nothing`;
  return `could not reach ${o.provider}`;
}
function classifyError(provider, err) {
  const status = err && err.response && err.response.status;
  return status ? { provider, kind: 'refused', status } : { provider, kind: 'unreachable' };
}

async function schwabSeries(accessToken, symbol, params) {
  try {
    const data = await schwabMarketGet('/pricehistory', accessToken, { symbol, ...params, needExtendedHoursData: false });
    const candles = (data && data.candles) || [];
    return { candles, outcome: { provider: 'Schwab', kind: candles.length ? 'ok' : 'empty' }, tried: [] };
  } catch (err) {
    return { candles: [], outcome: classifyError('Schwab', err), tried: [] };
  }
}

// The minute series, Alpaca first (as fetchCandles does), Schwab after, with
// what each one said. The outcome that names a missing timeframe's reason is
// the LAST provider asked; every earlier answer is kept for Details.
async function minuteSeries(accessToken, symbol, endMs, days) {
  const tried = [];
  let ready = false;
  try { ready = await alpaca.isReady(); } catch (e) { ready = false; }
  if (ready) {
    const report = {};
    const bars = await alpaca.fetchBars(symbol, { minutes: 1, startMs: endMs - days * 86400000, endMs, report });
    if (bars && bars.length) return { candles: bars, outcome: { provider: 'Alpaca', kind: 'ok' }, tried };
    tried.push(bars == null
      ? (report.status ? { provider: 'Alpaca', kind: 'refused', status: report.status } : { provider: 'Alpaca', kind: 'unreachable' })
      : { provider: 'Alpaca', kind: 'empty' });
  }
  const s = await schwabSeries(accessToken, symbol, { periodType: 'day', period: days, frequencyType: 'minute', frequency: 1, endDate: endMs });
  return { candles: s.candles, outcome: s.outcome, tried };
}

// The price at entry, with the evidence for it (spec A2). exactPrint, when
// given, is { price, atMs } -- the actual Alpaca print and its own time. A
// bare number carries no time and is not evidence.
function priceEvidence(oneMin, entryMs, exactPrint) {
  const secondStart = entryMs - (entryMs % 1000);
  if (exactPrint && typeof exactPrint === 'object'
      && Number.isFinite(exactPrint.price) && exactPrint.price > 0
      && Number.isFinite(exactPrint.atMs) && exactPrint.atMs >= secondStart && exactPrint.atMs <= entryMs) {
    return { price: exactPrint.price, source: 'exact-print', time: exactPrint.atMs };
  }
  const priorStart = entryMs - (entryMs % 60000) - 60000;
  const bar = (oneMin || []).find(c => c && c.datetime === priorStart);
  if (bar && Number.isFinite(bar.close) && bar.close > 0) {
    return { price: bar.close, source: 'prior-minute-close', time: priorStart };
  }
  return { price: null, source: null, time: null };
}

function statusFrom(barOpen, price) {
  if (barOpen == null || price == null) return null;
  if (price > barOpen) return 'bull';
  if (price < barOpen) return 'bear';
  return 'level';
}

function seriesLine(s) {
  const parts = (s.tried || []).map(describeFailure);
  parts.push(s.outcome.kind === 'ok' ? `${s.outcome.provider} answered` : describeFailure(s.outcome));
  return parts.join('; ');
}

// Figures out every timeframe for one ticker at one trade's entry time.
// Returns the fields every existing caller reads (timeframes, priceAtEntry,
// runLength, confirmed, direction, timeframesInRun -- unchanged in meaning
// for those callers) PLUS `reading`, the whole Fix-1 reading.
// exactPrint: { price, atMs } from Alpaca when known; anything else is not
// evidence. opts.version: the rule version to stamp on the reading.
async function getFtfcForTrade(accessToken, ticker, entryTimestampMs, exactPrint = null, opts = {}) {
  const entryMs = entryTimestampMs;
  // ONE minute series, covering TWO days (see the memory note in git
  // history: four ten-day series put the server at 589MB). Every intraday
  // bar is anchored to the session open, so one 1-minute series answers all
  // eight intraday timeframes.
  const minute = await minuteSeries(accessToken, ticker, entryMs, 2);
  const daily = await schwabSeries(accessToken, ticker, { periodType: 'year', period: 2, frequencyType: 'daily', frequency: 1, endDate: entryMs });
  const weekly = await schwabSeries(accessToken, ticker, { periodType: 'year', period: 5, frequencyType: 'weekly', frequency: 1, endDate: entryMs });
  const monthly = await schwabSeries(accessToken, ticker, { periodType: 'year', period: 20, frequencyType: 'monthly', frequency: 1, endDate: entryMs });

  const ev = priceEvidence(minute.candles, entryMs, exactPrint);
  const price = ev.price;
  const sameDay = sessionCandles(minute.candles, entryMs);
  const beforeSession = easternMinutesOfDay(entryMs) < SESSION_OPEN_MIN;

  const openFor = {};
  for (const [tf, mins] of Object.entries(INTRADAY_MINUTES)) openFor[tf] = intradayBarOpen(sameDay, entryMs, mins);
  const openOfContaining = (series) => { const c = candleContaining(series, entryMs); return c ? c.open : null; };
  openFor['1D'] = openOfContaining(daily.candles);
  openFor['1W'] = openOfContaining(weekly.candles);
  openFor['1M'] = openOfContaining(monthly.candles);
  openFor['3M'] = monthGroupOpen(monthly.candles, entryMs, 3);
  openFor['6M'] = monthGroupOpen(monthly.candles, entryMs, 6);
  const seriesFor = (tf) => (tf in INTRADAY_MINUTES ? minute : tf === '1D' ? daily : tf === '1W' ? weekly : monthly);

  const status = {}, missing = {}, grid = {};
  for (const tf of TIMEFRAMES) {
    const st = statusFrom(openFor[tf], price);
    if (st) {
      status[tf] = st;
      if (st === 'bull' || st === 'bear') grid[tf] = st;
      continue;
    }
    status[tf] = 'missing';
    // ONE reason, by fixed precedence (spec A3).
    if (price == null) missing[tf] = REASON_NO_PRICE;
    else if ((tf in INTRADAY_MINUTES) && beforeSession) missing[tf] = REASON_BEFORE_SESSION;
    else if (seriesFor(tf).outcome.kind !== 'ok') missing[tf] = describeFailure(seriesFor(tf).outcome);
    else missing[tf] = REASON_NO_BAR;
  }
  const complete = TIMEFRAMES.every(tf => status[tf] !== 'missing');
  const verdict = computeFtfcConfirmation(grid);
  const reading = {
    version: Number.isInteger(opts.version) ? opts.version : null,
    status, missing, complete,
    priceAtEntry: ev.price, priceSource: ev.source, priceTime: ev.time,
    run: complete ? verdict.runLength : null,
    confirmed: complete ? verdict.confirmed : null,
    direction: complete ? verdict.direction : null,
    timeframesInRun: complete ? verdict.timeframesInRun : [],
    grid,
    diagnostics: {
      minute: seriesLine(minute), daily: seriesLine(daily), weekly: seriesLine(weekly), monthly: seriesLine(monthly),
    },
  };
  return { timeframes: grid, priceAtEntry: price, ...verdict, reading };
}

module.exports = { getFtfcForTrade, getUnderlyingPriceAt, fetchCandles, TIMEFRAMES, computeFtfcConfirmation, priceEvidence, describeFailure,
  REASON_NO_PRICE, REASON_BEFORE_SESSION, REASON_NO_BAR };
