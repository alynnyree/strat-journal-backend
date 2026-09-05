// Alpaca market data — used for ONE thing: what the underlying stock was
// actually trading at when a fill went through.
//
// Why this exists. Schwab's trade record says what was paid for the
// option; it never says where SPY was at that instant. So the underlying
// price has always been a reconstruction: the CLOSE of the last candle
// before the fill, cascading 1m → 5m → 30m → daily as older data runs
// out. On a trade from last week that is the close of the preceding
// minute. On one from March it can be a 30-minute close, or the previous
// day's. Realized R:R is computed from it and inherits every bit of that
// error.
//
// Two things fix it, both on Alpaca's free tier:
//   1. Minute bars going back years, not the ~30-35 days Schwab keeps.
//      This is the bigger win — it removes the cliff that makes older
//      trades worst.
//   2. The individual trades that printed on the exchange, so the price
//      at the actual second of the fill can be read rather than inferred
//      from a bar. Free for anything older than 15 minutes.
//
// Everything here degrades to null rather than guessing. A caller that
// gets null falls back to the Schwab reconstruction, so a missing key or
// a bad day for Alpaca costs accuracy, never correctness.
const axios = require('axios');

const DATA_BASE = 'https://data.alpaca.markets/v2';

// Keys can come from two places: the server's own settings, or typed
// into the app. The second exists because the owner has no technical
// background and adding server settings by hand is a genuinely awkward
// job — the app already takes his Backend URL and App Key the same way,
// so this is the path he already knows.
//
// Held in memory once read, so a lookup does not hit storage per trade.
let savedKeys = null;
let savedKeysLoaded = false;

// Built on first use, not on load. Creating it at import time makes every
// module that pulls this one in depend on storage being reachable, which
// it need not be — and the whole point of this file is that it degrades
// to doing nothing rather than breaking anything.
const KEY_STORE = 'alpaca:keys';
let redisClient = null;
function store() {
  if (!redisClient) {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

async function loadSavedKeys() {
  try {
    const data = await store().get(KEY_STORE);
    savedKeys = data && data.key && data.secret ? data : null;
  } catch (err) {
    console.log('Could not read the saved Alpaca keys:', err.message);
    savedKeys = null;
  }
  savedKeysLoaded = true;
  return savedKeys;
}

async function saveKeys(key, secret) {
  // A different key may be on a different plan, so forget which feed the
  // old one had rather than carrying a stale answer forward.
  feedInUse = null; feedDowngraded = false;
  const clean = { key: String(key || '').trim(), secret: String(secret || '').trim() };
  if (!clean.key || !clean.secret) throw new Error('Both an API key and a secret are needed.');
  await store().set(KEY_STORE, clean);
  // Held in memory too, so the keys work for this run even if reading
  // them back later fails.
  savedKeys = clean;
  savedKeysLoaded = true;
  return true;
}

async function clearKeys() {
  await store().del(KEY_STORE);
  savedKeys = null;
  savedKeysLoaded = true;
}

// Reads the keys, preferring the server's own settings so they can always
// override what was typed in.
async function ensureKeysLoaded() {
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) return;
  if (!savedKeysLoaded) await loadSavedKeys();
}

function credentials() {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (key && secret) return { key, secret };
  return savedKeys || null;
}

function isConfigured() {
  return credentials() !== null;
}

// The safe way to ask "can we use Alpaca?".
//
// isConfigured() reads only what is already in memory. The keys he typed
// into the app live in storage, and memory is empty every time the server
// restarts -- which Render does on its own, and which happened when the
// server crashed on 30 August. So asking isConfigured() cold answers "no"
// even though the keys are sitting right there, and the caller silently
// falls back to Schwab. That is exactly why his trades kept showing an
// approximate stock price instead of an exact one.
//
// Always use this, never isConfigured(), before deciding whether to use
// Alpaca for something.
async function isReady() {
  try { await ensureKeysLoaded(); } catch (err) { /* fall through to the check */ }
  return isConfigured();
}

// Where the keys came from, for the app to show him honestly.
function keyStatus() {
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) {
    return { connected: true, from: 'server settings' };
  }
  if (savedKeys) {
    return { connected: true, from: 'typed into the app',
             keyEnding: savedKeys.key.slice(-4) };
  }
  return { connected: false, from: null };
}

async function alpacaGet(pathname, params) {
  const creds = credentials();
  if (!creds) throw new Error('Alpaca keys are not set on the server.');
  const resp = await axios.get(`${DATA_BASE}${pathname}`, {
    headers: {
      'APCA-API-KEY-ID': creds.key,
      'APCA-API-SECRET-KEY': creds.secret,
      accept: 'application/json',
    },
    params,
    timeout: 15000,
  });
  return resp.data;
}

