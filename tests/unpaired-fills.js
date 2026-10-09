// AUDIT H-2: no broker fill is dropped without a record. Authorized by the
// owner on 9 October 2026 ("I authorize H-2 implementation"); revised plan
// reviewed by the auditor.
//
// The live matcher used to discard the part of a sale it could not pair, and
// purge purchases past expiry or older than 45 days, without a word. They are
// now `exceptions`, saved in the same change that marks the fills processed,
// keyed by kind + broker fill id, never duplicated, never deleted. Pairing
// itself is unchanged. Runs the REAL matcher, sync, backfill and reset against
// stand-ins for storage and Schwab (as tests/sync-state-safety.js does).
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..');

process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };

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
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
const cron = require(path.join(BACKEND, 'cron.js'));
const tradeStore = require(path.join(BACKEND, 'tradeStore.js'));
const { processFills } = require(path.join(BACKEND, 'matcher.js'));

// ---- Fills, the way schwabClient hands them over.
const FAR = 'SPY   261231C00600000';            // expires end of 2026: never past expiry here
const T0 = Date.now() - 3 * 60 * 60 * 1000;
function fill(id, kind, minute, { price = 1, qty = 1, fees = 0.66, occ = FAR, at } = {}) {
  const ts = at != null ? at : T0 + minute * 60000; const d = new Date(ts);
  return { transactionId: id, occ, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
    price, quantity: qty, fees,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const fresh = s => { for (const k of Object.keys(store)) delete store[k]; writeState(s); tokens.last_transaction_check = null; schwab.answers = []; };
const exOf = st => st.exceptions || {};
const cents = x => (x == null ? null : Math.round(x * 100));
// Each case runs on its own, so one that throws (as on the code before H-2)
// is reported as a failure and the rest still run.
async function section(fn) { try { await fn(); } catch (e) { fail++; console.log('FAIL: this case threw:', e && e.message); } }

(async () => {
  try {
    console.log('--- T1. a sale with no purchase on file: no trade, one record, the fill processed ---');
    await section(async () => {
      const m = processFills([fill('c1', 'close', 5, { price: 1.2, fees: 0.67 })], { openLegs: [], pending: [] });
      const e = m.exceptions[0];
      check('no trade', m.newPending.length === 0);
      check('one record, keyed by kind + fill id, with quantity, price, fee and reason',
        m.exceptions.length === 1 && e.key === 'close-without-open:c1' && e.fillId === 'c1' && e.contractsUnmatched === 1
          && e.price === 1.2 && e.feeCents === 67 && /no purchase of this contract is on file/.test(e.reason), e);
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('c1', 'close', 5, { price: 1.2, fees: 0.67 })] });
      await cron.runSyncCheck();
      const st = readState();
      check('through the real sync: recorded, status open, and the fill marked processed',
        exOf(st)['close-without-open:c1'] && exOf(st)['close-without-open:c1'].status === 'open' && st.lastProcessedIds.includes('c1') && st.pending.length === 0, st);
    });

    console.log('\n--- T2. partial: a sale of 3 against 2 open gives a 2-contract trade plus a 1-contract record; fees to the cent ---');
    await section(async () => {
      const m = processFills([fill('o1', 'open', 0, { qty: 2, fees: 0.66 }), fill('c1', 'close', 5, { qty: 3, price: 1.3, fees: 1.00 })], { openLegs: [], pending: [] });
      const t = m.newPending[0], e = m.exceptions[0];
      check('one trade of 2 contracts on o1+c1', m.newPending.length === 1 && t.contracts === 2 && t.fills.join('+') === 'o1+c1');
      check('one record of 1 contract, saying more was sold than was open', m.exceptions.length === 1 && e.contractsUnmatched === 1 && e.contractsInSale === 3 && /more contracts were sold/.test(e.reason), e);
      check(`the sale's fee adds up: ${cents(t.exitFees)} + ${e.feeCents} = 100 cents`, cents(t.exitFees) + e.feeCents === 100);
      check('the purchase fee goes whole to the trade (66 cents)', cents(t.entryFees) === 66);
    });

    console.log('\n--- T3. delivered twice, a retry, a backfill after a sync, a re-run after reset: exactly one record, never removed ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('c9', 'close', 5)] });
      await cron.runSyncCheck();
      const first = exOf(readState())['close-without-open:c9'];
      schwab.answers.push({ fills: [fill('c9', 'close', 5)] });            // the same fill again
      await cron.runSyncCheck();
      schwab.answers.push({ fills: [fill('c9', 'close', 5)] });            // a backfill covering it
      await cron.runBackfill(30);
      await cron.resetSyncState();                                          // a reset
      schwab.answers.push({ fills: [fill('c9', 'close', 5)] });            // and history read again
      await cron.runBackfill(30);
      const st = readState();
      const keys = Object.keys(exOf(st)).filter(k => k.endsWith(':c9'));
      check('one record after five sightings and a reset', keys.length === 1, Object.keys(exOf(st)));
      check('the first sighting is kept as it was (firstSeenAt unchanged)', exOf(st)['close-without-open:c9'].firstSeenAt === first.firstSeenAt);
    });

    console.log('\n--- T4. concurrency: a sync held mid-way while the phone acknowledges and a backfill waits; then a reset ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [{ id: 'W', fills: ['x1', 'x2'] }], lastProcessedIds: ['x1', 'x2'] });
      schwab.answers.push({ fills: [fill('oA', 'open', 0), fill('cA', 'close', 2), fill('lonely-A', 'close', 3, { occ: 'SPY   261231P00500000' })] });
      schwab.answers.push({ fills: [fill('lonely-B', 'close', 4, { occ: 'SPY   261231P00510000' })] });
      const release = holdEnrichment();
      const sync = cron.runSyncCheck();
      const reached = await waitFor(() => gate.entered > 0);
      const backfill = cron.runBackfill(30);                               // waits for the sync (runExclusive)
      await tradeStore.removePendingTrade('W');                             // the phone says "taken"
      const midway = gate.held !== null;
      release(); await sync; await backfill;
      const st = readState();
      check('the overlap really happened', reached && midway);
      check('both records kept: the sync\'s and the backfill\'s', exOf(st)['close-without-open:lonely-A'] && exOf(st)['close-without-open:lonely-B'], Object.keys(exOf(st)));
      check('the acknowledgement stayed made, and the sync\'s own trade is waiting', !st.pending.some(t => t.id === 'W') && st.pending.some(t => (t.fills || []).join('+') === 'oA+cA'));
      await cron.resetSyncState();
      const after = readState();
      check('a reset keeps every record (and empties what it always emptied)',
        Object.keys(exOf(after)).length === Object.keys(exOf(st)).length && after.pending.length === 0 && after.openLegs.length === 0 && after.lastProcessedIds.length === 0);
    });

    console.log('\n--- T5. a sale dated before its purchase (the midnight case): a record, time never substituted ---');
    await section(async () => {
      const day = Date.UTC(2026, 4, 18);
      const buy = fill('b5', 'open', 0, { occ: 'SPY   260518P00736000', at: day + 13 * 3600e3 + 42 * 60e3 });
      const sale = fill('s5', 'close', 0, { occ: 'SPY   260518P00736000', at: day + 4 * 3600e3, price: 1.12 });   // tradeDate 04:00Z
      const m = processFills([sale, buy].sort((a, b) => a.timestamp - b.timestamp), { openLegs: [], pending: [] });
      check('no trade pairs them', m.newPending.length === 0);
      const e = m.exceptions.find(x => x.kind === 'close-without-open');
      check('the sale is a record with its own timestamp, unchanged', e && e.fillId === 's5' && e.timestamp === sale.timestamp && /no purchase of this contract is on file/.test(e.reason), m.exceptions);
      const m2 = processFills([sale], { openLegs: [{ occ: sale.occ, ticker: 'SPY', dir: 'Short', openPrice: 0.98, openDate: '2026-05-18', openTime: '09:42',
        openTimestamp: buy.timestamp, totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: 'b5' }], pending: [] });
      check('with the later purchase already on file, the reason says so', m2.exceptions[0] && /dated after this sale/.test(m2.exceptions[0].reason), m2.exceptions);
    });

    console.log('\n--- T6. purchases past expiry, and older than 45 days: one record each, never "worthless" ---');
    await section(async () => {
      const exp = Date.UTC(2026, 5, 5, 15);
      const legExp = { occ: 'SPY   260605C00700000', ticker: 'SPY', dir: 'Long', openPrice: 0.5, openDate: '2026-06-05', openTime: '11:00',
        openTimestamp: exp, totalQuantity: 3, remaining: 2, openFees: 0.66, openFeeCents: 22, openFillId: 'pe1' };
      const legOld = { occ: FAR, ticker: 'SPY', dir: 'Long', openPrice: 0.7, openDate: '2026-04-01', openTime: '10:00',
        openTimestamp: Date.UTC(2026, 3, 1, 14), totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: 'po1' };
      const later = fill('z1', 'open', 0, { occ: 'SPY   261231C00610000', at: Date.UTC(2026, 5, 10, 14) });
      const m = processFills([later], { openLegs: [legExp, legOld], pending: [] });
      const a = m.exceptions.find(e => e.key === 'open-retired:pe1'), b = m.exceptions.find(e => e.key === 'open-retired:po1');
      check('past expiry: recorded with what was still open and the unallocated fee', a && a.contractsRemaining === 2 && a.feeCents === 22 && a.reason === 'past expiry (no sale on file)', a);
      check('older than 45 days: recorded', b && b.reason === 'older than 45 days (no sale on file)', b);
      check('neither says worthless or assumes an outcome', !m.exceptions.some(e => /worthless/i.test(JSON.stringify(e))));
      check('both are gone from the open legs, as before', !m.updatedState.openLegs.some(l => l.openFillId === 'pe1' || l.openFillId === 'po1'));
    });

    console.log('\n--- T7. resolution: a record whose fill is later paired becomes "resolved", never deleted ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      schwab.answers.push({ fills: [fill('c7', 'close', 10)] });          // the sale arrives alone
      await cron.runSyncCheck();
      await cron.resetSyncState();
      schwab.answers.push({ fills: [fill('o7', 'open', 2), fill('c7', 'close', 10)] });   // history, purchase included
      await cron.runBackfill(30);
      const r = exOf(readState())['close-without-open:c7'];
      check('kept, status resolved, with the evidence: every contract of c7 paired, with o7', r && r.status === 'resolved' && r.resolvedAt
        && r.resolution && r.resolution.by === 'backfill' && JSON.stringify(r.resolution.pairedWith) === JSON.stringify([{ fillId: 'o7', contracts: 1 }]), r);
      check('the trade itself is queued normally', readState().pending.some(t => (t.fills || []).join('+') === 'o7+c7'));
    });

    console.log('\n--- T8. conservation, on random fill streams, per contract (contracts and fee cents) ---');
    await section(async () => {
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let bad = 0, runs = 0;
      for (let run = 0; run < 300; run++) {
        const occs = ['SPY   260610C00700000', 'SPY   260612P00690000', 'IWM   261231C00290000'];
        const base = Date.UTC(2026, 5, 9, 14);
        const fills = [];
        let id = 1;
        for (let k = 0; k < 14; k++) {
          const occ = occs[Math.floor(rnd() * occs.length)];
          const ts = base + Math.floor(rnd() * 5 * 86400e3);
          fills.push(fill(`f${run}-${id++}`, rnd() < 0.5 ? 'open' : 'close', 0, { occ, at: ts, qty: 1 + Math.floor(rnd() * 3), fees: Math.round((0.6 + rnd()) * 100) / 100, price: Math.round((0.3 + rnd() * 2) * 100) / 100 }));
        }
        fills.sort((a, b) => a.timestamp - b.timestamp);
        const m = processFills(fills, { openLegs: [], pending: [] });
        runs++;
        for (const occ of occs) {
          const opened = fills.filter(f => f.occ === occ && f.instruction === 'BUY_TO_OPEN').reduce((s, f) => s + f.quantity, 0);
          const closed = fills.filter(f => f.occ === occ && f.instruction === 'SELL_TO_CLOSE').reduce((s, f) => s + f.quantity, 0);
          const paired = m.newPending.filter(t => t.occ === occ).reduce((s, t) => s + t.contracts, 0);
          const stillOpen = m.updatedState.openLegs.filter(l => l.occ === occ).reduce((s, l) => s + l.remaining, 0);
          const retired = m.exceptions.filter(e => e.occ === occ && e.kind === 'open-retired').reduce((s, e) => s + e.contractsRemaining, 0);
          const unmatched = m.exceptions.filter(e => e.occ === occ && e.kind === 'close-without-open').reduce((s, e) => s + e.contractsUnmatched, 0);
          if (opened !== paired + stillOpen + retired || closed !== paired + unmatched) bad++;
        }
        for (const f of fills) {
          const fc = Math.round(f.fees * 100);
          if (f.instruction === 'SELL_TO_CLOSE') {
            const tr = m.newPending.filter(t => t.fills[1] === f.transactionId).reduce((s, t) => s + cents(t.exitFees), 0);
            const ex = m.exceptions.filter(e => e.kind === 'close-without-open' && e.fillId === f.transactionId).reduce((s, e) => s + e.feeCents, 0);
            if (tr + ex !== fc) bad++;
          } else {
            const tr = m.newPending.filter(t => t.fills[0] === f.transactionId).reduce((s, t) => s + cents(t.entryFees), 0);
            const ex = m.exceptions.filter(e => e.kind === 'open-retired' && e.fillId === f.transactionId).reduce((s, e) => s + e.feeCents, 0);
            const leg = m.updatedState.openLegs.filter(l => l.openFillId === f.transactionId).reduce((s, l) => s + l.openFeeCents, 0);
            if (tr + ex + leg !== fc) bad++;
          }
        }
      }
      check(`${runs} random streams: opened = paired + still open + retired, closed = paired + unmatched, and every fill's fee cents conserved`, bad === 0, bad);
    });

    console.log('\n--- T9. a missing fill id: keyed by what it is made of, marked uncertain, pairs nothing ---');
    await section(async () => {
      const m = processFills([fill(null, 'close', 5, { price: 1.4 })], { openLegs: [], pending: [] });
      const e = m.exceptions[0];
      check('keyed by its shape and marked identityUncertain', e && e.key.startsWith('close-without-open:S:') && e.identityUncertain === true && e.fillId === null, e);
      const leg = { occ: 'SPY   260605C00700000', ticker: 'SPY', dir: 'Long', openPrice: 0.5, openDate: '2026-06-05', openTime: '11:00',
        openTimestamp: Date.UTC(2026, 5, 5, 15), totalQuantity: 1, remaining: 1, openFees: 0.66 };   // saved before fill references
      const before = JSON.stringify(leg);
      const m2 = processFills([fill('z2', 'open', 0, { occ: FAR, at: Date.UTC(2026, 5, 10, 14) })], { openLegs: [leg], pending: [] });
      check('the caller\'s legacy leg is not written to while it is retired', JSON.stringify(leg) === before, leg);
      const r = m2.exceptions[0];
      check('a legacy leg with no id: retired under its shape key, uncertain, its legacy fee converted', r && r.key.startsWith('open-retired:S:') && r.identityUncertain === true && r.feeCents === 66, r);
      check('and no trade is formed from either', m.newPending.length === 0 && m2.newPending.length === 0);
    });

    console.log('\n--- T10. pairing unchanged: ordinary trades and fees as before ---');
    await section(async () => {
      const fills = [fill('a1', 'open', 0, { qty: 2, fees: 0.66 }), fill('a2', 'open', 1, { qty: 1, fees: 0.66 }), fill('a3', 'close', 5, { qty: 3, price: 1.5, fees: 1.33 })];
      const m = processFills(fills, { openLegs: [], pending: [] });
      check('oldest purchase first, no record', m.exceptions.length === 0 && m.newPending.map(t => t.fills.join('+') + 'x' + t.contracts).join(',') === 'a1+a3x2,a2+a3x1');
      check('the sale\'s fee split exactly as before (89 + 44 = 133)', m.newPending.map(t => cents(t.exitFees)).join('+') === '89+44');
    });

    console.log('\n--- T11. the stored record is additive: older readers see the same fields as before ---');
    await section(async () => {
      const st = readState();
      check('openLegs, pending and lastProcessedIds keep their shapes', Array.isArray(st.openLegs) && Array.isArray(st.pending) && Array.isArray(st.lastProcessedIds));
      check('exceptions is one extra field, an object of records', st.exceptions && typeof st.exceptions === 'object' && !Array.isArray(st.exceptions));
    });

    // ======================================================================
    // AUDITOR REVIEW OF THE IMPLEMENTATION (9 Oct 2026), items 1-6.
    // ======================================================================
    const sync = async fills => { schwab.answers.push({ fills }); await cron.runSyncCheck(); };
    const backfill = async fills => { schwab.answers.push({ fills }); await cron.runBackfill(30); };
    const ORIGINAL = ['kind', 'key', 'fillId', 'occ', 'ticker', 'date', 'time', 'timestamp', 'price',
      'contractsUnmatched', 'contractsInSale', 'contractsRemaining', 'contractsOpened', 'feeCents', 'reason', 'firstSeenAt', 'firstSeenBy'];
    const factsOf = r => JSON.stringify(ORIGINAL.map(f => [f, r[f]]));

    console.log('\n--- T12 (item 1). part paired is not paired: a partly paired sale or purchase stays OPEN ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      await sync([fill('o12', 'open', 0, { qty: 2 }), fill('c12', 'close', 5, { qty: 3, price: 1.3, fees: 1.00 })]);
      const r = exOf(readState())['close-without-open:c12'];
      check('a sale of 3 with 2 paired: its 1-contract record is OPEN in the same change, not resolved by its own 2-contract trade', r && r.status === 'open' && r.contractsUnmatched === 1, r);
      // A purchase of 3, one sold, then the rest left to expire inside the same run.
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const PAST = 'SPY   260605C00700000';
      await sync([fill('o13', 'open', 0, { occ: PAST, qty: 3, at: Date.UTC(2026, 5, 5, 14) }),
        fill('c13', 'close', 0, { occ: PAST, qty: 1, at: Date.UTC(2026, 5, 5, 15) }),
        fill('x13', 'open', 0, { at: Date.UTC(2026, 5, 9, 14) })]);
      const o = exOf(readState())['open-retired:o13'];
      check('a purchase of 3 with 1 sold and 2 retired: OPEN, 2 remaining, not resolved by the 1-contract trade', o && o.status === 'open' && o.contractsRemaining === 2, o);
    });

    console.log('\n--- T13 (item 1). a trade with one fill id cannot resolve a record of the other side ---');
    await section(async () => {
      // A purchase saved before fill references: its trade cites only the sale.
      const legacy = { occ: FAR, ticker: 'SPY', dir: 'Long', openPrice: 1, openDate: '2026-06-09', openTime: '10:00',
        openTimestamp: T0 - 60000, totalQuantity: 1, remaining: 1, openFees: 0.66 };
      fresh({ openLegs: [legacy], pending: [], lastProcessedIds: [], exceptions: {
        'open-retired:c14': { kind: 'open-retired', key: 'open-retired:c14', fillId: 'c14', occ: FAR, status: 'open', contractsRemaining: 1 } } });
      await sync([fill('c14', 'close', 5)]);
      const st = readState();
      check('the trade is formed and cites only the sale', st.pending.length === 1 && st.pending[0].fills.join('+') === 'c14', st.pending);
      check('the record keyed "open-retired:c14" is untouched (a sale id is never read as a purchase id)', exOf(st)['open-retired:c14'].status === 'open' && !exOf(st)['open-retired:c14'].resolution, exOf(st)['open-retired:c14']);
    });

    console.log('\n--- T14 (item 1). an uncertain identity is never a match ---');
    await section(async () => {
      const rec = { kind: 'close-without-open', key: 'close-without-open:q1', fillId: 'q1', identityUncertain: true, occ: FAR,
        date: '2026-06-09', time: '10:00', timestamp: 5, price: 1, contractsInSale: 1, contractsUnmatched: 1, feeCents: 66, reason: 'r', status: 'open' };
      const out = cron.withExceptions({ exceptions: { [rec.key]: rec } }, [],
        [{ resolves: 'close-without-open', fillId: 'q1', occ: FAR, date: '2026-06-09', time: '10:00', timestamp: 5, price: 1, quantity: 1, pairedWith: [] }], 'now', 'sync');
      check('a record marked identityUncertain stays open even when id and every fact match', out[rec.key].status === 'open', out[rec.key]);
      const m = processFills([fill(null, 'open', 0), fill(null, 'close', 5)], { openLegs: [], pending: [] });
      check('fills with no id are never offered as evidence', m.newPending.length === 1 && m.fullyPaired.length === 0, m.fullyPaired);
    });

    console.log('\n--- T15 (items 1, 5). one fill id on two different fills: both kept, flagged, never resolved ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      const other = 'SPY   261231P00500000';
      await sync([fill('m15', 'close', 5, { price: 1.1 }), fill('m15', 'close', 5, { occ: other, price: 2.2, qty: 2 })]);
      const r = exOf(readState())['close-without-open:m15'];
      check('one record keeps the first fill exactly', r && r.occ === FAR && r.price === 1.1 && r.status === 'open', r);
      const o = r && (r.observations || [])[0];
      check('the second fill is recorded beside it, not dropped: contract, price, size', o && o.kind === 'fill-id-on-a-different-fill' && o.facts.occ === other && o.facts.price === 2.2 && o.facts.contractsInSale === 2, r);
      check('and the record is marked conflicted', r && r.conflicted === true);
      await backfill([fill('p15', 'open', 0), fill('m15', 'close', 5, { price: 1.1 })]);
      check('a later full pairing of that id does NOT resolve a conflicted record', exOf(readState())['close-without-open:m15'].status === 'open');
    });

    console.log('\n--- T16 (item 1). evidence whose facts differ from the record never resolves it ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      await sync([fill('c16', 'close', 5, { price: 1.1 })]);
      await cron.resetSyncState();
      await backfill([fill('o16', 'open', 0), fill('c16', 'close', 5, { price: 9.9 })]);   // same id, a different price
      const r = exOf(readState())['close-without-open:c16'];
      check('still open, the differing fill noted, the record flagged', r.status === 'open' && r.conflicted === true
        && r.observations.some(o => o.kind === 'fill-id-on-a-different-fill' && o.facts.price === 9.9), r);
    });

    console.log('\n--- T17 (item 2). resolution adds only its own fields; repeats change nothing; contradictions are noted, not applied ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      await sync([fill('c17', 'close', 5, { price: 1.2, fees: 0.67 })]);
      const before = exOf(readState())['close-without-open:c17'];
      await cron.resetSyncState();
      await backfill([fill('o17', 'open', 0), fill('c17', 'close', 5, { price: 1.2, fees: 0.67 })]);
      const after = exOf(readState())['close-without-open:c17'];
      check('every original fact is identical after resolution', factsOf(after) === factsOf(before), [before, after]);
      const added = Object.keys(after).filter(k => !(k in before)).sort().join(',');
      check(`only these were added: ${added}`, added === 'resolution,resolvedAt' && after.status === 'resolved' && before.status === 'open');
      const snap = JSON.stringify(readState().exceptions);
      await cron.resetSyncState();
      await backfill([fill('o17', 'open', 0), fill('c17', 'close', 5, { price: 1.2, fees: 0.67 })]);
      check('a second full pairing of the same fill changes nothing (idempotent)', JSON.stringify(readState().exceptions) === snap);
      for (let i = 0; i < 3; i++) { await cron.resetSyncState(); await backfill([fill('c17', 'close', 5, { price: 1.2, fees: 0.67 })]); }
      const late = exOf(readState())['close-without-open:c17'];
      check('reported unpaired again after resolution, three times: still resolved, facts unchanged, ONE observation, flagged',
        late.status === 'resolved' && factsOf(late) === factsOf(before) && late.conflicted === true
          && late.observations.length === 1 && late.observations[0].kind === 'reported-unpaired-after-resolution', late);
    });

    console.log('\n--- T18 (item 2). the record and "processed" are one write: if it fails, neither changes ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: ['earlier'] });
      const realSet = fakeRedis.set;
      fakeRedis.set = async () => { throw new Error('storage refused'); };
      try { await sync([fill('c18', 'close', 5)]); } finally { fakeRedis.set = realSet; }
      const st = readState();
      check('nothing marked processed and nothing recorded', JSON.stringify(st.lastProcessedIds) === '["earlier"]' && !st.exceptions, st);
      await sync([fill('c18', 'close', 5)]);
      check('the next sync records it and marks it processed together', exOf(readState())['close-without-open:c18'] && readState().lastProcessedIds.includes('c18'));
      fresh({ openLegs: [], pending: [], lastProcessedIds: [], exceptions: ['not', 'an', 'object'] });
      await sync([fill('c19', 'close', 5)]);
      const bad = readState();
      check('an exceptions field of the wrong shape: the change refuses -- nothing processed, the stored value untouched',
        bad.lastProcessedIds.length === 0 && JSON.stringify(bad.exceptions) === '["not","an","object"]', bad);
    });

    console.log('\n--- T22 (auditor, second review). a bad record at the exact key: the whole change refuses ---');
    await section(async () => {
      // On file: one open purchase, one queued trade, one good record -- and a
      // bad value at the key the new unpaired sale c20 must be recorded under.
      const leg = { occ: FAR, ticker: 'SPY', dir: 'Long', openPrice: 1, openDate: '2026-06-09', openTime: '10:00',
        openTimestamp: T0 - 60000, totalQuantity: 1, remaining: 1, openFees: 0.66, openFeeCents: 66, openFillId: 'L0' };
      const start = { openLegs: [leg], pending: [{ id: 'q0', fills: ['a', 'b'] }], lastProcessedIds: ['earlier'],
        exceptions: { 'close-without-open:c20': 'garbage', 'close-without-open:g1': { kind: 'close-without-open', key: 'close-without-open:g1', fillId: 'g1', status: 'open' } } };
      fresh(start);
      const before = JSON.stringify(readState());
      // The same sync also brings a purchase, and a sale that would pair with the purchase on file.
      const batch = [fill('o20', 'open', 1), fill('s20', 'close', 2), fill('c20', 'close', 5, { occ: 'SPY   261231P00500000' })];
      await sync(batch);
      const st = readState();
      check('the bad record is exactly as it was', st.exceptions['close-without-open:c20'] === 'garbage');
      check('c20 is NOT marked processed (nor anything else in that batch)', JSON.stringify(st.lastProcessedIds) === '["earlier"]', st.lastProcessedIds);
      check('nothing from the attempted change is saved: open legs, queue, records, the whole record byte for byte',
        JSON.stringify(st) === before, st);
      check('the sync checkpoint did not move, so the same fills are asked for again', tokens.last_transaction_check === null, tokens);
      // Repeated ticks keep refusing; they never overwrite.
      await sync(batch);
      check('a second attempt refuses the same way', JSON.stringify(readState()) === before);
      // Addressed by hand, outside the service (an authorized repair moves the bad value aside); then a retry.
      const repaired = JSON.parse(before);
      repaired.exceptionsSetAside = { 'close-without-open:c20': repaired.exceptions['close-without-open:c20'] };
      delete repaired.exceptions['close-without-open:c20'];
      writeState(repaired);
      await sync(batch);
      const ok = readState();
      const r = ok.exceptions['close-without-open:c20'];
      check('after the repair the retry records c20 (open) and marks the whole batch processed',
        r && r.status === 'open' && r.fillId === 'c20' && ['o20', 's20', 'c20'].every(id => ok.lastProcessedIds.includes(id)), ok);
      check('the sale s20 paired with the purchase on file, the good record and the set-aside value untouched',
        ok.pending.some(t => (t.fills || []).join('+') === 'L0+s20') && ok.exceptions['close-without-open:g1'].status === 'open'
          && ok.exceptionsSetAside['close-without-open:c20'] === 'garbage');
    });

    console.log('\n--- T23 (auditor, second review). the per-kind summary has a fixed set of labels ---');
    await section(async () => {
      const api = require(path.join(BACKEND, 'api.js'));
      const layer = api.stack.find(l => l.route && l.route.path === '/trades/exceptions');
      const ask = () => new Promise((resolve, reject) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
        layer.route.stack[0].handle({ method: 'GET', query: {}, params: {} }, res, reject);
      });
      const ex = {};
      for (let i = 0; i < 500; i++) ex[`k${i}`] = { kind: `made-up-kind-${i}`, key: `k${i}`, status: 'open' };
      ex.a = { kind: 'close-without-open', key: 'a', status: 'open' };
      ex.b = { kind: 'open-retired', key: 'b', status: 'resolved' };
      fresh({ openLegs: [], pending: [], lastProcessedIds: [], exceptions: ex });
      const a = await ask();
      check('500 made-up kinds give three labels: 1 close-without-open, 1 open-retired, 500 other',
        JSON.stringify(a.body.counts.byKind) === JSON.stringify({ 'close-without-open': 1, 'open-retired': 1, other: 500 }), a.body.counts.byKind);
    });

    console.log('\n--- T19 (item 3). fee allocation in whole cents, checked against hand-worked figures ---');
    await section(async () => {
      // Purchase fee 133 cents on 3 contracts, sold one at a time:
      //   round(133 x 1/3) = 44, leaving 89; round(89 x 1/2) = 45 (x.5 rounds up), leaving 44; the last takes 44.
      let m = processFills([fill('a', 'open', 0, { qty: 3, fees: 1.33 }), fill('b', 'close', 1, { fees: 0.66 }),
        fill('c', 'close', 2, { fees: 0.66 }), fill('d', 'close', 3, { fees: 0.66 })], { openLegs: [], pending: [] });
      check('purchase fee 133 over three single sales: 44 + 45 + 44', m.newPending.map(t => cents(t.entryFees)).join('+') === '44+45+44');
      // Sale fee 101 cents on 3 contracts, against three purchases of 1 (oldest first):
      //   round(101 x 1/3) = 34, leaving 67; round(67 x 1/2) = 34, leaving 33; the last takes 33.
      m = processFills([fill('e', 'open', 0), fill('f', 'open', 1), fill('g', 'open', 2), fill('h', 'close', 5, { qty: 3, fees: 1.01 })], { openLegs: [], pending: [] });
      check('sale fee 101 over three purchases: 34 + 34 + 33, oldest purchase first', m.newPending.map(t => t.fills[0] + cents(t.exitFees)).join(' ') === 'e34 f34 g33');
      // Same purchase moment: the lower fill id goes first (compared as a number), whatever the arrival order.
      m = processFills([fill('20', 'open', 0), fill('3', 'open', 0), fill('k', 'close', 5, { qty: 2, fees: 1.01 })], { openLegs: [], pending: [] });
      check('a tie on the purchase moment goes to fill id 3 before 20, and the cents follow it (51 then 50)', m.newPending.map(t => t.fills[0] + ':' + cents(t.exitFees)).join(' ') === '3:51 20:50');
      // Sale of 3 against 2 open, fee 100: 2/3 of 100 = 66.67 -> 67 to the trade, 33 to the record.
      m = processFills([fill('o', 'open', 0, { qty: 2 }), fill('s', 'close', 5, { qty: 3, fees: 1.00 })], { openLegs: [], pending: [] });
      check('a partly unpaired sale: 67 to the trade, 33 to the record', cents(m.newPending[0].exitFees) === 67 && m.exceptions[0].feeCents === 33);
      m = processFills([fill('o', 'open', 0, { qty: 2 }), fill('s', 'close', 5, { qty: 3, fees: null })], { openLegs: [], pending: [] });
      check('an unknown sale fee stays unknown: the trade\'s fee and after-fee figure, and the record\'s fee, are null (never 0)',
        m.newPending[0].exitFees === null && m.newPending[0].fees === null && m.newPending[0].pnlNet === null && m.exceptions[0].feeCents === null, [m.newPending[0], m.exceptions[0]]);
      const PAST = 'SPY   260605C00700000';
      m = processFills([fill('u', 'open', 0, { occ: PAST, fees: null, at: Date.UTC(2026, 5, 5, 14) }), fill('n', 'open', 0, { at: Date.UTC(2026, 5, 9, 14) })], { openLegs: [], pending: [] });
      check('an unknown purchase fee, retired: null on the record, not 0', m.exceptions[0] && m.exceptions[0].feeCents === null, m.exceptions[0]);
    });

    console.log('\n--- T20 (item 4). every writer of the record keeps the exception ledger ---');
    await section(async () => {
      fresh({ openLegs: [], pending: [], lastProcessedIds: [] });
      await sync([fill('c21', 'close', 5)]);
      const want = JSON.stringify(readState().exceptions);
      const steps = [
        ['a sync with nothing new', () => sync([])],
        ['a sync that pairs an ordinary trade', () => sync([fill('o22', 'open', 6), fill('c22', 'close', 7)])],
        ['the phone taking a trade', () => tradeStore.removePendingTrade(readState().pending[0].id)],
        ['a trade added to the queue', () => tradeStore.addPendingTrade({ id: 'x', fills: ['y', 'z'] })],
        ['a backfill with nothing new in it', () => backfill([])],
        ['a reset', () => cron.resetSyncState()],
      ];
      for (const [label, step] of steps) {
        await step();
        check(`after ${label}: the ledger is byte-for-byte the same`, JSON.stringify(readState().exceptions) === want, readState().exceptions);
      }
    });

    console.log('\n--- T21 (item 6). the read-only answer is bounded and sends only named fields ---');
    await section(async () => {
      process.env.APP_SECRET = process.env.APP_SECRET || 'test-only-not-a-real-key';
      const api = require(path.join(BACKEND, 'api.js'));
      const layer = api.stack.find(l => l.route && l.route.path === '/trades/exceptions');
      const ask = () => new Promise((resolve, reject) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
        layer.route.stack[0].handle({ method: 'GET', query: {}, params: {} }, res, reject);
      });
      const many = {};
      for (let i = 0; i < 250; i++) many[`close-without-open:n${i}`] = { kind: 'close-without-open', key: `close-without-open:n${i}`, fillId: `n${i}`,
        timestamp: i, status: 'open', reason: 'x'.repeat(5000), raw: { account: 'should never be sent' } };
      many['close-without-open:bad'] = 'garbage';
      fresh({ openLegs: [], pending: [], lastProcessedIds: [], exceptions: many });
      const a = await ask();
      const size = JSON.stringify(a.body).length;
      check(`250 records stored: 100 sent, newest first, counts over all 250 (${size} characters)`, a.body.exceptions.length === 100
        && a.body.exceptions[0].fillId === 'n249' && a.body.counts.total === 250 && a.body.counts.open === 250 && a.body.counts.shown === 100, a.body.counts);
      check('a 5,000-character reason is cut to 200 + "..."', a.body.exceptions[0].reason.length === 203);
      check('a field not on the list (a raw payload) is never sent', !JSON.stringify(a.body).includes('should never be sent'));
      check('a stored value of the wrong shape is counted, not thrown', a.body.counts.malformed === 1);
      fresh({ openLegs: 'nonsense', pending: [], lastProcessedIds: [], exceptions: 'nonsense' });
      const b = await ask();
      check('a whole record of the wrong shape: answered, nothing listed, said so', b.status === 200 && b.body.exceptions.length === 0
        && b.body.counts.malformed === 'the whole record' && b.body.openLegs.held === 0, b.body);
    });
  } catch (e) {
    fail++; console.log('FAIL: crashed', e && e.stack);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
