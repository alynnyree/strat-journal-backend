// REMOVAL BY EXACT qid, THE LEGACY FORMS, AND ACTIVATION, through the REAL
// routes and save module on a real Redis (Queue plan v14.1 rev 3.2; Deploy 2):
//   Q-T8   every 4.2 answer, asserted on the response AND the stored queue
//   Q-T13  the legacy forms exactly as before, including removing BOTH of two
//          same-id, same-pair entries (QR-1, made visible)
//   Q-T22  (a)-(g) activation: refusal with counts, the race in both orders,
//          after activation, and an activation whose answer is lost
//   and the removal answers when a save cannot go through (busy,
//   outcome-unknown, not-ready, fenced).
// There is deliberately no route that RUNS activation (Deploy 2 plan v2, S7);
// these checks call the change itself.
const path = require('path');
const crypto = require('crypto');
const { setUp } = require('./lib/gen2Harness');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 5 * 60 * 1000).unref();

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
  const { shim, tradeStore: ts, Q, R, KEY } = h;
  const api = require(path.join(h.BACKEND, 'api.js'));
  const route = (method, p, req = {}) => {
    const layer = api.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    return new Promise(resolve => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
      layer.route.stack[0].handle({ method: method.toUpperCase(), params: {}, query: {}, body: {}, ...req }, res, err => resolve({ next: err }));
    });
  };
  const del = (id, query) => route('delete', '/trades/pending/:id', { params: { id }, query });
  const E = 'a'.repeat(32);
  // A ready record with tagged visible entries, two same-id same-pair twins,
  // and one older untagged entry.
  const seed = async () => {
    await h.ready({ openLegs: [], pending: [], lastProcessedIds: [] });
    const d = await h.doc();
    d.queueEpoch = E; d.queueSeq = 10;
    d.pending = [
      { id: 'A', fills: ['1', '2'], qid: E + '-1' }, { id: 'B', fills: ['3', '4'], qid: E + '-2' },
      { id: 'T', fills: ['5', '6'], qid: E + '-3' }, { id: 'T', fills: ['5', '6'], qid: E + '-4' },
      { id: 'OLD', fills: ['7', '8'] },
    ];
    await R.call('SET', KEY, JSON.stringify(d));
    return d;
  };
  const qids = async () => (await h.doc()).pending.map(e => e.qid || e.id);
  try {
    await section('Q-T8 EVERY 4.2 ANSWER, on the response and the stored queue', async () => {
      await seed();
      let r = await del('A', { fills: '1,2', qid: E + '-1' });
      check('the exact entry: 200 {removed: 1, reason: "removed"}; only it is gone', r.status === 200 && r.body.removed === 1 && r.body.reason === 'removed' && (await qids()).join() === [E + '-2', E + '-3', E + '-4', 'OLD'].join(), r);
      r = await del('A', { fills: '1,2', qid: E + '-1' });
      check('the same again (already removed, nothing with that id and pair left): 200 "not-found"', r.status === 200 && r.body.removed === 0 && r.body.reason === 'not-found', r);
      r = await del('T', { fills: '5,6', qid: E + '-99' });
      check('a qid naming no entry while same-id, same-pair entries exist: 409 "other-qids" listing them, nothing removed',
        r.status === 409 && r.body.reason === 'other-qids' && r.body.queuedQids.join() === [E + '-3', E + '-4'].join() && (await qids()).length === 4, r);
      r = await del('T', { fills: '5,6', qid: E + '-3' });
      const r2 = await del('T', { fills: '5,6', qid: E + '-4' });
      check('two same-id, same-pair entries: removed one at a time by qid', r.body.removed === 1 && r2.body.removed === 1 && (await qids()).join() === [E + '-2', 'OLD'].join());
      for (const [label, id, fills, want] of [['a different id only', 'X', '3,4', ['id']], ['a different open only', 'B', '9,4', ['open']], ['a different close only', 'B', '3,9', ['close']], ['all three different', 'X', '8,9', ['id', 'open', 'close']]]) {
        const before = await h.text();
        r = await del(id, { fills, qid: E + '-2' });
        check(`an existing qid with ${label}: 409 "qid-mismatch" naming exactly ${want.join(', ')}, the record byte-identical`,
          r.status === 409 && r.body.reason === 'qid-mismatch' && r.body.mismatch.join() === want.join() && (await h.text()) === before, r);
      }
      for (const bad of ['a'.repeat(31) + '-1', 'A'.repeat(32) + '-1', E + '-0', E + '-01', E]) {
        const before = await h.text();
        r = await del('B', { fills: '3,4', qid: bad });
        check(`a malformed qid (${bad.length > 34 ? '...' + bad.slice(-4) : bad.slice(-6)}): 400 "bad-qid", nothing removed`, r.status === 400 && r.body.reason === 'bad-qid' && (await h.text()) === before, r);
      }
      r = await del('B', { qid: E + '-2' });
      check('a qid without fills: 400 "qid-without-fills"', r.status === 400 && r.body.reason === 'qid-without-fills', r);
    });

    await section('Q-T13 THE LEGACY FORMS, exactly as before', async () => {
      await seed();
      let r = await del('T', { fills: '5,6' });
      check('by id and pair (no qid): removes EVERY entry with that id and pair -- BOTH twins (QR-1, asserted so it is visible)', r.status === 200 && r.body.removed === 2 && !(await qids()).includes(E + '-3') && !(await qids()).includes(E + '-4'), r);
      r = await del('OLD', {});
      check('by id only (the oldest apps): {ok: true}, every entry with the id removed, an untagged one included', r.status === 200 && r.body.ok === true && !(await qids()).includes('OLD'), r);
      const d = await h.doc(); d.pending.push({ id: 'B', fills: ['30', '31'], qid: E + '-9' }); await R.call('SET', KEY, JSON.stringify(d));
      r = await del('B', { fills: '3,4' });
      check('by id and pair, with another pair under the same id: that one kept, 409 naming it, as before', r.status === 409 && r.body.removed === 1 && r.body.queuedPairs[0].join() === '30,31' && (await qids()).includes(E + '-9'), r);
    });

    await section('REMOVAL WHEN A SAVE CANNOT GO THROUGH: an answer that says so, nothing removed', async () => {
      await seed();
      shim.hooks.before = async cmd => { if (h.scriptOf(cmd) === 'COMMIT') await h.competitor(d => { d.lastSync = { n: Date.now() }; }); };
      let r = await del('B', { fills: '3,4', qid: E + '-2' });
      shim.hooks = {};
      check('ten refused saves (5.6): 503 {removed: 0, reason: "busy"}, the entry still there', r.status === 503 && r.body.reason === 'busy' && (await qids()).includes(E + '-2'), r);
      await seed();
      let n = 0;
      shim.hooks.after = async cmd => {
        if (h.scriptOf(cmd) === 'COMMIT' && !n++) {
          // The answer is lost AND the record moves on and is pruned: R5.
          for (let i = 0; i < 3; i++) await ts.protect('progress', Q.progressUpdate, { payload: { i }, at: Date.now() + (i + 2) * 3600001 });
          return { drop: true };
        }
      };
      r = await del('B', { fills: '3,4', qid: E + '-2' });
      shim.hooks = {};
      check('a lost answer that cannot be resolved: 503 {reason: "outcome-unknown"} -- the app keeps the entry and asks again', r.status === 503 && r.body.reason === 'outcome-unknown', r);
      const again = await del('B', { fills: '3,4', qid: E + '-2' });
      check('asked again: "not-found" (it HAD been removed); nothing else can be removed by that qid', again.status === 200 && again.body.reason === 'not-found', again);
      ts._resetProcessState();
      r = await del('B', { fills: '3,4' });
      check('before start-up: 503 "not-ready", nothing removed', r.status === 503 && r.body.reason === 'not-ready', r);
      await seed(); await R.call('SET', h.FENCE, '3');
      r = await del('B', { fills: '3,4' });
      check('fenced by a newer generation: 503 "fenced", nothing removed', r.status === 503 && r.body.reason === 'fenced' && (await qids()).includes(E + '-2'), r);
      ts._resetProcessState();
    });

    await section('Q-T22 (a)-(d) ACTIVATION: both lists clean, or refused with the counts', async () => {
      await seed();
      let out = await ts.protect('activate', Q.activateUpdate);
      check('(c) an untagged VISIBLE entry: refused, counts {visible: 1, staged: 0}, removalEnabled stays false', out.status === 'unchanged' && out.result.status === 'refused' && out.result.untagged.visible === 1 && (await h.doc()).removalEnabled === false, out);
      await del('OLD', {});
      const d = await h.doc(); d.pendingStaged = [{ id: 'S', fills: ['9', '10'] }]; await R.call('SET', KEY, JSON.stringify(d));
      out = await ts.protect('activate', Q.activateUpdate);
      check('(b) the visible list clean, ONE untagged STAGED entry: refused (0 visible, 1 staged)', out.result.status === 'refused' && out.result.untagged.staged === 1 && out.result.untagged.visible === 0);
      for (const bad of ['a'.repeat(31) + '-1', 'A'.repeat(32) + '-1', E + '-0']) {
        const d2 = await h.doc(); d2.pendingStaged = [{ id: 'S', qid: bad }]; await R.call('SET', KEY, JSON.stringify(d2));
        check(`(d) a malformed qid in staging (${bad.slice(-5)}): counted as untagged, refused`, (await ts.protect('activate', Q.activateUpdate)).result.status === 'refused');
      }
      const d3 = await h.doc(); d3.pendingStaged = []; await R.call('SET', KEY, JSON.stringify(d3));
      out = await ts.protect('activate', Q.activateUpdate);
      check('(a) both lists clean: committed, removalEnabled true, with its record', out.status === 'committed' && (await h.doc()).removalEnabled === true && (await h.doc()).opRecords[out.record.opId].kind === 'activate', out);
      const pend = await route('get', '/trades/pending');
      check('GET /trades/pending now says removalEnabled: true', pend.body.removalEnabled === true);
      out = await ts.protect('deactivate', Q.deactivateUpdate);
      check('deactivation: committed, removalEnabled false', out.status === 'committed' && (await h.doc()).removalEnabled === false);
    });

    // A test writer, through THE COMMIT, that adds an UNTAGGED entry to staging.
    const addUntagged = () => ts.protect('progress', (doc, fx) => ({ next: { ...doc, pendingStaged: [...doc.pendingStaged, { id: 'U', fills: ['1', '1'] }] }, result: { fields: ['pendingStaged'] } }));
    await section('Q-T22 (e) THE RACE, both orders: never removalEnabled true with an untagged entry', async () => {
      await seed(); await del('OLD', {});
      let raced = false;
      shim.hooks.before = async cmd => { if (!raced && h.scriptOf(cmd) === 'COMMIT') { raced = true; shim.hooks = {}; await addUntagged(); } };
      const out = await ts.protect('activate', Q.activateUpdate);
      const d = await h.doc();
      check('an untagged entry lands between activation\'s read and its commit: activation gets CONFLICT, re-runs on the newer record, and is REFUSED',
        raced && out.status === 'unchanged' && out.result.status === 'refused' && out.runs === 2 && d.removalEnabled === false && d.pendingStaged.length === 1, out);
      await seed(); await del('OLD', {});
      const a = await ts.protect('activate', Q.activateUpdate);
      const w = await addUntagged();
      const d2 = await h.doc();
      check('the reverse: activation commits first, then the writer adding an untagged entry is REFUSED "untagged-entry"', a.status === 'committed' && w.status === 'untagged-entry' && d2.removalEnabled === true && d2.pendingStaged.length === 0, w);
    });

    await section('Q-T22 (f) AFTER ACTIVATION: tagged entries flow, removable by exact qid; no untagged entry can reach the queue', async () => {
      await seed(); await del('OLD', {});
      await ts.protect('activate', Q.activateUpdate);
      const cron = require(path.join(h.BACKEND, 'cron.js'));
      const OCC = 'SPY   261231C00600000';
      const f = (id, kind, m) => { const t = Date.parse('2026-10-20T14:00:00Z') + m * 60000; const dd = new Date(t); return { transactionId: id, accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL', instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66, date: dd.toISOString().slice(0, 10), time: dd.toISOString().slice(11, 16), timestamp: t }; };
      const st = await ts.protect('staging', cron.stagingUpdate([f('71001', 'open', 0), f('71002', 'close', 5)]));
      const staged = st.out.staged[0];
      const pub = await ts.protect('publication', Q.publicationUpdate, { payload: { prev: { qid: staged.qid, decided: 'result', trade: staged }, qids: [staged.qid] } });
      const r = await del(staged.id, { fills: staged.fills.join(','), qid: staged.qid });
      check('a staged item stages WITH a qid, publishes under it, and is removed by that exact qid', st.status === 'committed' && Q.isQid(staged.qid) && pub.status === 'committed' && r.body.reason === 'removed');
      const land = await ts.protect('sync-landing', cron.syncLandingUpdate({ fills: [f('72001', 'open', 0), f('72002', 'close', 5)], report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: new Date().toISOString() }));
      check('the live sync still lands, tagged', land.status === 'committed' && Q.isQid(land.out.landed[0].qid));
      for (const [label, fn] of [
        ['a writer adding an untagged VISIBLE entry', (doc) => ({ next: { ...doc, pending: [{ id: 'U' }, ...doc.pending] }, result: { fields: ['pending'] } })],
        ['a writer adding an untagged STAGED entry', (doc) => ({ next: { ...doc, pendingStaged: [{ id: 'U' }] }, result: { fields: ['pendingStaged'] } })],
        ['a writer adding an entry with a MALFORMED qid', (doc) => ({ next: { ...doc, pending: [{ id: 'U', qid: 'nope' }, ...doc.pending] }, result: { fields: ['pending'] } })],
      ]) {
        const before = await h.text();
        const out = await ts.protect('progress', fn);
        check(`${label}: refused "untagged-entry", nothing written`, out.status === 'untagged-entry' && (await h.text()) === before, out.status);
      }
    });

    await section('Q-T22 (g) AN ACTIVATION WHOSE ANSWER IS LOST: the true state, never activated twice', async () => {
      await seed(); await del('OLD', {});
      let n = 0; shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !n++ ? { drop: true } : undefined);
      const out = await ts.protect('activate', Q.activateUpdate);
      shim.hooks = {};
      const d = await h.doc();
      const recs = Object.values(d.opRecords).filter(r => r.kind === 'activate');
      check('landed, answer lost: "recovered" with its stored result; removalEnabled true; ONE activation record', out.status === 'recovered' && d.removalEnabled === true && recs.length === 1, out);
      await seed(); await del('OLD', {});
      let m = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !m++ ? { drop: true } : undefined);
      const out2 = await ts.protect('activate', Q.activateUpdate);
      shim.hooks = {};
      check('not landed, answer lost: R1, committed once', out2.status === 'committed' && Object.values((await h.doc()).opRecords).filter(r => r.kind === 'activate').length === 1);
    });
  } catch (e) {
    fail++; console.log('FAIL: TEST CRASHED', e && e.stack || e);
  } finally {
    const stopped = await h.tearDown();
    check('the local Redis was stopped by SHUTDOWN NOSAVE and its folder removed', stopped.exited && stopped.folderGone, stopped);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
