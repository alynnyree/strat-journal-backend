const cron = require('node-cron');
const { getValidAccessToken } = require('./auth');
const { getOptionFills } = require('./schwabClient');
const { processFills } = require('./matcher');
const tradeStore = require('./tradeStore');
const { getTokens, setLastCheck } = require('./tokenStore');
const { getUnderlyingPriceAt, getFtfcForTrade } = require('./ftfcCheck');
const { getReplayCandles } = require('./replayData');
const { classifyStrategy } = require('./aiClient');
const { notifyTradeClosed, notifyTradeOpened, notifyTradeStillOpen } = require('./pushcut');
const { queueBrowserEvent } = require('./browserEvents');

const SHORT_TRADE_SAFETY_NET_MS = 15 * 60 * 1000; // matches pushcut.js's SHORT_TRADE_MS

// Runs once, 15 minutes after a leg opens: if it's STILL sitting unmatched
// in openLegs at that point, the trade has run past the video-vs-screenshot
// cutoff, so it's time to bail out of recording. If it already closed (and
// so is no longer in openLegs), this is a silent no-op — notifyTradeClosed
// already handled that trade via the normal close path.
// In-memory only (a plain setTimeout, not a durable job) — if the server
// restarts in the middle of this 15-minute window, the check is lost and
// that one trade's recording (if the owner is still mid-trade) won't get
// the automatic "still open" nudge. Acceptable for a personal app at this
// scale; worth revisiting only if it turns out to happen often in practice.
function scheduleStillOpenCheck(leg) {
  setTimeout(async () => {
    try {
      const state = await tradeStore.getState();
      const stillOpen = (state.openLegs || []).some(
        l => l.occ === leg.occ && l.openTimestamp === leg.openTimestamp
      );
      if (stillOpen) {
        await notifyTradeStillOpen(leg);
        queueBrowserEvent('stillOpen', { ticker: leg.ticker, dir: leg.dir, timestamp: leg.openTimestamp }).catch(() => {});
      }
    } catch (err) {
      console.log('Still-open safety-net check failed:', err.message);
    }
  }, SHORT_TRADE_SAFETY_NET_MS);
}

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

// Auto-tags each newly-matched trade with one of the trader's own defined
// Strat setups, using the FTFC/price data and replay candles gathered by
// the enrichment steps above — must run after those, not before. Left null
// (same as before — shows the "Needs Setup" badge) whenever the model
// isn't confident, rather than force a guess onto a trade the trader will
// see in their Journal.
async function enrichWithStrategy(trades) {
  for (const trade of trades) {
    try {
      const result = await classifyStrategy(trade);
      if (result) {
        trade.strat = result.strategy;
        trade.stratConfidence = result.confidence;
        trade.stratReasoning = result.reasoning;
      }
    } catch (err) {
      console.log(`Strategy classification failed for ${trade.ticker}:`, err.message);
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
      const { updatedState, newPending, newlyOpenedLegs } = processFills(freshFills, state);
      if (newPending.length) {
        await enrichWithUnderlyingPrices(token, newPending);
        await enrichWithFtfc(token, newPending);
        await enrichWithReplayData(token, newPending);
        await enrichWithStrategy(newPending);
      }
      updatedState.lastProcessedIds = [
        ...(state.lastProcessedIds || []).slice(-500), // keep this list bounded
        ...freshFills.map(f => f.transactionId),
      ];
      await tradeStore.saveState(updatedState);
      // Only here, in the live 5-minute/streamer-triggered check — never
      // from runBackfill() below, which can surface a hundred-plus
      // historical trades/legs at once and would spam notifications.
      if (newlyOpenedLegs.length) {
        console.log(`Auto-sync: ${newlyOpenedLegs.length} newly-opened position(s).`);
        for (const leg of newlyOpenedLegs) {
          notifyTradeOpened(leg).catch(() => {});
          queueBrowserEvent('opened', { ticker: leg.ticker, dir: leg.dir, timestamp: leg.openTimestamp }).catch(() => {});
          scheduleStillOpenCheck(leg);
        }
      }
      if (newPending.length) {
        console.log(`Auto-sync: ${newPending.length} closed trade(s) ready for tagging.`);
        for (const trade of newPending) {
          notifyTradeClosed(trade).catch(() => {}); // notifyTradeClosed already logs its own failures
          queueBrowserEvent('closed', { ticker: trade.ticker, dir: trade.dir, timestamp: trade.exitTimestamp }).catch(() => {});
        }
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
    await enrichWithStrategy(newPending);
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
