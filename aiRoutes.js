const express = require('express');
const { wrap } = require('./asyncRoute');
const { runPortfolioAnalysis, classifyStrategy, testClassifyStrategy, interpretBacktest } = require('./aiClient');
const { getFtfcForTrade } = require('./ftfcCheck');
const queue = require('./classifyQueue');
const { getValidAccessToken } = require('./auth');
const testFeedbackRouter = require('./aiTestFeedback');

const router = express.Router();
router.use(testFeedbackRouter);

router.post('/analyze', wrap(async (req, res) => {
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
}));

// Classifies a single trade against the trader's own defined Strat setups.
// Same classifier the cron job already runs automatically on newly-synced
// trades (see cron.js's enrichWithStrategy) — exposed here so the frontend
// can also run it on demand, for trades that predate that automatic
// tagging or that it wasn't confident enough to tag the first time. Takes
// one trade per request (not a batch) so a phone never holds one request
// open for the minutes a large batch would take — see CLAUDE.md's known
// traps about iOS Safari request timeouts.
// Hands a trade over to be read and answers IMMEDIATELY.
//
// This used to call Gemini and reply only when it came back -- ten or
// twenty seconds on a good day, past a minute once its retries are
// counted. A phone browser will not hold a connection that long, so every
// one of the owner's requests failed with Safari's "Load failed" and his
// setups were never read. The thinking now happens on the server's own
// time; the app collects the answers from /classify/results on the
// polling it already does.
router.post('/classify', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const trade = req.body && req.body.trade;
  if (!trade || typeof trade !== 'object' || trade.id == null) {
    return res.status(400).json({ error: 'trade (with an id) is required' });
  }
  try {
    const out = await queue.enqueue(trade);
    queue.drainSoon();
    res.json(out);
  } catch (err) {
    console.log('Could not queue a trade for reading:', err.message);
    res.status(500).json({ error: 'Could not take that trade just now.' });
  }
}));

// The answers worked out so far. Collecting them clears them, so the same
// answer is never applied twice.
router.get('/classify/results', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  try {
    const results = await queue.takeResults();
    // Nudge the worker whenever the app checks in, so a queue left over
    // from a restart starts moving again without being asked.
    queue.drainSoon();
    res.json({ results, waiting: await queue.queueDepth() });
  } catch (err) {
    console.log('Could not hand over reading results:', err.message);
    res.status(500).json({ error: 'Could not fetch results just now.' });
  }
}));

// Sandbox classification against a made-up chart — no real trade required.
// Deliberately gives the classifier NOTHING but the picture and/or typed
// description — no direction, no FTFC, no Broadening Formation. The point
// is to test whether the AI can read the chart itself, purely from what's
// visible, the same way the owner is testing his own eye. Returns three
// layered answers (candle combo, FTFC, Broadening Formation), each
// independently allowed to be "unclear" — see testClassifyStrategy in
// aiClient.js for why this uses its own chart-reading prompt rather than
// the real trade classifier's trade-oriented one.
// Never touches real trade data; nothing here is saved to the Journal.
// Always returns the model's real answer (even "unclear" or low
// confidence) rather than hiding it the way the real auto-tagging does,
// since the whole point is to see what the AI actually thinks.
router.post('/test-classify', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const body = req.body || {};
  const image = typeof body.image === 'string' ? body.image : null;
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const ticker = typeof body.ticker === 'string' ? body.ticker.trim().toUpperCase() : '';
  const when = typeof body.when === 'string' ? body.when.trim() : '';
  if (!image && !description) {
    return res.status(400).json({ error: 'Provide an image, a description, or both.' });
  }

  try {
    // Given a ticker and a moment, the timeframe alignment is MEASURED
    // from real candles rather than read off the picture. Both are then
    // put in front of the model. Failing to get it is not a failure of
    // the whole request -- the tool still reads the chart visually, which
    // is what it did before this existed.
    let marketFtfc = null;
    let marketError = null;
    if (ticker && when) {
      const whenMs = Date.parse(when);
      if (!Number.isFinite(whenMs)) {
        marketError = 'That date and time could not be read, so the chart was judged by eye alone.';
      } else if (whenMs > Date.now()) {
        marketError = 'That moment is in the future, so there is no market data for it — the chart was judged by eye alone.';
      } else {
        try {
          const token = await getValidAccessToken();
          const ftfc = await getFtfcForTrade(token, ticker, whenMs);
          // The field is runLength, not run. Getting this wrong would have
          // meant the measured data never reached the model and nothing
          // said so — the request would just have quietly gone on reading
          // the picture as before.
          if (ftfc && ftfc.runLength) {
            marketFtfc = {
              ticker, when,
              confirmed: !!ftfc.confirmed,
              direction: ftfc.direction || null,
              run: ftfc.runLength || 0,
              timeframesInRun: ftfc.timeframesInRun || [],
              timeframes: ftfc.timeframes || {},
            };
          } else {
            marketError = `No market data came back for ${ticker} at that moment, so the chart was judged by eye alone.`;
          }
        } catch (err) {
          marketError = 'Market data could not be reached just now, so the chart was judged by eye alone.';
        }
      }
    }

    const result = await testClassifyStrategy({ image, description, marketFtfc });
    res.json({ result, marketFtfc, marketError });
  } catch (err) {
    // The owner has no way to "check server logs" himself — this is his
    // only route to finding out what actually went wrong, so the real
    // detail needs to reach the screen, not just this console line.
    const detail = err.response?.data?.error?.message
      || (typeof err.response?.data === 'string' ? err.response.data : null)
      || err.message
      || 'Unknown error';
    console.log('Test classification failed:', detail);
    res.status(500).json({ error: `Classification failed: ${detail}` });
  }
}));

// Runs a backtest and then has the model read the finished numbers.
// The two steps are deliberately separate: the counting is arithmetic on
// real candles, the reading is the model's only job, and the model never
// sees a request to produce a figure.
router.post('/backtest', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const body = req.body || {};
  const ticker = (body.ticker || '').trim().toUpperCase();
  const setups = Array.isArray(body.setups) ? body.setups : [];
  const timeframes = Array.isArray(body.timeframes) ? body.timeframes : [];
  const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 30));
  const targetR = Math.max(0.25, Math.min(20, Number(body.targetR) || 2));

  if (!ticker) return res.status(400).json({ error: 'Pick a ticker.' });
  if (!setups.length) return res.status(400).json({ error: 'Pick at least one setup to test.' });
  if (!timeframes.length) return res.status(400).json({ error: 'Pick at least one timeframe.' });

  try {
    const { getValidAccessToken } = require('./auth');
    const { runBacktest } = require('./backtest');
    const token = await getValidAccessToken();
    const stopSettings = await require('./stopRule').loadSettings();
    const results = await runBacktest(token, {
      ticker, setups, timeframes, days, targetR,
      largeMultiple: stopSettings.largeMultiple,
      lookback: stopSettings.lookback,
    });

    // The counted results are returned whatever happens to the reading.
    // Real numbers are the valuable part; the commentary is a bonus, and
    // losing the numbers because the model was busy would be absurd.
    let reading = null, readingError = null;
    try {
      reading = await interpretBacktest(results);
    } catch (err) {
      readingError = err.response?.data?.error?.message || err.message;
      console.log('Backtest reading failed:', readingError);
    }
    res.json({ ...results, reading, readingError });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message || 'Unknown error';
    console.error('Backtest failed:', detail);
    res.status(500).json({ error: `Backtest failed: ${detail}` });
  }
}));

module.exports = router;
