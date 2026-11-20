// STEP 1: the moment the new setup reading was switched on. Set ONCE, the
// first time this code runs, and never moved. Only trades whose entry is at
// or after it are read under the new rule; every older trade is left exactly
// as it is (re-reading those is its own step, L1-a).
//
// If the moment cannot be read, NOTHING is read: an unknown boundary must
// not be guessed, because guessing low would re-read his old trades.
const KEY = 'setup:switchOnAt';
let cached = null;

async function switchOnAt({ redis = null, now = null } = {}) {
  if (cached != null) return cached;
  try {
    let r = redis;
    if (!r) {
      if (!process.env.UPSTASH_REDIS_REST_URL) return null;
      const { Redis } = require('@upstash/redis');
      r = Redis.fromEnv();
    }
    await r.set(KEY, String(now ?? Date.now()), { nx: true });
    const v = Number(await r.get(KEY));
    if (!Number.isFinite(v) || v <= 0) return null;
    cached = v;
    return v;
  } catch (err) {
    console.log('Setup reading: the switch-on moment could not be read, so nothing is read:', err.message);
    return null;
  }
}
function resetForTests() { cached = null; }

module.exports = { switchOnAt, resetForTests, KEY };
