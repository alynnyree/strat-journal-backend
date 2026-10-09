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
      check('kept, status resolved, naming the pair that resolved it', r && r.status === 'resolved' && r.resolvedBy.join('+') === 'o7+c7' && r.resolvedAt, r);
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
      const m2 = processFills([fill('z2', 'open', 0, { occ: FAR, at: Date.UTC(2026, 5, 10, 14) })], { openLegs: [leg], pending: [] });
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
  } catch (e) {
    fail++; console.log('FAIL: crashed', e && e.stack);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
