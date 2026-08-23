const express = require('express');
const { Redis } = require('@upstash/redis');

const router = express.Router();
const redis = Redis.fromEnv();

// A lightweight queue of "a trade just opened / is still open / closed"
// signals for a browser extension to poll — the laptop/desktop equivalent
// of the Pushcut notifications the phone already reacts to. Only a small
// pointer record is stored here (no image); the extension itself takes the
// screenshot and uploads it to the existing /media/upload route, same as
// the phone Shortcuts do, using this event's own `timestamp` (the real
// trade open/close time) rather than whatever time the extension happens
// to poll at.
const LIST_KEY = 'browserEvents:pending';
const EVENT_TTL_SECONDS = 20 * 60; // generous cushion past the app's own 10-minute entry/exit matching window — a much older event is no longer useful to capture

async function queueBrowserEvent(type, { ticker, dir, timestamp }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, type, ticker, dir, timestamp };
  await redis.set(`browserEvent:${id}`, JSON.stringify(record), { ex: EVENT_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);
  return record;
}

// Polled by the browser extension's background script (roughly once a
// minute — Chrome's alarms API doesn't allow finer granularity). Mirrors
// the shape of /media/pending.
router.get('/events', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const ids = await redis.lrange(LIST_KEY, 0, -1);
  if (!ids.length) return res.json({ events: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`browserEvent:${id}`)));
  const events = raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
    .filter(Boolean);
  res.json({ events });
});

// Called by the extension once it's captured and uploaded a picture for an
// event, so the same one isn't offered again on the next poll.
router.delete('/events/:id', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`browserEvent:${id}`);
  await redis.lrem(LIST_KEY, 0, id);
  res.json({ ok: true });
});

module.exports = { router, queueBrowserEvent };
