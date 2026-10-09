// AUDIT M-1: a trade's id comes from its broker fills, never from chance or
// shape. Plan v4, reviewed by the auditor; authorized by the owner on
// 9 October 2026 ("I authorize M-1 implementation").
//
// Runs the REAL matcher, sync, backfill, queue and removal route against
// stand-ins for storage and Schwab (as tests/sync-state-safety.js does). A
// collision is forced by injecting a hash (tests only): a 128-bit hash makes a
// real one practically impossible, so the only way to see the handling is to
// make one.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.APP_SECRET = process.env.APP_SECRET || 'test-only-not-a-real-key';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
async function section(fn) { try { await fn(); } catch (e) { fail++; console.log('FAIL: this case threw:', e && e.message); } }

// ---- Stand-in storage, through JSON as on the wire.
const store = {};
const fakeRedis = {
  get: async k => (k in store ? JSON.parse(store[k]) : null),
  set: async (k, v) => { store[k] = JSON.stringify(v); return 'OK'; },
  del: async k => { delete store[k]; return 1; },
};
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const readState = () => (store['trades:state'] ? JSON.parse(store['trades:state']) : null);
const writeState = s => { store['trades:state'] = JSON.stringify(s); };

// ---- Stand-in Schwab: each call takes the next scripted answer.
const schwab = { answers: [] };
function getOptionFills(token, startDate, endDate, report = null) {
  const a = schwab.answers.length ? schwab.answers.shift() : { fills: [] };
  if (report) { report.accountFound = true; report.windowsAsked = 1; report.windowsOk = 1; report.windowsFailed = 0; report.failures = []; report.oldestWindowWithData = null; }
  return Promise.resolve(JSON.parse(JSON.stringify(a.fills)));
}
const tokens = { last_transaction_check: null };
const gate = { held: null, entered: 0 };
function holdEnrichment(){ let open; gate.held = new Promise(r => { open = r; }); gate.entered = 0; return () => { gate.held = null; open(); }; }
const waitFor = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 5)); } return true; };

