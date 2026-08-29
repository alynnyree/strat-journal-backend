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

function credentials() {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  return key && secret ? { key, secret } : null;
}

function isConfigured() {
  return credentials() !== null;
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
  if (!isConfigured() || !Number.isFinite(timestampMs)) return null;
  if (tooRecentForFreePlan(timestampMs)) return null;
  const end = new Date(timestampMs).toISOString();
  const start = new Date(timestampMs - windowMinutes * 60 * 1000).toISOString();
  try {
    const data = await alpacaGet(`/stocks/${encodeURIComponent(symbol)}/trades`, {
      start, end, limit: 10000, feed: 'sip',
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
  if (!isConfigured() || !Number.isFinite(timestampMs)) return null;
  if (tooRecentForFreePlan(timestampMs)) return null;
  const end = new Date(timestampMs).toISOString();
  const start = new Date(timestampMs - 6 * 60 * 60 * 1000).toISOString();
  try {
    const data = await alpacaGet(`/stocks/${encodeURIComponent(symbol)}/bars`, {
      timeframe: '1Min', start, end, limit: 10000, adjustment: 'raw', feed: 'sip',
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

// The underlying price at a fill, best available source first, along with
// HOW it was arrived at. The caller stores that alongside the number so a
// figure is never shown as exact when it is not.
async function underlyingPriceAt(symbol, timestampMs) {
  const printed = await lastTradePriceAt(symbol, timestampMs);
  if (printed != null) return { price: printed, source: 'alpaca-trade', exact: true };

  const minute = await minuteCloseAt(symbol, timestampMs);
  if (minute != null) return { price: minute, source: 'alpaca-1m', exact: false };

  return null;
}

module.exports = {
  isConfigured, underlyingPriceAt, lastTradePriceAt, minuteCloseAt,
  tooRecentForFreePlan, FREE_PLAN_DELAY_MS,
};
