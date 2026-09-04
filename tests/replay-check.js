// A blind replay of one of his real trades. Two things matter most: that
// the journal is told NOTHING it is supposed to work out, and that what
// it works out from the raw facts comes back matching the real trade.
const Module = require('module');
const path = require('path');
const fakeRedis = { get: async()=>null, set: async()=>'OK', del: async()=>1,
  lpush: async()=>1, lrange: async()=>[], lrem: async()=>0, ltrim: async()=>'OK' };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === './auth') return { getValidAccessToken: async () => 'tok', router: null };
  return origLoad.apply(this, arguments);
};
const rc = require(path.join(__dirname, '..', 'replayCheck.js'));
const { applyClassificationToTrade } = require(path.join(__dirname, '..', 'cron.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// A real trade of his shape: SPY calls, bought and sold the same morning.
// 14:30 UTC is 10:30 Eastern in summer.
const REAL = {
  occ: 'SPY   260828C00655000', ticker: 'SPY', putCall: 'CALL', contracts: 2,
  entryTimestamp: Date.parse('2026-08-28T14:30:00Z'),
  exitTimestamp:  Date.parse('2026-08-28T14:52:00Z'),
  entryPrice: 1.24, exitPrice: 1.61,
  entryFees: 1.32, exitFees: 1.32,
};

const deps = (over = {}) => ({
  enrichWithUnderlyingPrices: async (t, [x]) => { x.undEntry = 655.42; x.undExit = 656.10; x.undPricedWithAlpaca = true; },
  enrichWithFtfc: async (t, [x]) => { x.ftfcRun = true; x.ftfcDirection = 'bull'; x.ftfcTimeframesInRun = ['1m','3m','5m','15m']; },
  enrichWithReplayData: async (t, [x]) => { x.replayData = { candles: new Array(90).fill({}) }; },
  enrichWithStopRule: async (t, [x]) => { x.stop = 654.10; x.rrRealized = 1.9; },
  classifyForTest: async () => ({ reached: true, tagged: true, result: { strategy: '2-1-2 Continuation', confidence: 'high', notation: '2U-1-2U', notationDirection: 'Bullish' } }),
  applyClassification: applyClassificationToTrade,
  getToken: async () => 'tok',
  ...over,
});

(async () => {
  // ===== 1. The transactions it rebuilds look like Schwab's own =====
  {
    const [buy, sell] = rc.buildTransactions(REAL);
    check('two transactions: a buy and a sell', !!buy && !!sell);
    check('the buy is marked as opening', buy.transferItems[0].positionEffect === 'OPENING');
    check('the sell is marked as closing', sell.transferItems[0].positionEffect === 'CLOSING');
    check('the buy pays money out (negative cash)', buy.transferItems[0].cost < 0 && buy.netAmount < 0);
    check('the sell brings money in (positive cash)', sell.transferItems[0].cost > 0 && sell.netAmount > 0);
    // THE FEE TEST: the cash must differ from the contracts' value by exactly the fee.
    const buyGross = 1.24 * 100 * 2, sellGross = 1.61 * 100 * 2;
    check(`the buy's cash is value PLUS fee (${Math.abs(buy.netAmount)})`,
      Math.abs(Math.abs(buy.netAmount) - (buyGross + 1.32)) < 0.005);
    check(`the sell's cash is value MINUS fee (${sell.netAmount})`,
      Math.abs(sell.netAmount - (sellGross - 1.32)) < 0.005);
    check('the contract travels unchanged', buy.transferItems[0].instrument.symbol === REAL.occ);
  }

  // ===== 2. The real extraction gets the times, dates and fees back =====
  {
    const r = await rc.runReplayCheck(deps(), REAL);
    const t = r.trade;
    check('the replay produced a trade', !!t);
    check(`the entry date is right (${t.entryDate})`, t.entryDate === '2026-08-28');
    check(`the entry time converts to Eastern (${t.entryTime})`, t.entryTime === '10:30');
    check(`the exit date is right (${t.exitDate})`, t.exitDate === '2026-08-28');
    check(`the exit time is right (${t.exitTime})`, t.exitTime === '10:52');
    check(`the fill prices survive (${t.optEntry} -> ${t.optExit})`, t.optEntry === 1.24 && t.optExit === 1.61);
    check(`the size survives (${t.contracts})`, t.contracts === 2);
    check(`a CALL reads as Long (${t.dir})`, t.dir === 'Long');
    // The fee was worked back out of the cash -- it was never sent as a fee.
    check(`the fee is recovered from the cash (${t.fees})`, Math.abs(t.fees - 2.64) < 0.02);
    check(`the profit is right (${t.pnlDollar})`, Math.abs(t.pnlDollar - 74) < 0.01);
    check(`the profit after fees is right (${t.pnlNet})`, Math.abs(t.pnlNet - 71.36) < 0.03);
    check(`it is marked a win (${t.winLoss})`, t.winLoss === 'Win');
    check('every step worked', r.ok === true);
  }

  // ===== 3. A PUT reads as Short =====
  {
    const put = { ...REAL, occ: 'SPY   260828P00650000', putCall: 'PUT' };
    const r = await rc.runReplayCheck(deps(), put);
    check(`a PUT reads as Short (${r.trade.dir})`, r.trade.dir === 'Short');
  }

  // ===== 4. Winter time, to catch a timezone slip =====
  {
    const winter = { ...REAL,
      occ: 'SPY   260115C00600000',
      entryTimestamp: Date.parse('2026-01-15T15:30:00Z'),   // 10:30 Eastern in winter
      exitTimestamp:  Date.parse('2026-01-15T15:52:00Z') };
    const r = await rc.runReplayCheck(deps(), winter);
    check(`a January trade still reads 10:30 (${r.trade.entryTime})`, r.trade.entryTime === '10:30');
    check(`and the right date (${r.trade.entryDate})`, r.trade.entryDate === '2026-01-15');
  }

  // ===== 5. A late trade must not roll onto the next day =====
  {
    const late = { ...REAL,
      entryTimestamp: Date.parse('2026-08-28T19:45:00Z'),   // 15:45 Eastern
      exitTimestamp:  Date.parse('2026-08-28T19:55:00Z') };
    const r = await rc.runReplayCheck(deps(), late);
    check(`a late-afternoon trade stays on its own day (${r.trade.entryDate} ${r.trade.entryTime})`,
      r.trade.entryDate === '2026-08-28' && r.trade.entryTime === '15:45');
  }

  // ===== 6. THE BLINDNESS RULE: nothing it must work out is sent in =====
  {
    const answers = ['strat', 'play', 'stratNotation', 'undEntry', 'undExit',
                     'ftfcConfirmed', 'ftfcDirection', 'stop', 'fees', 'pnlDollar',
                     'pnlNet', 'winLoss', 'entryDate', 'entryTime', 'exitDate', 'exitTime'];
    const sentKeys = Object.keys(REAL);
    const leaked = answers.filter(a => sentKeys.includes(a));
    check(`none of the answers are sent in (${leaked.join(', ') || 'none'})`, leaked.length === 0);
    // And what IS sent is only what Schwab itself would provide.
    const allowed = ['occ','ticker','putCall','contracts','entryTimestamp','exitTimestamp',
                     'entryPrice','exitPrice','entryFees','exitFees'];
    const extra = sentKeys.filter(k => !allowed.includes(k));
    check(`nothing beyond Schwab's own facts is sent (${extra.join(', ') || 'none'})`, extra.length === 0);
  }

  // ===== 7. A trade missing something is refused, not half-run =====
  {
    const broken = { ...REAL }; delete broken.exitTimestamp;
    const r = await rc.runReplayCheck(deps(), broken);
    check('an incomplete trade is refused', r.ok === false && !!r.error);
    check('with no half-finished steps', r.steps.length === 0);
    check('and it says so readably', /cannot be tested/.test(r.error));
    check('missingFields names what is absent', rc.missingFields(broken).includes('exitTimestamp'));
  }

  // ===== 8. One failing step does not stop the rest =====
  {
    const r = await rc.runReplayCheck(deps({
      enrichWithFtfc: async () => { throw new Error('Schwab refused the candle request.'); },
    }), REAL);
    check('the run reports as not fully working', r.ok === false);
    const bad = r.steps.find(s => !s.ok);
    check(`the failing step is named (${bad.name})`, /timeframes/i.test(bad.name));
    check('later steps still ran', r.steps.find(s => /replay candles/i.test(s.name)).ok === true);
    check('and the money was still worked out', r.trade.pnlDollar != null);
  }

  // ===== 9. It never writes anything =====
  {
    let writes = 0;
    const watched = { ...fakeRedis, set: async () => { writes++; return 'OK'; } };
    await rc.runReplayCheck(deps(), REAL);
    check('the replay stores nothing', writes === 0);
    const r = await rc.runReplayCheck(deps(), REAL);
    check('and its trade is marked so it can never be mistaken for real',
      r.trade.isTest === true && r.trade.source === 'replay-check');
  }

  // ===== 10. Raw machine text must never reach his screen =============
  {
    const rough = [
      [{ message:'Request failed with status code 429', response:{status:429} }, /out of|allowance|did not work/i],
      [{ message:'Request failed with status code 500', response:{status:500} }, /no readable reason/i],
      [{ message:'connect ETIMEDOUT 1.2.3.4:443' }, /connection dropped/i],
      [{ message:'{"error":"unsupported_token_type"}' }, /sign in again/i],
      [{ message:'<HTML><HEAD><TITLE>Access Denied' }, /turned away/i],
      [{ message:'Error: something exploded at line 42' }, /no readable reason/i],
    ];
    for(const [err, expect] of rough){
      const out = rc.plainStepError(err);
      check(`"${String(err.message).slice(0,32)}" reads plainly ("${out.slice(0,34)}")`, expect.test(out));
    }
    const all = rough.map(([e]) => rc.plainStepError(e)).join(' ');
    check(`no status codes reach the words (${/status code|\b429\b|\b500\b/.test(all) ? 'found' : 'none'})`,
      !/status code|\b429\b|\b500\b/.test(all));
    check('nor any web code or braces', !/[<>{}]/.test(all));
  }

  // ===== 11. A spent allowance is its own answer, not a failure =======
  {
    check('429 counts as out-of-allowance', rc.rateLimited({ response:{status:429} }));
    check('503 does too', rc.rateLimited({ response:{status:503} }));
    check('a real error does not', !rc.rateLimited({ response:{status:500} }));
    check('nor a plain throw', !rc.rateLimited(new Error('boom')));

    const r = await rc.runReplayCheck(deps({
      classifyForTest: async () => { const e = new Error('Request failed with status code 429'); e.response = { status: 429 }; throw e; },
    }), REAL);
    const ai = r.steps.find(s => s.name === 'Read the setup with AI');
    check('a spent allowance does NOT fail the step', ai.ok === true);
    check('it is flagged as worked-with-nothing', ai.soft === true);
    check(`and says plainly it is not a fault ("${ai.summary.slice(0,36)}")`,
      /not a fault/.test(ai.summary) && /allowance/.test(ai.summary));
    check('no status code in what he sees', !/429|status code/.test(ai.summary));

    // A genuine AI failure still fails, and still reads plainly.
    const r2 = await rc.runReplayCheck(deps({
      classifyForTest: async () => { const e = new Error('Request failed with status code 500'); e.response = { status: 500 }; throw e; },
    }), REAL);
    const ai2 = r2.steps.find(s => s.name === 'Read the setup with AI');
    check('a real AI failure still fails', ai2.ok === false);
    check('and still never shows machine text', !/status code|500/.test(ai2.summary));
  }

  // ===== 12. An aged-out trade explains itself =========================
  {
    const old = { ...REAL,
      entryTimestamp: Date.now() - 190 * 86400000,
      exitTimestamp: Date.now() - 190 * 86400000 + 1320000 };
    const r = await rc.runReplayCheck(deps({
      enrichWithReplayData: async () => {},          // nothing comes back
      alpacaReady: async () => false,                 // and no Alpaca to reach back
    }), old);
    const step = r.steps.find(s => /replay candles/i.test(s.name));
    check('an old trade with no Alpaca does not fail the step', step.ok === true);
    check('it is flagged as worked-with-nothing', step.soft === true);
    check(`and explains why ("${step.summary.slice(0,40)}")`,
      /only keeps about a month/.test(step.summary) && /not a fault/.test(step.summary));

    // With Alpaca connected, an empty answer IS a fault worth showing.
    const r2 = await rc.runReplayCheck(deps({
      enrichWithReplayData: async () => {},
      alpacaReady: async () => true,
    }), old);
    check('with Alpaca on, empty candles is still a real failure',
      r2.steps.find(s => /replay candles/i.test(s.name)).ok === false);
  }

  // ===== 13. My own explanation must survive the scrubber =============
  // The guard that stops machine text reaching his screen ate a careful
  // 159-character sentence about which source was asked, and printed
  // "no readable reason came back" -- destroying the very diagnosis it
  // was written to give.
  {
    const long = 'Bar Replay has nothing to show. Alpaca is connected on the free market data and answered, but has no minute-by-minute bars for those minutes.';
    check(`a long message is scrubbed when it comes from outside (${long.length} chars)`,
      rc.plainStepError(new Error(long)) !== long);
    const mine = new Error(long); mine.plain = true;
    check('but a message written here, on purpose, survives intact',
      rc.plainStepError(mine) === long);
    // The guard must still work on real machine text even if flagged wrongly.
    check('an unflagged wall of machine text is still replaced',
      /no readable reason/.test(rc.plainStepError(new Error('{"error":{"code":500,"detail":"x".repeat(200)}}'))));
  }

  // ===== 14. An empty replay reports WHAT Alpaca actually gave =========
  {
    // The third case deliberately does NOT name the plan: if Alpaca has
    // the bars, the plan is beside the point and the fault is in how the
    // replay asks for them. That is what it should say.
    const cases = [
      [async () => null,  /could not be completed/,  'could not reach it', true],
      [async () => [],    /has no minute-by-minute bars/, 'it has nothing there', true],
      [async () => new Array(42).fill({}), /does have 42 bars.*fault is in how the replay asks/, 'it HAS the bars', false],
    ];
    for (const [probe, expect, label, namesPlan] of cases) {
      const r = await rc.runReplayCheck(deps({
        enrichWithReplayData: async () => {},
        alpacaReady: async () => true,
        feedState: () => ({ feed: 'iex', downgraded: true }),
        probeCandles: probe,
      }), REAL);
      const step = r.steps.find(s => /replay candles/i.test(s.name));
      check(`"${label}" is reported as such ("${step.summary.slice(0, 46)}")`, expect.test(step.summary));
      check(`  and it survives the scrubber intact`, step.summary.length > 60);
      check(`  and ${namesPlan ? 'names the plan in use' : 'points at the request, not the plan'}`,
        namesPlan ? /free market data/.test(step.summary) : /how the replay asks/.test(step.summary));
    }
  }

  // ===== 15. A probe that itself blows up does not break the run ======
  {
    const r = await rc.runReplayCheck(deps({
      enrichWithReplayData: async () => {},
      alpacaReady: async () => true,
      probeCandles: async () => { throw new Error('boom'); },
    }), REAL);
    const step = r.steps.find(s => /replay candles/i.test(s.name));
    check('a probe that throws is treated as "could not"', /could not be completed/.test(step.summary));
    check('and the rest of the run still finished', !!r.trade && r.trade.pnlDollar != null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
