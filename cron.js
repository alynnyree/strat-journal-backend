const cron = require('node-cron');
const { getValidAccessToken } = require('./auth');
const { getOptionFills } = require('./schwabClient');
const { processFills } = require('./matcher');
const tradeStore = require('./tradeStore');
const { getTokens, setLastCheck } = require('./tokenStore');

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
async function runBackfill(daysBack = 730) {
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
