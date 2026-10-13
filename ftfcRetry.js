// FTFC Fix 1 -- retry cycles, envelopes and the reading checks (13 Oct
// 2026). Owner's authorisation, in words: "I authorize FTFC Fix 1
// implementation." Plans v1-v14 and the consolidated spec, sections B and C.
//
// WHY THIS EXISTS. A new trade's timeframe reading can come back incomplete
// -- a provider refused or answered with nothing, or (very often for a quick
// trade) Alpaca's free plan holds back the last fifteen minutes of bars, so
// the entry's own minutes are not there yet. Before this, that incomplete
// reading was saved as final and could read "no FTFC" when the truth was
// unknown. Now an incomplete reading is UNKNOWN with its reasons, and the
// service measures again a bounded number of times: at most three retries,
// 5 minutes, 30 minutes and 2 hours after the first measurement.
//
// Everything here that decides is a plain function of its inputs, so the
// tests can drive it without a network or a clock.

const { TIMEFRAMES, computeFtfcConfirmation, REASON_NO_PRICE, REASON_BEFORE_SESSION, REASON_NO_BAR } = require('./ftfcCheck');

const RETRY_OFFSETS_MS = [5 * 60e3, 30 * 60e3, 120 * 60e3];   // attempts 1, 2, 3 after T0
const MIN_GAP_MS = 5 * 60e3;
const INTERRUPT_AFTER_MS = 10 * 60e3;
const MAX_PER_TICK = 5;
const KEEP_CLOSED_MS = 30 * 24 * 3600e3;
const FINAL_CODES = ['EXHAUSTED_READING', 'EXHAUSTED_INTERRUPTED', 'SUPERSEDED'];
const STATUSES = ['bull', 'bear', 'level', 'missing'];
const INTRADAY = ['4H', '2H', '1H', '30m', '15m', '5m', '3m', '1m'];
const REASON_INTERRUPTED = 'the service stopped during this attempt';
const REASON_NOT_MEASURED = 'not measured during the sync';

const cycleKey = (version, open, close) => `${version}|${open}|${close}`;

