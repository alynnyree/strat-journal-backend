// Stores raw open legs (waiting for a matching close) and fully-matched
// closed trades that are ready for the user to tag with Strat setup/FTFC
// in the app. Persisted to Upstash Redis so it survives Render restarts.
//
// GENERATION 2 (Queue Exact-Removal plan v14.1 revision 3.2, "Deploy 2";
// owner, 24 Oct 2026: "I authorize Deploy 2 implementation: a new branch and
// pull request, local tests only, no merge.").
//
// This is THE ONE MODULE that writes "trades:state", its fence and the
// exhaustion log. Every write of the record goes through protect() below,
// which saves only through THE COMMIT: one script, run inside the database,
// that saves the new record only if the fence reads 2 AND the record is still
// exactly the text this change was computed from. A source check
// (tests/source-check.js, run by guardCheck.js too) fails any other write.
//
// Why: a deploy can run an old and a new server side by side, and a plain
// save written over a newer record loses whatever the other wrote. Since
// Deploy 1 an old server refuses to save once the fence is above 1; this
// server raises it to 2 at start-up, before its first save. And because two
// servers of THIS generation can still meet (a later fix overlapping this
// one), each save carries proof of what it read, and is refused if anything
// landed meanwhile.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const Q = require('./queueOps');

const KEY = 'trades:state';
const FENCE_KEY = '{trades:state}:fence';
const LOG_KEY = 'queue:casFailures';
const WRITER_GENERATION = 2;
const DEFAULT_STATE = { openLegs: [], pending: [], lastProcessedIds: [] };

// Readers (the routes that show what is waiting) keep the ordinary client,
// which turns the stored text into an object.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
// The PROTECTED path has its own client (plan 5.5, H0 IS TAKEN FROM THE EXACT
// STORED TEXT):
// - automaticDeserialization: false, so the stored text arrives exactly as
//   stored and its fingerprint can be compared;
// - NO retry, because a request the client quietly sent twice would hide
//   whether the first one landed -- a lost answer must be SEEN as lost.
//   Written { retries: 0 }: this client (1.38.2, nodejs.js) reads `retry:
//   false` as ONE retry ("attempts: 1", then "i <= attempts"), so a failed
//   request is sent a second time. Measured: two arrivals for one call with
//   `false`, one with { retries: 0 } (tests/gen2-store.js);
// - a time limit on every request, so a hung request becomes a lost answer
//   (resolved by the rules below) instead of a wait for ever. Given as a
//   FUNCTION: with a fixed signal, this client turns an aborted request into
//   a made-up answer reading "Aborted" (node_modules/@upstash/redis,
//   nodejs.js), which would look like a reply.
const REQUEST_LIMIT_MS = 10 * 1000;
const raw = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  automaticDeserialization: false,
  retry: { retries: 0, backoff: () => 0 },
  enableAutoPipelining: false,
  signal: () => AbortSignal.timeout(REQUEST_LIMIT_MS),
});

