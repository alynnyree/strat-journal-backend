// Single-user token store, persisted to Upstash Redis (survives restarts,
// unlike local disk on Render's free tier which gets wiped).
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY = 'schwab:tokens';

async function readStore() {
  const data = await redis.get(KEY);
  return data || {};
}

async function writeStore(data) {
  await redis.set(KEY, data);
}

async function saveTokens({ access_token, refresh_token, expires_in }) {
  const store = await readStore();
  store.access_token = access_token;
  store.refresh_token = refresh_token || store.refresh_token;
  store.expires_at = Date.now() + (expires_in * 1000) - 30000; // 30s safety margin
  store.last_transaction_check = store.last_transaction_check || null;
  await writeStore(store);
  return store;
}

async function getTokens() {
  return await readStore();
}

async function setLastCheck(iso) {
  const store = await readStore();
  store.last_transaction_check = iso;
  await writeStore(store);
}

module.exports = { saveTokens, getTokens, setLastCheck };
