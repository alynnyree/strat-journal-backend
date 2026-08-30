const cron = require('node-cron');
const { getValidAccessToken } = require('./auth');
const { getOptionFills } = require('./schwabClient');
const alpaca = require('./alpacaClient');
const { processFills } = require('./matcher');
const tradeStore = require('./tradeStore');
const { getTokens, setLastCheck } = require('./tokenStore');
const { getUnderlyingPriceAt, getFtfcForTrade } = require('./ftfcCheck');
const { getReplayCandles } = require('./replayData');
const { computeStopForTrade, loadSettings: loadStopSettings } = require('./stopRule');
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
// Where the underlying stock was when the fill went through.
//
// Alpaca first, because it can answer with an actual print at the actual
// second and its minute data goes back years. Schwab second, because it
// is always available but only keeps minute data ~35 days and otherwise
// falls back to a 30-minute or daily close.
//
// Each price is stored with HOW it was obtained, so a reconstruction is
// never displayed as though it were a record. Alpaca failing costs
// accuracy, never correctness -- the Schwab path is unchanged beneath it.
async function priceWithProvenance(token, ticker, timestampMs) {
  // isReady(), never isConfigured(). isConfigured() reads only what is in
  // memory, and memory is empty after every restart, so this gate was
  // closing on a server that had his Alpaca keys in storage the whole
  // time -- silently falling through to a Schwab candle and marking every
  // price "approximate". That is the bug he reported on 30 August.
  const alpacaOn = await alpaca.isReady();
  if (alpacaOn) {
    try {
      const hit = await alpaca.underlyingPriceAt(ticker, timestampMs);
      if (hit) return { ...hit, alpacaChecked: true };
    } catch (err) {
      console.log(`Alpaca lookup failed for ${ticker}, falling back to Schwab:`, err.message);
    }
  }
  const price = await getUnderlyingPriceAt(token, ticker, timestampMs);
  // Records whether Alpaca was actually available when this price was
  // worked out. Without it there is no way to tell a price that Alpaca
  // could not improve from one it was never asked about -- and the app
  // needs that to know which trades are worth looking up again.
  return price == null ? null : { price, source: 'schwab-candle', exact: false, alpacaChecked: alpacaOn };
}

