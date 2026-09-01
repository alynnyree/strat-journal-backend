// The reminder is useless unless the scheduled check actually runs it.
// This calls the real scheduled check with everything around it faked,
// rather than matching text in the source -- a comment moving used to be
// enough to break a test like that.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');

let signInChecked = 0;
let syncRan = 0;

const fakeRedis = {
  // A sign-in that exists on file, so collecting trades genuinely reaches
  // Schwab and genuinely fails -- the real shape of a lapsed sign-in,
  // rather than the server skipping the whole step as "never connected".
  get: async (k) => (String(k).includes('token')
    ? { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 600000,
        connected_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString() }
    : null),
  set: async () => 'OK', del: async () => 1,
  lpush: async () => 1, lrange: async () => [], lrem: async () => 0,
  rpop: async () => null, ltrim: async () => 'OK',
};
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === './signInWatch') {
    return { checkSignInAndNotify: async () => { signInChecked++; return { sent: null }; } };
  }
  if (request === './auth') {
    // Exactly what a lapsed sign-in does: everything to do with Schwab
    // fails at this one point, which is where getValidAccessToken lives.
    return {
      getValidAccessToken: async () => { syncRan++; throw new Error('unsupported_token_type'); },
      router: null,
    };
  }
  if (request === './schwabClient') {
    return {
      getOptionFills: async () => [], getUnderlyingPriceAt: async () => null,
      fetchCandles: async () => [], refreshAccessToken: async () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

const { runScheduledTick } = require(path.join(BACKEND, 'cron.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

(async () => {
  await runScheduledTick();
  check('the scheduled check looks at the sign-in', signInChecked === 1);
  check('and it tried to collect trades too', syncRan >= 1);

  // The one that matters: collecting trades FAILED, because the sign-in
  // had run out. That is exactly when the reminder must still go out --
  // it must not sit downstream of the thing it is warning about.
  await runScheduledTick();
  check('a failed trade check does not stop the sign-in reminder', signInChecked === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