// ---- THE SCRIPTS. Byte for byte the texts Gate 1 ran on a real Upstash
// database (accepted 23 Oct 2026); their SHA-1s are pinned in PINNED and
// checked by tests/source-check.js. Do not edit one without a new gate.
//
// THE RAISE (5.8.2). KEYS[1] = the fence. Digits only, compared AS DIGITS
// (leading zeros removed), never through tonumber(): on Upstash, tonumber()
// of a value beyond 64 bits gives nil (Gate 1 Step 1, 23 Oct 2026).
const RAISE = [
  "local f = redis.call('GET', KEYS[1])",
  "if f then",
  "  if not string.match(f, '^%d+$') then return 'FENCE-INVALID' end",
  "  local d = (string.gsub(f, '^0+', ''))",
  "  if d == '2' then return 'ALREADY' end",
  "  if d ~= '' and d ~= '1' then return 'FENCED' end",
  "end",
  "redis.call('SET', KEYS[1], '2')",
  "return 'RAISED'",
].join('\n');
// THE COMMIT (5.5, S0 to S3). KEYS[1] = the record, KEYS[2] = the fence.
// ARGV[1] = H0 (the SHA-1 of the exact stored text this change was computed
// from) or "none" for "expected no value"; ARGV[2] = the new text; ARGV[3] =
// this build's generation, "2". The fence is checked as digits first; its
// one tonumber() is an EQUALITY, where a nil (a number too large) is simply
// "not equal" and so FENCED -- it never stops the script.
const COMMIT = [
  "local f = redis.call('GET', KEYS[2])",
  "if (not f) or (not string.match(f, '^%d+$')) or (tonumber(f) ~= tonumber(ARGV[3])) then return 'FENCED' end",
  "local cur = redis.call('GET', KEYS[1])",
  "if ARGV[1] == 'none' then",
  "  if cur then return 'CONFLICT' end",
  "else",
  "  if (not cur) or (redis.sha1hex(cur) ~= ARGV[1]) then return 'CONFLICT' end",
  "end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 'COMMITTED'",
].join('\n');
// THE RESOLUTION READ (5.5). Replies {'absent'}, {'unreadable'} (a key of the
// wrong kind), or {'present', SHA-1 computed inside, text}.
const RESOLUTION_READ = [
  "local cur = redis.pcall('GET', KEYS[1])",
  "if type(cur) == 'table' and cur['err'] then return {'unreadable'} end",
  "if not cur then return {'absent'} end",
  "return {'present', redis.sha1hex(cur), cur}",
].join('\n');
// THE EXHAUSTION LOG (5.6 (ii)). KEYS[1] = the log; ARGV[1] = one entry.
const LOG = [
  "local t = redis.call('TYPE', KEYS[1])",
  "if type(t) == 'table' then t = t['ok'] end",
  "if t ~= 'list' and t ~= 'none' then return redis.error_reply('wrong-type') end",
  "redis.call('LPUSH', KEYS[1], ARGV[1])",
  "redis.call('LTRIM', KEYS[1], 0, 99)",
  "return redis.call('LLEN', KEYS[1])",
].join('\n');
const SCRIPTS = { RAISE, COMMIT, RESOLUTION_READ, LOG };
const PINNED = {
  RAISE: '8bab7b6be6738459a7decfa3bcdc489b759e974e',
  COMMIT: '2ed6d703b781a328059b4f2eb515a9fb61a6b248',
  RESOLUTION_READ: 'a25e8b7ba49778dacf7f34b9a47ae10cb7dcc4b6',
  LOG: 'e2585315c7a488bcdd8ce65a51838f3e529bd3d4',
};

const MAX_RUNS = 10;                    // 5.6: the first run and up to 9 more
const OP_DEADLINE_MS = 60 * 1000;       // 5.5: a liveness limit, never a safety rule

// ---- What this process knows about its own saves. Reported by /health
// behind the app key: the counters belong to this ONE process, start at 0
// after a restart, and are a live indicator only, never the durable record
// (5.6 (i)).
const writer = {
  generation: WRITER_GENERATION,
  fenced: null,                // true once a save or the raise was told FENCED
  ready: false,                // true once the fence reads 2 and the record is expanded
  startup: { stage: 'not-started', why: null, at: null },
  schemaVersion: null, stateVersion: null,
  lastSaveAt: null, lastRefusedAt: null,
  casExhausted: { count: 0, lastAt: null, lastOperation: null },
  casLogFailed: { count: 0, lastAt: null, lastReason: null },
  commitErrors: 0,            // commit calls with no usable answer (each treated as lost)
  stateInvalid: { count: 0, lastAt: null, lastWhy: null },
  clockSkew: { count: 0, lastAt: null },
  untrustedRecords: null,      // counted at the last read
};
function writerStatus() { return JSON.parse(JSON.stringify(writer)); }
// THE PUBLIC ANSWER (owner's decision D-2, 24 Oct 2026: "add generation,
// fenced, schemaVersion and build to the public health check"): exactly these
// four, nothing else. tests/private-doors-are-locked.js holds the list.
function publicStatus() {
  return {
    generation: WRITER_GENERATION,
    fenced: writer.fenced,
    schemaVersion: writer.schemaVersion,
    build: process.env.RENDER_GIT_COMMIT || null,
  };
}
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

