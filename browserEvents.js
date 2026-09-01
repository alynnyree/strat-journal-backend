const express = require('express');
const { wrap } = require('./asyncRoute');
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
const MAX_LIST = 200; // a ceiling on what is READ, not just on how often -- an unbounded list is how a small job turns into a large one
const EVENT_TTL_SECONDS = 20 * 60; // generous cushion past the app's own 10-minute entry/exit matching window — a much older event is no longer useful to capture

async function queueBrowserEvent(type, { ticker, dir, timestamp }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, type, ticker, dir, timestamp };
  await redis.set(`browserEvent:${id}`, JSON.stringify(record), { ex: EVENT_TTL_SECONDS });
  await redis.lpush(LIST_KEY, id);
  await redis.ltrim(LIST_KEY, 0, MAX_LIST - 1);
  return record;
}

// Polled by the browser extension's background script (roughly once a
// minute — Chrome's alarms API doesn't allow finer granularity). Mirrors
// the shape of /media/pending.
router.get('/events', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  // Bounded on purpose. Each record expires after 20 minutes but its id
  // is left behind in this list, so without a ceiling AND a sweep this
  // grows for ever and every check drags the whole history along with it.
  const ids = await redis.lrange(LIST_KEY, 0, MAX_LIST - 1);
  if (!ids.length) return res.json({ events: [] });

  const raw = await Promise.all(ids.map(id => redis.get(`browserEvent:${id}`)));
  const events = [];
  const dead = [];
  ids.forEach((id, i) => {
    const r = raw[i];
    if (r == null) { dead.push(id); return; }   // its record expired; the id is litter
    try {
      events.push(typeof r === 'string' ? JSON.parse(r) : r);
    } catch (e) {
      dead.push(id);                             // unreadable is no more use than absent
    }
  });
  // Swept here rather than on a timer of its own: this is the only route
  // that reads the list, so it is the only place that can know an id has
  // outlived its record.
  for (const id of dead) {
    await redis.lrem(LIST_KEY, 0, id).catch(() => {});
  }
  res.json({ events });
}));

// Called by the extension once it's captured and uploaded a picture for an
// event, so the same one isn't offered again on the next poll.
router.delete('/events/:id', wrap(async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const { id } = req.params;
  await redis.del(`browserEvent:${id}`);
  await redis.lrem(LIST_KEY, 0, id);
  res.json({ ok: true });
}));

module.exports = { router, queueBrowserEvent };
