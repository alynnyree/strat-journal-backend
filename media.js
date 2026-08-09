const express = require('express');
const { Redis } = require('@upstash/redis');

const router = express.Router();

// Uses the SDK's own documented fromEnv() helper, which reads
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — the standard names
// Upstash itself sets when a database is provisioned and linked to Render.
// If these aren't set under those exact names for some reason, every route
// below will fail loudly with a clear "Missing UPSTASH_REDIS_REST_URL"
// error rather than silently doing nothing — easy to spot and fix.
const redis = Redis.fromEnv();

const LIST_KEY = 'screenshots:pending';
const SCREENSHOT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long enough for a slow-to-close trade to still get matched, short enough not to let stray/unmatched uploads pile up forever

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

// Called by the Shortcut right after it takes and compresses a screenshot.
// Sent as a real multipart/form-data file upload — Shortcuts' "Get
// Contents of URL" with Request Body: Form lets you attach the image
// itself directly as a File-type field, which is far more reliable in the
// Shortcuts editor than trying to hand-build a JSON body with a text
// variable. The timestamp travels as a URL query parameter.
// URL: POST /media/upload?key=...&timestamp=<unix SECONDS>
// Form field: "image" (type File) = the Resized Image
router.post('/upload', upload.single('image'), async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'Missing "image" file — expected a Form field named "image" with Type set to File.' });
  }
  const timestampRaw = req.query.timestamp;
  const timestamp = timestampRaw ? Number(timestampRaw) : NaN;
  if (!timestampRaw || Number.isNaN(timestamp)) {
    return res.status(400).json({ error: 'Missing or invalid "timestamp" query parameter — expected unix seconds, e.g. ?timestamp=1723150000.' });
  }

  // Converted to a data: URL here so the rest of the app (Journal display,
  // trade cards) can treat this exactly like the manually-attached
  // screenshots already stored that way — no special-casing needed
  // elsewhere for how a screenshot arrived.
  const mime = req.file.mimetype && req.file.mimetype.startsWith('image/') ? req.file.mimetype : 'image/jpeg';
  const image = `data:${mime};base64,${req.file.buffer.toString('base64')}`;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, image, timestamp: timestamp * 1000 }; // store as ms internally, matches trade timestamps used elsewhere
  await redis.set(`screenshot:${id}`, JSON.stringify(record), { ex: SCREENSHOT_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);

  console.log(`Screenshot uploaded: ${id} (~${Math.round(req.file.buffer.length/1024)}KB, ts=${new Date(timestamp*1000).toISOString()})`);
  res.json({ ok: true, id });
});

// Frontend polls this alongside /api/trades/pending, and tries to match
// each one against trades already in the Journal by how close its
// timestamp is to an entry or exit time.
router.get('/pending', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return res.json({ screenshots: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`screenshot:${id}`)));
  const screenshots = raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
  res.json({ screenshots });
});

// Frontend calls this once it's successfully attached a screenshot to a
// trade, so the same one isn't offered again on the next poll.
router.delete('/:id', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`screenshot:${id}`);
  await redis.lrem(LIST_KEY, 0, id);
  res.json({ ok: true });
});

module.exports = router;