// ---- THE EXACT READ, always inside a script (plan 5.5 v14: no safety
// decision rests on a plain read). The fingerprint the script computed is
// re-checked here against the text; a reply of any other shape, or one whose
// fingerprint does not match, is treated as "could not be read", never as a
// value.
async function readExact() {
  const reply = await raw.eval(RESOLUTION_READ, [KEY], []);
  if (Array.isArray(reply) && reply.length === 1 && reply[0] === 'absent') return { kind: 'absent' };
  if (Array.isArray(reply) && reply.length === 1 && reply[0] === 'unreadable') return { kind: 'unreadable', why: 'the record is not a text value' };
  if (Array.isArray(reply) && reply.length === 3 && reply[0] === 'present' && typeof reply[1] === 'string'
      && /^[0-9a-f]{40}$/.test(reply[1]) && typeof reply[2] === 'string' && Q.sha1(reply[2]) === reply[1]) {
    return { kind: 'present', sha1: reply[1], text: reply[2] };
  }
  return { kind: 'unreadable', why: 'the read did not answer in its exact shape' };
}
function parseDoc(text) {
  try {
    const d = JSON.parse(text);
    return Q.isPlain(d) ? { doc: d } : { why: 'the record is not a JSON object' };
  } catch (e) { return { why: 'the record is not JSON' }; }
}

// ---- THE EXHAUSTION LOG: ONE call, never retried, never a write to the
// protected record (5.6 (ii)). Returns {recorded, why}.
async function logFailure(entry) {
  let reply;
  try { reply = await raw.eval(LOG, [LOG_KEY], [JSON.stringify(entry)]); }
  catch (e) { return noteLogFailed('the log call failed or got no answer'); }
  const n = typeof reply === 'string' && /^\d+$/.test(reply) ? Number(reply) : reply;
  if (Number.isSafeInteger(n) && n >= 1 && n <= 100) return { recorded: true };
  return noteLogFailed('the log answered something other than a length from 1 to 100');
}
function noteLogFailed(why) {
  writer.casLogFailed.count++; writer.casLogFailed.lastAt = new Date().toISOString(); writer.casLogFailed.lastReason = why;
  return { recorded: false, why };
}

const randomHex = () => crypto.randomBytes(16).toString('hex');