// The real matcher; the copy the service loads can be handed a forced hash.
const matcher = require(path.join(BACKEND, 'matcher.js'));
const force = { hash: null };
const ZERO = () => '0'.repeat(64);
const stubs = {
  '@upstash/redis': { Redis },
  'node-cron': { schedule: () => ({ stop(){} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './schwabClient': { getOptionFills },
  './tokenStore': { getTokens: async () => ({ ...tokens }), setLastCheck: async iso => { tokens.last_transaction_check = iso; } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async () => { gate.entered++; if (gate.held) await gate.held; return 500; },
    getFtfcForTrade: async () => ({ timeframes: {}, runLength: 0, confirmed: false, direction: null, timeframesInRun: [] }),
  },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {} },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
  './matcher': { ...matcher, processFills: (f, s, o = {}) => matcher.processFills(f, s, force.hash ? { ...o, idHash: force.hash } : o) },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const cron = require(path.join(BACKEND, 'cron.js'));
const tradeStore = require(path.join(BACKEND, 'tradeStore.js'));
const api = require(path.join(BACKEND, 'api.js'));
const { processFills, canonicalPair } = matcher;

// ---- Fills, the way schwabClient hands them over (with the account it stamps).
const OCC = 'SPY   261231C00600000';           // expires end of 2026: never "dead"
const A = 'acct-aaaaaaaaaaaaaaaa', B = 'acct-bbbbbbbbbbbbbbbb';
const T0 = Date.now() - 3 * 60 * 60 * 1000;
function fill(id, kind, minute, { price = 1, qty = 1, fees = 0.66, acct = A, occ = OCC } = {}) {
  const ts = T0 + minute * 60000; const d = new Date(ts);
  return { transactionId: id, accountRef: acct, occ, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
    price, quantity: qty, fees,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const run = (fills, opts) => processFills(fills, { openLegs: [], pending: [] }, opts);
const fresh = s => { for (const k of Object.keys(store)) delete store[k]; writeState(s); tokens.last_transaction_check = null; schwab.answers = []; };
const sync = async fills => { schwab.answers.push({ fills }); await cron.runSyncCheck(); };
const backfill = async fills => { schwab.answers.push({ fills }); await cron.runBackfill(30); };
const exOf = st => Object.values((st && st.exceptions) || {});
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Calls the real DELETE route's handler (behind the app key, as every api route).
function del(id, fills) {
  const layer = api.stack.find(l => l.route && l.route.path === '/trades/pending/:id' && l.route.methods.delete);
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    layer.route.stack[0].handle({ method: 'DELETE', params: { id }, query: fills === undefined ? {} : { fills } }, res, reject);
  });
}

(async () => {
  try {
    console.log('--- 1. the same pair gives the same id; the canonical string, exactly ---');
    await section(async () => {
      const a = run([fill('101', 'open', 0), fill('201', 'close', 5)]).newPending[0];
      const b = run([fill('101', 'open', 0), fill('201', 'close', 5)]).newPending[0];
      const canon = `m1v1|${A.length}:${A}|3:101|3:201`;
      check(`canonical string is "${canon}"`, canonicalPair(A, '101', '201') === canon);
      check(`the id is contract-times-"p"+first 32 hex of its SHA-256 (${a.id})`,
        a.id === `${OCC}-${a.entryTime}-${a.exitTime}-p${sha(canon).slice(0, 32)}`);
      check('two runs over the same pair: the same id', a.id === b.id);
      const n = run([fill(101, 'open', 0), fill(201, 'close', 5)]).newPending[0];
      check('an activityId sent as a number gives the same id as the same digits as text', n && n.id === a.id && n.fills.join('+') === '101+201');
      const sp = run([fill('  101', 'open', 0), fill('201', 'close', 5)]);
      check('"  101" is rejected as malformed, not trimmed: no trade, a pair-unidentified record',
        sp.newPending.length === 0 && sp.exceptions.some(e => e.kind === 'pair-unidentified' && e.openFillId === '  101'), sp.exceptions);
      const amb1 = canonicalPair('ab', '1', '23'), amb2 = canonicalPair('ab', '12', '3');
      check('the length prefixes keep "1"+"23" and "12"+"3" apart', amb1 !== amb2);
      check('the readable part carries no identity: a different time, the same fills -> the same hash',
        a.id.split('-p')[1] === `${sha(canon).slice(0, 32)}`);
      check('idBasis "fill-pair", the account carried on the trade', a.idBasis === 'fill-pair' && a.accountRef === A);
    });

    console.log('\n--- 2. a different account gives a different id for the same fill ids ---');
    await section(async () => {
      const a = run([fill('101', 'open', 0), fill('201', 'close', 5)]).newPending[0];
      const b = run([fill('101', 'open', 0, { acct: B }), fill('201', 'close', 5, { acct: B })]).newPending[0];
      check('different ids', a && b && a.id !== b.id, [a && a.id, b && b.id]);
    });

    console.log('\n--- 3. identical-shape twins, and one purchase closed by two sales ---');
    await section(async () => {
      const t = run([fill('301', 'open', 0), fill('302', 'open', 0), fill('401', 'close', 5), fill('402', 'close', 5)]).newPending;
      check('two trades of identical shape, two different ids', t.length === 2 && t[0].id !== t[1].id
        && t[0].entryTime === t[1].entryTime && t[0].optEntry === t[1].optEntry, t.map(x => x.id));
      const u = run([fill('501', 'open', 0, { qty: 2 }), fill('601', 'close', 5), fill('602', 'close', 6)]).newPending;
      check('one purchase, two sales: two trades, two ids', u.length === 2 && u[0].id !== u[1].id, u.map(x => x.fills));
    });

    console.log('\n--- 4. a missing or malformed id: not queued, one record across retries; a "U-" id is kept ---');
    await section(async () => {
      for (const [label, bad] of [['missing', null], ['malformed', 'csv7'], ['upper-case hex', 'U-' + 'A'.repeat(32)]]) {
        fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
        for (let i = 0; i < 3; i++) {
          await cron.resetSyncState();
          await backfill([fill('701', 'open', 0), fill(bad, 'close', 5)]);
        }
        const st = readState();
        const recs = exOf(st).filter(e => e.kind === 'pair-unidentified');
        check(`${label}: nothing queued, one pair-unidentified record after three runs, marked uncertain`,
          st.pending.length === 0 && recs.length === 1 && recs[0].identityUncertain === true && recs[0].contracts === 1, [st.pending, recs]);
      }
      const uOpen = 'U-' + 'a'.repeat(32), uClose = 'U-' + 'b'.repeat(32);
      const t = run([fill(uOpen, 'open', 0), fill(uClose, 'close', 5)]).newPending[0];
      check('a "U-" pair: queued, idBasis "uncertain-fill-id"', t && t.idBasis === 'uncertain-fill-id' && t.fills.join('+') === `${uOpen}+${uClose}`, t);
      const half = run([fill(uOpen, 'open', 0), fill('801', 'close', 5)]).newPending[0];
      check('one "U-" side is enough for "uncertain-fill-id"', half && half.idBasis === 'uncertain-fill-id');
    });

    console.log('\n--- 5. a forced collision: in one run, in the queue, five times ---');
    await section(async () => {
      // In one matcher run.
      const r = run([fill('901', 'open', 0), fill('902', 'open', 0), fill('903', 'close', 5, { qty: 2 })], { idHash: ZERO });
      const inc = r.exceptions.filter(e => e.kind === 'id-collision');
      check('one run: no trade queued, one incident holding both pairs, with contracts and fee cents',
        r.newPending.length === 0 && inc.length === 1 && inc[0].pairs.length === 2
          && inc[0].pairs.map(p => p.fills.join('+')).sort().join(' ') === '901+903 902+903'
          && inc[0].pairs.every(p => p.contracts === 1 && p.entryFeeCents === 66), inc);
      check('their fills are not offered as evidence of pairing', r.fullyPaired.length === 0);
      // Five detections of the same incident, through the real backfill.
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      force.hash = ZERO;
      for (let i = 0; i < 5; i++) { await cron.resetSyncState(); await backfill([fill('901', 'open', 0), fill('902', 'open', 0), fill('903', 'close', 5, { qty: 2 })]); }
      force.hash = null;
      const st = readState();
      const recs = exOf(st).filter(e => e.kind === 'id-collision');
      check('five detections: ONE record, detections 5, detectedBy ["matcher"], nothing queued',
        recs.length === 1 && recs[0].detections === 5 && JSON.stringify(recs[0].detectedBy) === '["matcher"]' && st.pending.length === 0, recs);
      check('its id and pairs never changed; first and last seen recorded', recs[0].pairs.length === 2 && recs[0].firstSeenAt && recs[0].lastSeenAt);
      // In the queue: a waiting trade with id X, an arrival of another pair with the same id.
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      force.hash = ZERO;
      await sync([fill('911', 'open', 0), fill('912', 'close', 5)]);
      const waiting = JSON.stringify(readState().pending);
      await sync([fill('921', 'open', 6), fill('922', 'close', 7)]);   // same minutes would differ; force the same id
      force.hash = null;
      const st2 = readState();
      const q = exOf(st2).filter(e => e.kind === 'id-collision');
      check('the readable parts differ, so the queue sees no collision there (ids differ)', q.length === 0 && st2.pending.length === 2);
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      force.hash = ZERO;
      await sync([fill('931', 'open', 0), fill('932', 'close', 5)]);
      const before = JSON.stringify(readState().pending);
      await sync([fill('941', 'open', 0), fill('942', 'close', 5)]);   // same contract and minutes: the same id
      force.hash = null;
      const st3 = readState();
      const q3 = exOf(st3).filter(e => e.kind === 'id-collision');
      check('in the queue: the waiting trade is untouched, the arrival not queued', JSON.stringify(st3.pending) === before, st3.pending);
      check('one incident, detectedBy ["queue"], holding both pairs', q3.length === 1 && JSON.stringify(q3[0].detectedBy) === '["queue"]'
        && q3[0].pairs.map(p => p.fills.join('+')).sort().join(' ') === '931+932 941+942', q3);
      check('the arrival\'s fills are marked processed (no re-delivery loop)', ['941', '942'].every(id => st3.lastProcessedIds.includes(id)));
      void waiting;
    });

    console.log('\n--- 6. removal names the pair; a different pair is kept and answered 409 ---');
    await section(async () => {
      const t = run([fill('951', 'open', 0), fill('952', 'close', 5)]).newPending[0];
      const other = { ...t, fills: ['961', '962'] };
      fresh({ openLegs: [], pending: [other], lastProcessedIds: [] });
      const r1 = await del(t.id, '951,952');
      check('a different pair under the id: 409, nothing removed, the queued pair named',
        r1.status === 409 && r1.body.removed === 0 && JSON.stringify(r1.body.queuedPairs) === '[["961","962"]]' && readState().pending.length === 1, r1);
      fresh({ openLegs: [], pending: [t, other], lastProcessedIds: [] });
      const r2 = await del(t.id, '951,952');
      check('both under the id: its own pair removed, the other kept, 409 naming it',
        r2.status === 409 && r2.body.removed === 1 && readState().pending.length === 1 && readState().pending[0].fills.join('+') === '961+962', r2);
      fresh({ openLegs: [], pending: [t], lastProcessedIds: [] });
      const r3 = await del(t.id, '951,952');
      check('the same pair: removed, 200', r3.status === 200 && r3.body.removed === 1 && readState().pending.length === 0, r3);
      fresh({ openLegs: [], pending: [{ ...t, fills: [951, 952] }], lastProcessedIds: [] });
      const rn = await del(t.id, '951,952');
      check('a queued pair stored as numbers is the same pair sent as text: removed, no false 409', rn.status === 200 && rn.body.removed === 1, rn);
      const r4 = await del(t.id, 'only-one');
      check('a "fills" that is not two ids: 400, nothing touched', r4.status === 400);
      fresh({ openLegs: [], pending: [t, other], lastProcessedIds: [] });
      const r5 = await del(t.id);
      check('no "fills" (an app from before M-1): today\'s behaviour, every entry with the id removed', r5.status === 200 && readState().pending.length === 0);
      // Removal at the same moment as a sync that is queueing (gated).
      fresh({ openLegs: [], pending: [t], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('971', 'open', 20), fill('972', 'close', 25)] });
      const release = holdEnrichment();
      const job = cron.runSyncCheck();
      const reached = await waitFor(() => gate.entered > 0);
      const r6 = await del(t.id, '951,952');
      const stillRunning = gate.held !== null;
      release(); await job;
      const st = readState();
      check('the overlap really happened (the sync was mid-enrichment during the removal)', reached && stillRunning);
      check('no entry lost: the removed one stays removed, the sync\'s new trade is waiting',
        r6.status === 200 && !st.pending.some(x => x.id === t.id) && st.pending.some(x => x.fills.join('+') === '971+972'), st.pending);
    });

    console.log('\n--- 8. existing queued trades and their fields are untouched by a sync ---');
    await section(async () => {
      const old = [{ id: 'SPY   261231C00600000-10:00-10:05-ab1cd', fills: ['1', '2'], contracts: 1, notes: 'x' },
                   { id: 'T:abcdef', fills: ['3', '4'], contracts: 2 }];
      fresh({ openLegs: [], pending: old, lastProcessedIds: [] });
      await sync([fill('981', 'open', 0), fill('982', 'close', 5)]);
      const st = readState();
      check('the two existing entries are byte-for-byte as they were, ids included',
        JSON.stringify(st.pending.slice(-2)) === JSON.stringify(old) && st.pending.length === 3, st.pending);
    });

    console.log('\n--- 9. accounts: a cross-account pair, and a leg with no account ---');
    await section(async () => {
      const keep = [{ id: 'kept', fills: ['5', '6'] }];
      fresh({ openLegs: [], pending: keep, lastProcessedIds: [] });
      await sync([fill('991', 'open', 0, { acct: A }), fill('992', 'close', 5, { acct: B })]);
      const st = readState();
      const r = exOf(st).find(e => e.fillId === '992');
      check('purchase in A, sale in B: no trade, "account-mismatch" recorded', r && r.kind === 'account-mismatch' && r.contractsUnmatched === 1, exOf(st));
      check('the queue is byte-identical', JSON.stringify(st.pending) === JSON.stringify(keep));
      check('the purchase stays open in its own account', st.openLegs.length === 1 && st.openLegs[0].accountRef === A);
      const legacy = { occ: OCC, ticker: 'SPY', dir: 'Long', openPrice: 1, openDate: '2026-06-09', openTime: '10:00',
        openTimestamp: T0 - 60000, totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: '995' };
      fresh({ openLegs: [legacy], pending: [], lastProcessedIds: [] });
      await sync([fill('996', 'close', 5)]);
      const st2 = readState();
      const r2 = exOf(st2).find(e => e.fillId === '996');
      check('a leg saved with no account: its sale is "account-unknown", never paired, never assumed',
        r2 && r2.kind === 'account-unknown' && st2.pending.length === 0 && st2.openLegs.length === 1, exOf(st2));
      const m = run([fill('997', 'open', 0), fill('998', 'close', 5, { acct: null })]);
      check('a sale with no account: "account-unknown"', m.newPending.length === 0 && m.exceptions[0].kind === 'account-unknown');
      // A later full pairing of that sale in its own account resolves it (H-2 rule, same fill, same facts).
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      await sync([fill('999', 'close', 5)]);
      await cron.resetSyncState();
      await backfill([fill('990', 'open', 0), fill('999', 'close', 5)]);
      const res = exOf(readState()).find(e => e.fillId === '999');
      check('the H-2 resolution still works: close-without-open 999 resolved by a full pairing', res && res.status === 'resolved');
      // The incident across two layers: one record, detectedBy both.
      const recA = { kind: 'id-collision', key: 'id-collision:X:h', id: 'X', pairs: [], detectedBy: ['matcher'] };
      let ex = cron.withExceptions({}, [recA], [], 't1', 'sync');
      ex = cron.withExceptions({ exceptions: ex }, [{ ...recA, detectedBy: ['queue'] }], [], 't2', 'sync');
      check('the same incident from two layers: one record, detections 2, detectedBy ["matcher","queue"]',
        Object.keys(ex).length === 1 && ex['id-collision:X:h'].detections === 2
          && JSON.stringify(ex['id-collision:X:h'].detectedBy) === '["matcher","queue"]' && ex['id-collision:X:h'].lastSeenAt === 't2', ex);
    });

    console.log('\n--- 10. conservation still holds on random streams with accounts and bad ids ---');
    await section(async () => {
      let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let bad = 0;
      for (let k = 0; k < 400; k++) {
        const fills = [];
        for (let j = 0; j < 12; j++) {
          const r = rnd();
          const id = r < 0.05 ? null : r < 0.08 ? 'bad' + j : String(k * 100 + j);
          fills.push(fill(id, rnd() < 0.5 ? 'open' : 'close', Math.floor(rnd() * 300), { qty: 1 + Math.floor(rnd() * 3), acct: rnd() < 0.1 ? B : rnd() < 0.05 ? null : A }));
        }
        fills.sort((a, b) => a.timestamp - b.timestamp);
        const m = run(fills);
        const opened = fills.filter(f => f.instruction === 'BUY_TO_OPEN').reduce((s, f) => s + f.quantity, 0);
        const sold = fills.filter(f => f.instruction === 'SELL_TO_CLOSE').reduce((s, f) => s + f.quantity, 0);
        const queued = m.newPending.reduce((s, t) => s + t.contracts, 0);
        const unid = m.exceptions.filter(e => e.kind === 'pair-unidentified').reduce((s, e) => s + e.contracts, 0);
        const coll = m.exceptions.filter(e => e.kind === 'id-collision').reduce((s, e) => s + e.pairs.reduce((a, p) => a + p.contracts, 0), 0);
        const unmatched = m.exceptions.filter(e => matcher.CLOSE_KINDS.includes(e.kind)).reduce((s, e) => s + e.contractsUnmatched, 0);
        const stillOpen = m.updatedState.openLegs.reduce((s, l) => s + l.remaining, 0);
        const retired = m.exceptions.filter(e => e.kind === 'open-retired').reduce((s, e) => s + e.contractsRemaining, 0);
        const paired = queued + unid + coll;
        if (sold !== paired + unmatched || opened !== paired + stillOpen + retired) bad++;
        if (m.newPending.some(t => !/^[0-9]+$|^U-[0-9a-f]{32}$/.test(t.fills[0]) || !/^[0-9]+$|^U-[0-9a-f]{32}$/.test(t.fills[1]))) bad++;
      }
      check(`400 random streams: sold = paired (queued + unidentified + collided) + unmatched; opened = paired + open + retired; every queued trade has two valid ids`, bad === 0, bad);
    });
  } catch (e) {
    fail++; console.log('FAIL: crashed', e && e.stack);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
