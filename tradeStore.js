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

// THE WRITER FENCE, GENERATION 1 (Queue Exact-Removal plan v14.1 revision 2,
// 5.8.2, "Deploy 1"; owner, 20 Oct 2026: "I authorize Q-D: implementation of
// Queue Exact-Removal plan v14.1 revision 2, stage 1 only (Deploy 1's code)").
//
// The next server version (generation 2) changes the shape of this record.
// A deploy can briefly run the old and the new server side by side, and an
// old server that saves with a plain SET would write the old shape straight
// over the new one. So before the new shape exists, the save itself learns
// to step aside: the new server raises a number kept in its own key, the
// FENCE, and this save refuses once that number is above 1.
//
// The check and the save are ONE script, run inside the database, so
// nothing can land between "the fence is low" and "save". Reading the fence
// first and saving in a second command would leave exactly that gap.
// Nothing else about the save changes: the same whole record, the same text
// (the client sends an object to SET as JSON.stringify of it, and so does
// this), after the same one-at-a-time queue, for the same callers. This
// server never creates, raises, lowers or deletes the fence.
//
// The braces put the fence in the same storage slot as "trades:state", so
// one script may touch both on any Redis layout.
const FENCE_KEY = '{trades:state}:fence';
const WRITER_GENERATION = 1;
// (F1) a fence that is present but not a whole number, or a whole number
// above 1, refuses; (F2) otherwise the one SET, and its reply.
// The fence is compared AS DIGITS, never through tonumber(): on Upstash,
// tonumber() of a number too large for 64 bits gives nil, and comparing nil
// stopped the script with an error instead of refusing (Gate 1 Step 1,
// 23 Oct 2026). Leading zeros are removed, so "" is 0 and "1" is 1; any
// other digit string (2, 3, 99999999999999999999, ...) refuses.
const GEN1_SAVE_SCRIPT = [
  "local fence = redis.call('GET', KEYS[2])",
  "if fence then",
  "  if not string.match(fence, '^%d+$') then return 'FENCED' end",
  "  local d = (string.gsub(fence, '^0+', ''))",
  "  if d ~= '' and d ~= '1' then return 'FENCED' end",
  "end",
  "redis.call('SET', KEYS[1], ARGV[1])",
  "return 'SAVED'",
].join('\n');

// What /health reports about this server's saves (behind the app key, never
// on his screen). "fenced" is what the LAST save attempt was told; null
// until this process has saved at all.
const writer = { generation: WRITER_GENERATION, fenced: null, lastSaveAt: null, lastRefusedAt: null };
function writerStatus() { return { ...writer }; }

async function write(data) {
  const reply = await redis.eval(GEN1_SAVE_SCRIPT, [KEY, FENCE_KEY], [JSON.stringify(data)]);
  if (reply === 'SAVED') {
    writer.fenced = false; writer.lastSaveAt = new Date().toISOString();
    return;
  }
  if (reply === 'FENCED') {
    writer.fenced = true; writer.lastRefusedAt = new Date().toISOString();
    const err = new Error('fenced: this server is generation 1 and a newer generation has taken over saving, so nothing was saved');
    err.code = 'FENCED';
    throw err;
  }
  // Anything else is not a save this code can vouch for. Said as it is,
  // never treated as success.
  const err = new Error('save not confirmed: the save script answered ' + JSON.stringify(reply));
  err.code = 'SAVE_UNCONFIRMED';
  throw err;
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

module.exports = { getState, saveState, updateState, addPendingTrade, removePendingTrade, removePendingTradeIfPair,
                   writerStatus, KEY, FENCE_KEY, WRITER_GENERATION, GEN1_SAVE_SCRIPT };
