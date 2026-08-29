const express = require('express');
const axios = require('axios');
const { getValidAccessToken } = require('./auth');
const { getTokens, setLastCheck } = require('./tokenStore');
const tradeStore = require('./tradeStore');
const { runBackfill, runSyncCheck } = require('./cron');
const { getFtfcForTrade, getUnderlyingPriceAt } = require('./ftfcCheck');
const { getReplayCandles } = require('./replayData');
const stopRule = require('./stopRule');

const router = express.Router();

// Schwab Trader API base, per developer.schwab.com. Verify exact paths
// (they're versioned and have changed before) against current docs.
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

async function schwabGet(pathname, accessToken, params = {}) {
  const resp = await axios.get(`${TRADER_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return resp.data;
}

// Returns the account's current open positions.
router.get('/positions', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const accountsHash = await schwabGet('/accounts/accountNumbers', token);
    const accountNumber = accountsHash?.[0]?.hashValue;
    if (!accountNumber) return res.json({ positions: [] });

    const data = await schwabGet(`/accounts/${accountNumber}`, token, { fields: 'positions' });
    res.json({ positions: data?.securitiesAccount?.positions || [] });
  } catch (err) {
    console.error('positions error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Closed trades the cron job has already matched (open+close paired) and
// which are waiting for you to tag with Strat setup / FTFC / stop / shots.
// This is what makes sync feel automatic: by the time you open the app,
// the background job has already done the matching — you're just tagging.
router.get('/trades/pending', async (req, res) => {
  const state = await tradeStore.getState();
  res.json({ pending: state.pending || [] });
});

// Call once the trade has been tagged and saved into the app's own
// journal (localStorage), so the backend stops surfacing it again.
router.delete('/trades/pending/:id', async (req, res) => {
  await tradeStore.removePendingTrade(req.params.id);
  res.json({ ok: true });
});

// One-time historical pull. daysBack defaults to ~90 days; Schwab's own
// transaction history window may be shorter — whatever's available comes back.
//
// This responds immediately once the backfill has STARTED rather than
// waiting for it to fully finish — with a lot of matched trades, each one
// needs ~15+ sequential Schwab API calls (FTFC across 13 timeframes,
// underlying price, replay candles), which easily takes minutes. Making
// the phone hold a request open that long reliably times out (shows as a
// generic "Load failed" client-side) even though the backend is still
// working correctly. The backfill keeps running after this responds;
// check /trades/pending (or tap "Check for New Trades") a bit later to
// see the results land.
router.post('/trades/backfill', async (req, res) => {
  // Defaulted to 90, which silently truncated the owner's history to the
  // last three months while he had been trading all year. A year now, and
  // capped at three so a typo cannot ask Schwab for a decade.
  const requested = parseInt(req.body?.daysBack, 10);
  const daysBack = Number.isFinite(requested) ? Math.max(1, Math.min(1095, requested)) : 365;
  res.json({ started: true, daysBack });
  runBackfill(daysBack)
    .then(newPending => console.log(`Background backfill complete: ${newPending.length} trade(s) imported.`))
    .catch(err => console.error('Background backfill failed:', err.response?.data || err.message));
});

// What the historical import is doing right now. The app polls this so it
// can report the truth -- "still fetching", "found 148 trades, working out
// the details", "Schwab only served data back to 2 March" -- instead of
// waiting a few seconds and declaring there was nothing to find.
router.get('/trades/backfill/status', async (req, res) => {
  try {
    const state = await tradeStore.getState();
    res.json({ backfill: state.lastBackfill || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for an immediate check, same logic the cron job runs
// on its own every few minutes.
router.post('/trades/sync-now', async (req, res) => {
  try {
    await runSyncCheck();
    const state = await tradeStore.getState();
    res.json({ pending: state.pending || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-checks Full Time Frame Continuity for one ticker at one trade's
// entry time, using Schwab's own candle data. Returns bull/bear per
// timeframe (or leaves a timeframe out if Schwab has no data that far back).
router.post('/ftfc/check', async (req, res) => {
  try {
    const { ticker, entryTimestamp } = req.body || {};
    if (!ticker || !entryTimestamp) {
      return res.status(400).json({ error: 'ticker and entryTimestamp are required' });
    }
    const token = await getValidAccessToken();
    const result = await getFtfcForTrade(token, ticker, entryTimestamp);
    res.json({ ftfc: result.timeframes, confirmed: result.confirmed, runLength: result.runLength, direction: result.direction });
  } catch (err) {
    console.error('ftfc check error:', err.response?.data || err.message);
    res.status(500).json({ error: 'FTFC check failed' });
  }
});

// Wipes the entire pending queue AND the memory of which Schwab
// transactions have already been processed — use this before re-running
// backfill after a matching-logic fix, so every trade gets freshly
// re-matched instead of keeping old (possibly wrong) results around.
// This does NOT touch your saved Journal (that's local to the app).
router.post('/trades/reset', async (req, res) => {
  try {
    await tradeStore.saveState({ openLegs: [], pending: [], lastProcessedIds: [] });
    res.json({ ok: true });
  } catch (err) {
    console.error('reset error:', err.message);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Lets a manually-entered trade (typed into the New Trade form, not pulled
// from Schwab auto-sync) get the same underlying price + replay data that
// auto-synced trades get automatically. Only works within Schwab's normal
// minute-data retention window (~30-35 days) — same limit as everywhere
// else this data comes from.
router.post('/trade-data/enrich', async (req, res) => {
  try {
    const { ticker, entryTimestamp, exitTimestamp } = req.body || {};
    if (!ticker || !entryTimestamp) {
      return res.status(400).json({ error: 'ticker and entryTimestamp are required' });
    }
    const token = await getValidAccessToken();
    const [undEntry, undExit, replayData] = await Promise.all([
      getUnderlyingPriceAt(token, ticker, entryTimestamp),
      exitTimestamp ? getUnderlyingPriceAt(token, ticker, exitTimestamp) : Promise.resolve(null),
      getReplayCandles(token, ticker, entryTimestamp, exitTimestamp),
    ]);
    res.json({ undEntry, undExit, replayData });
  } catch (err) {
    console.error('trade-data enrich error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Enrichment failed' });
  }
});

// ---- Stop rule ------------------------------------------------------
// The trader's own stop rule, so the app can show it, change it, and try
// it against a single trade without waiting for the next sync.

router.get('/stop-rule/settings', async (req, res) => {
  try {
    const settings = await stopRule.loadSettings();
    res.json({ settings, timeframes: stopRule.TIMEFRAME_CHOICES });
  } catch (err) {
    console.error('stop-rule settings read error:', err.message);
    res.status(500).json({ error: 'Could not read the stop rule settings.' });
  }
});

router.put('/stop-rule/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (stopRule.TIMEFRAME_CHOICES.includes(body.timeframe)) patch.timeframe = body.timeframe;
    // Guarded rather than trusted at the bottom end: a multiple at or below
    // 1 would call every candle large and silently move every stop to the
    // halfway mark. The top end is left generous on purpose — setting a
    // high multiple is how the trader says "effectively never use the
    // halfway mark, always the full candle", which is a legitimate choice
    // and the only way to express it.
    const mult = Number(body.largeMultiple);
    if (Number.isFinite(mult) && mult > 1 && mult <= 20) patch.largeMultiple = mult;
    const look = parseInt(body.lookback, 10);
    if (Number.isFinite(look) && look >= 5 && look <= 200) patch.lookback = look;
    if (body.perSetup && typeof body.perSetup === 'object') {
      const clean = {};
      for (const [setup, tf] of Object.entries(body.perSetup)) {
        if (stopRule.TIMEFRAME_CHOICES.includes(tf)) clean[setup] = tf;
      }
      patch.perSetup = clean;
    }
    res.json({ settings: await stopRule.saveSettings(patch) });
  } catch (err) {
    console.error('stop-rule settings write error:', err.message);
    res.status(500).json({ error: 'Could not save the stop rule settings.' });
  }
});

// Works out the stop for one trade on demand — used when the trader picks
// a different timeframe for a trade and wants to see the level move.
router.post('/stop-rule/compute', async (req, res) => {
  try {
    const { ticker, entryTimestamp, dir, strat, timeframe } = req.body || {};
    if (!ticker || !entryTimestamp) {
      return res.status(400).json({ error: 'ticker and entryTimestamp are required' });
    }
    const settings = await stopRule.loadSettings();
    const token = await getValidAccessToken();
    const result = await stopRule.computeStopForTrade(
      token,
      { ticker, entryTimestamp, dir, strat, stopTimeframe: timeframe || null },
      settings,
    );
    res.json(result);
  } catch (err) {
    console.error('stop-rule compute error:', err.response?.data || err.message);
    res.status(500).json({ error: `Could not work out a stop: ${err.message}` });
  }
});

module.exports = router;