async function enrichWithUnderlyingPrices(token, trades) {
  for (const trade of trades) {
    try {
      if (trade.entryTimestamp) {
        const hit = await priceWithProvenance(token, trade.ticker, trade.entryTimestamp);
        trade.undEntry = hit ? hit.price : null;
        trade.undEntrySource = hit ? hit.source : null;
        trade.undEntryExact = hit ? hit.exact : null;
        trade.undPricedWithAlpaca = hit ? !!hit.alpacaChecked : false;
      }
      if (trade.exitTimestamp) {
        const hit = await priceWithProvenance(token, trade.ticker, trade.exitTimestamp);
        trade.undExit = hit ? hit.price : null;
        trade.undExitSource = hit ? hit.source : null;
        trade.undExitExact = hit ? hit.exact : null;
        trade.undPricedWithAlpaca = trade.undPricedWithAlpaca && (hit ? !!hit.alpacaChecked : false);
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

// Fills in the stop from the trader's own rule, which Schwab cannot supply
// — a Strat stop is a line drawn on the underlying's chart, never an order
// sent to the broker, so an auto-imported trade has always arrived with the
// stop blank and therefore no realized R:R at all.
//
// Runs AFTER enrichWithStrategy, because the timeframe can depend on which
// setup it was, and never overwrites a stop the trader entered himself.
async function enrichWithStopRule(token, trades) {
  let settings;
  try {
    settings = await loadStopSettings();
  } catch (err) {
    console.log('Could not load stop-rule settings; skipping stop enrichment:', err.message);
    return trades;
  }
  if (!settings.enabled) return trades;

  for (const trade of trades) {
    if (trade.stop != null) continue; // his own number always wins
    try {
      const result = await computeStopForTrade(token, trade, settings);
      // Stored even when no level could be worked out, so the app can say
      // WHY a trade has no stop instead of just showing a blank.
      trade.stop = result.stop;
      trade.stopBasis = result.basis || null;
      trade.stopReason = result.reason || null;
      trade.stopTimeframe = result.timeframe || trade.stopTimeframe || null;
      trade.stopSizeRatio = result.sizeRatio ?? null;
      trade.stopAuto = result.stop != null;
    } catch (err) {
      console.log(`Stop-rule enrichment failed for ${trade.ticker}:`, err.message);
      trade.stopReason = `Could not work out a stop: ${err.message}`;
      trade.stopAuto = false;
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
        // The combo (WHAT he saw) and the play (HOW he chose it) are two
        // separate answers. Either can be confident while the other is
        // not, so each is written only when it survived on its own.
        if (result.strategy) {
          trade.strat = result.strategy;
          trade.stratConfidence = result.confidence;
          trade.stratReasoning = result.reasoning;
        }
        if (result.play) {
          trade.play = result.play;
          trade.playConfidence = result.playConfidence;
          trade.playReasoning = result.playReasoning;
        }
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
        await enrichWithStopRule(token, newPending);
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
    // Read defensively: a rejection carrying something that is not an
    // error would throw again right here, out of the very catch meant to
    // contain it, and end the process.
    console.log('Auto-sync check skipped:', (err && err.message) || err);
  }
}

// One-time (or on-demand) wide-range pull for historical backfill.
// Defaults to 90 days (3 months) — enough to study recent trades without
// pulling a full year; increase if you want to look further back.
// 90 days was the old default, and it is why the owner's journal began in
// mid-May while his trading began on 2 January — four months of real
// trades were never fetched, and nothing said so. A year is the sensible
// default for a history import; the caller can ask for more.
// Records where the backfill has got to, so the app can say something
// true while it runs instead of guessing. A year of history takes minutes
// -- fetching a dozen windows from Schwab, then working out the FTFC,
// underlying prices, replay data, setup and stop for every trade found.
// Before this existed the app waited seven seconds and then announced
// "Schwab had nothing new", which was not something it could know.
async function noteBackfillProgress(patch) {
  try {
    const state = await tradeStore.getState();
    state.lastBackfill = { ...(state.lastBackfill || {}), ...patch };
    await tradeStore.saveState(state);
  } catch (err) {
    // Progress reporting must never be the thing that breaks an import.
    console.log('Could not record backfill progress:', err.message);
  }
}

// How many trades are enriched before the work so far is saved. Small
// enough that a restart loses little, large enough not to rewrite the
// whole journal on every trade.
const ENRICH_BATCH = 25;

async function runBackfill(daysBack = 365) {
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const now = new Date();
  const requestedFrom = start.toISOString().slice(0, 10);

  // Keep the attempt count across a resume; a run that reaches 'done'
  // clears it, so a later manual import starts from a clean slate.
  const prior = (await tradeStore.getState()).lastBackfill || {};
  await noteBackfillProgress({
    status: 'running', phase: 'asking-schwab',
    startedAt: now.toISOString(), finishedAt: null,
    daysBack, requestedFrom,
    fillsFound: null, tradesMatched: null, error: null,
    windowsAsked: null, windowsOk: null, windowsFailed: null,
    failures: [], oldestWindowWithData: null,
    attempts: prior.attempts || 0,
  });

  try {
    const token = await getValidAccessToken();
    const report = {};
    const fills = await getOptionFills(
      token,
      requestedFrom,
      now.toISOString().slice(0, 10),
      report
    );

    await noteBackfillProgress({
      phase: 'matching',
      fillsFound: fills.length,
      windowsAsked: report.windowsAsked ?? null,
      windowsOk: report.windowsOk ?? null,
      windowsFailed: report.windowsFailed ?? null,
      failures: report.failures || [],
      oldestWindowWithData: report.oldestWindowWithData || null,
    });

    const state = await tradeStore.getState();
    const alreadySeen = new Set(state.lastProcessedIds || []);
    const freshFills = fills.filter(f => !alreadySeen.has(f.transactionId));

    const { updatedState, newPending } = processFills(freshFills, {
      openLegs: [],
      pending: state.pending, // keep any trades already queued
    });

    // Queue the matched trades BEFORE enriching them. Enrichment is the
    // slow part -- thirteen timeframes of candles per trade -- and there
    // is no reason to make him stare at an empty journal through all of
    // it. The details fill themselves in on the next sync.
    updatedState.lastProcessedIds = [
      ...(state.lastProcessedIds || []),
      ...freshFills.map(f => f.transactionId),
    ];
    updatedState.lastBackfill = {
      ...(state.lastBackfill || {}),
      phase: 'enriching',
      tradesMatched: newPending.length,
      freshFills: freshFills.length,
    };
    await tradeStore.saveState(updatedState);

    if (newPending.length) {
      // Worked through in batches, saving after each one.
      //
      // It used to enrich all three hundred trades and save once at the
      // end, so a restart part-way through threw away every minute of it
      // -- and the server has been restarting, both from the crash and
      // from running out of memory. Saving as it goes means a restart
      // costs one batch, not the whole run. It also gives him a journal
      // that fills in steadily rather than all at once at the end.
      for (let i = 0; i < newPending.length; i += ENRICH_BATCH) {
        const batch = newPending.slice(i, i + ENRICH_BATCH);
        await enrichWithUnderlyingPrices(token, batch);
        await enrichWithFtfc(token, batch);
        await enrichWithReplayData(token, batch);
        await enrichWithStrategy(batch);
        await enrichWithStopRule(token, batch);
        // The batch holds the same objects the queue does, so saving the
        // state is what actually keeps the work done so far.
        await tradeStore.saveState(updatedState);
        await noteBackfillProgress({
          phase: 'enriching',
          tradesMatched: newPending.length,
          tradesEnriched: Math.min(i + ENRICH_BATCH, newPending.length),
        });
      }
      // The enriched copies are the same objects the queue holds, so
      // saving the state again is what actually persists the extra detail.
      const latest = await tradeStore.getState();
      await tradeStore.saveState({ ...latest, pending: updatedState.pending });
    }

    await noteBackfillProgress({
      status: 'done', phase: 'done',
      finishedAt: new Date().toISOString(),
      attempts: 0, resumedAutomatically: false,
    });
    return newPending;
  } catch (err) {
    await noteBackfillProgress({
      status: 'failed', phase: 'done',
      finishedAt: new Date().toISOString(),
      error: String(err.response?.data ? JSON.stringify(err.response.data) : err.message).slice(0, 300),
    });
    throw err;
  }
}

// Carries an unfinished history import on by itself.
//
// The owner should not have to keep tapping a button, and until now he
// did: a backfill that Schwab blocked, or that died when the server
// restarted, simply stopped and waited for a human. Schwab turns requests
// away when too many arrive at once -- which a year-long import can
// trigger -- and that block lifts by itself after a few minutes. There is
// no reason a person needs to be involved in waiting for it.
//
// A backfill still marked "running" long after it started is not running;
// nothing survives a restart mid-job. Both that and an outright failure
// are treated the same way: wait, then carry on.
const RETRY_WAIT_MS = 16 * 60 * 1000;   // Schwab's block lifts in about 15
const STALE_RUN_MS = 25 * 60 * 1000;    // beyond this, a "running" job is dead
const MAX_RETRIES = 8;
let resumeInFlight = false;

async function resumeBackfillIfNeeded() {
  if (resumeInFlight) return;
  const state = await tradeStore.getState();
  const b = state.lastBackfill;
  if (!b || b.status === 'done') return;

  const startedMs = b.startedAt ? Date.parse(b.startedAt) : 0;
  const stalled = b.status === 'running' && Date.now() - startedMs > STALE_RUN_MS;
  if (b.status !== 'failed' && !stalled) return;   // genuinely still working

  const attempts = b.attempts || 0;
  if (attempts >= MAX_RETRIES) return;             // stop pestering Schwab

  const lastTry = Date.parse(b.finishedAt || b.startedAt || 0) || 0;
  if (Date.now() - lastTry < RETRY_WAIT_MS) return;

  resumeInFlight = true;
  console.log(`Resuming unfinished backfill by itself (attempt ${attempts + 1} of ${MAX_RETRIES}).`);
  try {
    await noteBackfillProgress({ attempts: attempts + 1, resumedAutomatically: true });
    await runBackfill(b.daysBack || 365);
  } catch (err) {
    console.log('Automatic resume failed, will try again later:', err.message);
  } finally {
    resumeInFlight = false;
  }
}

// Runs every 5 minutes by default. Change the cron expression to taste —
// Schwab rate limits are generous enough for personal use at this interval.
// One tick of the five-minute job. A named function rather than an inline
// one so it can actually be run in a test, instead of a test reading this
// file and pattern-matching the text of it.
//
// Nothing holds the promise this returns, so nothing here may be allowed
// to escape: an unhandled failure ends the entire server, which is what
// Render's "Exited with status 1" alert means. Each half is wrapped
// separately so a failure in one still lets the other run.
async function runScheduledTick() {
  try {
    await runSyncCheck();
  } catch (err) {
    console.log('Auto-sync tick failed:', (err && err.message) || err);
  }
  // Picking up where an interrupted import left off is part of keeping
  // the journal current, not a separate thing he has to ask for.
  try {
    await resumeBackfillIfNeeded();
  } catch (err) {
    console.log('Backfill resume check failed:', (err && err.message) || err);
  }
}

function startAutoSync(intervalCron = '*/5 * * * *') {
  cron.schedule(intervalCron, runScheduledTick);
  console.log(`Auto-sync scheduled: ${intervalCron}`);
}

// enrichWithUnderlyingPrices and priceWithProvenance are exported so a test
// can run them for real, rather than a test reading this file and guessing.
module.exports = { startAutoSync, runScheduledTick, runSyncCheck, runBackfill, resumeBackfillIfNeeded,
                   enrichWithUnderlyingPrices, priceWithProvenance };
