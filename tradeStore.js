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

// ONE CHANGE AT A TIME (audit Step B, F4; authorized 6 Oct 2026).
//
// Every writer used to read this whole record, work -- the sync for
// minutes, while it fetched prices and charts -- and then write back the
// copy it had read. Anything written in between was lost: the phone saying
// "I have taken this trade" came undone and the trade was served again, and
// a backfill's save erased open positions recorded by a sync. Now every
// change reads the record as it is AT THAT MOMENT, applies a small change,
// and writes it, strictly one after another -- the same arrangement the
// sign-in store has used since Phase 1. One queue is enough because one
// server process writes this record (Render runs a single instance); if
// that stops being true this must become a lock held in the database.
//
// `change` receives the latest record and returns the record to write, or
// null to write nothing. It must not wait on anything slow: the record is
// held between the read and the write.
let queue = Promise.resolve();
function oneAtATime(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

async function updateState(change) {
  return oneAtATime(async () => {
    const latest = await read();
    const next = await change(latest);
    if (next == null) return latest;
    await write(next);
    return next;
  });
}

// Replaces the whole record. Kept for tests that set up a starting record;
// nothing in the running service calls it with a copy read earlier.
async function saveState(state) {
  return oneAtATime(() => write(state));
}

async function addPendingTrade(trade) {
  return updateState(state => ({ ...state, pending: [trade, ...(state.pending || [])] }));
}

async function removePendingTrade(id) {
  return updateState(state => ({ ...state, pending: (state.pending || []).filter(t => t.id !== id) }));
}

// M-1: removes only the queued entries with this id AND this fill pair, in
// one change. An entry with the same id and a different pair is KEPT and
// reported back, so the caller can say so; nothing else is touched.
async function removePendingTradeIfPair(id, pair) {
  // Compared as text: a reference stored as a number and the same digits sent
  // as text are the same reference (the matcher stores text; this only
  // guards an entry written some other way).
  const want = JSON.stringify(pair.map(String));
  let removed = 0, kept = [];
  await updateState(state => {
    removed = 0; kept = [];
    const pending = (state.pending || []).filter(t => {
      if (!t || t.id !== id) return true;
      if (JSON.stringify((t.fills || []).map(String)) === want) { removed++; return false; }
      kept.push(t.fills || []);
      return true;
    });
    return removed ? { ...state, pending } : null;
  });
  return { removed, kept };
}

module.exports = { getState, saveState, updateState, addPendingTrade, removePendingTrade, removePendingTradeIfPair };
