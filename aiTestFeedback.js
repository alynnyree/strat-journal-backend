const express = require('express');
const { wrap } = require('./asyncRoute');
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

// Feedback records are kept FOREVER — no expiry. The owner's requirement
// is that every chart he has ever judged keeps improving the journal, so
// an entry quietly ageing out would silently undo work he had already
// done. (This previously expired after 90 days, which was wrong for
// exactly that reason.)
//
// The one thing that does still expire is the full-size picture, which
// is the only part big enough to matter: a few hundred entries of
// phone-sized screenshots would fill the storage plan on their own. The
// small teaching copy is permanent, so after the original ages out the
// entry still shows a picture in the log AND still teaches — it just
// shows the smaller one. Nothing is ever forgotten, only downscaled.
const FULL_IMAGE_TTL_SECONDS = 90 * 24 * 60 * 60;
const fullImageKey = id => `aiTestFeedback:img:${id}`;

router.post('/test-classify-feedback', wrap(async (req, res) => {
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
    // The per-timeframe read behind that verdict ("1D up, 4H up, 1H down"),
    // so a correction can land on the specific timeframe misread rather
    // than only on the overall verdict.
    predictedFtfcTimeframes: body.predictedFtfcTimeframes || null,
    actualFtfcTimeframes: body.actualFtfcTimeframes || null,
    predictedBroadeningFormation: body.predictedBroadeningFormation || null,
    wasCorrect: body.wasCorrect,
    actualStrategy: body.actualStrategy || null,
    // The owner's own corrections for the other two layers — stored as
    // true/false/null (null = he didn't say), not coerced, so "he didn't
    // correct this" stays distinguishable from "he said no."
    // Kept as text now that continuity has four states rather than two
    // ("confirmed" / "partial" / "none" / "unclear"). Older entries saved
    // this as true/false; normaliseFtfc below reads both.
    actualFtfc: body.actualFtfc == null ? null : String(body.actualFtfc),
    actualBroadeningFormation: body.actualBroadeningFormation == null ? null : !!body.actualBroadeningFormation,
    userNotes: body.userNotes || null,
  };
  // The full-size picture is split out under its own key so it can expire
  // on its own without taking the lesson with it.
  const fullImage = record.image;
  if (fullImage) {
    await redis.set(fullImageKey(id), fullImage, { ex: FULL_IMAGE_TTL_SECONDS });
    record.image = null;
  }
  await redis.set(`aiTestFeedback:${id}`, JSON.stringify(record));
  await redis.lpush(LIST_KEY, id);
  res.json({ ok: true, id });
}));

router.get('/test-classify-feedback', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return res.json({ feedback: [] });

  const feedback = await readAllFeedback();
  // Only the browsing view needs the full-size pictures — the teaching
  // path deliberately never loads them.
  const fulls = await Promise.all(feedback.map(f => redis.get(fullImageKey(f.id))));
  feedback.forEach((f, i) => {
    // Falls back to the small copy once the original has aged out, so an
    // old entry still shows its chart rather than turning into a blank.
    f.image = fulls[i] || f.teachImage || null;
  });
  res.json({ feedback });
}));

// Removing one entry. This matters more than an ordinary delete button
// because corrections are permanent and every one of them influences
// every future classification — so a mistaken correction that can't be
// removed is a wrong lesson taught forever. Takes the entry out of the
// index, the record itself, and its full-size picture, so nothing is
// left teaching from beyond the grave.
router.delete('/test-classify-feedback/:id', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Missing id.' });

  // Index first: if a later step fails, a stranded record is harmless,
  // whereas an index pointing at a deleted record shows a broken row.
  await redis.lrem(LIST_KEY, 0, id);
  await redis.del(`aiTestFeedback:${id}`);
  await redis.del(fullImageKey(id));
  res.json({ ok: true, id });
}));