// ---- protect(): ONE logical change to the record, under THE COMMIT.
//
// kind: one of queueOps.KINDS. update(doc, fixed) is PURE and returns
// {next, result} (next null: no change, nothing written, no record), or
// {refuse, why}. opts: {opId, at, payload, candidateEpoch, acceptKinds}.
// opId and the timestamp are made ONCE, here, before the first run, and are
// the same for every run of this change (5.5 FIXED INPUTS).
//
// Returns {status, result?, record?, why?, out?, runs}. status is one of:
//   committed     saved, with its record
//   unchanged     nothing to save; nothing written, no record
//   recovered     an earlier attempt of THIS change had saved; its stored
//                 result is returned verbatim
//   refused       the update itself declined (reason in why), nothing written
//   busy          10 runs were refused (5.6); nothing of it was written
//   outcome-unknown  it may or may not have been saved, and it will not be
//                 tried again by this call (R3, R5, R6, or past the deadline)
//   fenced        a newer generation has taken over saving; never retried
//   not-ready     this process has not finished its start-up
//   state-invalid the stored record is not in a form this code accepts
//   could-not-read  the record could not be read; nothing was decided
//   untagged-entry  5.7: removal is enabled and this would leave an entry
//                 without a usable qid
//   too-large     the new record would not fit (5.5 THE VALUE SIZE)
async function protect(kind, update, opts = {}) {
  if (!Q.KINDS.includes(kind)) throw new Error('protect: unknown operation kind ' + kind);
  if (writer.fenced) return { status: 'fenced', runs: 0 };
  if (!writer.ready && kind !== 'expand') return { status: 'not-ready', why: writer.startup.why || writer.startup.stage, runs: 0 };
  const fixed = {
    opId: opts.opId || randomHex(),
    at: Number.isSafeInteger(opts.at) ? opts.at : Date.now(),
    payload: opts.payload,
    candidateEpoch: opts.candidateEpoch || randomHex(),
  };
  if (!Q.HEX32.test(fixed.opId)) throw new Error('protect: the operation id is not 32 lower-case hex');
  const acceptKinds = opts.acceptKinds || [kind];
  const started = monotonicMs();
  let runs = 0;
  let lastRead = null;           // the stateVersion this change last read
  let ambiguous = null;          // {H0, V0min} once any attempt's answer was lost
  for (;;) {
    // OP_DEADLINE: a liveness limit. A change that has not finished within
    // 60 seconds stops here and says it does not know.
    if (monotonicMs() - started > OP_DEADLINE_MS) return { status: 'outcome-unknown', why: 'past the 60-second limit', runs };
    if (runs >= MAX_RUNS) return exhausted(kind, fixed, lastRead, runs, ambiguous);
    runs++;
    let read;
    try { read = await readExact(); }
    catch (e) {
      if (ambiguous) return { status: 'outcome-unknown', why: 'R6: the record could not be read', runs };
      return { status: 'could-not-read', why: 'the record could not be read', runs };
    }
    let doc;
    if (read.kind === 'absent') {
      if (kind !== 'expand') return invalid(kind, fixed, ambiguous, 'the record is absent', runs);
      doc = undefined;
    } else if (read.kind === 'unreadable') {
      return invalid(kind, fixed, ambiguous, read.why, runs);
    } else {
      const p = parseDoc(read.text);
      if (p.why) return invalid(kind, fixed, ambiguous, p.why, runs);
      doc = p.doc;
    }
    const expanded = doc !== undefined && Object.prototype.hasOwnProperty.call(doc, 'schemaVersion');
    if (!expanded && kind !== 'expand') return { status: 'not-ready', why: 'the record has not been expanded', runs };
    if (expanded) {
      const problems = Q.docProblems(doc);
      if (problems.length) return invalid(kind, fixed, ambiguous, problems.join('; '), runs);
      lastRead = doc.stateVersion;
      writer.schemaVersion = doc.schemaVersion; writer.stateVersion = doc.stateVersion;
      writer.untrustedRecords = Object.entries(doc.opRecords).filter(([k, r]) => Q.untrustedWhy(r, k, doc.stateVersion, fixed.at)).length;
      // 5.5 (2): its own record first. A record naming this id under another
      // key is a sign of damage: never let it fall through to "not saved".
      for (const [k, r] of Object.entries(doc.opRecords)) {
        if (k !== fixed.opId && Q.isPlain(r) && r.opId === fixed.opId) return { status: 'outcome-unknown', why: 'a record naming this change is stored under another key', runs };
      }
      if (Object.prototype.hasOwnProperty.call(doc.opRecords, fixed.opId)) {
        const rec = doc.opRecords[fixed.opId];
        const why = Q.untrustedWhy(rec, fixed.opId, doc.stateVersion, fixed.at) || (acceptKinds.includes(rec.kind) ? null : 'kind is not the one expected');
        if (why) return { status: 'outcome-unknown', why: 'R3: untrusted record: ' + why, runs };
        return { status: 'recovered', result: rec.result, record: rec, runs };
      }
    }
    // RESOLVING (5.5 R1 to R6, with A2's (I1) and (I2)): after any lost
    // answer, EVERY later run must prove the earlier attempt did not save
    // before it may compute again: the record is still exactly what that
    // attempt read (R1), or nothing as new as V0min + 1 could have been
    // pruned (R4). Otherwise (R5) it stops.
    if (ambiguous) {
      const h = read.kind === 'absent' ? 'none' : read.sha1;
      const pruned = expanded ? doc.prunedThroughVersion : 0;
      const r1 = h === ambiguous.H0;
      const r4 = pruned < ambiguous.V0min + 1;
      if (!r1 && !r4) return { status: 'outcome-unknown', why: 'R5: its record could have been pruned', runs };
    }
    // Compute, on its own copy, so nothing that happens to the object can
    // reach the next run.
    const out = update(doc === undefined ? undefined : JSON.parse(read.text), fixed);
    if (out.refuse) {
      if (out.refuse === 'state-invalid') return invalid(kind, fixed, ambiguous, out.why, runs);
      return { status: 'refused', why: out.refuse, detail: out.why, result: out.result, runs };
    }
    if (!out.next) return { status: 'unchanged', result: out.result, out, runs };
    const fin = Q.finalize(doc, out.next, out.result, kind, fixed);
    if (fin.skew) { writer.clockSkew.count++; writer.clockSkew.lastAt = new Date().toISOString(); }
    // 5.7, AFTER ACTIVATION: no write may leave an untagged entry.
    if (fin.final.removalEnabled === true) {
      const u = Q.untaggedCounts(fin.final);
      if (u.visible || u.staged) return { status: 'untagged-entry', result: { untagged: u }, runs };
    }
    const text = JSON.stringify(fin.final);
    if (Buffer.byteLength(text, 'utf8') >= Q.SIZE_LIMIT) {
      const log = await logFailure({ operation: kind, opId: fixed.opId, stateVersion: lastRead, runs, at: new Date().toISOString(), why: 'too-large' });
      return { status: 'too-large', recorded: log.recorded, runs };
    }
    const H0 = read.kind === 'absent' ? 'none' : read.sha1;
    const V0 = expanded ? doc.stateVersion : 0;
    let reply;
    try { reply = await raw.eval(COMMIT, [KEY, FENCE_KEY], [H0, text, String(WRITER_GENERATION)]); }
    catch (e) { reply = undefined; }
    if (reply === 'COMMITTED') {
      writer.lastSaveAt = new Date().toISOString(); writer.fenced = false;
      writer.schemaVersion = fin.final.schemaVersion; writer.stateVersion = fin.final.stateVersion;
      return { status: 'committed', result: out.result, record: fin.final.opRecords[fixed.opId], out, runs };
    }
    if (reply === 'CONFLICT') continue;                        // proof of no save: run again
    if (reply === 'FENCED') {
      writer.fenced = true; writer.lastRefusedAt = new Date().toISOString();
      return { status: 'fenced', runs };
    }
    // NO usable answer (lost, timed out, an error reply, or anything
    // unexpected): AMBIGUOUS. The plan allows an error reply to be read either
    // as "not saved" or, the stricter choice, as ambiguous; this takes the
    // stricter one. It is never taken as "not saved".
    writer.commitErrors++;
    ambiguous = { H0, V0min: ambiguous ? Math.min(ambiguous.V0min, V0) : V0 };
  }
}
async function exhausted(kind, fixed, lastRead, runs, ambiguous) {
  // A change whose earlier attempt may have landed cannot say "not saved".
  if (ambiguous) return { status: 'outcome-unknown', why: 'the run limit was reached after a lost answer', runs };
  writer.casExhausted.count++; writer.casExhausted.lastAt = new Date().toISOString(); writer.casExhausted.lastOperation = kind;
  const log = await logFailure({ operation: kind, opId: fixed.opId, stateVersion: lastRead, runs, at: new Date().toISOString() });
  return { status: 'busy', recorded: log.recorded, runs };
}
async function invalid(kind, fixed, ambiguous, why, runs) {
  // After a lost answer, an unreadable record is R6: outcome unknown.
  if (ambiguous) return { status: 'outcome-unknown', why: 'R6: ' + why, runs };
  writer.stateInvalid.count++; writer.stateInvalid.lastAt = new Date().toISOString(); writer.stateInvalid.lastWhy = why;
  const log = await logFailure({ operation: kind, opId: fixed.opId, stateVersion: null, runs, at: new Date().toISOString(), why: 'state-invalid' });
  return { status: 'state-invalid', why, recorded: log.recorded, runs };
}

