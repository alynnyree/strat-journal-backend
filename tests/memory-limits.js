// "Exceeded its memory limit, which triggered an automatic restart."
//
// Render kills the server for a SPIKE, so the risk is any single place
// that can build up an unbounded list. These are measured, not assumed.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL = 'https://x';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
process.env.ALPACA_KEY_ID = 'k'; process.env.ALPACA_SECRET_KEY = 's';

let pagesServed = 0;
const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') {
    class Redis { constructor(){} async get(){return null;} async set(){} async del(){} }
    return { Redis: Object.assign(Redis, { fromEnv: () => new Redis() }) };
  }
  if (req === 'axios') {
    return { get: async () => {
      // A source that never stops offering more pages -- the shape that
      // makes an unbounded fetch dangerous.
      pagesServed++;
      const bars = new Array(10000).fill(0).map((_, i) => ({
        t: new Date(1700000000000 + i * 60000).toISOString(), o:1.1, h:1.2, l:1.0, c:1.15, v:100 }));
      return { data: { bars, next_page_token: 'more' } };
    }, post: async () => ({ data: {} }) };
  }
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

(async () => {
  const alpaca = require('../alpacaClient');
  const before = rssMb();
  const bars = await alpaca.fetchBars('SPY', { minutes: 1, startMs: Date.parse('2020-01-01'), endMs: Date.now() - 30*60000 });
  const after = rssMb();
  const grew = after - before;

  check(`a source that never stops offering pages is cut off (got ${bars.length.toLocaleString()} candles)`,
    bars.length <= 150000);
  check(`and it stops well before the 200-page limit (${pagesServed} pages fetched)`, pagesServed <= 20);
  check(`memory grew by ${grew}MB, not hundreds`, grew < 120);
  check('what comes back is still usable, in time order',
    bars.length > 0 && bars.every((b, i) => i === 0 || b.datetime >= bars[i-1].datetime));

  // The peak is what a server gets killed for, so it must be reported.
  const guard = require('../crashGuard');
  const m = guard.memoryMb();
  check(`health can report memory in use (${m.nowMb}MB)`, typeof m.nowMb === 'number' && m.nowMb > 0);
  check(`and the highest it has reached (${m.peakMb}MB)`, m.peakMb >= m.nowMb);

  // The watcher must never be the reason the process stays alive.
  const t = guard.watchMemory(50);
  check('the memory watcher cannot hold the server open on its own',
    typeof t === 'object' && t !== null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
