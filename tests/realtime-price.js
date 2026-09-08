// A trade that closed minutes ago used to get a stock price up to a
// minute stale, because every Alpaca request under 15 minutes old was
// refused outright. The free plan does delay the FULL market tape by 15
// minutes -- but it serves IEX in real time, and that was being thrown
// away.
const Module = require('module');
const path = require('path');

let asked = [];
let behaviour = () => ({});
const fakeRedis = { get: async()=>null, set: async()=>'OK', del: async()=>1 };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === 'axios') {
    return { get: async (url, cfg) => {
      const params = (cfg && cfg.params) || {};
      asked.push({ url, feed: params.feed, start: params.start, end: params.end });
      return { data: behaviour(params) };
    } };
  }
  return realLoad.apply(this, arguments);
};
process.env.ALPACA_KEY_ID = 'k'; process.env.ALPACA_SECRET_KEY = 's';
const alpaca = require(path.join(__dirname, '..', 'alpacaClient.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log(`PASS: ${l}`); } else { fail++; console.log(`FAIL: ${l}`); } };
const refuse = (status) => { const e = new Error('refused'); e.response = { status, data: {} }; return e; };

(async () => {

  // ===== 1. A moment inside the delay asks the real-time feed =========
  {
    asked = [];
    const justNow = Date.now() - 3 * 60 * 1000;         // three minutes ago
    behaviour = () => ({ trades: [{ t: new Date(justNow - 1000).toISOString(), p: 741.48 }] });
    const hit = await alpaca.underlyingPriceAt('SPY', justNow);
    check('a three-minute-old fill now gets a price at all', hit != null && hit.price === 741.48);
    check('  and it is a real print, not a candle', hit.source === 'alpaca-trade' && hit.exact === true);
    check('  asked the real-time feed', asked.length === 1 && asked[0].feed === 'iex');
    check('  and did NOT ask the delayed full tape', !asked.some(a => a.feed === 'sip'));
    check('  it is marked as improvable later', hit.upgradable === true);
  }

  // ===== 2. An older moment still prefers the full tape ===============
  {
    asked = [];
    const older = Date.now() - 60 * 60 * 1000;          // an hour ago
    behaviour = () => ({ trades: [{ t: new Date(older - 1000).toISOString(), p: 655.42 }] });
    const hit = await alpaca.underlyingPriceAt('SPY', older);
    check('an hour-old fill is priced from the full tape', asked[0].feed === 'sip');
    check('  and is NOT marked improvable — there is nothing better to wait for',
      hit.upgradable === false);
  }

  // ===== 3. A restricted ask must not teach the wrong lesson =========
  {
    // Learn 'sip' from a normal request.
    asked = [];
    behaviour = () => ({ trades: [{ t: '2026-05-15T16:00:00Z', p: 1 }] });
    await alpaca.underlyingPriceAt('SPY', Date.parse('2026-05-15T16:00:00Z'));
    check(`the full feed is learned from an ordinary request (${alpaca.feedState().feed})`,
      alpaca.feedState().feed === 'sip');
    // Now a recent one, deliberately restricted to iex.
    asked = [];
    const justNow = Date.now() - 60 * 1000;
    behaviour = () => ({ trades: [{ t: new Date(justNow - 500).toISOString(), p: 2 }] });
    await alpaca.underlyingPriceAt('SPY', justNow);
    check('asking the real-time feed on purpose does not downgrade what was learned',
      alpaca.feedState().feed === 'sip');
    check('  and is not recorded as a downgrade', alpaca.feedState().downgraded === false);
  }

  // ===== 4. Still falls back properly when a feed is refused =========
  {
    asked = [];
    const older = Date.now() - 60 * 60 * 1000;
    behaviour = (params) => {
      if (params.feed === 'sip') throw refuse(403);
      return { trades: [{ t: new Date(older - 1000).toISOString(), p: 99.5 }] };
    };
    const hit = await alpaca.underlyingPriceAt('SPY', older);
    check('a refused full tape still falls back rather than giving up', hit && hit.price === 99.5);
    check(`  and tried both (${asked.map(a => a.feed).join(' > ')})`,
      asked.length >= 2 && asked[asked.length - 1].feed === 'iex');
  }

  // ===== 5. No print at all still answers honestly ===================
  {
    asked = [];
    const justNow = Date.now() - 2 * 60 * 1000;
    behaviour = (params) => (params.timeframe ? { bars: [] } : { trades: [] });
    const hit = await alpaca.underlyingPriceAt('SPY', justNow);
    check('a quiet second with no print comes back as nothing, not as a guess', hit === null);
  }

  // ===== 6. A minute bar for a recent moment uses real-time too ======
  {
    asked = [];
    const justNow = Date.now() - 4 * 60 * 1000;
    behaviour = (params) => (params.timeframe
      ? { bars: [{ t: new Date(justNow - 30000).toISOString(), c: 500.25 }] }
      : { trades: [] });
    const hit = await alpaca.underlyingPriceAt('SPY', justNow);
    check('falling to the minute bar still works inside the delay', hit && hit.price === 500.25);
    check('  and it too asked the real-time feed', asked.every(a => a.feed === 'iex'));
    check('  and it too is marked improvable', hit.upgradable === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