async function readAllFeedback() {
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return [];
  const raw = await Promise.all(ids.map(id => redis.get(`aiTestFeedback:${id}`)));
  return raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
}

// Entries saved before records became permanent still carry an expiry
// from the old behaviour, so they would vanish on their own schedule
// even now. This strips that, once, at startup — turning the existing
// history into part of the permanent record rather than leaving the
// owner with a memory that only starts from today.
async function persistExistingFeedback() {
  try {
    const ids = await redis.lrange(LIST_KEY, 0, -1);
    let persisted = 0;
    for (const id of ids) {
      // -1 = already permanent, -2 = already gone. Only the rest need it.
      const ttl = await redis.ttl(`aiTestFeedback:${id}`);
      if (ttl > 0) { await redis.persist(`aiTestFeedback:${id}`); persisted++; }
    }
    if (persisted) console.log(`Test feedback: made ${persisted} existing entr${persisted === 1 ? 'y' : 'ies'} permanent.`);
  } catch (err) {
    console.log('Could not make existing test feedback permanent:', err.message);
  }
}

// How many past corrections travel VERBATIM with each classification.
// Every one is re-sent on EVERY call, so this is a real cost/latency
// dial rather than a free "more is better" — which is why the full
// history travels as the digest below instead, and this cap covers only
// the recent ones worth quoting in full.
const MAX_TEACHING_EXAMPLES = 20;
const MAX_CORRECT_EXAMPLES = 5; // the rest of the budget goes to corrections, which teach far more

// --- The digest: how EVERY correction ever made keeps teaching ---------
//
// The verbatim cap above is what the owner objected to, and rightly:
// with only the newest 20 travelling, a lesson he taught months ago
// stopped having any effect. The fix is not to send everything — that
// grows without limit and eventually makes every classification slow —
// but to send a summary of everything alongside the recent detail.
//
// The key property: this digest's size grows with the number of DISTINCT
// KINDS of mistake, not the number of uploads. There are only nine
// combos, so the confusion table can never be large no matter how many
// hundreds of charts he judges, and a lesson from his very first upload
// survives forever as long as it is the only example of that mistake.
const MAX_DIGEST_PAIRS = 10;
const MAX_DIGEST_ACCURACY_ROWS = 8;
const MAX_NOTE_CHARS = 220; // one long note must not crowd out the others

// Entries predate the four-state answer, so old values have to keep
// meaning what they meant: a plain "yes"/true was a confirmed run, a
// "no"/false was none. Without this an entire back-history of lessons
// would read as unrecognised values and quietly stop counting.
function normaliseFtfc(v) {
  if (v == null || v === '') return null;
  if (v === true) return 'confirmed';
  if (v === false) return 'none';
  const t = String(v).toLowerCase();
  if (t === 'yes' || t === 'true') return 'confirmed';
  if (t === 'no' || t === 'false') return 'none';
  if (['confirmed', 'partial', 'none', 'unclear'].includes(t)) return t;
  return t;
}

const actualComboOf = f => (f.wasCorrect ? f.predictedStrategy : f.actualStrategy) || null;
const trimNote = n => {
  const t = String(n || '').trim();
  if (!t) return '';
  return t.length > MAX_NOTE_CHARS ? t.slice(0, MAX_NOTE_CHARS - 1).trimEnd() + '…' : t;
};

