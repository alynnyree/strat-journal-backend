// A server that has just restarted has NOTHING in memory. His Alpaca keys
// live in storage. Every path that can use Alpaca must load them first --
// asking the empty cache answers "no" and silently falls back to Schwab,
// which is why his trades kept showing an approximate stock price.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL = 'https://x';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
delete process.env.ALPACA_KEY_ID; delete process.env.ALPACA_SECRET_KEY;

const STORED = { key: 'AKTESTKEY1234', secret: 'sekret' };
let storedKeys = STORED;          // what is saved (survives a restart)
const alpacaCalls = [];
let schwabCalls = 0;

const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') {
    class Redis {
      constructor(){}
      async get(k){ return k === 'alpaca:keys' ? storedKeys : null; }
      async set(){} async del(){} async lrange(){return [];} async lpush(){} async ltrim(){}
    }
    return { Redis: Object.assign(Redis, { fromEnv: () => new Redis() }) };
  }
  if (req === 'axios') {
    return { get: async (url) => {
      if (/alpaca/.test(url)) {
        alpacaCalls.push(url);
        if (/\/trades/.test(url)) return { data: { trades: [{ t: '2026-06-24T19:55:00Z', p: 4.9012 }] } };
        return { data: { bars: [] } };
      }
      schwabCalls++;
      // Dated BEFORE the trade, or the lookup correctly finds nothing to
      // use -- the whole point is that it takes the last candle before.
      return { data: { candles: [{ close: 4.87, datetime: Date.parse('2026-06-24T19:54:00Z') }] } };
    }, post: async () => ({ data: {} }) };
  }
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

(async () => {
  // ---- 1. The bug itself: a cold cache used to answer "no" ----
  const alpaca = require('../alpacaClient');
  check('straight after a restart the keys are NOT in memory yet', alpaca.isConfigured() === false);
  check('but asking properly finds them in storage', (await alpaca.isReady()) === true);
  check('and after that they are in memory', alpaca.isConfigured() === true);

  // ---- 2. The real path: a trade being priced on a fresh server ----
  // Reload everything so nothing is cached from the check above.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  alpacaCalls.length = 0; schwabCalls = 0;

  const cron = require('../cron');
  const trades = [{ ticker: 'NIO', entryTimestamp: Date.parse('2026-06-24T19:55:00Z'),
                    exitTimestamp: Date.parse('2026-07-23T16:32:00Z') }];
  await cron.enrichWithUnderlyingPrices('token', trades);
  const t = trades[0];
  check(`Alpaca is actually asked on a freshly restarted server (${alpacaCalls.length} calls)`, alpacaCalls.length > 0);
  check(`the price comes from a real trade print, not a candle (source: ${t.undEntrySource})`, t.undEntrySource === 'alpaca-trade');
  check(`and is marked exact (${t.undEntryExact})`, t.undEntryExact === true);
  check(`the price is the printed one (${t.undEntry})`, t.undEntry === 4.9012);
  check('and it did not fall back to Schwab', schwabCalls === 0);
  check('the trade records that Alpaca was available when it was priced', t.undPricedWithAlpaca === true);

  // ---- 3. With no keys saved at all, it still works -- just approximate ----
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  storedKeys = null; alpacaCalls.length = 0; schwabCalls = 0;
  const cron2 = require('../cron');
  const t2 = [{ ticker: 'NIO', entryTimestamp: Date.parse('2026-06-24T19:55:00Z') }];
  await cron2.enrichWithUnderlyingPrices('token', t2);
  console.log('   (no-keys result:', JSON.stringify(t2[0]), ')');
  check('with no Alpaca keys it still gets a price from Schwab', t2[0].undEntry === 4.87);
  check('marked as not exact, honestly', t2[0].undEntryExact === false);
  check('and marked as never having been checked with Alpaca', t2[0].undPricedWithAlpaca === false);

  // ---- 4. No file may go back to asking the cold cache ----
  const fs = require('fs');
  const offenders = fs.readdirSync(__dirname + '/..').filter(f => f.endsWith('.js') && f !== 'alpacaClient.js' && !f.startsWith('__'))
    .filter(f => /alpaca\.isConfigured\s*\(/.test(fs.readFileSync(__dirname + '/../' + f, 'utf8')));
  check(`no file asks the cold cache any more (${offenders.join(', ') || 'none'})`, offenders.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
