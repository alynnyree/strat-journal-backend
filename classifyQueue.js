// Reading a trade's setup, without the phone holding a connection open.
//
// /ai/classify used to call Gemini and answer only when it came back.
// Gemini can take ten or twenty seconds, and the route retries up to
// three times, and retries again with a bigger budget if the answer came
// back cut off -- so one request could easily run past a minute. A phone
// browser will not hold a connection that long, especially with the
// screen off. Every one of the owner's requests failed with Safari's
// "Load failed", and because nothing recorded WHY, the app showed him a
// counter that never moved.
//
// So the phone no longer waits. It hands the trade over, gets an answer
// immediately, and the server does the thinking in its own time. The app
// collects the results on the polling it already does.
const { Redis } = require('@upstash/redis');
const { classifyStrategy } = require('./aiClient');

const QUEUE_KEY = 'ai:classifyQueue';
const RESULTS_KEY = 'ai:classifyResults';
const MAX_QUEUED = 500;        // a ceiling on what may pile up
const MAX_RESULTS = 500;
const PACE_MS = 2500;          // between calls, to stay under the free allowance
const RATE_PAUSE_MS = 60 * 60 * 1000;

let redis = null;
function store() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return redis;
}
const parse = (row) => {
  if (row && typeof row === 'object') return row;
  try { return JSON.parse(row); } catch (e) { return null; }
};

// Hands a trade over to be read. Returns straight away.
async function enqueue(trade) {
  const r = store();
  if (!r) throw new Error('Storage is not set up on the server.');
  const queued = await r.lrange(QUEUE_KEY, 0, -1);
  const already = queued.map(parse).filter(Boolean).some(t => String(t.id) === String(trade.id));
  if (!already) {
    await r.lpush(QUEUE_KEY, JSON.stringify(trade));
    await r.ltrim(QUEUE_KEY, 0, MAX_QUEUED - 1);
  }
  return { queued: true, waiting: Math.min(queued.length + (already ? 0 : 1), MAX_QUEUED) };
}

// The answers worked out so far. Handing them over clears them, so the
// same answer is never applied twice.
async function takeResults() {
  const r = store();
  if (!r) return {};
  const held = parse(await r.get(RESULTS_KEY)) || {};
  if (Object.keys(held).length) await r.set(RESULTS_KEY, {});
  return held;
}

async function recordResult(id, result) {
  const r = store();
  if (!r) return;
  const held = parse(await r.get(RESULTS_KEY)) || {};
  const keys = Object.keys(held);
  if (keys.length >= MAX_RESULTS) delete held[keys[0]];
  held[id] = result;
  await r.set(RESULTS_KEY, held);
}

async function queueDepth() {
  const r = store();
  if (!r) return 0;
  try { return (await r.lrange(QUEUE_KEY, 0, -1)).length; } catch (e) { return 0; }
}

// One worker at a time, and it stops itself when the queue is empty or
// the AI says it is out of allowance.
let working = false;
let pausedUntil = 0;

async function drain() {
  if (working) return { skipped: 'already running' };
  if (Date.now() < pausedUntil) return { skipped: 'out of allowance' };
  const r = store();
  if (!r) return { skipped: 'no storage' };
  working = true;
  let done = 0, failed = 0;
  try {
    for (;;) {
      const row = await r.rpop(QUEUE_KEY);
      if (!row) break;
      const trade = parse(row);
      if (!trade || !trade.id) continue;
      try {
        const result = await classifyStrategy(trade);
        await recordResult(trade.id, result || { strategy: null, play: null });
        done++;
      } catch (err) {
        const status = err.response?.status;
        if (status === 429 || status === 503) {
          // Out of allowance. Put it back and stop -- burning the rest of
          // the queue against a wall would mark every trade as looked at.
          await r.lpush(QUEUE_KEY, row);
          pausedUntil = Date.now() + RATE_PAUSE_MS;
          console.log('Setup reading paused: the AI is at its limit for now.');
          break;
        }
        console.log(`Setup reading failed for ${trade.ticker || trade.id}:`, err.message);
        await recordResult(trade.id, { strategy: null, play: null, failed: true });
        failed++;
      }
      await new Promise(res => setTimeout(res, PACE_MS));
    }
  } finally {
    working = false;
  }
  if (done || failed) console.log(`Setup reading: ${done} read, ${failed} could not be read.`);
  return { done, failed };
}

// Started and not waited on, so it needs its own catch -- an unhandled
// failure here would end the whole server.
function drainSoon() {
  setTimeout(() => {
    drain().catch(err => console.log('Setup reading worker failed:', err && err.message));
  }, 50);
}

module.exports = { enqueue, takeResults, drain, drainSoon, queueDepth };