function buildLessonsDigest(all) {
  if (!all || !all.length) return '';
  const wrong = all.filter(f => f.wasCorrect === false);

  // 1. Which misreadings actually recur, across the whole history.
  const pairs = new Map();
  for (const f of wrong) {
    const actual = actualComboOf(f);
    const predicted = f.predictedStrategy || 'unclear';
    if (!actual || actual === predicted) continue;
    const key = `${actual}|${predicted}`;
    const entry = pairs.get(key) || { actual, predicted, count: 0, note: '', noteAt: -1 };
    entry.count++;
    // Keep the most recent explanation he gave for this kind of mistake —
    // his latest thinking on it, and the part that teaches most.
    const note = trimNote(f.userNotes);
    if (note && (f.timestamp || 0) > entry.noteAt) { entry.note = note; entry.noteAt = f.timestamp || 0; }
    pairs.set(key, entry);
  }
  const topPairs = [...pairs.values()].sort((a, b) => b.count - a.count || b.noteAt - a.noteAt).slice(0, MAX_DIGEST_PAIRS);

  // 2. Which combos it reads reliably and which it does not.
  const combo = new Map();
  for (const f of all) {
    const actual = actualComboOf(f);
    if (!actual) continue;
    const e = combo.get(actual) || { total: 0, right: 0 };
    e.total++;
    if (f.wasCorrect) e.right++;
    combo.set(actual, e);
  }
  const weakest = [...combo.entries()]
    .filter(([, e]) => e.total >= 2)
    .sort((a, b) => (a[1].right / a[1].total) - (b[1].right / b[1].total) || b[1].total - a[1].total)
    .slice(0, MAX_DIGEST_ACCURACY_ROWS);

  // 3. The other two layers, which have their own recurring biases.
  const layerTally = (predKey, actKey) => {
    const t = new Map();
    const isFtfc = actKey === 'actualFtfc';
    for (const f of wrong) {
      const a = f[actKey];
      if (a == null) continue;
      const actual = isFtfc ? normaliseFtfc(a) : (a === true ? 'yes' : (a === false ? 'no' : String(a)));
      const predicted = (isFtfc ? normaliseFtfc(f[predKey]) : f[predKey]) || 'unclear';
      if (actual === predicted) continue;
      const k = `said "${predicted}" when he said "${actual}"`;
      t.set(k, (t.get(k) || 0) + 1);
    }
    return [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  };
  const ftfc = layerTally('predictedFtfc', 'actualFtfc');
  const broadening = layerTally('predictedBroadeningFormation', 'actualBroadeningFormation');

  const section = (title, lines) => (lines.length ? `\n${title}\n${lines.join('\n')}` : '');

  return `

EVERYTHING THIS AI HAS EVER GOT WRONG — a running summary of all ${all.length} chart${all.length === 1 ? '' : 's'} the trader has judged (${wrong.length} correction${wrong.length === 1 ? '' : 's'}). This covers his ENTIRE history, including charts too old to be quoted in full below. Treat these as standing rules about how HE reads charts.${section(
    'Misreadings that keep recurring (what it truly was → what this AI wrongly called it):',
    topPairs.map(p => `- It was "${p.actual}" but this AI called it "${p.predicted}" — ${p.count} time${p.count === 1 ? '' : 's'}.${p.note ? ` He explained: "${p.note}"` : ''}`),
  )}${section(
    'Track record by combo (lowest accuracy first — be most careful with these):',
    weakest.map(([k, e]) => `- "${k}": read correctly ${e.right} of ${e.total} times.`),
  )}${section(
    'Recurring FTFC errors:',
    ftfc.map(([k, n]) => `- This AI ${k} — ${n} time${n === 1 ? '' : 's'}.`),
  )}${section(
    'Recurring Broadening Formation errors:',
    broadening.map(([k, n]) => `- This AI ${k} — ${n} time${n === 1 ? '' : 's'}.`),
  )}
`;
}

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
  // Recent ones quoted in full, the whole history summarised. Together
  // these mean nothing the owner has ever taught stops counting.
  return {
    examples: [...wrongSlice, ...correctSlice],
    digest: buildLessonsDigest(all),
    total: all.length,
  };
}

module.exports = router;
module.exports.getTeachingExamples = getTeachingExamples;
module.exports.readAllFeedback = readAllFeedback;
module.exports.buildLessonsDigest = buildLessonsDigest;
module.exports.normaliseFtfc = normaliseFtfc;
module.exports.persistExistingFeedback = persistExistingFeedback;