// ---- START-UP (5.8.3 (D3)): the raise, then the expansion. Until both have
// succeeded this process saves nothing (protect() answers "not-ready"), and
// server.js starts no schedule, stream or resume.
const RAISE_TRIES = 5, RAISE_WINDOW_MS = 60 * 1000;
async function raiseFence({ pauseMs = 2000 } = {}) {
  const started = monotonicMs();
  for (let i = 1; i <= RAISE_TRIES && monotonicMs() - started <= RAISE_WINDOW_MS; i++) {
    let reply;
    try { reply = await raw.eval(RAISE, [FENCE_KEY], []); } catch (e) { reply = undefined; }
    if (reply === 'RAISED' || reply === 'ALREADY') return { ok: true, reply };
    if (reply === 'FENCED') { writer.fenced = true; return { ok: false, reply, why: 'the fence reads above 2: a newer generation has taken over' }; }
    if (reply === 'FENCE-INVALID') return { ok: false, reply, why: 'the fence holds something that is not a whole number; nothing was written' };
    // A lost answer: the raise is safe to repeat (raising to 2 twice leaves 2).
    if (i < RAISE_TRIES) await new Promise(r => setTimeout(r, pauseMs));
  }
  return { ok: false, reply: 'fence-unknown', why: 'the raise got no usable answer within its tries' };
}
function noteStartup(stage, why) { writer.startup = { stage, why: why || null, at: new Date().toISOString() }; }
async function startGeneration2(opts = {}) {
  if (writer.ready) return { ready: true };
  noteStartup('raising');
  const r = await raiseFence(opts);
  if (!r.ok) {
    noteStartup(r.reply === 'FENCED' ? 'fenced' : r.reply === 'FENCE-INVALID' ? 'fence-invalid' : 'fence-unknown', r.why);
    return { ready: false, stage: writer.startup.stage, why: r.why };
  }
  noteStartup('expanding');
  const ex = await protect('expand', Q.expandUpdate, opts.expandOpts || {});
  if (!['committed', 'unchanged', 'recovered'].includes(ex.status)) {
    noteStartup(ex.status === 'state-invalid' ? 'state-invalid' : ex.status === 'fenced' ? 'fenced' : 'expansion-unconfirmed',
      ex.status + (ex.why ? ': ' + ex.why : ''));
    return { ready: false, stage: writer.startup.stage, why: writer.startup.why, expansion: ex };
  }
  // Confirmed by reading it back, never assumed.
  let read;
  try { read = await readExact(); } catch (e) { read = null; }
  const p = read && read.kind === 'present' ? parseDoc(read.text) : null;
  if (!p || !p.doc || p.doc.schemaVersion !== 2 || Q.docProblems(p.doc).length) {
    noteStartup('expansion-unconfirmed', 'the expanded record could not be read back');
    return { ready: false, stage: writer.startup.stage, why: writer.startup.why, expansion: ex };
  }
  writer.schemaVersion = 2; writer.stateVersion = p.doc.stateVersion;
  writer.ready = true;
  noteStartup('ready');
  return { ready: true, raise: r.reply, expansion: ex.status };
}

