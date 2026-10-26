'use strict';
// GENERATION 2, THE RULES THEMSELVES (Queue plan v14.1 rev 3.2, Deploy 2), as
// pure functions, with no storage at all. Real-store behaviour is
// tests/gen2-store.js; this file proves what each rule DECIDES:
//   Q-T15 (a)  PURITY: every update function, by name, run twice on the same
//              record and inputs gives byte-identical results; it never
//              changes its input (a deeply frozen input, and a compare
//              before/after); it never touches the clock, a random source or
//              the network (each replaced by a trap that fails the test);
//              and a broken copy that changes its stored record is caught.
//   Q-T15 (b), (d), (e), (k), (l), (m)  qids never reused; the epoch case
//              table with existing entries; candidate refusal; broken copies.
//   Q-T7       the protected reset keeps every new field; a fresh-object
//              reset is caught.
//   Q-T8, Q-T13  every removal answer, exact and legacy.
//   5.5 (1a), (5)  record trust, pruning, the clock guard; Q-T21 (m)-(o).
//   5.9.3      reset retention by count and the status decision.
//   5.7        activation counts (Q-T22 (a)-(d) on the function).
//   3.3, 3.11  publication and the poison guard.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const BACKEND = path.join(__dirname, '..');
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); } };
const section = (title, fn) => { console.log('\n--- ' + title + ' ---'); try { fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } };

const NO_STORE = new Proxy({}, { get: () => async () => { throw new Error('no store in this test'); } });
// cron.js is loaded with everything outside it stubbed, only to reach its two
// pure writers (the sync landing and the import's staging).
const stubs = {
  '@upstash/redis': { Redis: Object.assign(class { constructor() { return NO_STORE; } }, { fromEnv: () => NO_STORE }) },
  'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './schwabClient': { getOptionFills: async () => [] },
  './tokenStore': { getTokens: async () => ({}), setLastCheck: async () => {} },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {} },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const Q = require(path.join(BACKEND, 'queueOps.js'));
const cron = require(path.join(BACKEND, 'cron.js'));
const G2 = require('./lib/gen2StandIn');

const clone = v => JSON.parse(JSON.stringify(v));
const canon = v => Q.canonicalJson(v);
const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
const EPOCH_A = 'a'.repeat(32), EPOCH_B = 'b'.repeat(32), EPOCH_C = 'c'.repeat(32);
const AT = Date.parse('2026-10-24T12:00:00Z');
const hex = n => crypto.createHash('sha256').update(String(n)).digest('hex').slice(0, 32);

// A generation-2 record with something in every list.
function sampleDoc() {
  const d = G2.expanded({
    openLegs: [{ occ: 'SPY   261231C00600000', openFillId: 'o9', remaining: 1, accountRef: 'acct-x' }],
    pending: [{ id: 'V1', fills: ['1', '2'], qid: EPOCH_A + '-1' }, { id: 'V2', fills: ['3', '4'], qid: EPOCH_A + '-2' }, { id: 'OLD', fills: ['5', '6'] }],
    lastProcessedIds: ['1', '2', '3', '4', '5', '6'],
    exceptions: {}, identityCutoverAt: '2026-10-01T00:00:00.000Z', lastSync: { at: 'x' }, lastBackfill: { status: 'done' },
  }, AT - 1000);
  d.queueEpoch = EPOCH_A; d.queueSeq = 4;
  d.pendingStaged = [{ id: 'S1', fills: ['7', '8'], qid: EPOCH_A + '-3', stagedAt: 'x', stagedTries: 0 },
                     { id: 'S2', fills: ['9', '10'], qid: EPOCH_A + '-4', stagedAt: 'x', stagedTries: 2 }];
  return d;
}
const fixedFor = payload => ({ opId: hex('op'), at: AT, candidateEpoch: EPOCH_B, payload });

