// Which market feed Alpaca is asked for. Every request used to demand
// 'sip' -- the PAID feed -- in the same file whose own comment says the
// plan is the free one. On a free key that is refused, the refusal was
// logged where nobody reads it, and Alpaca reported itself connected
// while contributing nothing at all.
const Module = require('module');
const path = require('path');

// Records every request so the feed asked for can be inspected.
const asked = [];
let behaviour = () => ({ bars: [{ t:'2026-02-26T14:30:00Z', o:1, h:2, l:0.5, c:1.5, v:10 }] });

const fakeRedis = { get: async()=>null, set: async()=>'OK', del: async()=>1 };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === 'axios') {
    return { get: async (url, cfg) => {
      const params = (cfg && cfg.params) || {};
      asked.push({ url, feed: params.feed });
      return { data: behaviour(params) };
    } };
  }
  return origLoad.apply(this, arguments);
};

process.env.ALPACA_KEY_ID = 'k'; process.env.ALPACA_SECRET_KEY = 's';
const alpaca = require(path.join(__dirname, '..', 'alpacaClient.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

const refuse = (status, body) => { const e = new Error('Request failed with status code ' + status);
  e.response = { status, data: body || { message: 'subscription does not permit querying recent SIP data' } }; return e; };

(async () => {
  // ===== 1. No request may hardcode the paid feed =====
  {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'alpacaClient.js'), 'utf8');
    check('nothing demands the paid feed outright', !/feed:\s*'sip'/.test(src));
  }

  // ===== 2. A free key: sip refused, iex used, and REMEMBERED =====
  {
    asked.length = 0;
    behaviour = (params) => {
      if (params.feed === 'sip') throw refuse(403);
      return { bars: [{ t:'2026-02-26T14:30:00Z', o:1, h:2, l:0.5, c:1.5, v:10 }] };
    };
    const bars = await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-02-26T14:00:00Z'), endMs: Date.parse('2026-02-26T15:00:00Z') });
    check(`candles come back on a free key (${bars && bars.length})`, !!bars && bars.length === 1);
    check(`it tried the better feed first (${asked.map(a=>a.feed).join(' > ')})`, asked[0].feed === 'sip');
    check('then dropped to the one the key has', asked[1].feed === 'iex');
    check('and it says which feed is in use', alpaca.feedState().feed === 'iex');
    check('and that it had to downgrade', alpaca.feedState().downgraded === true);

    // The refusal must happen ONCE, not on every request thereafter.
    asked.length = 0;
    await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-02-26T14:00:00Z'), endMs: Date.parse('2026-02-26T15:00:00Z') });
    const triedSip = asked.some(a => a.feed === 'sip');
    check(`it does not ask for the refused feed again (${asked.map(a=>a.feed).join(',')})`, !triedSip);
  }

  // ===== 3. A refusal is recognised however Alpaca words it =====
  {
    check('a 403 is a feed refusal', alpaca.feedRefused(refuse(403)));
    check('a 400 naming the subscription is too',
      alpaca.feedRefused(refuse(400, { message: 'your subscription does not permit this feed' })));
    check('a plain 500 is NOT — that is a real failure',
      !alpaca.feedRefused(refuse(500, { message: 'server blew up' })));
    check('nor a timeout', !alpaca.feedRefused(new Error('ETIMEDOUT')));
  }

  // ===== 4. A real failure is not mistaken for a feed problem =====
  {
    asked.length = 0;
    behaviour = () => { throw refuse(500, { message: 'boom' }); };
    const bars = await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-02-26T14:00:00Z'), endMs: Date.parse('2026-02-26T15:00:00Z') });
    check('a genuine failure still returns "could not"', bars === null);
  }

  // ===== 5. New keys mean the plan may differ, so relearn =====
  {
    await alpaca.saveKeys('newkey', 'newsecret');
    check('saving new keys forgets the old plan', alpaca.feedState().feed === null);
    check('and clears the downgrade note', alpaca.feedState().downgraded === false);
  }

  // ===== 6. A paid key keeps the better feed =====
  {
    asked.length = 0;
    behaviour = () => ({ bars: [{ t:'2026-02-26T14:30:00Z', o:1, h:2, l:0.5, c:1.5, v:10 }] });
    const bars = await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-02-26T14:00:00Z'), endMs: Date.parse('2026-02-26T15:00:00Z') });
    check('a key that CAN have the full feed uses it', alpaca.feedState().feed === 'sip');
    check('and is not marked as downgraded', alpaca.feedState().downgraded === false);
    check('candles still come back', !!bars && bars.length === 1);
    check('only one request was needed', asked.length === 1);
  }

  // ===== 7. A learned feed must never be the ONLY one tried ==========
  // His exact symptom: the stock price came back "from Alpaca, exact"
  // (so the full feed was learned from the trades request), and then
  // every request for chart bars was refused it -- with no fallback left,
  // so Bar Replay was empty while everything else worked.
  {
    // Learn 'sip' from a request that IS allowed it.
    await alpaca.saveKeys('k2', 's2');
    asked.length = 0;
    behaviour = (params) => {
      if (String(params.timeframe || '') === '' ) return { trades: [{ t:'2026-05-15T16:00:00Z', p: 741.48 }] };
      return { bars: [{ t:'2026-05-15T16:00:00Z', o:1,h:2,l:0.5,c:1.5,v:10 }] };
    };
    await alpaca.lastTradePriceAt('SPY', Date.parse('2026-05-15T16:00:00Z'));
    check(`the price request learns the full feed (${alpaca.feedState().feed})`,
      alpaca.feedState().feed === 'sip');

    // Now bars are refused that feed -- the case that was silently failing.
    asked.length = 0;
    behaviour = (params) => {
      if (params.feed === 'sip' && params.timeframe) throw refuse(403);
      return { bars: [{ t:'2026-05-15T16:00:00Z', o:1,h:2,l:0.5,c:1.5,v:10 }] };
    };
    const bars = await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-05-15T15:00:00Z'), endMs: Date.parse('2026-05-15T16:00:00Z') });
    check(`chart bars still come back (${bars && bars.length})`, !!bars && bars.length === 1);
    check(`it fell back rather than giving up (${asked.map(a=>a.feed).join(' > ')})`,
      asked.length >= 2 && asked[asked.length-1].feed === 'iex');
    check('and the remembered feed is corrected downward', alpaca.feedState().feed === 'iex');
    check('and the downgrade is recorded', alpaca.feedState().downgraded === true);
  }

  // ===== 8. The learned feed is still tried FIRST (no wasted requests) =
  {
    asked.length = 0;
    behaviour = () => ({ bars: [{ t:'2026-05-15T16:00:00Z', o:1,h:2,l:0.5,c:1.5,v:10 }] });
    await alpaca.fetchBars('SPY', { minutes:1, startMs: Date.parse('2026-05-15T15:00:00Z'), endMs: Date.parse('2026-05-15T16:00:00Z') });
    check(`the remembered feed is asked first and alone when it works (${asked.map(a=>a.feed).join(',')})`,
      asked.length === 1 && asked[0].feed === 'iex');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
