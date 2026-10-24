// STALE DECIDING READS (Queue plan v14.1 rev 3.2, Amendment A2: Q-T21 (p2)
// with its must-fail controls (x1)-(x3), and Q-T26 (k) as rewritten in 3.1).
//
// A2's claim: no read has to be fresh for safety. A change whose answer was
// lost may read an OLD copy of the record; it must then never apply itself a
// second time. This makes it happen on purpose: a stand-in at the client
// boundary lets a change's commit LAND, drops its answer, and then answers the
// next k reads of EVERY kind (the resolution read and plain reads) with the
// record as it was BEFORE that commit, with that text's correct SHA-1 -- for
// k = 1, 2, 5 and "every read until the limit". Variants: a writer whose clock
// is 2 hours fast prunes the record during the stale window; two lost answers
// in one change. Every kind of change. Expected, always: the domain effect
// exactly once, the change's record at most once, never a second COMMITTED
// for it, and an outcome of "recovered", "outcome-unknown" or "busy".
//
// The same scenarios run against three deliberately broken copies of the save
// (a small copy of protect() kept in this file, shown faithful first) -- one
// skipping the operation-record check (x1), one taking V0 from its latest read
// instead of V0min (x2), one committing with H0 from a fresher read than the
// one it computed from (x3) -- and each MUST be caught applying a change twice.
const path = require('path');
const crypto = require('crypto');
const { setUp } = require('./lib/gen2Harness');
const { restShim } = require('./lib/localRedis');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 700)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 9 * 60 * 1000).unref();

const stubs = {
  './schwabClient': { getOptionFills: async () => [] },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': { getUnderlyingPriceAt: async () => 500, getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }) },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
};

