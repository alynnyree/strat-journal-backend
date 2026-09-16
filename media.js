const express = require('express');
const { wrap } = require('./asyncRoute');
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

// Accepts either a raw Unix-seconds number (e.g. "1723150000") or an ISO
// 8601 date string (e.g. "2026-08-22T13:49:00Z") and returns milliseconds
// since epoch, or null if neither parses. Added because not every iOS
// version's Shortcuts app offers "Unix Time" as a date format choice —
// ISO 8601 is available everywhere, so accepting both means the Shortcut
// doesn't have to fight with whatever format list happens to be on screen.
function parseTimestampToMs(raw) {
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (!Number.isNaN(asSeconds) && raw.trim() !== '') return asSeconds * 1000;
  // An ISO time carries its timezone as an offset, and east of London that
  // offset starts with a PLUS -- which means "a space" inside a web
  // address. So `...T09:49:00+02:00` arrives here as `...T09:49:00 02:00`
  // and will not read as a date at all. He is in New York, where the
  // offset is a minus and this never bites, which is exactly the kind of
  // thing that sits unnoticed until it matters. Repaired rather than
  // refused: a space can only have been a plus in this position.
  const repaired = raw.replace(/(T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?) (\d{2}:?\d{2})$/, '$1+$2');
  const asDate = Date.parse(repaired);
  return Number.isNaN(asDate) ? null : asDate;
}

// Videos are a completely different size class from a screenshot — a
// generous cap here, well beyond what a 15-minute (the owner's own
// video-vs-screenshot cutoff) screen recording should realistically need.
// NOT verified against Render's own platform limits for a single request
// body from here — if a real upload gets rejected before it reaches this
// code, that's Render's proxy, not this limit, and needs checking live.
const uploadVideoMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
const MAX_PENDING = 100; // pictures are large; a check that hands back more than this is a problem in itself
const VIDEO_LIST_KEY = 'videos:pending';
const VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60; // matches SCREENSHOT_TTL_SECONDS's reasoning

// Called by the Shortcut right after it takes and compresses a screenshot.
// Sent as a real multipart/form-data file upload — Shortcuts' "Get
// Contents of URL" with Request Body: Form lets you attach the image
// itself directly as a File-type field, which is far more reliable in the
// Shortcuts editor than trying to hand-build a JSON body with a text
// variable. The timestamp travels as a URL query parameter.
// URL: POST /media/upload?key=...&timestamp=<unix SECONDS, or an ISO 8601 date>
// Form field: "image" (type File) = the Resized Image
//
// Takes ANY field rather than insisting on one called "image", because
// this is the one part of the whole pipeline he builds by hand, in the
// Shortcuts app, from written instructions. `upload.single('image')`
// answers a field named anything else by throwing, which arrives as a
// blank failure -- so the message below, which names exactly what is
// wrong, could never be reached by the single most likely mistake. It now
// says what he called it and what it wanted.
router.post('/upload', upload.any(), wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const files = req.files || [];
  const file = files.find(f => f.fieldname === 'image') || null;
  if (!file || !file.buffer || !file.buffer.length) {
    // Three different faults, three different fixes: nothing was attached,
    // something was attached under the wrong name, or the right name
    // arrived empty.
    const error = files.length === 0
      ? 'No picture was attached — expected a Form field named "image" with Type set to File.'
      : !files.some(f => f.fieldname === 'image')
        ? `The picture was attached as "${files[0].fieldname}" — it has to be named "image", with Type set to File.`
        : 'The "image" field arrived empty — check its Type is set to File.';
    return res.status(400).json({ error });
  }
  req.file = file;
  const timestampMs = parseTimestampToMs(req.query.timestamp);
  if (timestampMs == null) {
    return res.status(400).json({ error: 'Missing or invalid "timestamp" query parameter — expected unix seconds (e.g. ?timestamp=1723150000) or an ISO 8601 date (e.g. ?timestamp=2026-08-22T13:49:00Z).' });
  }

  // Converted to a data: URL here so the rest of the app (Journal display,
  // trade cards) can treat this exactly like the manually-attached
  // screenshots already stored that way — no special-casing needed
  // elsewhere for how a screenshot arrived.
  const mime = req.file.mimetype && req.file.mimetype.startsWith('image/') ? req.file.mimetype : 'image/jpeg';
  const image = `data:${mime};base64,${req.file.buffer.toString('base64')}`;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, image, timestamp: timestampMs }; // stored as ms internally, matches trade timestamps used elsewhere
  // A rehearsal picture carries a label the whole way, so the app can show
  // it without ever attaching it to a real trade. Nothing that pretends to
  // be part of a trade goes into his journal unlabelled.
  if (req.query.test === '1' || req.query.test === 'true') record.test = true;
  if (req.query.moment) record.moment = String(req.query.moment).slice(0, 20);
  await redis.set(`screenshot:${id}`, JSON.stringify(record), { ex: SCREENSHOT_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);
  await redis.ltrim(LIST_KEY, 0, MAX_PENDING - 1);

  console.log(`Screenshot uploaded: ${id} (~${Math.round(req.file.buffer.length/1024)}KB, ts=${new Date(timestampMs).toISOString()})`);
  res.json({ ok: true, id });
}));

