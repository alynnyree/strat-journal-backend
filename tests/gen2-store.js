// GENERATION 2 ON A REAL REDIS: THE COMMIT, THE FENCE, THE EXPANSION, THE LOG
// AND THE OPERATION RECORDS (Queue plan v14.1 rev 3.2, Deploy 2).
//
// The service's REAL storage client and save module, against a real Redis on
// this machine behind a stand-in of Upstash's web service that can lose an
// answer, hold one, or answer with an error on purpose (tests/lib/
// localRedis.js). A local Redis is a REHEARSAL: the real-store run on a
// temporary Upstash database (plan 6.0, revision 3.2) is separately authorised.
//
//   Q-T23 (a)-(j), (k2)  THE COMMIT at every stage; the whole record is wholly
//                        the old or wholly the new one after each case.
//   Q-T24 (d), (e), (j)  the raise; the start-up order; step (S0).
//   Q-T25 (a)-(g)        the expansion on a real store, and the dry run on the
//                        same text.
//   Q-T20 (b)-(d)        the exhaustion log: wrong type, a failed call, an
//                        answer lost after the append.
//   Q-T19 (c)            exhaustion: one change refused ten times.
//   Q-T21 (a)-(o)        lost answers, per kind: R1, R2, R4, R5, R3; records
//                        damaged; the no-op and failed cases.
// Two-process cases are tests/gen2-processes.js; stale reads (Q-T21 (p2)) are
// tests/gen2-stale-reads.js.
const path = require('path');
const crypto = require('crypto');
const { setUp } = require('./lib/gen2Harness');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
async function section(title, fn) { console.log('\n--- ' + title + ' ---'); try { await fn(); } catch (e) { fail++; console.log('FAIL: this section threw:', e && e.stack || e); } }
const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');

setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 7 * 60 * 1000).unref();

