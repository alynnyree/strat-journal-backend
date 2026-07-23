// Stores raw open legs (waiting for a matching close) and fully-matched
// closed trades that are ready for the user to tag with Strat setup/FTFC
// in the app. Persisted to Upstash Redis so it survives Render restarts.
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY = 'trades:state';
const DEFAULT_STATE = { openLegs: [], pending: [], lastProcessedIds: [] };

async function read() {
  const data = await redis.get(KEY);
  return data || { ...DEFAULT_STATE };
}

async function write(data) {
  await redis.set(KEY, data);
}

async function getState() {
  return await read();
}

async function saveState(state) {
  await write(state);
}

async function addPendingTrade(trade) {
  const state = await read();
  state.pending.unshift(trade);
  await write(state);
}

async function removePendingTrade(id) {
  const state = await read();
  state.pending = state.pending.filter(t => t.id !== id);
  await write(state);
}

module.exports = { getState, saveState, addPendingTrade, removePendingTrade };
