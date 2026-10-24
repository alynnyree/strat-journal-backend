// ONE REAL SERVICE PROCESS for the two-process checks (tests/gen2-processes.js;
// Queue plan v14.1 rev 3.2). Started with child_process.fork, driven over IPC.
// It loads the service's REAL save module and import code, talking to the
// parent's local Redis through its OWN stand-in of Upstash's web service (so
// the parent can hold, drop or time each of its requests), with Schwab and
// the market replaced by stand-ins the parent controls.
//
// The market can END THIS PROCESS at a chosen trade ("exit"): a real
// process exit in the middle of real work, which is what the restart and
// poison-guard checks need.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..', '..');

const market = { behaviour: {}, hung: [] };
const schwab = { answers: [] };
const T0 = Date.parse('2026-10-20T14:00:00Z');
const indexOfTs = ts => Math.floor((ts - T0) / 60000 / 10);
const stubs = {
  'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok' },
  './tokenStore': { getTokens: async () => ({}), setLastCheck: async () => {} },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {}, lastPhoneAlert: async () => null },
  './browserEvents': { queueBrowserEvent: async () => {} },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
  './schwabClient': { getOptionFills: async (t, f, to, report) => {
    if (report) Object.assign(report, { accountFound: true, windowsAsked: 1, windowsOk: 1, windowsFailed: 0, failures: [] });
    return JSON.parse(JSON.stringify(schwab.answers.length ? schwab.answers.shift() : []));
  } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async (tok, ticker, ts) => {
      const i = indexOfTs(ts);
      const isEntry = ((ts - T0) / 60000) % 10 === 0;
      const b = market.behaviour[i];
      if (isEntry) process.send({ event: 'measuring', index: i });
      if (isEntry && b === 'exit') { process.send({ event: 'exiting', index: i }); setImmediate(() => process.exit(0)); await new Promise(() => {}); }
      if (isEntry && b === 'hang') await new Promise(r => market.hung.push(r));
      return 500;
    },
    getFtfcForTrade: async () => ({ timeframes: { '1D': 'BULLISH' }, runLength: 4, confirmed: true, direction: 'BULLISH', timeframesInRun: ['1D'] }),
  },
  './replayData': { getReplayCandles: async () => ({ candles: [], reason: 'stand-in' }) },
  './stopRule': { loadSettings: async () => ({ enabled: false }), computeStopForTrade: async () => ({ stop: null }) },
  './aiClient': { classifyStrategy: async () => null },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};

let ts, Q, cron;
const updates = () => ({
  staging: p => cron.stagingUpdate(p.fills),
  landing: p => cron.syncLandingUpdate({ fills: p.fills, report: {}, syncNote: null, enriched: new Map(), cutoverIso: '2026-10-01T00:00:00.000Z', cutoverMs: Date.parse('2026-10-01'), nowIso: '2026-10-24T12:00:00.000Z' }),
  publication: () => Q.publicationUpdate, poison: () => Q.poisonGuardUpdate, qidRemoval: () => Q.qidRemoval,
  legacyRemoval: () => Q.legacyRemovalById, reset: () => Q.resetUpdate, cancel: () => Q.resetCancelUpdate,
  progress: () => (doc, fx) => ({ next: { ...doc, lastBackfill: { ...(doc.lastBackfill || {}), [fx.payload.field]: fx.payload.value } }, result: { fields: [fx.payload.field] } }),
  expand: () => Q.expandUpdate,
});
const KIND_OF = { staging: 'staging', landing: 'sync-landing', publication: 'publication', poison: 'poison-guard', qidRemoval: 'qid-removal', legacyRemoval: 'legacy-removal', reset: 'reset', cancel: 'reset-cancel', progress: 'progress', expand: 'expand' };

async function handle(m) {
  switch (m.cmd) {
    case 'init':
      process.env.UPSTASH_REDIS_REST_URL = m.url;
      process.env.UPSTASH_REDIS_REST_TOKEN = 'stand-in-token';
      process.env.UPSTASH_DISABLE_TELEMETRY = '1';
      ts = require(path.join(BACKEND, 'tradeStore.js'));
      Q = require(path.join(BACKEND, 'queueOps.js'));
      cron = require(path.join(BACKEND, 'cron.js'));
      return m.start === false ? { started: false } : ts.startGeneration2({ pauseMs: 0 });
    case 'market': market.behaviour = m.behaviour; return true;
    case 'release': market.hung.splice(0).forEach(r => r()); return true;
    case 'schwab': schwab.answers.push(m.fills); return true;
    case 'start': return ts.startGeneration2({ pauseMs: 0 });
    case 'protect': {
      const fn = updates()[m.update](m.payload || {});
      const out = await ts.protect(KIND_OF[m.update], fn, { ...(m.opts || {}), payload: m.payload });
      return { status: out.status, result: out.result, why: out.why, runs: out.runs, recordOpId: out.record && out.record.opId, recordKind: out.record && out.record.kind };
    }
    case 'backfill': return cron.runBackfill(m.days || 30).then(v => (v || []).length);
    case 'publishStaged': return cron.publishStaged('tok', null);
    case 'batch': return cron.runStagedBatch('tok', m.entries).then(r => ({ guard: r.guard && r.guard.status, publication: r.publication && r.publication.status }));
    case 'log': return ts.logFailure(m.entry);
    case 'writer': return ts.writerStatus();
    case 'exit': setImmediate(() => process.exit(0)); return 'exiting';
    default: throw new Error('unknown command ' + m.cmd);
  }
}
process.on('message', async m => {
  try { process.send({ id: m.id, ok: true, value: await handle(m) }); }
  catch (e) { process.send({ id: m.id, ok: false, error: (e && e.message) || String(e) }); }
});
process.send({ event: 'ready' });
