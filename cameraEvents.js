const express = require('express');
const crypto = require('crypto');
const { requireAppKey } = require('./appKey');
const { wrap } = require('./asyncRoute');
const { Redis } = require('@upstash/redis');
const videoStorage = require('./videoStorage');
const media = require('./media');

// THE CHART CAMERA (a small computer at home that keeps his TradingView
// chart open all market day and records it). This file is everything the
// service does for it:
//
//   1. a DURABLE list of trade moments (opened / closed), numbered. The
//      laptop add-on's queue (browserEvents.js) forgets a moment after
//      twenty minutes and deletes it once read; the camera sits on a home
//      connection that drops, so it needs to catch up after a gap instead.
//      Nothing here is deleted on reading: the camera remembers the last
//      number it saw and asks for everything after it.
//   2. a heartbeat the camera sends once a minute, kept so "is the camera
//      running?" has an answer, and answered with the service's own clock
//      so the camera can tell whether ITS clock is right.
//   3. a temporary upload link for a recording, so a few hundred megabytes
//      go straight to storage and never count against this service's free
//      monthly allowance; and the pointer registered afterwards, only once
//      storage confirms the file is really there.
//
// The camera takes its own pictures and decides its own timings from these
// moments. The service never waits on it and nothing here can hold up a
// sync: queueing a moment is fire-and-forget, with its own catch.

const router = express.Router();
// Every route in this file needs the app key, checked once, first.
router.use(requireAppKey);
const redis = Redis.fromEnv();

const EVENTS_KEY = 'camera:events';
const SEQ_KEY = 'camera:seq';
const HEARTBEAT_KEY = 'camera:heartbeat';
const LAST_TEST_VIDEO_KEY = 'camera:lastTestVideo';
const MAX_EVENTS = 500;                       // a ceiling on what is kept AND read: weeks of trading
const HEARTBEAT_TTL_SECONDS = 2 * 24 * 60 * 60;
const ONLINE_WITHIN_SECONDS = 3 * 60;         // three missed minutes and it reads as not running
const TEST_CLOSE_AFTER_MS = 6 * 60 * 1000;    // past the 5-minute mark, so a practice trade shows a "during" picture

async function queueCameraEvent(type, fields) {
  const seq = Number(await redis.incr(SEQ_KEY));
  const record = Object.assign({}, fields, { seq, type, queuedAt: Date.now() });
  await redis.lpush(EVENTS_KEY, JSON.stringify(record));
  await redis.ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
  return record;
}

function parseRecord(r) {
  if (r == null) return null;
  try { const o = typeof r === 'string' ? JSON.parse(r) : r; return o && Number.isSafeInteger(o.seq) ? o : null; }
  catch (e) { return null; }
}

// GET /camera/events?after=<seq>: every kept moment numbered after <seq>,
// oldest first. `latestSeq` is the newest number kept, so the camera can
// tell "nothing new" from "I am far behind and some moments have already
// been dropped off the end" (oldestSeq > after + 1).
router.get('/events', wrap(async (req, res) => {
  const after = Number(req.query.after);
  const from = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  const raw = await redis.lrange(EVENTS_KEY, 0, MAX_EVENTS - 1);
  const all = raw.map(parseRecord).filter(Boolean).sort((a, b) => a.seq - b.seq);
  const events = all.filter(e => e.seq > from);
  res.json({
    events,
    latestSeq: all.length ? all[all.length - 1].seq : 0,
    oldestSeq: all.length ? all[0].seq : 0,
    serverTime: Date.now(),
  });
}));

// The fields a heartbeat may carry. Anything else is dropped, and text is
// cut short: this is a report, not a place to store things.
const HEARTBEAT_FIELDS = ['version', 'recording', 'chart', 'symbol', 'signedOut', 'lastFrameAt', 'clockOffsetMs',
  'diskFreeBytes', 'diskTotalBytes', 'outbox', 'pendingJobs', 'lastSeq', 'drops', 'misses', 'problem', 'startedAt'];
function cleanHeartbeat(body) {
  const out = {};
  for (const k of HEARTBEAT_FIELDS) {
    if (!(k in (body || {}))) continue;
    const v = body[k];
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map(x => (typeof x === 'string' ? x.slice(0, 300) : x));
  }
  return out;
}

router.post('/heartbeat', wrap(async (req, res) => {
  const serverTime = Date.now();
  const beat = Object.assign(cleanHeartbeat(req.body), { receivedAt: serverTime });
  await redis.set(HEARTBEAT_KEY, JSON.stringify(beat), { ex: HEARTBEAT_TTL_SECONDS });
  res.json({ ok: true, serverTime });
}));

