const express = require('express');
const { runPortfolioAnalysis, classifyStrategy, testClassifyStrategy } = require('./aiClient');
const testFeedbackRouter = require('./aiTestFeedback');

const router = express.Router();
router.use(testFeedbackRouter);

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

// Sandbox classification against a made-up chart — no real trade required.
// Lets the owner sanity-check/practice with the AI classifier while not
// currently in any real trades, using a drawn/AI-generated/internet
// picture, a typed description, or both. Never touches real trade data;
// nothing here is saved to the Journal. Always returns the model's real
// answer (even "unclear" or low confidence) rather than hiding it the way
// the real auto-tagging does, since the whole point is to see what the AI
// actually thinks.
router.post('/test-classify', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const body = req.body || {};
  const image = typeof body.image === 'string' ? body.image : null;
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!image && !description) {
    return res.status(400).json({ error: 'Provide an image, a description, or both.' });
  }

  const fakeTrade = {
    dir: body.dir || null,
    ftfcConfirmed: !!body.ftfcConfirmed,
    offBroadeningFormation: body.offBroadeningFormation == null ? null : !!body.offBroadeningFormation,
    shotEntry: image || undefined,
    testDescription: description || undefined,
  };

  try {
    const result = await testClassifyStrategy(fakeTrade);
    res.json({ result });
  } catch (err) {
    console.log('Test classification failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Classification failed — check server logs.' });
  }
});

module.exports = router;