// Frontend polls this alongside /api/trades/pending, and tries to match
// each one against trades already in the Journal by how close its
// timestamp is to an entry or exit time.
router.get('/pending', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  // Bounded, and swept. Each picture expires on its own but its id was
  // left on this list for ever -- the same fault found in the trade-moment
  // queue, and it was in here too. A ceiling on what accumulates, not just
  // on how often it loops.
  const ids = await redis.lrange(LIST_KEY, 0, MAX_PENDING - 1);
  if (!ids.length) return res.json({ screenshots: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`screenshot:${id}`)));
  const screenshots = [];
  const dead = [];
  ids.forEach((id, i) => {
    const r = raw[i];
    if (r == null) { dead.push(id); return; }
    try {
      screenshots.push(typeof r === 'string' ? JSON.parse(r) : r);
    } catch (e) {
      dead.push(id);
    }
  });
  for (const id of dead) {
    await redis.lrem(LIST_KEY, 0, id).catch(() => {});
  }

  // ?slim=1 LEAVES THE PICTURE ITSELF OUT.
  //
  // A picture that matches no trade is deliberately left here to try again
  // -- the trade may not have reached his journal yet. But the phone asks
  // for this list every thirty seconds it is open, and the answer carried
  // every waiting picture IN FULL, up to 3MB each and up to a hundred of
  // them. So one mistimed picture that will never match anything was
  // re-downloaded thousands of times over the thirty days it is kept, and
  // nothing anywhere said so. His hosting was suspended for going over its
  // data allowance four days before this was found.
  //
  // Deciding which trade a picture belongs to needs only its TIMESTAMP. So
  // the phone takes the list without the pictures, works out which ones it
  // is going to keep, and asks for those one at a time from /media/:id/image
  // below. An unmatched picture now costs about a hundred bytes a check
  // instead of megabytes.
  //
  // The key STAYS PRESENT and null rather than being dropped, so nothing
  // reading this can mistake "not sent this time" for "there is no picture".
  const slim = String(req.query.slim || '') === '1';
  const out = slim
    ? screenshots.map(sc => Object.assign({}, sc, {
        image: null,
        hasImage: !!sc.image,
        bytes: sc.image ? sc.image.length : 0,
      }))
    : screenshots;
  res.json({ screenshots: out, waiting: screenshots.length });
}));

// One picture's actual image data, asked for only once the phone has
// decided to keep it. See the note on ?slim=1 above.
//
// Answers with a REASON rather than an empty hand: a picture that has left
// the queue and a picture that never had an image are different faults.
router.get('/:id/image', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const raw = await redis.get(`screenshot:${req.params.id}`);
  if (raw == null) {
    return res.status(404).json({
      id: req.params.id, image: null,
      reason: 'That picture is no longer waiting to be collected.',
    });
  }
  let rec;
  try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) {
    return res.status(500).json({
      id: req.params.id, image: null,
      reason: 'That picture could not be read back from storage.',
    });
  }
  res.json({
    id: rec.id, image: rec.image || null, timestamp: rec.timestamp,
    reason: rec.image ? null : 'That picture was stored without any image data.',
  });
}));

// Frontend calls this once it's successfully attached a screenshot to a
// trade, so the same one isn't offered again on the next poll.
router.delete('/:id', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`screenshot:${id}`);
  await redis.lrem(LIST_KEY, 0, id);
  res.json({ ok: true });
}));

// Called by the "stop recording, upload video" Shortcut. Unlike the
// screenshot upload above, the file itself goes to R2 object storage (see
// videoStorage.js) rather than being embedded as a data: URL — a
// multi-minute recording is far too large for the same fast key-value
// store screenshots use. Only a small pointer record (which R2 object,
// what timestamp) is kept in Redis, for the same timestamp-based matching
// the frontend already does for screenshots.
// URL: POST /media/upload-video?key=...&timestamp=<unix SECONDS, or an ISO 8601 date>
// Form field: "video" (type File)
router.post('/upload-video', uploadVideoMw.single('video'), wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  if (!isVideoStorageConfigured()) {
    return res.status(503).json({ error: 'Video storage is not configured on the server yet.' });
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ error: 'Missing "video" file — expected a Form field named "video" with Type set to File.' });
  }
  const timestampMs = parseTimestampToMs(req.query.timestamp);
  if (timestampMs == null) {
    return res.status(400).json({ error: 'Missing or invalid "timestamp" query parameter — expected unix seconds (e.g. ?timestamp=1723150000) or an ISO 8601 date (e.g. ?timestamp=2026-08-22T13:49:00Z).' });
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

  const record = { id, r2Key, timestamp: timestampMs, sizeBytes: req.file.buffer.length };
  await redis.set(`video:${id}`, JSON.stringify(record), { ex: VIDEO_TTL_SECONDS });
  await redis.lpush(VIDEO_LIST_KEY, id);
  // A ceiling on what accumulates, not just on how often it loops. Each
  // record expires on its own but its id was left on this list for ever --
  // the same fault already found and fixed in both the trade-moment queue
  // and the screenshot queue, still live here.
  await redis.ltrim(VIDEO_LIST_KEY, 0, MAX_PENDING - 1);

  console.log(`Video uploaded: ${id} (~${Math.round(req.file.buffer.length / 1024 / 1024)}MB, ts=${new Date(timestampMs).toISOString()})`);
  res.json({ ok: true, id });
}));

