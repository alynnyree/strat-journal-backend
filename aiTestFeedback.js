const express = require('express');
const { Redis } = require('@upstash/redis');

const router = express.Router();
const redis = Redis.fromEnv();

// A small log of "Test Classification" tool runs the owner has marked
// correct/incorrect — kept so the owner can look back over time at what
// the classifier got wrong and (eventually) use it to improve the real
// prompt/rules, per his own stated goal of "making the system better
// recognize these patterns." Stores the image itself (same data: URL
// convention screenshots already use elsewhere) so a wrong call can
// actually be looked back at, not just remembered as a strategy name.
const LIST_KEY = 'aiTestFeedback:log';
const FEEDBACK_TTL_SECONDS = 90 * 24 * 60 * 60; // longer than the 30-day screenshot TTL used elsewhere — this is meant to accumulate a small reviewable history, not just bridge a short matching window

router.post('/test-classify-feedback', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const body = req.body || {};
  if (typeof body.wasCorrect !== 'boolean') {
    return res.status(400).json({ error: '"wasCorrect" (true/false) is required.' });
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    timestamp: Date.now(),
    image: body.image || null,
    description: body.description || null,
    dir: body.dir || null,
    ftfcConfirmed: body.ftfcConfirmed ?? null,
    offBroadeningFormation: body.offBroadeningFormation ?? null,
    predictedStrategy: body.predictedStrategy || null,
    predictedConfidence: body.predictedConfidence || null,
    predictedReasoning: body.predictedReasoning || null,
    wasCorrect: body.wasCorrect,
    actualStrategy: body.actualStrategy || null,
    userNotes: body.userNotes || null,
  };
  await redis.set(`aiTestFeedback:${id}`, JSON.stringify(record), { ex: FEEDBACK_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);
  res.json({ ok: true, id });
});

router.get('/test-classify-feedback', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return res.json({ feedback: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`aiTestFeedback:${id}`)));
  const feedback = raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
  res.json({ feedback });
});

module.exports = router;
