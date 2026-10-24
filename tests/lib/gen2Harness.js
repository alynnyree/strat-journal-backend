// The shared set-up for the generation-2 checks on a REAL Redis (Queue plan
// v14.1 rev 3.2, Deploy 2): this machine's Redis behind the stand-in of
// Upstash's web service (tests/lib/localRedis.js), the service's REAL storage
// client and REAL save module, and the rest of the world (Schwab, the market,
// the phone alerts) replaced by stand-ins.
//
// Without a redis-server the checks that need one say so and pass nothing
// (SKIPPED), unless REQUIRE_REAL_REDIS=1 (as in the automatic checks), when
// that is a failure.
const Module = require('module');
const path = require('path');
const { startRedis, restShim, scriptName, verb } = require('./localRedis');

const BACKEND = path.join(__dirname, '..', '..');

async function setUp({ stubs = {} } = {}) {
  const redis = await startRedis();
  if (!redis) return null;
  const shim = restShim(redis.client);
  const url = await shim.listen();
  process.env.UPSTASH_REDIS_REST_URL = url;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stand-in-token';
  process.env.UPSTASH_DISABLE_TELEMETRY = '1';
  process.env.APP_SECRET = process.env.APP_SECRET || 'test-only-not-a-real-key';
  const world = {
    'node-cron': { schedule: () => ({ stop() {} }) },
    './auth': { getValidAccessToken: async () => 'tok' },
    './tokenStore': { getTokens: async () => ({}), setLastCheck: async () => {} },
    './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {}, lastPhoneAlert: async () => null },
    './browserEvents': { queueBrowserEvent: async () => {} },
    './signInWatch': { checkSignInAndNotify: async () => ({}) },
    ...stubs,
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(world, request)) return world[request];
    return origLoad.apply(this, arguments);
  };
  const tradeStore = require(path.join(BACKEND, 'tradeStore.js'));
  const Q = require(path.join(BACKEND, 'queueOps.js'));
  const R = redis.client;
  const KEY = tradeStore.KEY, FENCE = tradeStore.FENCE_KEY, LOG = tradeStore.LOG_KEY;
  const h = {
    redis, shim, R, tradeStore, Q, KEY, FENCE, LOG, BACKEND,
    scriptOf: cmd => scriptName(cmd, tradeStore.SCRIPTS), verb,
    async text() { const t = await R.call('GET', KEY); return t && typeof t === 'object' ? null : t; },
    async doc() { const t = await h.text(); return t == null ? null : JSON.parse(t); },
    async fence() { return R.call('GET', FENCE); },
    // A fresh store: the record as given (object or exact text), the fence
    // as given (undefined: absent), the log empty, this process's knowledge
    // of its own saves forgotten.
    async fresh(record, fence) {
      shim.hooks = {};
      await R.call('FLUSHALL');
      if (record !== undefined) await R.call('SET', KEY, typeof record === 'string' ? record : JSON.stringify(record));
      if (fence !== undefined) await R.call('SET', FENCE, String(fence));
      tradeStore._resetProcessState();
    },
    // A fresh store, the fence raised and the record expanded by the REAL
    // start-up: a ready generation-2 process.
    async ready(record = { openLegs: [], pending: [], lastProcessedIds: [] }, fence = '1') {
      await h.fresh(record, fence);
      const out = await tradeStore.startGeneration2({ pauseMs: 0 });
      if (!out.ready) throw new Error('start-up did not reach ready: ' + JSON.stringify(out));
      return out;
    },
    // Writes a record directly, as another writer's committed save would
    // leave it (stateVersion + 1), for races.
    async competitor(mut) {
      const d = await h.doc();
      mut(d);
      d.stateVersion += 1;
      await R.call('SET', KEY, JSON.stringify(d));
      return d;
    },
    async tearDown() {
      await shim.close();
      return redis.stop();
    },
  };
  return h;
}

module.exports = { setUp, BACKEND };
