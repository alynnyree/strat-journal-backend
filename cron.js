const cron = require('node-cron');
const { getValidAccessToken } = require('./auth');
const { getOptionFills } = require('./schwabClient');
const { processFills } = require('./matcher');
const tradeStore = require('./tradeStore');
const { getTokens, setLastCheck } = require('./tokenStore');
const { getUnderlyingPriceAt, getFtfcForTrade } = require('./ftfcCheck');
const { getReplayCandles } = require('./replayData');

// Runs the Full Time Frame Continuity check for each newly-matched trade,
// same logic used everywhere else in the app — now run automatically at
// match time instead of waiting for the trade to be manually tagged, since
// the Journal no longer has a separate tagging step.
async function enrichWithFtfc(token, trades) {
  for (const trade of trades) {
    try {
      if (trade.entryTimestamp) {
        const result = await getFtfcForTrade(token, trade.ticker, trade.entryTimestamp);
        trade.ftfc = result.timeframes;
        trade.ftfcRun = result.runLength;
        trade.ftfcConfirmed = result.confirmed;
        trade.ftfcDirection = result.direction;
        trade.ftfcTimeframesInRun = result.timeframesInRun;
      }
    } catch (err) {
      console.log(`FTFC enrichment failed for ${trade.ticker}:`, err.message);
    }
  }
  return trades;
}

// Looks up the underlying stock's actual price at entry and exit for each
// newly-matched trade, since Schwab's option data never includes it. Runs
// one at a time (not in parallel) to stay comfortably within Schwab's rate
// limits during a large backfill.
async function enrichWithUnderlyingPrices(token, trades) {
  for (const trade of trades) {
    try {
      if (trade.entryTimestamp) {
        trade.undEntry = await getUnderlyingPriceAt(token, trade.ticker, trade.entryTimestamp);
      }
      if (trade.exitTimestamp) {
        trade.undExit = await getUnderlyingPriceAt(token, trade.ticker, trade.exitTimestamp);
      }
    } catch (err) {
      console.log(`Underlying price enrichment failed for ${trade.ticker}:`, err.message);
    }
  }
  return trades;
}

// Pulls the 1-minute candle window around each newly-matched trade for the
// bar-replay feature (a candle-by-candle playback of the trade, used as a
// substitute for video screen recording — see replayData.js). Same
// one-at-a-time approach as the underlying-price enrichment, for the same
// rate-limit reason. Stores null on trades too old for Schwab's minute-data
// retention rather than leaving the field missing, so the frontend can
// tell "no replay available" apart from "not checked yet".
async function enrichWithReplayData(token, trades) {
  for (const trade of trades) {
    try {
      trade.replayData = await getReplayCandles(token, trade.ticker, trade.entryTimestamp, trade.exitTimestamp);
    } catch (err) {
      console.log(`Replay data enrichment failed for ${trade.ticker}:`, err.message);
      trade.replayData = null;
    }
  }
  return trades;
}

async function runSyncCheck() {
  try {
    const token = await getValidAccessToken();
    const store = await getTokens();
    const since = store.last_transaction_check
      ? new Date(store.last_transaction_check)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();

    const fills = await getOptionFills(
      token,
      since.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10)
    );

    const state = await tradeStore.getState();
    const alreadySeen = new Set(state.lastProcessedIds || []);
    const freshFills = fills.filter(f => !alreadySeen.has(f.transactionId));

    if (freshFills.length) {
      const { updatedState, newPending } = processFills(freshFills, state);
      if (newPending.length) {
        await enrichWithUnderlyingPrices(token, newPending);
        await enrichWithFtfc(token, newPending);
        await enrichWithReplayData(token, newPending);
      }
      updatedState.lastProcessedIds = [
        ...(state.lastProcessedIds || []).slice(-500), // keep this list bounded
        ...freshFills.map(f => f.transactionId),
      ];
      await tradeStore.saveState(updatedState);
      if (newPending.length) {
        console.log(`Auto-sync: ${newPending.length} closed trade(s) ready for tagging.`);
      }
    }

    await setLastCheck(now.toISOString());
  } catch (err) {
    // Most common cause: not connected yet (no refresh token on file).
    console.log('Auto-sync check skipped:', err.message);
  }
}

// One-time (or on-demand) wide-range pull for historical backfill.
// Defaults to 90 days (3 months) — enough to study recent trades without
// pulling a full year; increase if you want to look further back.
async function runBackfill(daysBack = 90) {
  const token = await getValidAccessToken();
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const now = new Date();

  const fills = await getOptionFills(
    token,
    start.toISOString().slice(0, 10),
    now.toISOString().slice(0, 10)
  );

  const state = await tradeStore.getState();
  const alreadySeen = new Set(state.lastProcessedIds || []);
  const freshFills = fills.filter(f => !alreadySeen.has(f.transactionId));

  const { updatedState, newPending } = processFills(freshFills, {
    openLegs: [],
    pending: state.pending, // keep any trades already queued
  });
  if (newPending.length) {
    await enrichWithUnderlyingPrices(token, newPending);
    await enrichWithFtfc(token, newPending);
    await enrichWithReplayData(token, newPending);
  }
  updatedState.lastProcessedIds = [
    ...(state.lastProcessedIds || []),
    ...freshFills.map(f => f.transactionId),
  ];
  await tradeStore.saveState(updatedState);
  return newPending;
}

// Runs every 5 minutes by default. Change the cron expression to taste —
// Schwab rate limits are generous enough for personal use at this interval.
function startAutoSync(intervalCron = '*/5 * * * *') {
  cron.schedule(intervalCron, runSyncCheck);
  console.log(`Auto-sync scheduled: ${intervalCron}`);
}

module.exports = { startAutoSync, runSyncCheck, runBackfill };