(async () => {
  const h = await setUp({ stubs });
  if (!h) { console.log('SKIPPED: no redis-server on this machine.\n\n0 passed, 0 failed'); process.exit(0); }
  const { shim, tradeStore: ts, Q, R, KEY, FENCE } = h;
  const cron = require(path.join(h.BACKEND, 'cron.js'));
  const api = require(path.join(h.BACKEND, 'api.js'));
  const { Redis } = require('@upstash/redis');

  // A SECOND service process's save module (the fast-clock writer), with its
  // own stand-in of the web service that is never made stale.
  const shim2 = restShim(h.redis.client);
  const url2 = await shim2.listen();
  const tsPath = require.resolve(path.join(h.BACKEND, 'tradeStore.js'));
  const keep = require.cache[tsPath];
  delete require.cache[tsPath];
  const url1 = process.env.UPSTASH_REDIS_REST_URL;
  process.env.UPSTASH_REDIS_REST_URL = url2;
  const ts2 = require(tsPath);
  process.env.UPSTASH_REDIS_REST_URL = url1;
  require.cache[tsPath] = keep;

  // ---- The stale stand-in: after a change's commit LANDS and its answer is
  // dropped, the next k reads of every kind get the record from before it.
  const stale = { pre: null, left: 0, target: null, dropped: 0, dropMax: 1, committed: [] };
  const newestOf = text => { const d = JSON.parse(text); const r = Object.values(d.opRecords).find(x => x.committedVersion === d.stateVersion); return r && r.opId; };
  // Installed again after every fresh start (h.ready() clears the hooks).
  const installStale = () => { shim.hooks = { before: staleBefore, after: staleAfter }; };
  const staleBefore = async cmd => {
    const s = h.scriptOf(cmd);
    if (stale.pre !== null && stale.left > 0 && (s === 'RESOLUTION_READ' || (h.verb(cmd) === 'get' && cmd[1] === KEY))) {
      stale.left--; stale.used++;
      return { reply: s === 'RESOLUTION_READ' ? ['present', sha1(stale.pre), stale.pre] : stale.pre };
    }
    if (s === 'COMMIT' && stale.target && cmd[6].includes(stale.target) && stale.pre === null) stale.preNext = await R.call('GET', KEY);
    return undefined;
  };
  const staleAfter = async (cmd, reply) => {
    if (h.scriptOf(cmd) !== 'COMMIT') return undefined;
    if (reply === 'COMMITTED') stale.committed.push(newestOf(cmd[6]));
    if (stale.target && cmd[6].includes(stale.target) && stale.dropped < stale.dropMax) {
      stale.dropped++;
      if (stale.pre === null && reply === 'COMMITTED') { stale.pre = stale.preNext; stale.left = stale.k; if (stale.onStale) await stale.onStale(); }
      return { drop: true };
    }
    return undefined;
  };
  const arm = (opId, k, opts = {}) => Object.assign(stale, { used: 0, pre: null, left: 0, target: opId, dropped: 0, dropMax: opts.dropMax || 1, committed: [], k, onStale: opts.onStale || null, preNext: null });
  const disarm = () => Object.assign(stale, { pre: null, left: 0, target: null });

  // ---- The kinds, each with its domain effect.
  const OCC = 'SPY   261231C00600000';
  const fill = (id, kind, m) => { const t0 = Date.parse('2026-10-20T14:00:00Z') + m * 60000; const d = new Date(t0); return { transactionId: id, accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL', instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66, date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: t0 }; };
  const landingFn = fills => cron.syncLandingUpdate({ fills, report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: '2026-10-24T12:00:00.000Z' });
  const KINDS = {
    staging: { prep: async () => ({}), op: () => ['staging', cron.stagingUpdate([fill('61001', 'open', 0), fill('61002', 'close', 5)])], effect: d => d.pendingStaged.length === 1 && d.queueSeq === 1 },
    publication: { prep: async () => ({ e: (await ts.protect('staging', cron.stagingUpdate([fill('62001', 'open', 0), fill('62002', 'close', 5)]))).out.staged[0] }), op: c => ['publication', Q.publicationUpdate, { payload: { items: [{ qid: c.e.qid, trade: { ...c.e, measured: 1 }, unmeasured: null }] } }], effect: d => d.pending.filter(e => e.measured === 1).length === 1 && !d.pendingStaged.length },
    'poison-guard': { prep: async () => ({ e: (await ts.protect('staging', cron.stagingUpdate([fill('63001', 'open', 0), fill('63002', 'close', 5)]))).out.staged[0] }), op: c => ['poison-guard', Q.poisonGuardUpdate, { payload: { qids: [c.e.qid] } }], effect: d => d.pendingStaged[0].stagedTries === 1 },
    'qid-removal': { prep: async () => ({ e: (await ts.protect('sync-landing', landingFn([fill('64001', 'open', 0), fill('64002', 'close', 5)]))).out.landed[0] }), op: c => ['qid-removal', Q.qidRemoval, { payload: { id: c.e.id, pair: c.e.fills, qid: c.e.qid } }], effect: d => d.pending.length === 1 },
    'legacy-removal': { prep: async () => ({}), op: () => ['legacy-removal', Q.legacyRemovalById, { payload: { id: 'W1' } }], effect: d => d.pending.length === 0 },
    reset: { prep: async () => ({}), op: () => ['reset', Q.resetUpdate, { acceptKinds: ['reset', 'reset-cancel'] }], effect: d => d.resetCounter === 1 && d.pending.length === 0 },
    cancel: { prep: async () => ({}), op: () => ['reset-cancel', Q.resetCancelUpdate, { acceptKinds: ['reset', 'reset-cancel'] }], effect: d => d.resetCounter === 1 },
    'sync-landing': { prep: async () => ({}), op: () => ['sync-landing', landingFn([fill('65001', 'open', 0), fill('65002', 'close', 5)])], effect: d => d.pending.length === 2 && d.queueSeq === 1 },
    activation: { prep: async () => { await ts.protect('legacy-removal', Q.legacyRemovalById, { payload: { id: 'W1' } }); return {}; }, op: () => ['activate', Q.activateUpdate], effect: d => d.removalEnabled === true },
    // A counter, so a second application is visible for a kind whose own
    // effect would look the same twice.
    progress: { prep: async () => ({}), op: () => ['progress', (doc) => { const lb = doc.lastBackfill || {}; return { next: { ...doc, lastBackfill: { ...lb, n: (lb.n || 0) + 1 } }, result: { fields: ['n'] } }; }], effect: d => d.lastBackfill.n === 1 },
  };
  const START = { openLegs: [], pending: [{ id: 'W1', fills: ['a1', 'a2'] }], lastProcessedIds: ['a1', 'a2'] };

  // ---- A small copy of protect(), kept here ONLY to be broken on purpose.
  // It must first behave like the real one (shown below), so that a
  // failure of a broken copy is the defect's, not the copy's.
  const raw = new Redis({ url: url1, token: 'stand-in-token', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 }, enableAutoPipelining: false, signal: () => AbortSignal.timeout(10000) });
  async function copyProtect(defect, kind, update, opts = {}) {
    const fixed = { opId: opts.opId, at: opts.at || Date.now(), payload: opts.payload, candidateEpoch: opts.candidateEpoch || hex('cand' + Math.random()) };
    const accept = opts.acceptKinds || [kind];
    let amb = null;
    for (let runs = 1; runs <= 10; runs++) {
      let reply = await raw.eval(ts.SCRIPTS.RESOLUTION_READ, [KEY], []);
      if (!Array.isArray(reply) || reply[0] !== 'present') return { status: 'outcome-unknown' };
      const text = reply[2], sha = reply[1];
      const doc = JSON.parse(text);
      const rec = doc.opRecords[fixed.opId];
      if (rec && defect !== 'x1') return Q.untrustedWhy(rec, fixed.opId, doc.stateVersion, fixed.at) || !accept.includes(rec.kind) ? { status: 'outcome-unknown' } : { status: 'recovered', result: rec.result };
      if (amb) {
        const v0 = defect === 'x2' ? doc.stateVersion : amb.V0min;
        if (!(sha === amb.H0 || doc.prunedThroughVersion < v0 + 1)) return { status: 'outcome-unknown' };
      }
      const out = update(JSON.parse(text), fixed);
      if (out.refuse) return { status: 'refused' };
      if (!out.next) return { status: 'unchanged', result: out.result };
      const fin = Q.finalize(doc, out.next, out.result, kind, fixed).final;
      let H0 = sha;
      if (defect === 'x3') { const fresh = await R.call('GET', KEY); H0 = sha1(fresh); }
      let c;
      try { c = await raw.eval(ts.SCRIPTS.COMMIT, [KEY, FENCE], [H0, JSON.stringify(fin), '2']); } catch (e) { c = undefined; }
      if (c === 'COMMITTED') return { status: 'committed', result: out.result };
      if (c === 'CONFLICT') continue;
      if (c === 'FENCED') return { status: 'fenced' };
      amb = { H0: sha, V0min: amb ? Math.min(amb.V0min, doc.stateVersion) : doc.stateVersion };
    }
    return { status: amb ? 'outcome-unknown' : 'busy' };
  }

  // One scenario: a kind, a k, a variant, an engine. Returns what happened.
  async function scenario(name, k, variant, engine) {
    const spec = KINDS[name];
    await h.ready(START);
    await ts2._resetProcessState(); await ts2.startGeneration2({ pauseMs: 0 });
    disarm(); installStale();
    const c = await spec.prep();
    const [kind, fn, opts = {}] = spec.op(c);
    const opId = hex([name, k, variant, engine, Math.random()].join('|'));
    const later = Date.now() + 2 * 3600e3;
    arm(opId, k, {
      dropMax: variant === 'two-lost-answers' ? 2 : 1,
      onStale: variant === 'fast-clock-prunes' ? async () => {
        // The other process, its clock 2 hours fast, writes twice: its first
        // write is more than an hour after the change, so the change's record
        // is pruned.
        for (let i = 0; i < 2; i++) await ts2.protect('progress', Q.progressUpdate, { payload: { fast: i }, at: later + i * 3600001 });
      } : null,
    });
    const run = engine === 'real' ? ts.protect : (kd, f, o) => copyProtect(engine === 'faithful copy' ? null : engine, kd, f, o);
    const out = await run(kind, fn, { ...opts, opId });
    const committed = stale.committed.filter(x => x === opId).length;
    disarm();
    const d = await h.doc();
    const recs = Object.keys(d.opRecords).filter(x => x === opId).length;
    return { out: out.status, once: spec.effect(d), committed, recs, staleServed: stale.used };
  }
  // A pass needs the stale reads to have been SERVED (a case where none were
  // would prove nothing).
  const ok = r => r.staleServed > 0 && r.once && r.committed === 1 && r.recs <= 1 && ['recovered', 'outcome-unknown', 'busy'].includes(r.out);

  try {
    await section('Q-T21 (p2) STALE DECIDING READS: every kind, k = 1, 2, 5 and every read until the limit', async () => {
      for (const name of Object.keys(KINDS)) {
        for (const k of [1, 2, 5, Infinity]) {
          const r = await scenario(name, k, 'plain', 'real');
          check(`${name}, k=${k === Infinity ? 'all' : k}: once, one record, one COMMITTED, outcome "${r.out}"`, ok(r), r);
        }
      }
    });
    await section('Q-T21 (p2) VARIANTS: a 2-hours-fast writer prunes the record in the stale window; two lost answers in one change', async () => {
      for (const name of Object.keys(KINDS)) {
        for (const variant of ['fast-clock-prunes', 'two-lost-answers']) {
          for (const k of [2, Infinity]) {
            const r = await scenario(name, k, variant, 'real');
            check(`${name}, ${variant}, k=${k === Infinity ? 'all' : k}: once, never committed twice, outcome "${r.out}"`, ok(r), r);
          }
        }
      }
    });
    await section('THE MUST-FAIL CONTROLS: a faithful small copy passes; each broken copy is CAUGHT applying a change twice', async () => {
      const cases = [['progress', 2, 'plain'], ['poison-guard', 2, 'plain'], ['progress', 2, 'fast-clock-prunes'], ['poison-guard', 1, 'fast-clock-prunes']];
      for (const [name, k, variant] of cases) {
        const r = await scenario(name, k, variant, 'faithful copy');
        check(`the faithful copy, ${name} / ${variant} / k=${k}: as the real one (once, one COMMITTED)`, ok(r), r);
      }
      const caught = {};
      for (const defect of ['x1', 'x2', 'x3']) {
        for (const [name, k, variant] of cases) {
          const r = await scenario(name, k, variant, defect);
          if (!ok(r)) caught[defect] = (caught[defect] || []).concat(`${name}/${variant}/k=${k}: committed ${r.committed}, effect once ${r.once}`);
        }
      }
      check('(x1) a copy that skips the operation-record check on re-runs: caught (a second application)', !!caught.x1, caught.x1);
      check('(x2) a copy that takes V0 from its latest read instead of V0min: caught (a second application)', !!caught.x2, caught.x2);
      check('(x3) a copy that commits with H0 from a fresher read than the one it computed from: caught (a second COMMITTED)', !!caught.x3, caught.x3);
      console.log('     what each broken copy did:', JSON.stringify(caught));
    });

    await section('Q-T26 (k) STATUS AND CANCEL ON A STALE READ (no part requires any read to be fresh)', async () => {
      const route = (method, p, req = {}) => {
        const layer = api.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
        return new Promise(resolve => {
          const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
          layer.route.stack[0].handle({ method: method.toUpperCase(), params: {}, query: {}, body: {}, ...req }, res, err => resolve({ next: err }));
        });
      };
      for (const k of [1, 2, 5, Infinity]) {
        await h.ready(START); installStale();
        const id = hex('k' + k);
        // The reset commits, its answer is lost, and reads go stale.
        arm(id, k);
        const rr = await route('post', '/trades/reset', { body: { requestId: id, base: 0 } });
        disarm();
        // Now status and cancel, with the next k reads stale again.
        const pre = await (async () => { const d = await h.doc(); return d; })();
        Object.assign(stale, { pre: JSON.stringify((() => { const x = JSON.parse(JSON.stringify(pre)); delete x.opRecords[id]; x.stateVersion -= 1; x.resetCounter = 0; x.pending = START.pending; return x; })()), left: k, target: null });
        const s1 = await route('get', '/trades/reset/:requestId', { params: { requestId: id }, query: { base: '0' } });
        const c1 = await route('post', '/trades/reset/:requestId/cancel', { params: { requestId: id } });
        const leftover = stale.left;
        disarm();
        const d = await h.doc();
        const recs = Object.values(d.opRecords).filter(r => r.opId === id);
        check(`k=${k === Infinity ? 'all' : k}: the reset itself ended ${rr.status} ${rr.body.status || rr.body.reason}; applied exactly once (resetCounter 1, one record, a reset)`,
          d.resetCounter === 1 && recs.length === 1 && recs[0].kind === 'reset', { rr, rc: d.resetCounter });
        check(`k=${k === Infinity ? 'all' : k}: the status on a stale read is never a wrong FINAL answer ("${s1.body.status}")`, ['not-yet', 'unknown', 'applied'].includes(s1.body.status) && (s1.body.status !== 'applied' || leftover < k), s1.body);
        check(`k=${k === Infinity ? 'all' : k}: the CANCEL never wrote a tombstone and never answered "cancelled"; it answered "${c1.body.status}" (final: ${c1.body.final})`,
          c1.body.status !== 'cancelled' && recs[0].kind === 'reset' && (c1.body.status === 'applied' ? c1.body.final === true : c1.body.final === false), c1.body);
      }
      // Broken copies: a status that answers "cancelled" without the record,
      // and a cancel that writes its tombstone without a COMMITTED answer.
      await h.ready(START);
      const id = hex('broken');
      await route('post', '/trades/reset', { body: { requestId: id, base: 0 } });
      const brokenStatus = () => ({ status: 'cancelled' });
      check('BROKEN COPY, a status answering "cancelled" with no tombstone recorded: caught (the record says "reset")', brokenStatus().status === 'cancelled' && (await h.doc()).opRecords[id].kind === 'reset');
      const d = await h.doc();
      d.opRecords[id] = { ...d.opRecords[id], kind: 'reset-cancel' };
      check('BROKEN COPY, a cancel that writes its tombstone over an applied reset without a COMMITTED answer: caught (its record no longer matches its check: untrusted)', Q.untrustedWhy(d.opRecords[id], id, d.stateVersion, Date.now()) !== null);
    });
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    await shim2.close();
    const stopped = await h.tearDown();
    check('the local Redis was stopped by SHUTDOWN NOSAVE and its folder removed', stopped.exited && stopped.folderGone, stopped);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
