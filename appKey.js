// ONE check for the app key, used by every private route.
//
// Audit, 29 September 2026: eighteen routes -- including the one that wipes
// the server's trade list (/api/trades/reset) and the one that hands out
// every trade (/api/trades/pending) -- answered anyone at all, and the
// twenty-eight routes that did check the key each did so with their own copy
// of `req.query.key !== process.env.APP_SECRET`. That copy has two faults:
//
//   1. The key travels in the web address, where it is written into
//      browser history and server logs.
//   2. If APP_SECRET is ever missing, `undefined !== undefined` is false, so
//      a request with NO key passes. It fails OPEN.
//
// So the key is now read from an `Authorization: Bearer <key>` header. The
// old `?key=` is still accepted for now, because the owner's iPhone Shortcut,
// his Chrome add-on and the Schwab sign-in link (a page navigation, which
// cannot carry a header) still send it that way -- his decision D: accept it
// temporarily, record who still uses it, and switch it off once nothing has
// for an agreed period. The record never contains the key itself.
//
// A missing APP_SECRET now refuses every private request (fail CLOSED), with
// its own answer, so "the server is not set up" can never be confused with
// "you sent the wrong key".
const crypto = require('crypto');

function presentedKey(req) {
  const header = (req.get && req.get('authorization')) || (req.headers && req.headers.authorization) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (m) return { key: m[1].trim(), via: 'header' };
  const q = req.query && typeof req.query.key === 'string' ? req.query.key : '';
  if (q) return { key: q, via: 'query' };
  return { key: null, via: null };
}

// Compared in constant time, so the time an answer takes says nothing about
// how much of a guess was right.
function sameSecret(given, secret) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Three different answers, never folded into one:
//   { ok: true, via }                 -- right key, and how it arrived
//   { ok: false, reason: 'no-secret' } -- the SERVER has no key set up
//   { ok: false, reason: 'no-key' }    -- the request brought no key
//   { ok: false, reason: 'wrong-key' } -- the request brought the wrong one
function keyCheck(req) {
  const secret = process.env.APP_SECRET;
  if (!secret) return { ok: false, reason: 'no-secret' };
  const { key, via } = presentedKey(req);
  if (!key) return { ok: false, reason: 'no-key' };
  // A header, if present, is the answer -- a right key in the address does
  // not rescue a wrong one in the header.
  if (!sameSecret(key, secret)) return { ok: false, reason: 'wrong-key', via };
  return { ok: true, via };
}

function keyOk(req) {
  return keyCheck(req).ok;
}

// ---- Who still sends the key in the address (decision D) ----------------
//
// Kept in memory and written to storage at most once a minute per kind of
// caller, so a busy caller cannot run up the free database's command count.
// Only the KIND of caller, the route and the time are kept -- never the key,
// and never the query string it came in.
const QUERY_USE_KEY = 'auth:queryKeyUse';
const FLUSH_EVERY_MS = 60 * 1000;
const queryUse = new Map(); // kind -> { count, lastAt, lastRoute, flushedAt }

function callerKind(req) {
  const ua = String((req.get && req.get('user-agent')) || '');
  const origin = String((req.get && req.get('origin')) || '');
  if (/^chrome-extension:\/\//i.test(origin)) return 'chrome add-on';
  if (/Shortcuts|WorkflowKit|CFNetwork/i.test(ua)) return 'iPhone Shortcut';
  if (/^https:\/\/alynnyree\.github\.io$/i.test(origin)) return 'app';
  if (/Safari|Mobile|Chrome|Firefox/i.test(ua)) return 'a browser (sign-in link or unknown page)';
  return 'other';
}

let redis = null;
function store() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redis;
}

function noteQueryKeyUse(req) {
  const kind = callerKind(req);
  const route = `${req.method} ${(req.baseUrl || '') + (req.path || '')}`;
  const now = Date.now();
  const rec = queryUse.get(kind) || { count: 0, lastAt: 0, lastRoute: null, flushedAt: 0 };
  rec.count++;
  rec.lastAt = now;
  rec.lastRoute = route;
  queryUse.set(kind, rec);
  if (now - rec.flushedAt < FLUSH_EVERY_MS) return;
  rec.flushedAt = now;
  const r = store();
  if (!r) return;
  // Fire and forget, with its own catch: recording who used the old way must
  // never be the thing that fails a request.
  Promise.resolve()
    .then(() => r.hset(QUERY_USE_KEY, {
      [kind]: JSON.stringify({ lastAt: new Date(now).toISOString(), lastRoute: route, countSinceStart: rec.count }),
    }))
    .catch(err => console.log('Could not record ?key= use:', (err && err.message) || err));
}

// What is known about ?key= use: this run's own tally, plus what earlier runs
// wrote down.
async function queryKeyUse() {
  const out = {};
  const r = store();
  if (r) {
    try {
      const saved = (await r.hgetall(QUERY_USE_KEY)) || {};
      for (const [kind, v] of Object.entries(saved)) {
        out[kind] = typeof v === 'string' ? JSON.parse(v) : v;
      }
    } catch (err) {
      out._readError = (err && err.message) || String(err);
    }
  }
  for (const [kind, rec] of queryUse) {
    out[kind] = Object.assign({}, out[kind], {
      lastAt: new Date(rec.lastAt).toISOString(),
      lastRoute: rec.lastRoute,
      countSinceStart: rec.count,
    });
  }
  return out;
}

// For routers: every route behind it needs the key.
function requireAppKey(req, res, next) {
  const r = keyCheck(req);
  if (r.ok) {
    if (r.via === 'query') noteQueryKeyUse(req);
    return next();
  }
  if (r.reason === 'no-secret') {
    return res.status(503).json({
      error: 'This server has no app key set up (APP_SECRET), so it refuses every private request until one is set.',
    });
  }
  // 403 and the plain word, exactly as every existing check answered -- the
  // app already reads a 403 as "your App Key does not match".
  return res.status(403).send('Forbidden');
}

module.exports = { keyCheck, keyOk, requireAppKey, callerKind, queryKeyUse, _presentedKey: presentedKey };
