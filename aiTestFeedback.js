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
    // A deliberately small, heavily-shrunk copy of the same picture, made
    // by the phone before upload. `image` is the full-size one kept for
    // looking back at in the log; `teachImage` is the only one ever sent
    // to the AI as a past example, because that one gets re-uploaded on
    // every future classification and so has to stay tiny. Null for video
    // uploads and for entries saved before this existed — those simply
    // teach by their text, exactly as before.
    teachImage: body.teachImage || null,
    description: body.description || null,
    dir: body.dir || null,
    ftfcConfirmed: body.ftfcConfirmed ?? null,
    offBroadeningFormation: body.offBroadeningFormation ?? null,
    predictedStrategy: body.predictedStrategy || null,
    predictedConfidence: body.predictedConfidence || null,
    predictedReasoning: body.predictedReasoning || null,
    // What the model read for the other two layers, so a wrong call can be
    // reviewed on all three fronts later, not just the combo name.
    predictedFtfc: body.predictedFtfc || null,
    predictedBroadeningFormation: body.predictedBroadeningFormation || null,
    wasCorrect: body.wasCorrect,
    actualStrategy: body.actualStrategy || null,
    // The owner's own corrections for the other two layers — stored as
    // true/false/null (null = he didn't say), not coerced, so "he didn't
    // correct this" stays distinguishable from "he said no."
    actualFtfc: body.actualFtfc == null ? null : !!body.actualFtfc,
    actualBroadeningFormation: body.actualBroadeningFormation == null ? null : !!body.actualBroadeningFormation,
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

async function readAllFeedback() {
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return [];
  const raw = await Promise.all(ids.map(id => redis.get(`aiTestFeedback:${id}`)));
  return raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
}

// How many past corrections travel with each classification request.
// Every example is re-sent on EVERY call, so this is a real cost/latency
// dial, not a free "more is better" — hence a deliberate cap rather than
// sending the whole log.
const MAX_TEACHING_EXAMPLES = 20;
const MAX_CORRECT_EXAMPLES = 5; // the rest of the budget goes to corrections, which teach far more

// Picks which past corrections are worth showing the model on the next
// classification. Entries the trader marked WRONG are the valuable ones —
// they show exactly where the model's reading diverges from his — so they
// get most of the budget, newest first. A few confirmed-correct examples
// are included too, so the model gets some signal about what it's already
// reading right rather than only ever seeing failures.
async function getTeachingExamples() {
  const all = await readAllFeedback();
  const byNewest = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
  const wrong = all.filter(f => f.wasCorrect === false).sort(byNewest);
  const right = all.filter(f => f.wasCorrect === true).sort(byNewest);
  const correctSlice = right.slice(0, MAX_CORRECT_EXAMPLES);
  const wrongSlice = wrong.slice(0, MAX_TEACHING_EXAMPLES - correctSlice.length);
  return [...wrongSlice, ...correctSlice];
}

module.exports = router;
module.exports.getTeachingExamples = getTeachingExamples;
module.exports.readAllFeedback = readAllFeedback;