// Same New York clock the reading uses, built once.
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
});
function easternMinutes(ms) {
  const p = Object.fromEntries(EASTERN_CLOCK.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  let h = Number(p.hour); if (h === 24) h = 0;
  return h * 60 + Number(p.minute);
}

const FAILURE = /^(Alpaca|Schwab) refused \(status \d+\)$|^(Alpaca|Schwab) answered with nothing$|^could not reach (Alpaca|Schwab)$/;

// Spec C4. Returns a list of what is wrong; empty means valid. The app runs
// the same rules (its own copy, in index.html) before it applies anything;
// the service runs them before it stores or sends anything.
function readingProblems(r, entryMs) {
  const out = [];
  if (!r || typeof r !== 'object') return ['not a reading'];
  if (!Number.isInteger(r.version)) out.push('no rule version');
  const st = r.status || {}, miss = r.missing || {};
  for (const tf of TIMEFRAMES) if (!STATUSES.includes(st[tf])) out.push(`status for ${tf} missing or unknown`);
  for (const k of Object.keys(st)) if (!TIMEFRAMES.includes(k)) out.push(`unknown timeframe ${k}`);
  const missingTfs = TIMEFRAMES.filter(tf => st[tf] === 'missing');
  if (r.complete !== (missingTfs.length === 0)) out.push('complete flag disagrees with the statuses');
  for (const tf of missingTfs) if (typeof miss[tf] !== 'string' || !miss[tf].length || miss[tf].length > 120) out.push(`no reason for ${tf}`);
  for (const k of Object.keys(miss)) if (st[k] !== 'missing') out.push(`reason given for ${k}, which is not missing`);
  // Price evidence (spec A2).
  const hasPrice = r.priceAtEntry != null;
  if (hasPrice) {
    if (!(Number.isFinite(r.priceAtEntry) && r.priceAtEntry > 0)) out.push('price is not a positive number');
    if (r.priceSource === 'exact-print') {
      const s0 = Number.isFinite(entryMs) ? entryMs - (entryMs % 1000) : NaN;
      if (!(Number.isFinite(r.priceTime) && r.priceTime >= s0 && r.priceTime <= entryMs)) out.push('exact print is not inside the entry second');
    } else if (r.priceSource === 'prior-minute-close') {
      const want = Number.isFinite(entryMs) ? entryMs - (entryMs % 60000) - 60000 : NaN;
      if (r.priceTime !== want) out.push('prior minute is not the minute before the entry minute');
    } else out.push('price has no allowed source');
  } else if (r.priceSource != null || r.priceTime != null) out.push('a source or time without a price');
  if (r.complete && !hasPrice) out.push('complete without a price');
  // Reason precedence (spec A3).
  for (const tf of missingTfs) {
    const why = miss[tf];
    if (!hasPrice) { if (why !== REASON_NO_PRICE) out.push(`${tf}: expected "${REASON_NO_PRICE}"`); continue; }
    if (why === REASON_NO_PRICE) { out.push(`${tf}: "no price" given while a price exists`); continue; }
    const before = Number.isFinite(entryMs) && easternMinutes(entryMs) < 9 * 60 + 30;
    if (INTRADAY.includes(tf) && before) { if (why !== REASON_BEFORE_SESSION) out.push(`${tf}: expected "${REASON_BEFORE_SESSION}"`); continue; }
    if (why === REASON_BEFORE_SESSION) { out.push(`${tf}: "before the session" given for an entry that was not`); continue; }
    if (why !== REASON_NO_BAR && !FAILURE.test(why)) out.push(`${tf}: reason not in the allowed forms`);
  }
  // Verdict and grid (spec A4).
  const grid = r.grid || {};
  for (const tf of TIMEFRAMES) {
    const want = (st[tf] === 'bull' || st[tf] === 'bear') ? st[tf] : undefined;
    if (grid[tf] !== want) out.push(`grid disagrees with the status for ${tf}`);
  }
  for (const k of Object.keys(grid)) if (!TIMEFRAMES.includes(k)) out.push(`grid has unknown ${k}`);
  if (r.complete) {
    const v = computeFtfcConfirmation(grid);
    if (r.run !== v.runLength || r.confirmed !== v.confirmed || (r.direction ?? null) !== (v.direction ?? null)
        || JSON.stringify(r.timeframesInRun || []) !== JSON.stringify(v.timeframesInRun || [])) out.push('verdict disagrees with the statuses');
  } else if (r.run != null || r.confirmed != null || r.direction != null || (r.timeframesInRun || []).length) {
    out.push('an incomplete reading carries a verdict');
  }
  return out;
}

// One envelope = everything the cycle has produced so far (spec B5/B6).
function envelopeFor(rec, kind, finalCode = null) {
  return {
    version: rec.version, open: rec.open, close: rec.close, kind,
    highestSeq: rec.attempts.length ? rec.attempts[rec.attempts.length - 1].seq : 0,
    ...(kind === 'final' ? { finalCode } : {}),
    attempts: rec.attempts.map(a => ({
      seq: a.seq, version: rec.version, open: rec.open, close: rec.close, outcome: a.outcome,
      ...(a.outcome === 'reading' ? { reading: a.reading } : { reason: a.reason }),
    })),
  };
}

// A history import's one measurement (spec B3): kind "single", never a cycle.
function singleEnvelope(version, open, close, reading) {
  return { version, open, close, kind: 'single', highestSeq: 0,
           attempts: [{ seq: 0, version, open, close, outcome: 'reading', reading }] };
}

// At most ONE waiting envelope per cycle identity, replaced in place.
function putUpdate(state, env) {
  const key = cycleKey(env.version, env.open, env.close);
  const list = (state.ftfcUpdates || []).filter(u => cycleKey(u.version, u.open, u.close) !== key);
  list.push(env);
  return list;
}

const nextDue = (rec, afterSeq, now) => Math.max(rec.t0 + RETRY_OFFSETS_MS[afterSeq], now + MIN_GAP_MS);

// Attempt 0 for a live-sync trade (spec B2). Returns { envelope, record } --
// record is null when the reading is already complete.
function startCycle({ version, open, close, ticker, entryTimestamp, reading, now }) {
  const ok = reading && readingProblems(reading, entryTimestamp).length === 0;
  const first = ok ? { seq: 0, outcome: 'reading', reading, closedAt: now }
                   : { seq: 0, outcome: 'interrupted', reason: REASON_NOT_MEASURED, closedAt: now };
  const rec = { version, open, close, ticker, entryTimestamp, t0: now, counter: 0,
                attempts: [first], inflight: null, nextAt: now + RETRY_OFFSETS_MS[0], closed: false, closedAt: null, closedCode: null };
  const envelope = envelopeFor(rec, 'retry');
  if (ok && reading.complete) return { envelope, record: null };
  return { envelope, record: rec };
}

// Records an attempt's outcome and decides what follows. Mutates rec; returns
// the envelope to queue.
function closeAttempt(rec, entry, now) {
  rec.attempts.push(entry);
  rec.inflight = null;
  const seq = entry.seq;
  if (entry.outcome === 'reading' && entry.reading.complete) {
    rec.closed = true; rec.closedAt = now; rec.closedCode = seq === 3 ? 'EXHAUSTED_READING' : 'complete';
    return seq === 3 ? envelopeFor(rec, 'final', 'EXHAUSTED_READING') : envelopeFor(rec, 'retry');
  }
  if (seq === 3) {
    const code = entry.outcome === 'reading' ? 'EXHAUSTED_READING' : 'EXHAUSTED_INTERRUPTED';
    rec.closed = true; rec.closedAt = now; rec.closedCode = code;
    return envelopeFor(rec, 'final', code);
  }
  rec.nextAt = nextDue(rec, seq, now);
  return envelopeFor(rec, 'retry');
}

// The tick's whole job (spec B4). deps: { store: tradeStore, measure(rec)
// -> reading, version, now() }. Returns a short account of what it did.
async function runFtfcRetries({ store, measure, version, now = () => Date.now() }) {
  const done = { superseded: 0, interrupted: 0, attempted: 0, expired: 0 };
  const t = now();
  // 1. Supersede old versions, recover dead attempts, expire old records --
  //    one locked write.
  await store.updateState(state => {
    const recs = state.ftfcRetry || {};
    let updates = state.ftfcUpdates || [];
    let changed = false;
    const keep = {};
    for (const [key, rec] of Object.entries(recs)) {
      if (rec.closed) {
        if (t - (rec.closedAt || 0) > KEEP_CLOSED_MS) { done.expired++; changed = true; continue; }
        keep[key] = rec; continue;
      }
      if (rec.version !== version) {
        rec.inflight = null; rec.closed = true; rec.closedAt = t; rec.closedCode = 'SUPERSEDED';
        updates = putUpdate({ ftfcUpdates: updates }, envelopeFor(rec, 'final', 'SUPERSEDED'));
        done.superseded++; changed = true; keep[key] = rec; continue;
      }
      if (rec.inflight && t - rec.inflight.startedAt > INTERRUPT_AFTER_MS) {
        const env = closeAttempt(rec, { seq: rec.inflight.seq, outcome: 'interrupted', reason: REASON_INTERRUPTED, closedAt: t }, t);
        updates = putUpdate({ ftfcUpdates: updates }, env);
        done.interrupted++; changed = true;
      }
      keep[key] = rec;
    }
    return changed ? { ...state, ftfcRetry: keep, ftfcUpdates: updates } : null;
  });

  // 2. Due attempts: oldest first, at most five, one per record.
  const snapshot = (await store.getState()).ftfcRetry || {};
  const due = Object.entries(snapshot)
    .filter(([, r]) => !r.closed && !r.inflight && r.version === version && r.counter < 3 && r.nextAt <= t)
    .sort((a, b) => a[1].nextAt - b[1].nextAt)
    .slice(0, MAX_PER_TICK);
  for (const [key] of due) {
    let started = null;
    // "started" and the counter, BEFORE any request.
    await store.updateState(state => {
      const rec = (state.ftfcRetry || {})[key];
      if (!rec || rec.closed || rec.inflight || rec.counter >= 3 || rec.nextAt > now()) return null;
      rec.counter += 1;
      rec.inflight = { seq: rec.counter, startedAt: now() };
      started = { ...rec.inflight, rec: JSON.parse(JSON.stringify(rec)) };
      return { ...state, ftfcRetry: { ...state.ftfcRetry, [key]: rec } };
    });
    if (!started) continue;
    done.attempted++;
    let entry;
    try {
      const reading = await measure(started.rec);
      const problems = readingProblems(reading, started.rec.entryTimestamp);
      entry = problems.length
        ? { seq: started.seq, outcome: 'interrupted', reason: ('the reading failed the service\'s own checks: ' + problems[0]).slice(0, 120) }
        : { seq: started.seq, outcome: 'reading', reading };
    } catch (err) {
      entry = { seq: started.seq, outcome: 'interrupted', reason: ('the attempt failed: ' + ((err && err.message) || 'unknown')).slice(0, 120) };
    }
    // "done", the outcome and the queued update: ONE locked write. If the
    // record moved on meanwhile (superseded, or recovered as interrupted),
    // this result is discarded -- it never lands twice.
    await store.updateState(state => {
      const rec = (state.ftfcRetry || {})[key];
      if (!rec || rec.closed || !rec.inflight || rec.inflight.seq !== started.seq) return null;
      entry.closedAt = now();
      const env = closeAttempt(rec, entry, now());
      return { ...state, ftfcRetry: { ...state.ftfcRetry, [key]: rec }, ftfcUpdates: putUpdate(state, env) };
    });
  }
  return done;
}

module.exports = {
  RETRY_OFFSETS_MS, INTERRUPT_AFTER_MS, MAX_PER_TICK, KEEP_CLOSED_MS, FINAL_CODES,
  REASON_INTERRUPTED, REASON_NOT_MEASURED,
  cycleKey, readingProblems, envelopeFor, singleEnvelope, putUpdate, startCycle, closeAttempt, runFtfcRetries,
};
