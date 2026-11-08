'use strict';
// THE PLANNER: from the service's trade moments, which pictures and which
// recording each trade is owed, and at what exact second. It takes nothing
// itself and reads no clock of its own (the caller passes "now"), so every
// rule here can be checked on its own.
//
// Owed, per trade:
//   - an ENTRY picture at the second of the buy;
//   - a DURING picture every `intervalMinutes` after it, while contracts are
//     still held (stopping a minute before the exit, where it would only
//     repeat the exit picture), at most `maxDuringPerTrade`;
//   - an EXIT picture at the second of each sale;
//   - a RECORDING from `preRollSeconds` before the entry to
//     `postRollSeconds` after that sale. Longer than `maxVideoMinutes`, it
//     keeps the first `keepHeadMinutes` and the last `keepTailMinutes`, so
//     the exit is always in it, and says which minutes were left out.
//
// Every job has an id made from what it is for, so hearing the same moment
// twice (a restart, a repeated read) owes nothing twice.

const MIN = 60 * 1000;

const DEFAULTS = Object.freeze({
  intervalMinutes: 5,
  preRollSeconds: 60,
  postRollSeconds: 60,
  maxVideoMinutes: 45,
  keepHeadMinutes: 40,
  keepTailMinutes: 5,
  maxDuringPerTrade: 30,
  duringStopsBeforeExitSeconds: 60,
});

function emptyState() {
  return { cursor: 0, positions: {}, jobs: {}, missedEvents: [] };
}

function settings(cfg) { return Object.assign({}, DEFAULTS, cfg || {}); }

const tradeKeyOf = e => e.tradeId || `${e.legKey}>${e.exitTimestamp}`;

function addJob(state, job) {
  if (state.jobs[job.id]) return false;
  state.jobs[job.id] = Object.assign({ status: 'waiting', tries: 0, reason: null, nextTryAt: 0 }, job);
  return true;
}

function ensurePosition(state, e) {
  if (!e.legKey || !Number.isFinite(e.entryTimestamp)) return null;
  let p = state.positions[e.legKey];
  if (!p) {
    p = state.positions[e.legKey] = {
      legKey: e.legKey, ticker: e.ticker, dir: e.dir || null, entryTs: e.entryTimestamp,
      test: !!e.test, open: true, closedAt: null,
    };
    addJob(state, { id: `${e.legKey}|entry`, kind: 'picture', moment: 'entry', at: e.entryTimestamp,
      ticker: e.ticker, legKey: e.legKey, test: !!e.test });
  }
  return p;
}

// The recording for one closed trade: which stretches of time to keep.
function clipPlan(entryTs, exitTs, cfg) {
  const c = settings(cfg);
  const from = entryTs - c.preRollSeconds * 1000;
  const to = exitTs + c.postRollSeconds * 1000;
  if (to - from <= c.maxVideoMinutes * MIN) return { from, to, parts: [[from, to]], cut: null };
  const headEnd = from + c.keepHeadMinutes * MIN;
  const tailStart = to - c.keepTailMinutes * MIN;
  return { from, to, parts: [[from, headEnd], [tailStart, to]], cut: { skippedFrom: headEnd, skippedTo: tailStart } };
}

// One moment from the service. Returns what was added, for the log.
function applyEvent(state, e, cfg) {
  const added = [];
  if (!e || typeof e !== 'object') return added;
  if (e.type === 'opened') {
    const had = !!state.positions[e.legKey];
    const p = ensurePosition(state, e);
    if (p && !had) added.push(`entry ${e.ticker}`);
    if (p && p.closedAt != null && p.closedAt < e.entryTimestamp) { p.open = true; p.closedAt = null; }
  } else if (e.type === 'closed') {
    if (!Number.isFinite(e.exitTimestamp)) return added;
    const p = ensurePosition(state, e);   // a quick trade may arrive as a closing alone
    if (!p) return added;
    const key = tradeKeyOf(e);
    if (addJob(state, { id: `${key}|exit`, kind: 'picture', moment: 'exit', at: e.exitTimestamp,
      ticker: e.ticker, legKey: e.legKey, test: !!e.test })) added.push(`exit ${e.ticker}`);
    const plan = clipPlan(p.entryTs, e.exitTimestamp, cfg);
    if (addJob(state, { id: `${key}|clip`, kind: 'clip', at: plan.to, from: plan.from, to: plan.to, parts: plan.parts,
      cut: plan.cut, entryTs: p.entryTs, exitTs: e.exitTimestamp, ticker: e.ticker, legKey: e.legKey, test: !!e.test })) added.push(`recording ${e.ticker}`);
    // Still held? Only an explicit "yes" keeps it open. Not knowing closes
    // it at this sale: during-pictures for a position that may be gone would
    // be pictures of nothing.
    if (e.stillOpen === true) { p.open = true; }
    else { p.open = false; p.closedAt = Math.max(p.closedAt || 0, e.exitTimestamp); }
  }
  return added;
}

// The during-pictures owed up to `now`. Called on every round; ids are
// fixed, so nothing is owed twice.
function planDuring(state, now, cfg) {
  const c = settings(cfg);
  const step = c.intervalMinutes * MIN;
  const added = [];
  for (const p of Object.values(state.positions)) {
    const until = p.open ? now : Math.min(now, p.closedAt - c.duringStopsBeforeExitSeconds * 1000);
    for (let k = 1; k <= c.maxDuringPerTrade; k++) {
      const at = p.entryTs + k * step;
      if (at > until) break;
      if (addJob(state, { id: `${p.legKey}|during|${k}`, kind: 'picture', moment: 'during', at,
        ticker: p.ticker, legKey: p.legKey, test: !!p.test })) added.push(`during ${p.ticker} +${k * c.intervalMinutes}m`);
    }
  }
  return added;
}

// Everything new from one read of the service's list.
function applyEvents(state, events, oldestSeq, cfg) {
  const added = [];
  const sorted = (Array.isArray(events) ? events : []).filter(e => e && typeof e === 'object' && Number.isSafeInteger(e.seq)).sort((a, b) => a.seq - b.seq);
  // Moments that dropped off the end of the service's list while the
  // camera was away cannot be recovered; that is said, never passed over.
  if (state.cursor > 0 && oldestSeq > state.cursor + 1) {
    state.missedEvents.push({ from: state.cursor + 1, to: oldestSeq - 1 });
  }
  for (const e of sorted) {
    if (e.seq <= state.cursor) continue;
    added.push(...applyEvent(state, e, cfg));
    state.cursor = e.seq;
  }
  return added;
}

// Positions finished with: closed, and every job for them settled. Kept a
// day after, so a late duplicate closing is still recognised.
function prune(state, now, keepMs = 24 * 60 * MIN) {
  for (const [k, p] of Object.entries(state.positions)) {
    if (p.open) continue;
    const open = Object.values(state.jobs).some(j => j.legKey === k && (j.status === 'waiting'));
    if (!open && p.closedAt != null && now - p.closedAt > keepMs) delete state.positions[k];
  }
  for (const [id, j] of Object.entries(state.jobs)) {
    if ((j.status === 'done' || j.status === 'failed') && j.settledAt && now - j.settledAt > 3 * keepMs) delete state.jobs[id];
  }
}

module.exports = { DEFAULTS, emptyState, applyEvent, applyEvents, planDuring, clipPlan, prune, tradeKeyOf };
