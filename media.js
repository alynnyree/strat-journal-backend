const express = require('express');
const { Redis } = require('@upstash/redis');
const { uploadVideo, getPlaybackUrl, isConfigured: isVideoStorageConfigured } = require('./videoStorage');

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

// Videos are a completely different size class from a screenshot — a
// generous cap here, well beyond what a 15-minute (the owner's own
// video-vs-screenshot cutoff) screen recording should realistically need.
// NOT verified against Render's own platform limits for a single request
// body from here — if a real upload gets rejected before it reaches this
// code, that's Render's proxy, not this limit, and needs checking live.
const uploadVideoMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
const VIDEO_LIST_KEY = 'videos:pending';
const VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60; // matches SCREENSHOT_TTL_SECONDS's reasoning

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

// Called by the "stop recording, upload video" Shortcut. Unlike the
// screenshot upload above, the file itself goes to R2 object storage (see
// videoStorage.js) rather than being embedded as a data: URL — a
// multi-minute recording is far too large for the same fast key-value
// store screenshots use. Only a small pointer record (which R2 object,
// what timestamp) is kept in Redis, for the same timestamp-based matching
// the frontend already does for screenshots.
// URL: POST /media/upload-video?key=...&timestamp=<unix SECONDS>
// Form field: "video" (type File)
router.post('/upload-video', uploadVideoMw.single('video'), async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  if (!isVideoStorageConfigured()) {
    return res.status(503).json({ error: 'Video storage is not configured on the server yet.' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'Missing "video" file — expected a Form field named "video" with Type set to File.' });
  }
  const timestampRaw = req.query.timestamp;
  const timestamp = timestampRaw ? Number(timestampRaw) : NaN;
  if (!timestampRaw || Number.isNaN(timestamp)) {
    return res.status(400).json({ error: 'Missing or invalid "timestamp" query parameter — expected unix seconds, e.g. ?timestamp=1723150000.' });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = (req.file.mimetype && req.file.mimetype.split('/')[1]) || 'mov';
  const r2Key = `videos/${id}.${ext}`;

  try {
    await uploadVideo(r2Key, req.file.buffer, req.file.mimetype);
  } catch (err) {
    console.log('Video upload to R2 failed:', err.message);
    return res.status(502).json({ error: 'Upload to storage failed — check server logs.' });
  }

  const record = { id, r2Key, timestamp: timestamp * 1000, sizeBytes: req.file.buffer.length };
  await redis.set(`video:${id}`, JSON.stringify(record), { ex: VIDEO_TTL_SECONDS });
  await redis.lpush(VIDEO_LIST_KEY, id);

  console.log(`Video uploaded: ${id} (~${Math.round(req.file.buffer.length / 1024 / 1024)}MB, ts=${new Date(timestamp * 1000).toISOString()})`);
  res.json({ ok: true, id });
});

// Frontend polls this the same way it polls /pending for screenshots, and
// matches each one to a trade by timestamp.
router.get('/pending-videos', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(VIDEO_LIST_KEY, 0, -1);
  if (!ids.length) return res.json({ videos: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`video:${id}`)));
  const videos = raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
  res.json({ videos });
});

// Frontend calls this once it's matched a pending video to a trade, so the
// same one isn't offered again — mirrors DELETE /media/:id for screenshots,
// but under its own path since a video's pending id lives in a separate
// Redis list from screenshots' ids.
router.delete('/video/:id', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`video:${id}`);
  await redis.lrem(VIDEO_LIST_KEY, 0, id);
  res.json({ ok: true });
});

// Hands back a temporary, signed link to actually watch a stored video —
// the R2 bucket itself is private, so nothing can play the video directly
// from its raw storage address without one of these. Expires on its own
// (1 hour), so there's no standing public link sitting around forever.
router.get('/video-url', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  if (!isVideoStorageConfigured()) {
    return res.status(503).json({ error: 'Video storage is not configured on the server yet.' });
  }
  const r2Key = req.query.r2Key;
  if (!r2Key) {
    return res.status(400).json({ error: 'Missing "r2Key" query parameter.' });
  }
  try {
    const url = await getPlaybackUrl(r2Key);
    res.json({ url });
  } catch (err) {
    console.log('Presigned video URL generation failed:', err.message);
    res.status(502).json({ error: 'Could not generate a playback link — check server logs.' });
  }
});

module.exports = router;