// ---- READERS.
// The ordinary read, for routes that only show what is waiting. A stale copy
// is harmless there; nothing is decided from it.
async function getState() {
  const data = await redis.get(KEY);
  return data || { ...DEFAULT_STATE };
}
// The exact read with its fingerprint, for the reset status (5.9.3 S-R6).
// {kind: 'absent' | 'unreadable' | 'present', sha1, text, doc}.
async function readDocument() {
  const r = await readExact();
  if (r.kind !== 'present') return r;
  const p = parseDoc(r.text);
  return p.why ? { kind: 'unreadable', why: p.why } : { ...r, doc: p.doc };
}

// THE PRESERVED-STATE REPORT (plan 5.8.6 (3), 5.4 RB-2, Q-T11 (d), (e)):
// read-only, from the LIVE record and the LIVE fence (each read inside a
// script), never from a remembered figure. It never says a rollback is safe:
// once the fence reads 2, going back to generation 0 or 1 is never safe,
// whatever the counts say (an empty staging list included).
async function preservedStateReport() {
  const at = new Date().toISOString();
  let fence;
  try {
    const f = await raw.eval(RESOLUTION_READ, [FENCE_KEY], []);
    fence = Array.isArray(f) && f[0] === 'present' ? f[2] : Array.isArray(f) && f[0] === 'absent' ? 'absent' : 'unreadable';
  } catch (e) { fence = 'could not be read'; }
  let r;
  try { r = await readDocument(); } catch (e) { r = { kind: 'could not be read' }; }
  const doc = r.kind === 'present' ? r.doc : null;
  const expanded = !!(doc && doc.schemaVersion === 2);
  const untagged = expanded ? Q.untaggedCounts(doc) : null;
  const damaged = expanded && Q.isPlain(doc.opRecords)
    ? Object.entries(doc.opRecords).filter(([k, rec]) => Q.untrustedWhy(rec, k, doc.stateVersion, Date.now())).length : null;
  return {
    readAt: at,
    fence,
    record: r.kind === 'present' ? 'present' : r.kind,
    schemaVersion: doc ? (doc.schemaVersion === undefined ? null : doc.schemaVersion) : null,
    stateVersion: doc && Number.isSafeInteger(doc.stateVersion) ? doc.stateVersion : null,
    stagedCount: expanded && Array.isArray(doc.pendingStaged) ? doc.pendingStaged.length : null,
    waitingCount: doc && Array.isArray(doc.pending) ? doc.pending.length : null,
    untagged,
    damagedRecords: damaged,
    removalEnabled: expanded ? doc.removalEnabled : null,
    thisProcess: writerStatus(),
    rollback: /^0*2$/.test(String(fence))
      ? 'NOT SAFE: the fence reads 2. Generation 0 or 1 must never be deployed again (plan 5.4 RB-2); stop and preserve (5.8.6).'
      : 'The fence does not read 2. Whether a rollback is safe is decided by plan 5.4, never by this report.',
  };
}

// For tests only: forget what this process learned about its own saves.
function _resetProcessState() {
  Object.assign(writer, { fenced: null, ready: false, startup: { stage: 'not-started', why: null, at: null },
    schemaVersion: null, stateVersion: null, lastSaveAt: null, lastRefusedAt: null,
    casExhausted: { count: 0, lastAt: null, lastOperation: null },
    casLogFailed: { count: 0, lastAt: null, lastReason: null }, commitErrors: 0,
    stateInvalid: { count: 0, lastAt: null, lastWhy: null }, clockSkew: { count: 0, lastAt: null }, untrustedRecords: null });
}

module.exports = {
  KEY, FENCE_KEY, LOG_KEY, WRITER_GENERATION, SCRIPTS, PINNED, MAX_RUNS, OP_DEADLINE_MS, REQUEST_LIMIT_MS,
  protect, startGeneration2, raiseFence, getState, readDocument, writerStatus, publicStatus, logFailure, preservedStateReport,
  _resetProcessState,
};