// "Is the camera running, and if not, since when?" Three answers that must
// never share one: it has never checked in, it checked in recently, it has
// gone quiet (and when it was last heard from).
router.get('/status', wrap(async (req, res) => {
  const raw = await redis.get(HEARTBEAT_KEY);
  const beat = parseBeat(raw);
  let lastTestVideo = null;
  try { const t = await redis.get(LAST_TEST_VIDEO_KEY); lastTestVideo = t == null ? null : (typeof t === 'string' ? JSON.parse(t) : t); } catch (e) { lastTestVideo = null; }
  if (!beat) return res.json({ state: 'never', heartbeat: null, secondsSince: null, lastTestVideo });
  const secondsSince = Math.max(0, Math.round((Date.now() - beat.receivedAt) / 1000));
  res.json({ state: secondsSince <= ONLINE_WITHIN_SECONDS ? 'online' : 'quiet', heartbeat: beat, secondsSince, lastTestVideo });
}));
function parseBeat(r) {
  if (r == null) return null;
  try { const o = typeof r === 'string' ? JSON.parse(r) : r; return o && typeof o.receivedAt === 'number' ? o : null; }
  catch (e) { return null; }
}

// A temporary link to upload ONE recording straight to storage.
router.post('/video-upload-url', wrap(async (req, res) => {
  if (!videoStorage.isConfigured()) {
    return res.status(503).json({ error: 'Recordings are not switched on for storage yet, so there is nowhere to put this one.' });
  }
  const id = `camera-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const r2Key = `videos/${id}.mp4`;
  const expiresInSeconds = 15 * 60;
  const uploadUrl = await videoStorage.getUploadUrl(r2Key, 'video/mp4', expiresInSeconds);
  res.json({ id, r2Key, uploadUrl, contentType: 'video/mp4', expiresInSeconds });
}));

// The recording has been uploaded: confirm it is really in storage, then
// offer it to the journal like any other recording. Matched to a trade by
// its ENTRY time, the same as every recording the journal already takes.
router.post('/video-uploaded', wrap(async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const r2Key = String(b.r2Key || '');
  if (!/^camera-\d+-[0-9a-f]{8}$/.test(id) || r2Key !== `videos/${id}.mp4`) {
    return res.status(400).json({ error: 'That is not a recording this service handed out an upload link for.' });
  }
  const entry = Number(b.entryTimestamp), exit = Number(b.exitTimestamp);
  if (!Number.isSafeInteger(entry) || entry <= 0) {
    return res.status(400).json({ error: 'The recording did not say when the trade was entered, so it could not be matched to one.' });
  }
  const there = await videoStorage.headVideo(r2Key);
  if (!there.found) return res.status(409).json({ error: there.reason });
  const extra = { source: 'camera' };
  if (Number.isSafeInteger(exit) && exit > 0) extra.exitTimestamp = exit;
  if (typeof b.ticker === 'string') extra.ticker = b.ticker.slice(0, 12);
  // A PRACTICE recording never joins the journal's waiting list: the
  // journal matches recordings by time alone, so one made during a
  // rehearsal could otherwise be filed against a real trade taken within
  // minutes of it. It is kept to one side, where the rehearsal can show it.
  if (b.test === true) {
    const rec = Object.assign(extra, { test: true, id, r2Key, timestamp: entry, sizeBytes: there.sizeBytes, at: Date.now() });
    await redis.set(LAST_TEST_VIDEO_KEY, JSON.stringify(rec), { ex: HEARTBEAT_TTL_SECONDS });
    return res.json({ ok: true, test: true, video: rec });
  }
  // A trade longer than the kept length: which minutes were left out, so
  // the journal can say so instead of passing a cut recording off as whole.
  if (b.cut && Number.isSafeInteger(b.cut.skippedFrom) && Number.isSafeInteger(b.cut.skippedTo)) {
    extra.cut = { skippedFrom: b.cut.skippedFrom, skippedTo: b.cut.skippedTo };
  }
  const record = await media.registerPendingVideo({ id, r2Key, timestamp: entry, sizeBytes: there.sizeBytes, extra });
  res.json({ ok: true, video: record });
}));

// A practice trade for the camera: an opening now and a closing six
// minutes later, so a rehearsal produces an entry picture, one "during"
// picture and an exit picture, and a short recording. Labelled as a test
// the whole way, so nothing from it is ever filed against a real trade.
async function queueCameraTestTrade({ ticker = 'SPY', now = Date.now() } = {}) {
  const t = String(ticker).toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 8) || 'SPY';
  const legKey = `TEST-${t}-${now}`;
  const opened = await queueCameraEvent('opened', { ticker: t, dir: 'Long', legKey, entryTimestamp: now, test: true });
  const closed = await queueCameraEvent('closed', {
    ticker: t, dir: 'Long', legKey, entryTimestamp: now, exitTimestamp: now + TEST_CLOSE_AFTER_MS, stillOpen: false, test: true,
  });
  return [opened, closed];
}

router.post('/test-trade', wrap(async (req, res) => {
  const queued = await queueCameraTestTrade({ ticker: (req.body && req.body.ticker) || req.query.ticker });
  res.json({ ok: true, moments: queued.length, closesInSeconds: TEST_CLOSE_AFTER_MS / 1000 });
}));

module.exports = {
  router, queueCameraEvent, queueCameraTestTrade,
  EVENTS_KEY, MAX_EVENTS, ONLINE_WITHIN_SECONDS, TEST_CLOSE_AFTER_MS,
};
