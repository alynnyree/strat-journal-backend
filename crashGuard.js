// Keeps the server alive through a failure nobody wrapped, and leaves a
// record of what happened.
//
// Why this exists: Render emailed the owner "Server failure detected on
// strat-journal-backend: Exited with status 1". Node ends the whole
// process on an unhandled promise rejection or an uncaught exception, and
// there was nothing anywhere in this app to stop that. So one stray
// failure in a background job — a WebSocket that refused to open, a send
// on a socket that had just closed — took down every part of the server
// at once: the five-minute sync, the live stream, the history import, and
// every route the phone talks to. The owner then found out by email,
// hours later, with nothing in it he could act on.
//
// Two things are wrong with that and this fixes both:
//
//  1. The server should not die. A background job failing is not a reason
//     to stop answering the phone. Both handlers log loudly and carry on.
//     (Yes, the usual advice is to exit on an uncaught exception because
//     the process may be in an unknown state. That advice is written for
//     a service behind a load balancer with other instances to take over.
//     This is one small personal server on a free plan where "exit" means
//     the owner's trades stop arriving until he happens to notice — and
//     the routes here are independent request handlers, not shared
//     mutable state. Staying up is plainly the better trade here.)
//
//  2. The crash should not be invisible. Render's own logs age out and
//     the owner cannot read them anyway. Each one is written to storage
//     and reported on /health, so the next question about "why did my
//     trades stop" can be answered from evidence instead of guessed at.
const { Redis } = require('@upstash/redis');

const KEY = 'server:crashes';
const MAX_KEPT = 20;

let redis = null;
// Built on first use rather than at import. Building it at import time is
// what broke unrelated test suites before — the client throws immediately
// when the connection details are not set, taking down anything that
// merely required the file.
function store() {
  if (redis) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (err) {
    console.log('Crash guard: could not reach storage —', err.message);
    return null;
  }
  return redis;
}

const startedAt = new Date().toISOString();
let lastInMemory = null;

function describe(err) {
  if (err == null) return String(err);
  if (err instanceof Error) return err.stack || err.message;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

async function recordCrash(kind, err) {
  const entry = {
    kind,                                   // 'unhandledRejection' | 'uncaughtException'
    at: new Date().toISOString(),
    serverStartedAt: startedAt,
    detail: describe(err).slice(0, 2000),
  };
  lastInMemory = entry;
  const r = store();
  if (!r) return;
  try {
    await r.lpush(KEY, JSON.stringify(entry));
    await r.ltrim(KEY, 0, MAX_KEPT - 1);
  } catch (e) {
    console.log('Crash guard: could not save the record —', e.message);
  }
}

// The most recent failures, newest first. Survives a restart, so a crash
// that DID kill the process before this existed can still be read back.
async function getCrashes(limit = 5) {
  const r = store();
  if (!r) return lastInMemory ? [lastInMemory] : [];
  try {
    const rows = await r.lrange(KEY, 0, Math.max(0, limit - 1));
    return rows.map(row => {
      if (row && typeof row === 'object') return row;   // Upstash may hand back parsed JSON
      try { return JSON.parse(row); } catch (e) { return { detail: String(row) }; }
    });
  } catch (e) {
    return lastInMemory ? [lastInMemory] : [];
  }
}

let installed = false;
function installCrashGuards() {
  if (installed) return;   // installing twice would double every log line
  installed = true;

  process.on('unhandledRejection', (reason) => {
    console.log('!! Unhandled rejection — staying up. Cause:', describe(reason));
    recordCrash('unhandledRejection', reason).catch(() => {});
  });

  process.on('uncaughtException', (err) => {
    console.log('!! Uncaught exception — staying up. Cause:', describe(err));
    recordCrash('uncaughtException', err).catch(() => {});
  });
}

function uptimeSeconds() { return Math.round(process.uptime()); }

module.exports = { installCrashGuards, getCrashes, recordCrash, uptimeSeconds, startedAt };