// WHICH DATA FEED. Alpaca serves two: 'sip', the full consolidated tape,
// which is part of the PAID plan; and 'iex', which is what a free key
// gets. Every request here used to ask for 'sip' outright -- in the same
// file whose own comment below says the plan is the free one. On a free
// key that is refused, the refusal was caught and written to a log nobody
// reads, and the answer came back as null. So Alpaca reported itself
// "connected" while contributing nothing at all: no candles for Bar
// Replay, no exact prices, nothing.
//
// Now it asks for the better feed, and if that is refused it drops to the
// one the key actually has and REMEMBERS which worked, so the refusal
// happens once rather than on every request. Which feed is in use is
// reported, so a downgrade is never silent again.
let feedInUse = null;      // 'sip' or 'iex', learned from the first answer
let feedDowngraded = false;

function feedRefused(err) {
  const status = err && err.response && err.response.status;
  const body = JSON.stringify((err && err.response && err.response.data) || '');
  // Alpaca answers a feed the key cannot have with a 403, and sometimes a
  // 400 whose body names the subscription.
  return status === 403 || (status === 400 && /subscription|feed|not authorized|not permitted/i.test(body));
}

// Asks with the best feed the key has, learning which that is.
async function alpacaGetFeed(pathname, params) {
  // The learned feed goes FIRST, but never alone. A key can be allowed
  // the full feed for one kind of request and refused it for another --
  // which is exactly what happened: the stock price came back "from
  // Alpaca, exact" (so the full feed was learned from the trades
  // request), and every request for chart bars was then refused it with
  // no fallback left to try. fetchBars caught the refusal and returned
  // nothing, so Bar Replay was empty while everything else worked.
  //
  // Learning an answer once and never re-testing it is the fault. The
  // remembered feed is a starting point, not a commitment.
  const feeds = [];
  if (feedInUse) feeds.push(feedInUse);
  for (const f of ['sip', 'iex']) if (!feeds.includes(f)) feeds.push(f);
  let lastErr = null;
  for (const feed of feeds) {
    try {
      const data = await alpacaGet(pathname, { ...params, feed });
      if (feedInUse !== feed) {
        feedInUse = feed;
        if (feed === 'iex') {
          feedDowngraded = true;
          console.log('Alpaca: the full market feed was refused for this key, so the free one is in use. Prices and candles still work; they cover fewer venues.');
        }
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (!feedRefused(err)) throw err;   // a real failure, not a feed it cannot have
    }
  }
  throw lastErr;
}

// So a downgrade can be SHOWN rather than logged where nobody looks.
function feedState() {
  return { feed: feedInUse, downgraded: feedDowngraded };
}

// Alpaca's free plan serves full-market history for anything older than
// 15 minutes. Asking for something more recent than that returns nothing
// useful, so it is not worth the request — and a trade closed moments ago
// still has Schwab's own 1-minute data, which is accurate at that age.
const FREE_PLAN_DELAY_MS = 15 * 60 * 1000;
function tooRecentForFreePlan(timestampMs) {
  return Date.now() - timestampMs < FREE_PLAN_DELAY_MS;
}

// The price of the last trade that printed at or before this moment.
// This is the real thing: an actual transaction on the exchange, not a
// bar's closing value.
//
// Looks back over a window rather than at an instant, because a quiet
// second may contain no trade at all. Takes the LAST trade in the window,
// which is the most recent one at or before the moment asked for.
async function lastTradePriceAt(symbol, timestampMs, { windowMinutes = 10 } = {}) {
  await ensureKeysLoaded();
  if (!isConfigured() || !Number.isFinite(timestampMs)) return null;
  if (tooRecentForFreePlan(timestampMs)) return null;
  const end = new Date(timestampMs).toISOString();
  const start = new Date(timestampMs - windowMinutes * 60 * 1000).toISOString();
  try {
    const data = await alpacaGetFeed(`/stocks/${encodeURIComponent(symbol)}/trades`, {
      start, end, limit: 10000,
    });
    const trades = data?.trades || [];
    if (!trades.length) return null;
    // Guard against anything after the moment asked for slipping in.
    const upTo = trades.filter(t => Date.parse(t.t) <= timestampMs);
    const chosen = (upTo.length ? upTo : trades)[Math.max(0, (upTo.length ? upTo : trades).length - 1)];
    const price = Number(chosen?.p);
    return Number.isFinite(price) ? price : null;
  } catch (err) {
    console.log(`Alpaca trade lookup failed for ${symbol}:`, err.response?.status || err.message);
    return null;
  }
}

// The close of the minute containing (or immediately before) this moment.
// Second best to an actual print, but far better than a 30-minute bar,
// and it reaches back years where Schwab's minute data stops at ~35 days.
async function minuteCloseAt(symbol, timestampMs) {
  await ensureKeysLoaded();
  if (!isConfigured() || !Number.isFinite(timestampMs)) return null;
  if (tooRecentForFreePlan(timestampMs)) return null;
  const end = new Date(timestampMs).toISOString();
  const start = new Date(timestampMs - 6 * 60 * 60 * 1000).toISOString();
  try {
    const data = await alpacaGetFeed(`/stocks/${encodeURIComponent(symbol)}/bars`, {
      timeframe: '1Min', start, end, limit: 10000, adjustment: 'raw',
    });
    const bars = data?.bars || [];
    if (!bars.length) return null;
    const upTo = bars.filter(b => Date.parse(b.t) <= timestampMs);
    const bar = (upTo.length ? upTo : bars)[(upTo.length ? upTo : bars).length - 1];
    const close = Number(bar?.c);
    return Number.isFinite(close) ? close : null;
  } catch (err) {
    console.log(`Alpaca bar lookup failed for ${symbol}:`, err.response?.status || err.message);
    return null;
  }
}

// Candles, in the same shape the rest of the app already uses, so an
// Alpaca-sourced bar and a Schwab-sourced one are interchangeable.
//
// This is the bigger half of what Alpaca is for. Schwab keeps roughly 35
// days of minute data, which is why backtesting was stuck testing a month
// and why a trade older than that had no Bar Replay. Alpaca keeps years.
const ALPACA_TIMEFRAME = {
  1: '1Min', 3: '3Min', 5: '5Min', 10: '10Min', 15: '15Min', 30: '30Min', 60: '1Hour',
};

// Alpaca pages long ranges; a year of 1-minute bars is far more than one
// response holds, so every page is followed to the end.
// The most candles any one request may build up in memory. A year of
// every minute of the trading day is about 98,000, so this is comfortably
// more than anything real, while being roughly 20MB rather than 274MB.
const MAX_BARS = 150000;

async function fetchBars(symbol, { minutes = 1, startMs, endMs, daily = false }) {
  await ensureKeysLoaded();
  if (!isConfigured()) return null;
  const timeframe = daily ? '1Day' : ALPACA_TIMEFRAME[minutes];
  if (!timeframe) return null;

  // Never ask for anything inside the window the free plan holds back.
  const cappedEnd = Math.min(endMs ?? Date.now(), Date.now() - FREE_PLAN_DELAY_MS);
  if (cappedEnd <= startMs) return [];

  const out = [];
  let pageToken = null;
  let pages = 0;
  let truncated = false;
  try {
    do {
      const params = {
        timeframe,
        start: new Date(startMs).toISOString(),
        end: new Date(cappedEnd).toISOString(),
        limit: 10000, adjustment: 'raw',
      };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGetFeed(`/stocks/${encodeURIComponent(symbol)}/bars`, params);
      for (const bar of (data?.bars || [])) {
        out.push({
          datetime: Date.parse(bar.t),
          open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v,
        });
      }
      pageToken = data?.next_page_token || null;
      pages++;
      // A guard against following pages for ever if the token never clears.
      if (pages > 200) break;
      // And a guard on the SIZE, which is the one that actually mattered.
      // The page cap alone allowed two million candles in a single list.
      // Measured on this data shape that is 274MB in one go, on a server
      // whose whole memory allowance is a fraction of that -- which is
      // what "exceeded its memory limit" in Render's alert means. Nothing
      // in this app has a use for more candles than the cap below (that
      // is over a year of every single minute), so hitting it means a
      // request was wrong, and it says so rather than quietly returning
      // less than was asked for.
      if (out.length >= MAX_BARS) { truncated = true; break; }
    } while (pageToken);
  } catch (err) {
    console.log(`Alpaca bars failed for ${symbol} (${timeframe}):`, err.response?.status || err.message);
    return null;   // null means "could not", which is different from "none"
  }
  if (truncated) {
    console.log(`Alpaca bars for ${symbol} (${timeframe}) hit the ${MAX_BARS.toLocaleString()}-candle ceiling — the answer is the OLDEST ${MAX_BARS.toLocaleString()}, not everything asked for. Ask for a shorter span.`);
  }
  out.sort((a, b) => a.datetime - b.datetime);
  return out;
}

// The underlying price at a fill, best available source first, along with
// HOW it was arrived at. The caller stores that alongside the number so a
// figure is never shown as exact when it is not.
async function underlyingPriceAt(symbol, timestampMs) {
  await ensureKeysLoaded();
  const printed = await lastTradePriceAt(symbol, timestampMs);
  if (printed != null) return { price: printed, source: 'alpaca-trade', exact: true };

  const minute = await minuteCloseAt(symbol, timestampMs);
  if (minute != null) return { price: minute, source: 'alpaca-1m', exact: false };

  return null;
}

module.exports = {
  isConfigured, isReady, underlyingPriceAt, lastTradePriceAt, minuteCloseAt,
  tooRecentForFreePlan, FREE_PLAN_DELAY_MS, fetchBars, ALPACA_TIMEFRAME,
  feedState, feedRefused,
  saveKeys, clearKeys, loadSavedKeys, ensureKeysLoaded, keyStatus,
};
