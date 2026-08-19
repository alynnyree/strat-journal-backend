const express = require('express');
const { runPortfolioAnalysis, classifyStrategy } = require('./aiClient');

const router = express.Router();

router.post('/analyze', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const trades = (req.body && req.body.trades) || [];
  if (!Array.isArray(trades) || trades.length < 5) {
    return res.status(400).json({ error: 'Need at least 5 trades for analysis.' });
  }
  try {
    const result = await runPortfolioAnalysis(trades);
    res.json(result);
  } catch (err) {
    console.log('AI analysis failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Analysis failed — check server logs.' });
  }
});

// Classifies a single trade against the trader's own defined Strat setups.
// Same classifier the cron job already runs automatically on newly-synced
// trades (see cron.js's enrichWithStrategy) — exposed here so the frontend
// can also run it on demand, for trades that predate that automatic
// tagging or that it wasn't confident enough to tag the first time. Takes
// one trade per request (not a batch) so a phone never holds one request
// open for the minutes a large batch would take — see CLAUDE.md's known
// traps about iOS Safari request timeouts.
router.post('/classify', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const trade = req.body && req.body.trade;
  if (!trade || typeof trade !== 'object') {
    return res.status(400).json({ error: 'trade is required' });
  }
  try {
    const result = await classifyStrategy(trade);
    res.json({ result });
  } catch (err) {
    console.log('AI classification failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Classification failed — check server logs.' });
  }
});

module.exports = router;