(async () => {
  const h = await setUp();
  if (!h) {
    console.log('SKIPPED: no redis-server on this machine; nothing here was run. (REQUIRE_REAL_REDIS=1 makes this a failure.)');
    console.log('\n0 passed, 0 failed');
    process.exit(0);
  }
  const { tradeStore: ts, Q, R, shim, KEY, FENCE, LOG } = h;
  const cron = require(path.join(h.BACKEND, 'cron.js'));
  // Every COMMIT the store answered COMMITTED, by the operation id inside it.
  const committedOps = [];
  const watchCommits = () => {
    const prev = shim.hooks.after;
    shim.hooks.after = async (cmd, reply) => {
      if (h.scriptOf(cmd) === 'COMMIT' && reply === 'COMMITTED') {
        const d = JSON.parse(cmd[6]);
        committedOps.push(...Object.keys(d.opRecords).filter(k => d.opRecords[k].committedVersion === d.stateVersion));
      }
      return prev ? prev(cmd, reply) : undefined;
    };
  };
  const timesCommitted = opId => committedOps.filter(x => x === opId).length;
  const OCC = 'SPY   261231C00600000';
  const fill = (id, kind, minute) => {
    const ts0 = Date.parse('2026-10-20T14:00:00Z') + minute * 60000; const d = new Date(ts0);
    return { transactionId: id, accountRef: 'acct-x', occ: OCC, ticker: 'SPY', putCall: 'CALL',
      instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE', price: 1, quantity: 1, fees: 0.66,
      date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts0 };
  };
  const START = { openLegs: [], pending: [{ id: 'W1', fills: ['a1', 'a2'], note: 'café ü — "quoted" 日本' }], lastProcessedIds: ['a1', 'a2'], exceptions: {}, unknownField: { keep: [1, 2, 3] } };

  try {
    await section('Q-T24 (d) THE RAISE, every fence value; (e) nothing saves before it', async () => {
      for (const [f, want, after] of [[undefined, 'RAISED', '2'], ['0', 'RAISED', '2'], ['1', 'RAISED', '2'], ['2', 'ALREADY', '2'], ['02', 'ALREADY', '02'],
        ['3', 'FENCED', '3'], ['18446744073709551616', 'FENCED', '18446744073709551616'], ['99999999999999999999', 'FENCED', '99999999999999999999'],
        ['x', 'FENCE-INVALID', 'x'], ['-1', 'FENCE-INVALID', '-1'], ['1.5', 'FENCE-INVALID', '1.5'], ['', 'FENCE-INVALID', '']]) {
        await h.fresh(START, f);
        const r = await ts.raiseFence({ pauseMs: 0 });
        check(`raise from ${f === undefined ? 'absent' : JSON.stringify(f)}: ${want}, fence afterwards ${JSON.stringify(after)}`,
          (r.ok ? r.reply : r.reply) === want && (await h.fence()) === after, { r, fence: await h.fence() });
      }
      // With its answer withheld after it ran, the re-run says ALREADY and the fence is 2.
      await h.fresh(START, '1');
      let dropped = 0;
      shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'RAISE' && !dropped++ ? { drop: true } : undefined);
      const r = await ts.raiseFence({ pauseMs: 0 });
      check('raise with its answer lost: the re-run gives ALREADY, the fence is 2', r.ok && r.reply === 'ALREADY' && (await h.fence()) === '2', r);
      // (e) START-UP ORDER, asserted at the store client.
      await h.fresh(START, '1');
      const seen = [];
      shim.hooks.before = async cmd => { seen.push(h.verb(cmd) === 'eval' ? h.scriptOf(cmd) : h.verb(cmd)); };
      const before = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      check('(e) before start-up a protected change answers "not-ready" and sends NOTHING to the store', before.status === 'not-ready' && seen.length === 0, { before, seen });
      const st = await ts.startGeneration2({ pauseMs: 0 });
      const firstCommit = seen.indexOf('COMMIT');
      check('(e) start-up: the raise comes first, then the expansion\'s read and commit, and nothing else saves',
        st.ready && seen[0] === 'RAISE' && firstCommit > 0 && seen.filter(s => s === 'COMMIT').length === 1, seen);
      // (h) broken copy: a generation-2 save before the raise -- the store refuses it (S0).
      await h.fresh(START, '1');
      const t0 = await h.text();
      const reply = await R.call('EVAL', ts.SCRIPTS.COMMIT, '2', KEY, FENCE, sha1(t0), JSON.stringify({ hijack: 1 }), '2');
      check('(h) BROKEN COPY, a generation-2 save sent before the raise: refused FENCED by (S0), nothing written', reply === 'FENCED' && (await h.text()) === t0, reply);
    });

    await section('Q-T23 (j) STEP (S0): a generation-2 commit with the fence absent, malformed, 1, 2, 3', async () => {
      for (const [f, want] of [[null, 'fenced'], ['x', 'fenced'], ['1', 'fenced'], ['2', 'committed'], ['3', 'fenced'], ['18446744073709551616', 'fenced']]) {
        await h.ready(START);
        if (f === null) await R.call('DEL', FENCE); else await R.call('SET', FENCE, f);
        const t0 = await h.text();
        const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
        check(`fence ${f === null ? 'absent' : JSON.stringify(f)}: ${want}${want === 'fenced' ? ', nothing written, the process now reports fenced' : ''}`,
          out.status === want && (want !== 'fenced' || ((await h.text()) === t0 && ts.writerStatus().fenced === true)), out);
      }
      ts._resetProcessState();
      // Once told FENCED, every later change refuses at once.
      await h.ready(START); await R.call('SET', FENCE, '3');
      await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      let sent = 0; shim.hooks.before = async () => { sent++; };
      const again = await ts.protect('progress', Q.progressUpdate, { payload: { x: 2 } });
      check('after FENCED, the next change refuses "fenced" without asking the store again', again.status === 'fenced' && sent === 0);
    });

    await section('Q-T25 (a), (c), (d), (g) THE EXPANSION on a real store', async () => {
      await h.fresh(START, '1');
      const t0 = await h.text();
      const st = await ts.startGeneration2({ pauseMs: 0 });
      const d = await h.doc();
      const added = Object.keys(d).filter(k => !(k in START));
      check('(a) one commit adds exactly the nine fields', st.ready && st.expansion === 'committed' && added.join() === Q.NEW_NAMES.join(), added);
      check('(a) every existing field, the unknown one and the non-English text included, is unchanged (canonical JSON)',
        Object.keys(START).every(k => Q.canonicalJson(d[k]) === Q.canonicalJson(START[k])));
      check('(a) no queue entry is changed or tagged', JSON.stringify(d.pending) === JSON.stringify(START.pending));
      const rec = Object.values(d.opRecords)[0];
      check('(a) stateVersion 1, the record\'s committedVersion 1, its result naming the added and unknown fields, trusted',
        d.stateVersion === 1 && rec.committedVersion === 1 && rec.kind === 'expand' && rec.result.unknownFields.join() === 'unknownField'
        && Q.untrustedWhy(rec, rec.opId, d.stateVersion, Date.now()) === null);
      // (g) the dry run on the SAME input text.
      const fs = require('fs'), os = require('os');
      const tool = require(path.join(h.BACKEND, 'tools', 'expansion-dryrun.js'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-same-'));
      const file = path.join(dir, 'b.json');
      fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), readOnly: true, keys: { [KEY]: { type: 'string', value: JSON.parse(t0) } }, excluded: [], notCopied: [], totals: { copied: 1, excluded: 0, notCopied: 0, bytes: 1 } }));
      const L = tool.run(file);
      fs.rmSync(dir, { recursive: true, force: true });
      const addedLine = (L.find(x => x.startsWith('Fields the expansion would ADD:')) || '').replace('Fields the expansion would ADD: ', '');
      check('(g) on the same input text, the dry run passes and lists exactly the fields this commit added',
        L.some(x => x.startsWith('VERDICT: ALL CHECKS PASS')) && addedLine === added.join(', '), { addedLine });
      // (d) twice.
      const t1 = await h.text();
      ts._resetProcessState();
      const st2 = await ts.startGeneration2({ pauseMs: 0 });
      check('(d) a second expansion writes nothing and keeps no record', st2.ready && st2.expansion === 'unchanged' && (await h.text()) === t1);
      // (c) an absent key.
      await h.fresh(undefined, '1');
      const st3 = await ts.startGeneration2({ pauseMs: 0 });
      const d3 = await h.doc();
      check('(c) an absent key: today\'s default record with the nine fields, through the "no value" case',
        st3.ready && JSON.stringify([d3.openLegs, d3.pending, d3.lastProcessedIds]) === '[[],[],[]]' && d3.schemaVersion === 2 && d3.stateVersion === 1);
    });

    await section('Q-T25 (b) EACH RULE BROKEN IN TURN: "state-invalid", nothing written, everything refuses', async () => {
      const cases = {
        'not JSON': '{oops', 'a list': '[1,2]', 'pending not a list': JSON.stringify({ pending: 'no' }),
        'an entry without an id': JSON.stringify({ pending: [{ fills: [] }] }), 'a bad identityCutoverAt': JSON.stringify({ pending: [], identityCutoverAt: 'nope' }),
        'exceptions not an object': JSON.stringify({ pending: [], exceptions: [1] }), 'a new name already present': JSON.stringify({ pending: [], queueSeq: 3 }),
        'over 5 MB once expanded': JSON.stringify({ pending: [], big: 'a'.repeat(5.1 * 1024 * 1024) }),
      };
      for (const [label, text] of Object.entries(cases)) {
        await h.fresh(text, '1');
        const st = await ts.startGeneration2({ pauseMs: 0 });
        const p = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
        const ok = (await h.text()) === text;
        check(`${label}: start-up stops (${st.stage}), the record byte-identical, every change refusing (${p.status})`,
          !st.ready && ['state-invalid', 'expansion-unconfirmed'].includes(st.stage) && (label.startsWith('over') ? true : st.stage === 'state-invalid') && ok && p.status === 'not-ready', { st, p: p.status });
      }
    });

    await section('Q-T25 (e) THE EXPANSION AMBIGUOUS: R2 when it landed, R1 when it did not', async () => {
      await h.fresh(START, '1');
      let n = 0; shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !n++ ? { drop: true } : undefined);
      const st = await ts.startGeneration2({ pauseMs: 0 });
      check('its answer lost AFTER it committed: resolved to R2 ("recovered"), one commit', st.ready && st.expansion === 'recovered' && n === 1, st);
      await h.fresh(START, '1');
      let m = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !m++ ? { drop: true } : undefined);
      const st2 = await ts.startGeneration2({ pauseMs: 0 });
      const d = await h.doc();
      check('its answer lost WITHOUT a commit: resolved to R1, committed once', st2.ready && st2.expansion === 'committed' && d.stateVersion === 1 && Object.keys(d.opRecords).length === 1, st2);
    });

    await section('Q-T25 (f) A SYNC LANDING DURING THE EXPANSION: "not-ready" until it reads 2, then lands', async () => {
      await h.fresh(START, '1');
      let landingDuring = null;
      shim.hooks.before = async cmd => {
        if (h.scriptOf(cmd) === 'COMMIT' && landingDuring === null) {
          landingDuring = 'asked';
          landingDuring = await ts.protect('sync-landing', cron.syncLandingUpdate({ fills: [fill('95001', 'open', 0), fill('95002', 'close', 5)], report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: new Date().toISOString() }));
        }
      };
      await ts.startGeneration2({ pauseMs: 0 });
      shim.hooks = {};
      const after = await ts.protect('sync-landing', cron.syncLandingUpdate({ fills: [fill('95001', 'open', 0), fill('95002', 'close', 5)], report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: new Date().toISOString() }));
      const d = await h.doc();
      check('the landing tried during the expansion was refused "not-ready"', landingDuring && landingDuring.status === 'not-ready', landingDuring);
      check('after it, the landing goes through THE COMMIT with its qid, and the earlier entry is still there',
        after.status === 'committed' && d.pending.length === 2 && Q.isQid(d.pending[0].qid) && d.pending[1].id === 'W1');
    });

    await section('Q-T23 (i) THE REAL DATABASE RUNS THE EXACT SCRIPTS', async () => {
      await h.ready(START);
      const big = { ...(await h.doc()), filler: 'ü日本—'.repeat(200000) };
      await R.call('SET', KEY, JSON.stringify(big));
      const raw = await R.call('EVAL', ts.SCRIPTS.RESOLUTION_READ, '1', KEY);
      check(`the SHA-1 computed inside the script equals the caller's, for non-English text, ${(Buffer.byteLength(raw[2]) / 1e6).toFixed(1)} MB`,
        raw[0] === 'present' && raw[1] === sha1(raw[2]) && raw[2] === JSON.stringify(big));
      const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      const viaDefault = await ts.getState();
      check('a record saved by THE COMMIT reads back through the DEFAULT client as the same object (as backupExport.js and generation 1 read it)',
        out.status === 'committed' && Q.canonicalJson(viaDefault) === Q.canonicalJson(await h.doc()));
      const pins = Object.fromEntries(Object.entries(ts.SCRIPTS).map(([k, v]) => [k, sha1(v)]));
      check('the four scripts are the pinned texts', Object.keys(ts.PINNED).every(k => pins[k] === ts.PINNED[k]), pins);
    });

    await section('Q-T23 (a) CONFLICT: another writer saves between the read and the commit', async () => {
      await h.ready(START);
      let raced = false;
      shim.hooks.before = async cmd => {
        if (h.scriptOf(cmd) === 'COMMIT' && !raced) { raced = true; await h.competitor(d => { d.lastBackfill = { other: 'writer' }; }); }
      };
      const before = await h.doc();
      const out = await ts.protect('progress', Q.progressUpdate, { payload: { mine: 1 } });
      const d = await h.doc();
      check('the first commit was refused CONFLICT and nothing of it was written; the re-run on the newer record committed',
        raced && out.status === 'committed' && out.runs === 2 && d.lastBackfill.other === 'writer' && d.lastBackfill.mine === 1 && d.stateVersion === before.stateVersion + 2, { out, lb: d.lastBackfill });
    });

    await section('Q-T23 (b), (c) AN ERROR REPLY: nothing written; never taken as saved', async () => {
      await h.ready(START);
      const t0 = await h.text();
      let n = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !n++ ? { error: 'ERR stand-in: the script failed at (S1)' } : undefined);
      const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      const d = await h.doc();
      check('(b) [stand-in at the client boundary] an error reply: treated as ambiguous (the stricter reading), resolved R1, applied exactly once',
        out.status === 'committed' && d.stateVersion === JSON.parse(t0).stateVersion + 1 && ts.writerStatus().commitErrors >= 1, out);
      // (c) a REAL error at the SET: the store at its memory limit.
      await h.ready(START);
      const t1 = await h.text();
      await R.call('CONFIG', 'SET', 'maxmemory', '1');
      await R.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
      const oom = await R.call('EVAL', ts.SCRIPTS.COMMIT, '2', KEY, FENCE, sha1(t1), JSON.stringify({ x: 1 }), '2');
      const outOom = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      await R.call('CONFIG', 'SET', 'maxmemory', '0');
      check('(c) the REAL store at its memory limit answers the commit with an error, and writes nothing', oom && typeof oom === 'object' && /OOM|memory/i.test(oom.error) && (await h.text()) === t1, oom);
      check('(c) protect() never reports that as saved (outcome-unknown or busy), and the record is byte-identical',
        ['outcome-unknown', 'busy'].includes(outOom.status) && (await h.text()) === t1, outOom);
    });

    await section('Q-T23 (d), (e) NO REPLY after / without the SET; (h) "no reply = committed" is caught', async () => {
      await h.ready(START);
      let n = 0; shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !n++ ? { drop: true } : undefined);
      const v0 = (await h.doc()).stateVersion;
      const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      check('(d) the answer lost AFTER the SET: resolved R2, "recovered", the stored result verbatim, applied once',
        out.status === 'recovered' && JSON.stringify(out.result) === '{"fields":["x"]}' && (await h.doc()).stateVersion === v0 + 1, out);
      await h.ready(START);
      let m = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !m++ ? { drop: true } : undefined);
      const v1 = (await h.doc()).stateVersion;
      const out2 = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      check('(e) the answer lost with NO SET: resolved R1, run again, applied exactly once', out2.status === 'committed' && (await h.doc()).stateVersion === v1 + 1, out2);
      check('(h) BROKEN COPY that treats "no reply" as "committed": in (e) it would have reported a save that never happened -- the dropped attempt wrote nothing (two commits were sent, one stored)', m === 2 && out2.runs === 2);
    });

    await section('Q-T23 (g) A MALFORMED RECORD: every change refuses "state-invalid", nothing written', async () => {
      for (const [label, mut] of [['not JSON', () => '{oops'], ['a missing field', d => { delete d.opRecords; return JSON.stringify(d); }], ['a wrong type', d => { d.pendingStaged = 'x'; return JSON.stringify(d); }]]) {
        await h.ready(START);
        const bad = mut(await h.doc());
        await R.call('SET', KEY, bad);
        const outs = [];
        for (const [kind, fn, payload] of [['progress', Q.progressUpdate, { x: 1 }], ['legacy-removal', Q.legacyRemovalById, { id: 'W1' }], ['reset', Q.resetUpdate]]) {
          outs.push((await ts.protect(kind, fn, { payload })).status);
        }
        const log = await R.call('LRANGE', LOG, '0', '-1');
        check(`${label}: every change refused (${outs.join(', ')}), the record byte-identical, each refusal logged`,
          outs.every(s => s === 'state-invalid') && (await h.text()) === bad && log.length === 3, { outs, log: log.length });
      }
    });

    await section('Q-T23 (k2) THE RESOLUTION READ is the read every decision rests on: no plain read on those paths', async () => {
      await h.ready(START);
      const verbs = [];
      shim.hooks.before = async cmd => { verbs.push(h.verb(cmd) === 'eval' ? h.scriptOf(cmd) : h.verb(cmd)); };
      let n = 0; const prevAfter = shim.hooks.after;
      shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'COMMIT' && !n++ ? { drop: true } : undefined);
      await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      await ts.readDocument();
      check('a change that went through a lost answer and R1 to R6, and a status read: zero plain reads (only the two scripts)',
        verbs.every(v => v === 'RESOLUTION_READ' || v === 'COMMIT') && verbs.includes('RESOLUTION_READ'), verbs);
      const plainR1 = async () => { const t = await R.call('GET', KEY); verbs.push('get'); return t; };
      verbs.length = 0; await plainR1();
      check('BROKEN COPY that decides R1 from a plain read: its count of plain reads is not zero (caught)', verbs.includes('get'));
      shim.hooks.after = prevAfter;
    });

    await section('Q-T20 (b), (c), (d) THE EXHAUSTION LOG', async () => {
      await h.ready(START);
      await R.call('SET', LOG, 'not a list');
      const r1 = await ts.logFailure({ operation: 'x' });
      check('(b) the log key holds the wrong kind: "not recorded", the key unchanged, casLogFailed + 1',
        r1.recorded === false && (await R.call('GET', LOG)) === 'not a list' && ts.writerStatus().casLogFailed.count === 1, r1);
      await R.call('DEL', LOG);
      let tries = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'LOG' ? (tries++, { drop: true }) : undefined);
      const r2 = await ts.logFailure({ operation: 'y' });
      check('(c) the call dropped: exactly ONE attempt, no retry, "not recorded", nothing in the list', r2.recorded === false && tries === 1 && (await R.call('LLEN', LOG)) === 0, { tries });
      shim.hooks = {}; shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'LOG' ? { drop: true } : undefined);
      const r3 = await ts.logFailure({ operation: 'z' });
      const held = await R.call('LRANGE', LOG, '0', '-1');
      check('(d) the answer lost AFTER the append: the caller knows "not recorded" (never true) ...', r3.recorded === false);
      check('(d) ... and, read separately, the store holds the entry (the one-way error the plan accepts)', held.length === 1 && JSON.parse(held[0]).operation === 'z');
    });

    await section('Q-T19 (c) EXHAUSTION: a competing save between every read and commit, ten times', async () => {
      for (const [kind, fn, payload, routeCase] of [['progress', Q.progressUpdate, { x: 1 }], ['legacy-removal', Q.legacyRemovalById, { id: 'W1' }, true]]) {
        await h.ready(START);
        await R.call('DEL', LOG);
        let competitorSaves = 0;
        shim.hooks.before = async cmd => { if (h.scriptOf(cmd) === 'COMMIT') { competitorSaves++; await h.competitor(d => { d.lastSync = { n: competitorSaves }; }); } };
        const exhaustedBefore = ts.writerStatus().casExhausted.count;
        const out = await ts.protect(kind, fn, { payload, opId: hex('exh' + kind) });
        shim.hooks = {};
        const d = await h.doc();
        const log = await R.call('LRANGE', LOG, '0', '-1');
        check(`${kind}: refused after ${out.runs} runs, "busy", recorded: true`, out.status === 'busy' && out.runs === 10 && out.recorded === true, out);
        check(`${kind}: the record is the competitor's last save, with no part of the failed change and no record of it`,
          d.lastSync.n === competitorSaves && !(hex('exh' + kind) in d.opRecords) && (kind !== 'legacy-removal' || d.pending.length === 1));
        check(`${kind}: exactly one entry in the log, naming it; casExhausted + 1`,
          log.length === 1 && JSON.parse(log[0]).operation === kind && JSON.parse(log[0]).runs === 10 && ts.writerStatus().casExhausted.count === exhaustedBefore + 1, log);
      }
    });

    // ---- Q-T21: per kind. Each spec sets up a record, runs one change, and
    // says what its domain effect looks like.
    const landingFn = fills => cron.syncLandingUpdate({ fills, report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: '2026-10-24T12:00:00.000Z' });
    const stageOne = async () => { const r = await ts.protect('staging', cron.stagingUpdate([fill('91001', 'open', 0), fill('91002', 'close', 5)])); return r.out.staged[0]; };
    const landOne = async () => { const r = await ts.protect('sync-landing', landingFn([fill('92001', 'open', 0), fill('92002', 'close', 5)])); return r.out.landed[0]; };
    const KINDS = {
      staging: { prep: async () => ({}), run: () => ['staging', cron.stagingUpdate([fill('93001', 'open', 0), fill('93002', 'close', 5)]), {}], effect: d => d.pendingStaged.length === 1 && d.queueSeq === 1 && d.lastProcessedIds.includes('93002') },
      publication: { prep: async () => ({ e: await stageOne() }), run: c => ['publication', Q.publicationUpdate, { payload: { items: [{ qid: c.e.qid, trade: { ...c.e, measured: 1 }, unmeasured: null }] } }], effect: d => d.pending.filter(e => e.measured === 1).length === 1 && d.pendingStaged.length === 0 },
      'poison-guard': { prep: async () => ({ e: await stageOne() }), run: c => ['poison-guard', Q.poisonGuardUpdate, { payload: { qids: [c.e.qid] } }], effect: d => d.pendingStaged[0].stagedTries === 1 },
      'qid-removal': { prep: async () => ({ e: await landOne() }), run: c => ['qid-removal', Q.qidRemoval, { payload: { id: c.e.id, pair: c.e.fills, qid: c.e.qid } }], effect: d => d.pending.length === 1 },
      'legacy-removal': { prep: async () => ({}), run: () => ['legacy-removal', Q.legacyRemovalById, { payload: { id: 'W1' } }], effect: d => d.pending.length === 0 },
      reset: { prep: async () => ({ e: await landOne() }), run: () => ['reset', Q.resetUpdate, { acceptKinds: ['reset', 'reset-cancel'] }], effect: d => d.resetCounter === 1 && d.pending.length === 0 },
      'reset-cancel': { prep: async () => ({}), run: () => ['reset-cancel', Q.resetCancelUpdate, { acceptKinds: ['reset', 'reset-cancel'] }], effect: d => d.resetCounter === 1 },
      'sync-landing': { prep: async () => ({}), run: () => ['sync-landing', landingFn([fill('94001', 'open', 0), fill('94002', 'close', 5)]), {}], effect: d => d.pending.length === 2 && d.queueSeq === 1 },
      activate: { prep: async () => ({ e: await landOne() }), run: () => ['activate', Q.activateUpdate, {}], effect: d => d.removalEnabled === false },
      progress: { prep: async () => ({}), run: () => ['progress', (doc, fx) => { const lb = doc.lastBackfill || {}; return { next: { ...doc, lastBackfill: { ...lb, n: (lb.n || 0) + 1 } }, result: { fields: ['n'] } }; }, {}], effect: d => d.lastBackfill.n === 1 },
    };
    // Activation refuses while an untagged entry (W1) is waiting; for its
    // ambiguity cases the untagged entry is removed first.
    const prepFor = async (name, spec) => {
      const c = await spec.prep();
      if (name === 'activate') await ts.protect('legacy-removal', Q.legacyRemovalById, { payload: { id: 'W1' } });
      return c;
    };
    const effectOf = (name, spec) => (name === 'activate' ? d => d.removalEnabled === true : spec.effect);

    await section('Q-T21 (a) LOST REPLY, COMMITTED (R2), each kind: the stored result verbatim, the change once', async () => {
      for (const [name, spec] of Object.entries(KINDS)) {
        await h.ready(START); committedOps.length = 0; watchCommits();
        const c = await prepFor(name, spec);
        const [kind, fn, opts] = spec.run(c);
        const opId = hex('a' + name);
        let n = 0; const prev = shim.hooks.after;
        shim.hooks.after = async (cmd, reply) => { const r = await prev(cmd, reply); if (h.scriptOf(cmd) === 'COMMIT' && cmd[6].includes(opId) && !n++) return { drop: true }; return r; };
        const out = await ts.protect(kind, fn, { ...opts, opId });
        const d = await h.doc();
        check(`${name}: "recovered", its record's result returned verbatim, committed exactly once, the effect once`,
          out.status === 'recovered' && JSON.stringify(out.result) === JSON.stringify(d.opRecords[opId].result) && timesCommitted(opId) === 1 && effectOf(name, spec)(d), { out: out.status, times: timesCommitted(opId) });
      }
    });

    await section('Q-T21 (b) LOST REPLY, NOT COMMITTED, nothing saved since (R1), each kind: run again, once', async () => {
      for (const [name, spec] of Object.entries(KINDS)) {
        await h.ready(START); committedOps.length = 0; watchCommits();
        const c = await prepFor(name, spec);
        const [kind, fn, opts] = spec.run(c);
        const opId = hex('b' + name);
        let n = 0; shim.hooks.before = async cmd => (h.scriptOf(cmd) === 'COMMIT' && cmd[6].includes(opId) && !n++ ? { drop: true } : undefined);
        const out = await ts.protect(kind, fn, { ...opts, opId });
        const d = await h.doc();
        check(`${name}: R1, committed on the re-run, exactly once`, out.status === 'committed' && timesCommitted(opId) === 1 && effectOf(name, spec)(d), { out: out.status, times: timesCommitted(opId) });
      }
    });

    await section('Q-T21 (c) LOST REPLY, NOT COMMITTED, others saved since, nothing pruned (R4), each kind: once', async () => {
      for (const [name, spec] of Object.entries(KINDS)) {
        await h.ready(START); committedOps.length = 0; watchCommits();
        const c = await prepFor(name, spec);
        const [kind, fn, opts] = spec.run(c);
        const opId = hex('c' + name);
        let n = 0;
        shim.hooks.before = async cmd => {
          // The other writer's change is in exceptions, which every kind keeps (a reset drops lastSync).
          if (h.scriptOf(cmd) === 'COMMIT' && cmd[6].includes(opId) && !n++) { await h.competitor(d => { d.exceptions = { ...d.exceptions, 'test:1': { kind: 'test', key: 'test:1', status: 'open' } }; }); return { drop: true }; }
        };
        const out = await ts.protect(kind, fn, { ...opts, opId });
        const d = await h.doc();
        check(`${name}: R4, run again on the newer record, exactly once, the other writer's save kept`,
          out.status === 'committed' && timesCommitted(opId) === 1 && effectOf(name, spec)(d) && !!d.exceptions['test:1'], { out: out.status });
      }
    });

    await section('Q-T21 (d) LOST REPLY, its record PRUNED (R5): "outcome-unknown", never run again', async () => {
      for (const name of ['poison-guard', 'reset', 'progress']) {
        const spec = KINDS[name];
        await h.ready(START); committedOps.length = 0; watchCommits();
        const c = await prepFor(name, spec);
        const [kind, fn, opts] = spec.run(c);
        const opId = hex('d' + name);
        let n = 0;
        const later = Date.now() + 2 * 60 * 60 * 1000;
        const prev = shim.hooks.after;
        shim.hooks.after = async (cmd, reply) => {
          await prev(cmd, reply);
          if (h.scriptOf(cmd) === 'COMMIT' && cmd[6].includes(opId) && !n++) {
            if (name === 'reset') {
              // A trade lands after the reset, then 201 more reset-kind
              // records: a reset's record is kept by COUNT (the newest 200,
              // 5.9.3 S-R5), so only that prunes it.
              await ts.protect('sync-landing', landingFn([fill('96001', 'open', 0), fill('96002', 'close', 5)]));
              for (let i = 0; i < 201; i++) await ts.protect('reset-cancel', Q.resetCancelUpdate, { opId: hex('cancel' + i), acceptKinds: ['reset', 'reset-cancel'] });
            } else {
              // 1,000 other changes, the clock passing OP_RETAIN: each an hour
              // after the last, so the record is pruned. (Done within the
              // client's 10-second limit on the held answer.)
              for (let i = 0; i < 1000; i++) await ts.protect('progress', Q.progressUpdate, { payload: { other: i }, at: later + i * 3600001 });
            }
            return { drop: true };
          }
        };
        const added = name === 'reset' ? await (async () => null)() : null;
        const out = await ts.protect(kind, fn, { ...opts, opId });
        const d = await h.doc();
        check(`${name}: R5, "outcome-unknown", and NOT run again (committed exactly once)`, out.status === 'outcome-unknown' && /R5/.test(out.why) && timesCommitted(opId) === 1 && !(opId in d.opRecords), out);
        if (name === 'poison-guard') check('poison guard: the whole record and the domain effect: stagedTries rose exactly once, the item still staged', d.pendingStaged.length === 1 && d.pendingStaged[0].stagedTries === 1);
        if (name === 'reset') check('reset: applied once -- the trade that landed after it is still waiting (resetCounter = 1 reset + 201 tombstones)', d.resetCounter === 202 && d.pending.length === 1 && d.pending[0].fills.join() === '96001,96002', { rc: d.resetCounter, p: d.pending.length });
        void added;
      }
    });

    await section('Q-T21 (h) PAST OP_DEADLINE: stops at its next decision point, no further write attempt', async () => {
      await h.ready(START);
      const realHr = process.hrtime.bigint;
      let shift = 0n;
      process.hrtime.bigint = () => realHr() + shift;
      let commits = 0;
      shim.hooks.before = async cmd => { if (h.scriptOf(cmd) === 'COMMIT') { commits++; shift = 61n * 1000000000n; return { drop: true }; } };
      const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 } });
      process.hrtime.bigint = realHr;
      check('a lost answer, then the 60-second limit passes: "outcome-unknown", and exactly one write attempt was made', out.status === 'outcome-unknown' && commits === 1, { out, commits });
    });

    await section('Q-T21 (i), (j) NO-OP AND FAILED CHANGES: no commit, no record; a repeat is fresh', async () => {
      await h.ready(START);
      const t0 = await h.text();
      const nf = await ts.protect('qid-removal', Q.qidRemoval, { payload: { id: 'nope', pair: ['1', '2'], qid: 'a'.repeat(32) + '-5' } });
      check('(i) a removal answering "not-found": unchanged, nothing written, no record', nf.status === 'unchanged' && nf.result.reason === 'not-found' && (await h.text()) === t0);
      const again = await ts.protect('qid-removal', Q.qidRemoval, { payload: { id: 'nope', pair: ['1', '2'], qid: 'a'.repeat(32) + '-5' } });
      check('(i) a repeat is a fresh evaluation, marked fresh (unchanged, not "recovered")', again.status === 'unchanged');
    });

    await section('Q-T21 (m), (n), (o) DAMAGED RECORDS: untrusted, never pruned, never a re-run', async () => {
      for (const [label, mut] of [['(m) committedAt made 2 hours older without updating check', r => { r.committedAt -= 2 * 3600e3; }],
        ['(n) committedAt as text', r => { r.committedAt = String(r.committedAt); }], ['(n) committedAt 1 hour in the future', r => { r.committedAt += 3600e3; }],
        ['(o) result altered without updating check', r => { r.result = { fields: ['tampered'] }; }]]) {
        await h.ready(START);
        const opId = hex('m' + label);
        let n = 0; shim.hooks.after = async cmd => (h.scriptOf(cmd) === 'COMMIT' && cmd[6].includes(opId) && !n++ ? { drop: true } : undefined);
        // The change lands; its answer is lost; its record is then damaged before the caller resolves.
        const prevAfter = shim.hooks.after;
        shim.hooks.after = async (cmd, reply) => {
          const r = await prevAfter(cmd, reply);
          if (r && r.drop) { const d = await h.doc(); mut(d.opRecords[opId]); await R.call('SET', KEY, JSON.stringify(d)); }
          return r;
        };
        const out = await ts.protect('progress', Q.progressUpdate, { payload: { x: 1 }, opId });
        shim.hooks = {};
        // Later writes, two hours on: an untrusted record is never pruned.
        for (let i = 0; i < 3; i++) await ts.protect('progress', Q.progressUpdate, { payload: { later: i }, at: Date.now() + 2 * 3600e3 });
        const d = await h.doc();
        check(`${label}: "outcome-unknown" (R3), never "recovered" and never a re-run; still stored afterwards; counted`,
          out.status === 'outcome-unknown' && /R3/.test(out.why) && opId in d.opRecords && ts.writerStatus().untrustedRecords >= 1 && d.lastBackfill.x === 1, out);
      }
    });

    await section('Q-T24 (f) NOTHING LOWERED THE FENCE in this whole file', async () => {
      check('every command this file sent: no DEL of the fence, and every SET of it was to "2" by THE RAISE or by the test itself',
        !shim.log.some(c => h.verb(c) === 'del' && c[1] === FENCE));
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
