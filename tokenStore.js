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

// ONE CHANGE AT A TIME (Phase 1; the second auditor's recommendation).
//
// Every change below reads the whole sign-in record, changes a field or two,
// and writes the whole record back. Two of them running at once -- the
// five-minute sync noting when it last looked while a renewal is saving a new
// sign-in -- could each write back a copy that lacks the other's change, and
// the renewed sign-in could be lost, stopping every sync until he signed in
// again.
//
// They are now queued, so each reads what the previous one wrote. One queue
// is enough because one server process is the only thing that writes this
// record (Render runs a single instance). If that ever stops being true, this
// must become a lock held in the database instead.
let queue = Promise.resolve();
function oneAtATime(change) {
  const run = queue.then(change, change);
  queue = run.catch(() => {});
  return run;
}

async function saveTokens({ access_token, refresh_token, expires_in }) {
  return oneAtATime(async () => {
    const store = await readStore();
    store.access_token = access_token;
    store.refresh_token = refresh_token || store.refresh_token;
    store.expires_at = Date.now() + (expires_in * 1000) - 30000; // 30s safety margin
    store.last_transaction_check = store.last_transaction_check || null;
    await writeStore(store);
    return store;
  });
}

async function getTokens() {
  return await readStore();
}

async function setLastCheck(iso) {
  return oneAtATime(async () => {
    const store = await readStore();
    store.last_transaction_check = iso;
    await writeStore(store);
  });
}

// Merges a few fields in without touching the tokens themselves. Used to
// record whether the Schwab connection is still alive.
async function saveTokenFields(fields) {
  return oneAtATime(async () => {
    const store = await readStore();
    await writeStore({ ...store, ...fields });
  });
}

module.exports = { saveTokens, getTokens, setLastCheck, saveTokenFields };