// Frontend polls this the same way it polls /pending for screenshots, and
// matches each one to a trade by timestamp.
router.get('/pending-videos', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(VIDEO_LIST_KEY, 0, MAX_PENDING - 1);
  if (!ids.length) return res.json({ videos: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`video:${id}`)));
  const videos = [];
  const dead = [];
  ids.forEach((id, i) => {
    const r = raw[i];
    if (r == null) { dead.push(id); return; }
    try { videos.push(typeof r === 'string' ? JSON.parse(r) : r); }
    catch (e) { dead.push(id); }
  });
  // An id whose record has expired is swept as it is found, the same as the
  // screenshot list above. This answer is already small -- it carries only
  // a pointer to each recording, never the recording itself -- so there is
  // nothing here to slim.
  for (const id of dead) {
    await redis.lrem(VIDEO_LIST_KEY, 0, id).catch(() => {});
  }
  res.json({ videos, waiting: videos.length });
}));

// Frontend calls this once it's matched a pending video to a trade, so the
// same one isn't offered again — mirrors DELETE /media/:id for screenshots,
// but under its own path since a video's pending id lives in a separate
// Redis list from screenshots' ids.
router.delete('/video/:id', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`video:${id}`);
  await redis.lrem(VIDEO_LIST_KEY, 0, id);
  res.json({ ok: true });
}));

// Hands back a temporary, signed link to actually watch a stored video —
// the R2 bucket itself is private, so nothing can play the video directly
// from its raw storage address without one of these. Expires on its own
// (1 hour), so there's no standing public link sitting around forever.
router.get('/video-url', wrap(async (req, res) => {
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
}));

// A plain web page (not JSON) so the owner can actually look at what a
// Shortcut has uploaded, straight from Safari, without any extra app or
// technical steps — just visiting this address with the App Key on the
// end shows every screenshot/video still waiting to be matched to a trade,
// newest first. Nothing here is deleted or changed; it's read-only.
// URL: GET /media/preview?key=...
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

router.get('/preview', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const shotIds = await redis.lrange(LIST_KEY, 0, -1);
  const shotRaw = shotIds.length ? await Promise.all(shotIds.map(id => redis.get(`screenshot:${id}`))) : [];
  const screenshots = shotRaw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  const videoIds = await redis.lrange(VIDEO_LIST_KEY, 0, -1);
  const videoRaw = videoIds.length ? await Promise.all(videoIds.map(id => redis.get(`video:${id}`))) : [];
  const videos = videoRaw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  let videoLinks = [];
  if (videos.length && isVideoStorageConfigured()) {
    videoLinks = await Promise.all(videos.map(async v => {
      try { return await getPlaybackUrl(v.r2Key); } catch (e) { return null; }
    }));
  }

  const shotCards = screenshots.map(s => `
    <div class="card">
      <img src="${escapeAttr(s.image)}" alt="screenshot">
      <div class="meta">${escapeAttr(new Date(s.timestamp).toLocaleString())}</div>
    </div>`).join('');

  const videoCards = videos.map((v, i) => `
    <div class="card">
      <div class="meta">${escapeAttr(new Date(v.timestamp).toLocaleString())} — ${Math.round((v.sizeBytes||0)/1024/1024)}MB</div>
      ${videoLinks[i] ? `<a href="${escapeAttr(videoLinks[i])}">Play video</a>` : '<div class="meta">(playback link unavailable)</div>'}
    </div>`).join('');

  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pending uploads</title>
<style>
body{font-family:-apple-system,sans-serif;background:#111;color:#eee;margin:0;padding:16px;}
h2{margin-top:24px;}
.card{background:#1c1c1c;border-radius:10px;padding:10px;margin-bottom:12px;}
.card img{max-width:100%;border-radius:6px;display:block;}
.meta{color:#aaa;font-size:13px;margin-top:6px;}
a{color:#4da3ff;}
</style></head>
<body>
<h2>Screenshots waiting to be matched (${screenshots.length})</h2>
${shotCards || '<div class="meta">None right now.</div>'}
<h2>Videos waiting to be matched (${videos.length})</h2>
${videoCards || '<div class="meta">None right now.</div>'}
</body></html>`);
}));

module.exports = router;