// The fills a staging or landing works from (fixed inputs).
const OCC = 'SPY   261231C00600000';
function fill(id, kind, minute) {
  const ts = Date.parse('2026-10-20T14:00:00Z') + minute * 60000; const d = new Date(ts);
  return { transactionId: id, accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const FILLS = [fill('101', 'open', 0), fill('102', 'close', 5), fill('103', 'open', 10)];

// EVERY update function, by name (plan 5.5 PURITY lists the writers).
const UPDATES = {
  'expansion (expandUpdate)': [d => Q.expandUpdate(G2.olderFields(d), fixedFor())],
  'removal by qid (qidRemoval)': [d => Q.qidRemoval(d, fixedFor({ id: 'V1', pair: ['1', '2'], qid: EPOCH_A + '-1' }))],
  'legacy removal by id (W6, legacyRemovalById)': [d => Q.legacyRemovalById(d, fixedFor({ id: 'OLD' }))],
  'legacy removal by id and pair (W7, legacyRemovalByPair)': [d => Q.legacyRemovalByPair(d, fixedFor({ id: 'V2', pair: ['3', '4'] }))],
  'reset (W2, resetUpdate)': [d => Q.resetUpdate(d, fixedFor())],
  'reset cancel (resetCancelUpdate)': [d => Q.resetCancelUpdate(d, fixedFor())],
  'activation (activateUpdate)': [d => Q.activateUpdate(d, fixedFor())],
  'deactivation (deactivateUpdate)': [d => Q.deactivateUpdate(d, fixedFor())],
  'backfill progress (W3, progressUpdate)': [d => Q.progressUpdate(d, fixedFor({ phase: 'enriching', tradesEnriched: 3 }))],
  'poison guard (poisonGuardUpdate), counting': [d => Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: EPOCH_A + '-3' }))],
  'poison guard (poisonGuardUpdate), abandoning': [d => Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: EPOCH_A + '-4' }))],
  'poison guard (poisonGuardUpdate), saving a decision': [d => Q.poisonGuardUpdate(d, fixedFor({ prev: { qid: EPOCH_A + '-3', decided: 'result', trade: { id: 'S1', fills: ['7', '8'], undEntry: 500 } }, qid: EPOCH_A + '-99' }))],
  'a decision not saved (decisionNotSavedUpdate)': [d => Q.decisionNotSavedUpdate(d, fixedFor({ qid: EPOCH_A + '-3', outcome: 'not-staged' }))],
  'publication (publicationUpdate)': [d => Q.publicationUpdate(d, fixedFor({ prev: { qid: EPOCH_A + '-3', decided: 'failed', trade: { id: 'S1', fills: ['7', '8'] } }, qids: [EPOCH_A + '-3', EPOCH_A + '-4', EPOCH_A + '-77'] }))],
  'the commit\'s bookkeeping (finalize)': [d => Q.finalize(d, Object.assign({}, d, { touched: 1 }), { fields: ['touched'] }, 'progress', fixedFor())],
  'qid issuing (issueQids)': [d => Q.issueQids(d, 3, EPOCH_B, AT)],
  'live-sync landing (W1, syncLandingUpdate)': [d => cron.syncLandingUpdate({ fills: FILLS, report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01T00:00:00.000Z'), nowIso: '2026-10-24T12:00:00.000Z' })(d, fixedFor())],
  'history-import staging (W5, stagingUpdate)': [d => cron.stagingUpdate(FILLS)(d, fixedFor())],
};
// The traps: any call fails the test (Q-T15 (a)).
function withTraps(fn) {
  const touched = [];
  const saved = { now: Date.now, random: Math.random, rb: crypto.randomBytes, ru: crypto.randomUUID, fetch: global.fetch, Date: global.Date };
  const RealDate = Date;
  function TrapDate(...a) { if (!a.length) { touched.push('new Date()'); throw new Error('TRAP: the clock was read'); } return new RealDate(...a); }
  TrapDate.prototype = RealDate.prototype; TrapDate.parse = RealDate.parse; TrapDate.UTC = RealDate.UTC;
  TrapDate.now = () => { touched.push('Date.now'); throw new Error('TRAP: the clock was read'); };
  try {
    global.Date = TrapDate;
    Math.random = () => { touched.push('Math.random'); throw new Error('TRAP: randomness'); };
    crypto.randomBytes = () => { touched.push('randomBytes'); throw new Error('TRAP: randomness'); };
    crypto.randomUUID = () => { touched.push('randomUUID'); throw new Error('TRAP: randomness'); };
    global.fetch = () => { touched.push('fetch'); throw new Error('TRAP: the network'); };
    return { out: fn(), touched };
  } catch (e) { return { error: e, touched }; }
  finally {
    global.Date = saved.Date; Math.random = saved.random; crypto.randomBytes = saved.rb; crypto.randomUUID = saved.ru; global.fetch = saved.fetch;
  }
}
const outText = o => JSON.stringify(o, (k, v) => (v instanceof Map ? [...v] : v));

section('Q-T15 (a) PURITY, every update function by name', () => {
  for (const [name, [fn]] of Object.entries(UPDATES)) {
    const doc = sampleDoc();
    const before = canon(doc);
    const r1 = withTraps(() => fn(clone(doc)));
    const r2 = withTraps(() => fn(clone(doc)));
    check(`${name}: no clock, random source or network touched`, !r1.error && !r2.error && !r1.touched.length && !r2.touched.length, { e: r1.error && r1.error.message, t: r1.touched });
    check(`${name}: twice on the same record and inputs, byte-identical results`, outText(r1.out) === outText(r2.out));
    const same = clone(doc);
    withTraps(() => fn(same));
    check(`${name}: its input is unchanged afterwards (compared as canonical JSON)`, canon(same) === before);
    let frozenErr = null;
    try { fn(deepFreeze(clone(doc))); } catch (e) { frozenErr = e; }
    check(`${name}: runs on a DEEPLY FROZEN record without trying to change it`, !frozenErr, frozenErr && frozenErr.message);
  }
  // A broken copy, today's attempt start (rec.counter += 1 on the stored
  // record), must be caught by the same checks.
  const broken = d => { d.pendingStaged[0].stagedTries += 1; return { next: d, result: {} }; };
  const doc = sampleDoc(), before = canon(doc), same = clone(doc);
  broken(same);
  let frozenErr = null; try { broken(deepFreeze(clone(doc))); } catch (e) { frozenErr = e; }
  check('BROKEN COPY that changes its stored record: caught (input changed, and it throws on a frozen record)', canon(same) !== before && !!frozenErr);
  const clocky = withTraps(() => ({ at: Date.now() }));
  check('BROKEN COPY that reads the clock: caught by the trap', !!clocky.error && clocky.touched.includes('Date.now'));
  const randy = withTraps(() => crypto.randomBytes(16).toString('hex'));
  check('BROKEN COPY that makes its own random epoch: caught by the trap', !!randy.error && randy.touched.includes('randomBytes'));
});

section('Q-T15 (a) SOURCE CHECK: no update function names the clock, randomness or the network', () => {
  const fs = require('fs');
  const qsrc = fs.readFileSync(path.join(BACKEND, 'queueOps.js'), 'utf8').replace(/\/\/.*$/gm, '');
  check('queueOps.js: no Date.now, no "new Date()", no Math.random, no randomBytes/UUID, no fetch',
    !/Date\.now|new Date\(\s*\)|Math\.random|randomBytes|randomUUID|getRandomValues|\bfetch\(|require\(['"](https?|net|axios)['"]\)/.test(qsrc));
  for (const f of [cron.syncLandingUpdate, cron.stagingUpdate]) {
    const s = f.toString().replace(/\/\/.*$/gm, '');
    check(`${f.name}: no Date.now, no "new Date()", no randomness, no network, no write to anything outside`,
      !/Date\.now|new Date\(\s*\)|Math\.random|randomBytes|randomUUID|fetch\(|tradeStore\.|await /.test(s));
  }
});

section('Q-T15 (b) 10,000 qids across stagings, landings and resets are all distinct', () => {
  let d = sampleDoc();
  const all = new Set();
  let dupes = 0;
  for (let i = 0; i < 2000; i++) {
    const r = Q.issueQids(d, 5, hex('c' + i), AT);
    for (const q of r.qids) { if (all.has(q)) dupes++; all.add(q); }
    d = Object.assign({}, d, r.fields);
    if (i % 97 === 0) { const rs = Q.resetUpdate(d); d = Object.assign({}, rs.next, { stateVersion: d.stateVersion + 1 }); }
  }
  check(`${all.size} qids, no duplicate (${dupes})`, all.size === 10000 && dupes === 0);
  check('a reset never touched the counter: the last n is 10,000', d.queueSeq === 10000 + 4);
});

section('Q-T15 (d), (e), (k), (l) THE EPOCH CASE TABLE', () => {
  const forms = {
    C2: [['absent', d => { delete d.queueSeq; }], ['a string', d => { d.queueSeq = '7'; }], ['-1', d => { d.queueSeq = -1; }], ['1.5', d => { d.queueSeq = 1.5; }], ['the maximum', d => { d.queueSeq = Number.MAX_SAFE_INTEGER; }]],
    C3: [['absent', d => { delete d.queueEpoch; }], ['wrong length', d => { d.queueEpoch = 'a'.repeat(31); }], ['upper case', d => { d.queueEpoch = 'A'.repeat(32); }], ['a number', d => { d.queueEpoch = 7; }]],
    C4: [['both absent', d => { delete d.queueEpoch; delete d.queueSeq; }], ['both malformed', d => { d.queueEpoch = 'X'; d.queueSeq = -1; }]],
  };
  for (const [kase, list] of Object.entries(forms)) {
    for (const [label, mut] of list) {
      const d = sampleDoc(); mut(d);
      const oldQids = [...d.pending, ...d.pendingStaged].map(e => e.qid);
      const r = Q.issueQids(d, 2, EPOCH_C, AT);
      check(`${kase} (${label}): the case is ${Q.identityCase(d)}`, Q.identityCase(d) === kase);
      check(`${kase} (${label}): the epoch becomes EXACTLY the candidate and the count restarts ("<candidate>-1")`,
        r.ok && r.fields.queueEpoch === EPOCH_C && r.qids[0] === EPOCH_C + '-1' && r.qids[1] === EPOCH_C + '-2', r);
      const ev = r.fields.queueEvents[r.fields.queueEvents.length - 1];
      check(`${kase} (${label}): ONE event records the case, the old values and the counts`,
        r.fields.queueEvents.length === d.queueEvents.length + 1 && ev.case === kase && ev.newEpoch === EPOCH_C
        && 'oldEpoch' in ev && 'oldSeq' in ev && ev.counts.staged === 2 && ev.counts.visible === 3, ev);
      check(`${kase} (${label}): existing entries untouched (issueQids returns no entries)`, JSON.stringify([...d.pending, ...d.pendingStaged].map(e => e.qid)) === JSON.stringify(oldQids));
      check(`${kase} (${label}): no new qid equals an existing one`, r.qids.every(q => !oldQids.includes(q)));
    }
  }
  const d = sampleDoc();
  const r = Q.issueQids(d, 2, EPOCH_C, AT);
  check('(e) VALID state (C1): the candidate is stored nowhere, no event, the count simply continues',
    r.fields.queueEpoch === EPOCH_A && r.qids.join() === [EPOCH_A + '-5', EPOCH_A + '-6'].join() && r.fields.queueEvents.length === d.queueEvents.length && !JSON.stringify(r).includes(EPOCH_C));
  // (k) candidate refusal.
  const broke = sampleDoc(); delete broke.queueSeq;
  check('(k) a candidate equal to the current epoch: refused, "epoch-collision"', Q.issueQids(broke, 1, EPOCH_A, AT).reason === 'epoch-collision');
  const withEv = sampleDoc(); delete withEv.queueSeq; withEv.queueEvents = [...withEv.queueEvents, { case: 'C3', newEpoch: EPOCH_C }];
  check('(k) a candidate already recorded in queueEvents: refused', Q.issueQids(withEv, 1, EPOCH_C, AT).reason === 'epoch-collision');
  const pre = sampleDoc(); delete pre.queueEpoch; pre.pending.push({ id: 'P', qid: EPOCH_C + '-9' });
  check('(k) a candidate that is the prefix of an existing qid: refused', Q.issueQids(pre, 1, EPOCH_C, AT).reason === 'epoch-collision');
  check('(k) ...and a new candidate is accepted', Q.issueQids(pre, 1, EPOCH_B, AT).ok);
  // (l) untagged entries survive an identity replacement unchanged (issueQids
  // never touches entries; the writers carry existing entries over as they are).
  const u = sampleDoc(); delete u.queueSeq; u.pending.push({ id: 'BAD', qid: 'not-a-qid' });
  const before = canon(u.pending);
  Q.issueQids(u, 1, EPOCH_C, AT);
  check('(l) untagged entries (none, or a malformed qid) are untouched by an identity replacement', canon(u.pending) === before);
  // (m) broken copies.
  const rebuild = doc => { const max = Math.max(0, ...[...doc.pending, ...doc.pendingStaged].map(e => Number(String(e.qid || '').split('-')[1]) || 0)); return doc.queueEpoch + '-' + (max + 1); };
  const gone = sampleDoc(); gone.pending = gone.pending.filter(e => e.qid !== EPOCH_A + '-2'); gone.pendingStaged = gone.pendingStaged.filter(e => e.qid !== EPOCH_A + '-4');
  const issuedBefore = [EPOCH_A + '-1', EPOCH_A + '-2', EPOCH_A + '-3', EPOCH_A + '-4'];
  check('(m) BROKEN COPY that rebuilds the counter from the highest surviving qid: reissues a removed qid (caught)', issuedBefore.includes(rebuild(gone)));
  check('(m) ...the real rule does not', !issuedBefore.includes(Q.issueQids(gone, 1, EPOCH_C, AT).qids[0]));
  const noPrefix = (doc, c) => ({ ok: true, qids: [c + '-1'] });
  check('(m) BROKEN COPY without the prefix refusal: would issue an existing qid (caught)', pre.pending.some(e => e.qid === EPOCH_C + '-9') && noPrefix(pre, EPOCH_C).qids[0] !== undefined && Q.issueQids(pre, 1, EPOCH_C, AT).ok === false);
});

section('Q-T7 THE PROTECTED RESET', () => {
  const d = sampleDoc();
  const r = Q.resetUpdate(d);
  const n = r.next;
  check('openLegs, pending, lastProcessedIds and pendingStaged are emptied', [n.openLegs, n.pending, n.lastProcessedIds, n.pendingStaged].every(a => Array.isArray(a) && !a.length));
  check('exceptions are kept, as before', canon(n.exceptions) === canon(d.exceptions));
  for (const k of ['schemaVersion', 'queueEpoch', 'queueSeq', 'queueEvents', 'opRecords', 'prunedThroughVersion', 'removalEnabled']) {
    check(`the new-schema field ${k} is byte-identical across the reset`, canon(n[k]) === canon(d[k]));
  }
  check('the older fields are dropped exactly as the generation-1 reset dropped them (lastSync, lastBackfill, identityCutoverAt)',
    !('lastSync' in n) && !('lastBackfill' in n) && !('identityCutoverAt' in n));
  check('resetCounter + 1, and the result counts what was emptied', n.resetCounter === 1 && r.result.resetSeq === 1
    && canon(r.result.emptied) === canon({ pending: 3, pendingStaged: 2, openLegs: 1, lastProcessedIds: 6 }));
  check('its result has the reset record\'s exact shape', Q.RESULT_SHAPES.reset(r.result));
  const fin = Q.finalize(d, n, r.result, 'reset', fixedFor());
  check('stateVersion rises by exactly 1, with the reset\'s own record', fin.final.stateVersion === d.stateVersion + 1 && fin.final.opRecords[hex('op')].kind === 'reset');
  const freshObject = { openLegs: [], pending: [], lastProcessedIds: [], ...(d.exceptions ? { exceptions: d.exceptions } : {}) };
  const lost = ['schemaVersion', 'stateVersion', 'queueEpoch', 'queueSeq', 'queueEvents', 'opRecords', 'prunedThroughVersion', 'pendingStaged', 'removalEnabled'].filter(k => !(k in freshObject));
  check('BROKEN COPY, a reset built as a fresh object (generation 1\'s): caught -- it drops ' + lost.length + ' new fields', lost.length === 9);
  check('...and the record it would leave is not a usable generation-2 record', Q.docProblems(freshObject).length > 0);
});

section('Q-T8 and Q-T13 EVERY REMOVAL ANSWER (the functions; the routes are in tests/gen2-store.js)', () => {
  const d = sampleDoc();
  d.pending.push({ id: 'TW', fills: ['20', '21'], qid: EPOCH_A + '-10' }, { id: 'TW', fills: ['20', '21'], qid: EPOCH_A + '-11' });
  const rm = p => Q.qidRemoval(d, fixedFor(p));
  let r = rm({ id: 'V1', pair: ['1', '2'], qid: EPOCH_A + '-1' });
  check('the exact entry: removed, and only it', r.result.reason === 'removed' && r.next.pending.length === d.pending.length - 1 && !r.next.pending.some(e => e.qid === EPOCH_A + '-1'));
  r = rm({ id: 'TW', pair: ['20', '21'], qid: EPOCH_A + '-10' });
  check('two same-id, same-pair entries: removed one at a time by qid', r.result.reason === 'removed' && r.next.pending.filter(e => e.id === 'TW').length === 1);
  for (const [label, p, want] of [
    ['a different id only', { id: 'X', pair: ['1', '2'] }, ['id']],
    ['a different open only', { id: 'V1', pair: ['9', '2'] }, ['open']],
    ['a different close only', { id: 'V1', pair: ['1', '9'] }, ['close']],
    ['all three different', { id: 'X', pair: ['8', '9'] }, ['id', 'open', 'close']],
  ]) {
    r = rm({ ...p, qid: EPOCH_A + '-1' });
    check(`an existing qid with ${label}: 409 "qid-mismatch" naming exactly ${want.join(', ')}, nothing removed`,
      r.next === null && r.result.status === 409 && r.result.reason === 'qid-mismatch' && canon(r.result.mismatch) === canon(want), r.result);
  }
  r = rm({ id: 'TW', pair: ['20', '21'], qid: EPOCH_A + '-99' });
  check('a qid naming no entry while same-id, same-pair entries exist: 409 "other-qids" listing them, nothing removed',
    r.next === null && r.result.reason === 'other-qids' && canon(r.result.queuedQids) === canon([EPOCH_A + '-10', EPOCH_A + '-11']));
  r = rm({ id: 'GONE', pair: ['1', '1'], qid: EPOCH_A + '-98' });
  check('a qid already removed, nothing with that id and pair: 200 "not-found"', r.next === null && r.result.status === 200 && r.result.reason === 'not-found');
  for (const bad of ['a'.repeat(31) + '-1', 'A'.repeat(32) + '-1', 'a'.repeat(32) + '-0', 'a'.repeat(32) + '-01', 'a'.repeat(32), 'a'.repeat(32) + '-1.5', '']) {
    check(`a malformed qid ${JSON.stringify(bad.slice(-6))} is not a qid (the route answers 400 "bad-qid")`, !Q.isQid(bad));
  }
  const byQidAlone = (doc, qid) => doc.pending.filter(e => e.qid !== qid);
  check('BROKEN COPY that removes by qid alone: removes an entry whose id and pair differ (caught)', byQidAlone(d, EPOCH_A + '-1').length === d.pending.length - 1
    && rm({ id: 'X', pair: ['8', '9'], qid: EPOCH_A + '-1' }).next === null);
  // Q-T13 the legacy forms, exactly as before, including removing BOTH twins.
  r = Q.legacyRemovalByPair(d, fixedFor({ id: 'TW', pair: ['20', '21'] }));
  check('legacy by id and pair: removes EVERY entry with that id and pair (both twins: QR-1, visible)', r.result.removed === 2 && !r.next.pending.some(e => e.id === 'TW'));
  const d2 = sampleDoc(); d2.pending.push({ id: 'V1', fills: ['30', '31'] });
  r = Q.legacyRemovalByPair(d2, fixedFor({ id: 'V1', pair: ['1', '2'] }));
  check('legacy by id and pair: an entry with the same id and another pair is kept and reported', r.result.removed === 1 && r.kept.length === 1 && r.next.pending.some(e => e.fills[0] === '30'));
  r = Q.legacyRemovalById(d2, fixedFor({ id: 'V1' }));
  check('legacy by id only: every entry with the id is removed', r.result.removed === 2 && !r.next.pending.some(e => e.id === 'V1'));
  check('legacy by id only, nothing with that id: no change, no record', Q.legacyRemovalById(d2, fixedFor({ id: 'nope' })).next === null);
});

section('5.5 (1a) RECORD TRUST, (5) PRUNING AND THE CLOCK GUARD; Q-T21 (m), (n), (o)', () => {
  const d = sampleDoc();
  const opId = hex('r1');
  const good = { opId, kind: 'progress', committedAt: AT - 1000, committedVersion: d.stateVersion, result: { fields: ['x'] } };
  good.check = Q.recordCheck(good);
  check('a well-formed record is trusted', Q.untrustedWhy(good, opId, d.stateVersion, AT) === null);
  const alter = (f, why) => { const r = Object.assign(clone(good), f); return [Q.untrustedWhy(r, opId, d.stateVersion, AT), why]; };
  for (const [w, label] of [
    alter({ committedAt: AT - 2 * 3600e3 }, '(m) committedAt made 2 hours older without updating check'),
    alter({ committedAt: String(AT) }, '(n) committedAt as text'),
    alter({ committedAt: AT + 0.5 }, '(n) committedAt a fraction'),
    alter({ committedAt: 1000 }, '(n) committedAt before 1 January 2026'),
    alter({ committedAt: AT + 3600e3 }, '(n) committedAt 1 hour in the future'),
    alter({ committedVersion: d.stateVersion + 1 }, '(o) committedVersion above stateVersion'),
    alter({ result: { fields: ['y'] } }, '(o) result altered without updating check'),
    alter({ kind: 'nonsense' }, 'an unknown kind'),
    alter({ opId: hex('other') }, 'an opId that is not the key it is stored under'),
    alter({ extra: 1 }, 'an extra field'),
  ]) check(`untrusted: ${label} (${w})`, w !== null);
  // Pruning.
  const old = { ...good, opId: hex('old'), committedAt: AT - 2 * 3600e3, committedVersion: 1 }; old.check = Q.recordCheck(old);
  const recent = { ...good, opId: hex('recent'), committedAt: AT - 60e3, committedVersion: 1 }; recent.check = Q.recordCheck(recent);
  const damaged = { ...old, opId: hex('dmg'), check: '0'.repeat(64) };
  const base = Object.assign(sampleDoc(), { opRecords: { [old.opId]: old, [recent.opId]: recent, [damaged.opId]: damaged }, prunedThroughVersion: 0 });
  let f = Q.finalize(base, base, { fields: [] }, 'progress', fixedFor());
  check('(5) a trusted record older than 1 hour is pruned, a recent one kept', !(old.opId in f.final.opRecords) && recent.opId in f.final.opRecords);
  check('(5) pruning raises prunedThroughVersion past it', f.final.prunedThroughVersion >= 1);
  check('(5) an UNTRUSTED record is never pruned automatically', damaged.opId in f.final.opRecords);
  const higher = Object.assign(clone(base), { prunedThroughVersion: 7 });
  f = Q.finalize(higher, higher, { fields: [] }, 'progress', fixedFor());
  check('(5) prunedThroughVersion never lowers', f.final.prunedThroughVersion === 7);
  const future = { ...good, opId: hex('fut'), committedAt: AT + 10 * 60e3 }; future.check = Q.recordCheck(future);
  const skew = Object.assign(clone(base), { opRecords: { ...base.opRecords, [future.opId]: future } });
  f = Q.finalize(skew, skew, { fields: [] }, 'progress', fixedFor());
  check('CLOCK GUARD: a record 10 minutes in the future: nothing pruned in this write, and the skew is reported', f.skew && old.opId in f.final.opRecords);
  check('stateVersion + 1 and the new record carries committedVersion = read + 1', f.final.stateVersion === skew.stateVersion + 1 && f.final.opRecords[hex('op')].committedVersion === skew.stateVersion + 1);
});

section('5.9.3 (S-R5) RESET RETENTION BY COUNT; (S-R6) THE STATUS DECISION', () => {
  let d = sampleDoc();
  const ids = [];
  for (let i = 1; i <= 205; i++) {
    const fx = { opId: hex('reset' + i), at: AT, candidateEpoch: EPOCH_B };
    const r = i % 2 ? Q.resetUpdate(d) : Q.resetCancelUpdate(d);
    d = Q.finalize(d, r.next, r.result, i % 2 ? 'reset' : 'reset-cancel', fx).final;
    ids.push(fx.opId);
  }
  const kept = ids.filter(id => id in d.opRecords);
  check(`205 reset-kind records written: the newest 200 kept (${kept.length}), whatever their age`, kept.length === 200 && ids.slice(5).every(id => id in d.opRecords));
  check('prunedResetThrough rose to the newest pruned resetSeq (5), and resetCounter is 205', d.prunedResetThrough === 5 && d.resetCounter === 205);
  check('prunedThroughVersion rose too: a pruned reset can never be "proved" unapplied by R4', d.prunedThroughVersion >= 5);
  const read = doc => ({ kind: 'present', doc });
  check('status: a record of an applied reset -> "applied"', Q.resetStatus(read(d), ids[204], 0, AT).status === 'applied');
  check('status: a tombstone -> "cancelled"', Q.resetStatus(read(d), ids[203], 0, AT).status === 'cancelled');
  check('status: no record, prunedResetThrough <= base -> "not-yet"', Q.resetStatus(read(d), hex('never'), 5, AT).status === 'not-yet');
  check('status: no record, prunedResetThrough >= base + 1 -> "unknown"', Q.resetStatus(read(d), hex('never'), 4, AT).status === 'unknown');
  const fresh = sampleDoc();
  check('status: before any reset-kind record (both counters absent, read as 0), base 0 -> "not-yet"', Q.resetStatus(read(fresh), hex('x'), 0, AT).status === 'not-yet');
  const mis = clone(d); mis.opRecords[hex('elsewhere')] = Object.assign({}, mis.opRecords[ids[204]]);
  check('status: a record naming the request under ANOTHER key -> "unknown" (never falls through)', Q.resetStatus(read(mis), ids[204], 999, AT).status === 'unknown');
  const unt = clone(d); unt.opRecords[ids[204]].check = '0'.repeat(64);
  check('status: an untrusted record -> "unknown", never "applied"', Q.resetStatus(read(unt), ids[204], 0, AT).status === 'unknown');
  check('status: absent, unreadable, unexpanded -> "unknown"', Q.resetStatus({ kind: 'absent' }, ids[1], 0, AT).status === 'unknown'
    && Q.resetStatus({ kind: 'unreadable' }, ids[1], 0, AT).status === 'unknown' && Q.resetStatus(read({ pending: [] }), ids[1], 0, AT).status === 'unknown');
});

section('5.7 ACTIVATION (Q-T22 (a)-(d), on the function)', () => {
  const clean = sampleDoc(); clean.pending = clean.pending.filter(e => e.qid);
  let r = Q.activateUpdate(clean);
  check('(a) both lists clean: removalEnabled becomes true', r.next && r.next.removalEnabled === true && Q.RESULT_SHAPES.activate(r.result));
  const st = clone(clean); st.pendingStaged.push({ id: 'U' });
  r = Q.activateUpdate(st);
  check('(b) one untagged STAGED entry: refused with the counts (0 visible, 1 staged), nothing written', r.next === null && r.result.status === 'refused' && r.result.untagged.visible === 0 && r.result.untagged.staged === 1);
  r = Q.activateUpdate(sampleDoc());
  check('(c) one untagged VISIBLE entry: refused', r.next === null && r.result.untagged.visible === 1);
  for (const bad of ['a'.repeat(31) + '-1', 'A'.repeat(32) + '-1', 'a'.repeat(32) + '-0', 'a'.repeat(32)]) {
    const m = clone(clean); m.pending[0].qid = bad;
    check(`(d) a malformed qid ${JSON.stringify(bad.slice(-5))} counts as untagged and refuses`, Q.activateUpdate(m).next === null);
  }
  check('deactivation always produces a change (its record is the evidence it ran)', Q.deactivateUpdate(clean).next.removalEnabled === false);
});

section('3.11 THE POISON GUARD, ONE TRADE AT A TIME, and 3.3 PUBLICATION (the functions; correction of 25 Oct 2026)', () => {
  const d = sampleDoc();
  const S1 = EPOCH_A + '-3', S2 = EPOCH_A + '-4';
  const at = (doc, q) => doc.pendingStaged.find(e => e.qid === q);
  const shapeOk = (kind, r) => Q.RESULT_SHAPES[kind](r);
  // Counting: ONLY the named trade.
  let g = Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: S1 }));
  check('counting: ONLY the named trade gets stagedTries + 1; its batch-mate is untouched', g.result.current.outcome === 'counted' && at(g.next, S1).stagedTries === 1 && at(g.next, S2).stagedTries === 2 && shapeOk('poison-guard', g.result));
  check('counting publishes nothing (the batch is published together)', g.next.pending.length === d.pending.length);
  g = Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: S2 }));
  check('a trade already started twice: decided "abandoned" in staging, its counter NOT raised, not published here',
    g.result.current.outcome === 'abandoned' && at(g.next, S2).decided === 'abandoned' && at(g.next, S2).stagedTries === 2 && g.next.pending.length === d.pending.length);
  // I5: not staged.
  g = Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: EPOCH_A + '-99' }));
  check('I5 a trade no longer staged: skipped, nothing written, nothing resurrected', g.result.current.outcome === 'skipped' && g.next === null);
  // Saving the previous decision.
  const dec = { qid: S1, decided: 'result', trade: { id: 'S1', fills: ['7', '8'], undEntry: 500, qid: 'ignored', stagedTries: 9, stagedAt: 'y' } };
  g = Q.poisonGuardUpdate(d, fixedFor({ prev: dec, qid: S2 }));
  const saved = at(g.next, S1);
  check('the previous decision is saved in ITS OWN staged entry, in the same commit as the next trade\'s count',
    g.result.saved.outcome === 'saved' && saved.decided === 'result' && saved.undEntry === 500 && at(g.next, S2).decided === 'abandoned' && shapeOk('poison-guard', g.result));
  check('the saved entry keeps the STORED qid and staging bookkeeping, never the copy\'s', saved.qid === S1 && saved.stagedTries === 0 && saved.stagedAt === 'x');
  // I1: previous no longer staged.
  const gone = clone(d); gone.pendingStaged = gone.pendingStaged.filter(e => e.qid !== S1);
  g = Q.poisonGuardUpdate(gone, fixedFor({ prev: dec, qid: null }));
  check('I1 the previous trade is no longer staged: the change REFUSES ("decision-not-saved"), writes nothing, and does NOT count the next trade',
    g.refuse === 'decision-not-saved' && g.result.saved.outcome === 'not-staged' && g.result.current === null && !g.next);
  const g2 = Q.poisonGuardUpdate(gone, fixedFor({ prev: dec, qid: S2 }));
  check('I1 ... even when the next trade is still staged and could be counted', g2.refuse === 'decision-not-saved' && g2.result.current === null && !g2.next);
  // I2: never over a saved decision.
  const done = clone(d); done.pendingStaged[0] = Object.assign({}, done.pendingStaged[0], { decided: 'result', undEntry: 111 });
  g = Q.poisonGuardUpdate(done, fixedFor({ prev: { qid: S1, decided: 'failed', trade: { id: 'S1', fills: ['7', '8'], undEntry: 999 } }, qid: null }));
  check('I2 a decision already saved is never overwritten (later or stale); this is NOT a stop', g.result.saved.outcome === 'already-decided' && g.next === null && !g.refuse);
  const g3 = Q.poisonGuardUpdate(done, fixedFor({ prev: { qid: S1, decided: 'failed', trade: { id: 'S1', fills: ['7', '8'], undEntry: 999 } }, qid: S2 }));
  check('already-decided: the batch carries on to the next trade, the stored decision untouched', !g3.refuse && g3.result.current.outcome === 'abandoned' && g3.next.pendingStaged[0].undEntry === 111 && g3.next.pendingStaged[0].decided === 'result');
  // I3: the current trade already decided.
  g = Q.poisonGuardUpdate(done, fixedFor({ prev: null, qid: S1 }));
  check('I3 a trade with a saved decision is neither counted nor measured again', g.result.current.outcome === 'already-decided' && g.next === null);
  // A decision about a different trade is refused.
  g = Q.poisonGuardUpdate(d, fixedFor({ prev: { qid: S1, decided: 'result', trade: { id: 'OTHER', fills: ['7', '8'] } }, qid: null }));
  check('a decision whose trade is not the staged one (id or fill pair): REFUSED ("mismatch"), nothing written, the next trade not counted', g.refuse === 'decision-not-saved' && g.result.saved.outcome === 'mismatch' && !g.next);
  let threw = false; try { Q.poisonGuardUpdate(d, fixedFor({ prev: { qid: S1, decided: 'abandoned', trade: { id: 'S1', fills: ['7', '8'] } }, qid: null })); } catch (e) { threw = true; }
  check('"abandoned" is never a measurement decision handed in (only the guard decides it)', threw);
  // Publication: from the DOCUMENT, decided trades only.
  const half = Q.poisonGuardUpdate(d, fixedFor({ prev: null, qid: S2 })).next;   // S2 decided "abandoned"
  const p = Q.publicationUpdate(half, fixedFor({ prev: dec, qids: [S1, S2, EPOCH_A + '-50'] }));
  check('publication saves the last decision, then publishes every decided trade of the batch together, keeping each qid',
    p.result.saved.outcome === 'saved' && p.result.published.join() === [S1, S2].join() && p.next.pending[0].qid === S1 && p.next.pending[0].undEntry === 500 && p.next.pending[1].qid === S2 && !p.next.pendingStaged.length && shapeOk('publication', p.result));
  check('a published entry loses its staging bookkeeping (stagedAt, stagedTries, decided)', p.next.pending.slice(0, 2).every(e => !('stagedAt' in e) && !('stagedTries' in e) && !('decided' in e)));
  check('the unmeasured reasons are counted (abandoned 1), the not-staged qid noted', p.next.lastBackfill.unmeasured.counts.abandoned === 1 && !p.next.lastBackfill.unmeasured.counts.result && p.result.notStaged.join() === EPOCH_A + '-50' && p.next.lastBackfill.notStaged.count === 1);
  const und = Q.publicationUpdate(d, fixedFor({ prev: null, qids: [S1] }));
  check('a staged trade with NO saved decision stays staged ("undecided"); nothing written', und.result.undecided.join() === S1 && und.next === null);
  check('a publication where nothing is still staged: no change, no record', Q.publicationUpdate(d, fixedFor({ prev: null, qids: [EPOCH_A + '-50'] })).next === null);
  const goneP = Q.publicationUpdate(gone, fixedFor({ prev: dec, qids: [S1] }));
  check('I5 publication never publishes a trade no longer staged from the copy in memory: its last decision unsaved, it REFUSES and publishes nothing',
    goneP.refuse === 'decision-not-saved' && !goneP.next && goneP.result.saved.outcome === 'not-staged' && goneP.result.published.length === 0);
  const gonePub = clone(half); gonePub.pendingStaged = gonePub.pendingStaged.filter(e => e.qid !== S1);
  const gp = Q.publicationUpdate(gonePub, fixedFor({ prev: dec, qids: [S1, S2] }));
  check('...and publishes NONE of the batch, even a trade with a saved decision (it stays staged for the next run): no partly visible batch', gp.refuse === 'decision-not-saved' && !gp.next);
  const note = Q.decisionNotSavedUpdate(sampleDoc(), fixedFor({ qid: S1, outcome: 'not-staged' }));
  check('the durable note: lastBackfill.decisionNotSaved counts it, with the qid, the reason and the time', note.next.lastBackfill.decisionNotSaved.count === 1 && note.next.lastBackfill.decisionNotSaved.examples[0].qid === S1 && note.next.lastBackfill.decisionNotSaved.examples[0].outcome === 'not-staged' && Q.RESULT_SHAPES.progress(note.result));
  // Two staged items with the same id and pair: each published once, by its own qid.
  const tw = sampleDoc();
  tw.pendingStaged = [{ id: 'T', fills: ['1', '2'], qid: EPOCH_A + '-20', stagedTries: 1 }, { id: 'T', fills: ['1', '2'], qid: EPOCH_A + '-21', stagedTries: 1 }];
  const p1 = Q.publicationUpdate(tw, fixedFor({ prev: { qid: EPOCH_A + '-20', decided: 'result', trade: { id: 'T', fills: ['1', '2'], v: 1 } }, qids: [EPOCH_A + '-20'] }));
  const p2 = Q.publicationUpdate(p1.next, fixedFor({ prev: { qid: EPOCH_A + '-21', decided: 'result', trade: { id: 'T', fills: ['1', '2'], v: 2 } }, qids: [EPOCH_A + '-21'] }));
  check('two staged items with the same id and pair: each published exactly once, each under its own qid, each with its own decision',
    p2.next.pending.filter(e => e.id === 'T').map(e => e.qid + ':' + e.v).sort().join() === [EPOCH_A + '-20:1', EPOCH_A + '-21:2'].join() && !p2.next.pendingStaged.length);
  const byIdPair = (doc, item) => doc.pendingStaged.filter(e => !(e.id === item.trade.id && canon(e.fills) === canon(item.trade.fills)));
  check('BROKEN COPY that matches staging by id and pair: takes BOTH twins out for one publication (caught)', byIdPair(tw, { trade: { id: 'T', fills: ['1', '2'] } }).length === 0);
});

section('5.5 MALFORMED STATE: what generation 2 refuses', () => {
  const ok = sampleDoc();
  check('a well-formed record has no problems', Q.docProblems(ok).length === 0, Q.docProblems(ok));
  for (const [label, mut] of [
    ['schemaVersion 3', d => { d.schemaVersion = 3; }], ['stateVersion 0', d => { d.stateVersion = 0; }], ['opRecords a list', d => { d.opRecords = []; }],
    ['pendingStaged missing', d => { delete d.pendingStaged; }], ['removalEnabled "false"', d => { d.removalEnabled = 'false'; }],
    ['a pending entry that is not an object', d => { d.pending.push(7); }], ['exceptions a list', d => { d.exceptions = [1]; }],
    ['resetCounter -1', d => { d.resetCounter = -1; }], ['identityCutoverAt not a date', d => { d.identityCutoverAt = 'nope'; }],
  ]) { const d = sampleDoc(); mut(d); check(`refused: ${label}`, Q.docProblems(d).length > 0); }
  const id = sampleDoc(); id.queueEpoch = 'X'; id.queueSeq = 'Y';
  check('a damaged queue identity is NOT a refusal: 4.1\'s case table replaces it', Q.docProblems(id).length === 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
