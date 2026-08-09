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

// Called by the Shortcut right after it takes and compresses a screenshot.
// The image is sent as the RAW request body (the Text action's output
// directly — no JSON wrapping needed), and the timestamp travels as a URL
// query parameter instead of a body field. This sidesteps building a JSON
// body inside Shortcuts entirely, which turned out to be an unreliable
// step in the Shortcuts editor.
// URL: POST /media/upload?key=...&timestamp=<unix SECONDS>
// Body (raw text, Content-Type doesn't matter): data:image/jpeg;base64,....
router.post('/upload', express.text({ limit: '5mb', type: () => true }), async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const image = typeof req.body === 'string' ? req.body.trim() : '';
  const timestampRaw = req.query.timestamp;
  const timestamp = timestampRaw ? Number(timestampRaw) : NaN;

  if (!image || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Missing or invalid image body — expected a data:image/... base64 string as the raw POST body.' });
  }
  if (!timestampRaw || Number.isNaN(timestamp)) {
    return res.status(400).json({ error: 'Missing or invalid "timestamp" query parameter — expected unix seconds, e.g. ?timestamp=1723150000.' });
  }
  // Rough sanity cap on the decoded size (base64 is ~4/3 the size of raw
  // bytes) — protects both Upstash's per-value limits and the free
  // storage budget from an accidentally-uncompressed upload.
  const approxBytes = image.length * 0.75;
  if (approxBytes > 3 * 1024 * 1024) {
    return res.status(413).json({ error: `Image too large (~${Math.round(approxBytes/1024)}KB). The Shortcut should resize/compress before uploading — see setup notes.` });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, image, timestamp: timestamp * 1000 }; // store as ms internally, matches trade timestamps used elsewhere
  await redis.set(`screenshot:${id}`, JSON.stringify(record), { ex: SCREENSHOT_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);

  console.log(`Screenshot uploaded: ${id} (~${Math.round(approxBytes/1024)}KB, ts=${new Date(timestamp*1000).toISOString()})`);
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
