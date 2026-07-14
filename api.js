const express = require('express');
const axios = require('axios');
const { getValidAccessToken } = require('./auth');
const { getTokens, setLastCheck } = require('./tokenStore');
const tradeStore = require('./tradeStore');
const { runBackfill, runSyncCheck } = require('./cron');

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
router.get('/trades/pending', (req, res) => {
  const state = tradeStore.getState();
  res.json({ pending: state.pending || [] });
});

// Call once the trade has been tagged and saved into the app's own
// journal (localStorage), so the backend stops surfacing it again.
router.delete('/trades/pending/:id', (req, res) => {
  tradeStore.removePendingTrade(req.params.id);
  res.json({ ok: true });
});

// One-time historical pull. daysBack defaults to ~2 years; Schwab's own
// transaction history window may be shorter — whatever's available comes back.
router.post('/trades/backfill', async (req, res) => {
  try {
    const daysBack = parseInt(req.body?.daysBack, 10) || 730;
    const newPending = await runBackfill(daysBack);
    res.json({ imported: newPending.length });
  } catch (err) {
    console.error('backfill error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// Manual trigger for an immediate check, same logic the cron job runs
// on its own every few minutes.
router.post('/trades/sync-now', async (req, res) => {
  try {
    await runSyncCheck();
    const state = tradeStore.getState();
    res.json({ pending: state.pending || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
