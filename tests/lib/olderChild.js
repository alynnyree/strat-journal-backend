// ONE REAL OLDER BUILD of this service, as its own process, for the rollback
// checks (tests/gen2-older-builds.js; queue plan v14.1 rev 3.2, Q-T11, Q-T15
// (n), Q-T24 (g)). Started with child_process.fork(file, [buildDir]) and
// driven over IPC, as tests/lib/gen2Child.js is.
//
// The build is the one written out of history by tests/lib/olderBuild.js
// (generation 1 = eb3880b, generation 0 = 6cb24a4), UNMODIFIED: its own save
// module, its own sync, reset and import code, and its own routes, stood up
// with its own buildApp() on a free port so the parent can call them over
// HTTP with the app key. Only the outside world is replaced: Schwab, the
// market, the phone alerts and the sign-in record, which the parent controls.
//
// The parent may FIX THE CLOCK ("clock"), so the same writer run by two
// builds on the same record at the same moment can be compared byte for byte.
// For that comparison (Q-T15 (n)) the same file also runs THIS checkout's
// build (generation 2), which must first be started ("start").
const Module = require('module');
const path = require('path');
const BUILD = process.argv[2];

const market = { hang: false, hung: [], entered: 0 };
const schwab = { answers: [] };
const tokens = { last_transaction_check: null, setCalls: 0 };
const stubs = {
  'node-cron': { schedule: () => ({ stop() {} }) },
  './auth': { getValidAccessToken: async () => 'tok', router: require('express').Router() },
  './tokenStore': {
    getTokens: async () => ({ last_transaction_check: tokens.last_transaction_check }),
    setLastCheck: async iso => { tokens.last_transaction_check = iso; tokens.setCalls++; },
  },
  './pushcut': { notifyTradeClosed: async () => {}, notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {}, lastPhoneAlert: async () => null },
  './browserEvents': { queueBrowserEvent: async () => {}, router: require('express').Router() },
  './signInWatch': { checkSignInAndNotify: async () => ({}) },
  './schwabStreamer': { startStreamer: () => {} },
  './schwabClient': { getOptionFills: async (t, f, to, report) => {
    if (report) Object.assign(report, { accountFound: true, windowsAsked: 1, windowsOk: 1, windowsFailed: 0, failures: [], oldestWindowWithData: null });
    return JSON.parse(JSON.stringify(schwab.answers.length ? schwab.answers.shift() : []));
  } },
  './alpacaClient': { isReady: async () => false, underlyingPriceAt: async () => null },
  './ftfcCheck': {
    getUnderlyingPriceAt: async () => { market.entered++; if (market.hang) await new Promise(r => market.hung.push(r)); return 500; },
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

function fixClock(iso) {
  const RealDate = Date, FIX = RealDate.parse(iso);
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(FIX); }
    static now() { return FIX; }
  };
}

let ts, cron, port;
const outcome = p => p.then(v => ({ ok: true, value: v === undefined ? null : v }), e => ({ ok: false, code: (e && e.code) || null, message: (e && e.message) || String(e) }));

async function handle(m) {
  switch (m.cmd) {
    case 'init': {
      process.env.UPSTASH_REDIS_REST_URL = m.url;
      process.env.UPSTASH_REDIS_REST_TOKEN = 'stand-in-token';
      process.env.UPSTASH_DISABLE_TELEMETRY = '1';
      process.env.APP_SECRET = m.key;
      if (m.clock) fixClock(m.clock);
      ts = require(path.join(BUILD, 'tradeStore.js'));
      cron = require(path.join(BUILD, 'cron.js'));
      const app = require(path.join(BUILD, 'server.js')).buildApp();
      await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => { port = s.address().port; r(); }); });
      return { port, generation1: typeof ts.writerStatus === 'function' };
    }
    case 'schwab': schwab.answers.push(m.fills); return true;
    case 'hang': market.hang = !!m.on; return true;
    case 'release': market.hang = false; market.hung.splice(0).forEach(r => r()); return true;
    case 'entered': return market.entered;
    case 'tokens': return { ...tokens };
    case 'sync': return outcome(cron.runSyncCheck());
    case 'start': return ts.startGeneration2({ pauseMs: 0 });
    case 'reset': return outcome(cron.resetSyncState(m.args));
    case 'report': return ts.preservedStateReport();
    // Started and not waited on, so the parent can act while it is held at
    // the market; 'backfillResult' collects it.
    case 'backfillStart': market.job = outcome(cron.runBackfill(m.days || 30)).then(o => ({ ...o, value: o.ok ? (o.value || []).length : null })); return true;
    case 'backfillResult': return market.job;
    case 'save': return outcome(ts.saveState(m.doc));
    case 'writer': return typeof ts.writerStatus === 'function' ? ts.writerStatus() : null;
    case 'jobRunning': return cron.jobRunning();
    case 'exit': setImmediate(() => process.exit(0)); return 'exiting';
    default: throw new Error('unknown command ' + m.cmd);
  }
}
process.on('message', async m => {
  try { process.send({ id: m.id, ok: true, value: await handle(m) }); }
  catch (e) { process.send({ id: m.id, ok: false, error: (e && e.message) || String(e) }); }
});
process.send({ event: 'ready' });
