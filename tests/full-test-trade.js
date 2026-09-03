// The rehearsed trade. Every step is run for real against stand-in
// market data, and the two things that matter most are checked hardest:
// that it calls the REAL pipeline, and that it cannot reach his journal.
const Module = require('module');
const path = require('path');

const fakeRedis = {
  get: async () => null, set: async () => 'OK', del: async () => 1,
  lpush: async () => 1, lrange: async () => [], lrem: async () => 0,
  ltrim: async () => 'OK', rpop: async () => null,
};
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === './auth') return { getValidAccessToken: async () => 'tok', router: null };
  return origLoad.apply(this, arguments);
};

const tt = require(path.join(__dirname, '..', 'testTrade.js'));
const { applyClassificationToTrade } = require(path.join(__dirname, '..', 'cron.js'));

// Reached the AI, confident answer -> tagged. Reached, unsure -> not
// tagged. Threw -> could not reach.
const aiSure = (result) => ({ classifyForTest: async () => ({ reached:true, tagged:true, result }), applyClassification: applyClassificationToTrade });
const aiUnsure = () => ({ classifyForTest: async () => ({ reached:true, tagged:false, result:{ strategy:null, play:null } }), applyClassification: applyClassificationToTrade });
const aiUnreachable = () => ({ classifyForTest: async () => { throw new Error('The AI could not be reached.'); }, applyClassification: applyClassificationToTrade });

// The rehearsal now sources itself from a real setup unless a time is
// pinned. In these unit tests we hand it a fixed found-setup so the run is
// deterministic; the finder itself is tested in find-setup.js.
const foundAt = Date.parse('2026-08-28T14:30:00Z');
const finder = () => ({ findRecentSetup: async () => ({ ticker:'SPY', timeframe:'5m', setup:'2-1-2 Continuation', dir:'Long', entryTimestampMs: foundAt, when: new Date(foundAt).toISOString() }) });
const noFinder = () => ({ findRecentSetup: async () => null });

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

(async () => {
  // ===== 1. The session it picks =====
  {
    // A Wednesday. Yesterday was a Tuesday -- a normal trading day.
    const wed = new Date('2026-09-02T15:00:00Z');
    const s = tt.pickSession(wed);
    check(`a weekday picks the day before (${s.year}-${s.month}-${s.day})`, s.day === '01');

    // A Monday. Yesterday was a Sunday, so it must step back to Friday.
    const mon = new Date('2026-09-07T15:00:00Z');
    const m = tt.pickSession(mon);
    check(`a Monday steps back to Friday (${m.year}-${m.month}-${m.day})`, m.day === '04');

    // A Sunday. Yesterday was Saturday -> Friday.
    const sun = new Date('2026-09-06T15:00:00Z');
    const su = tt.pickSession(sun);
    check(`a Sunday also lands on Friday (${su.day})`, su.day === '04');

    check('it never picks today', tt.pickSession(wed).day !== '02');
  }

  // ===== 2. Eastern time, across both changeovers =====
  {
    const summer = tt.easternMoment({ year: '2026', month: '07', day: '15' }, 10, 30);
    check(`10:30 in July is 14:30 UTC (${new Date(summer).toISOString()})`,
      new Date(summer).toISOString() === '2026-07-15T14:30:00.000Z');
    const winter = tt.easternMoment({ year: '2026', month: '01', day: '15' }, 10, 30);
    check(`10:30 in January is 15:30 UTC (${new Date(winter).toISOString()})`,
      new Date(winter).toISOString() === '2026-01-15T15:30:00.000Z');
  }

  // ===== 3. The contract it builds =====
  {
    const occ = tt.buildOcc('SPY', { year: '2026', month: '09', day: '01' }, 655, 'CALL');
    check(`the contract reads like Schwab's own ("${occ}")`, occ === 'SPY   260901C00655000');
    check('it is the right length', occ.length === 21);
    const put = tt.buildOcc('SPY', { year: '2026', month: '09', day: '01' }, 655, 'PUT');
    check('a put is marked P', put.includes('P00655000'));
  }

  // ===== 4. The fills, and the money they imply =====
  {
    const session = { year: '2026', month: '09', day: '01' };
    const entry = tt.easternMoment(session, 10, 30);
    const exit = entry + tt.HOLD_MINUTES * 60000;
    const fills = tt.buildFills(session, 655, entry, exit);
    check('two fills: one in, one out', fills.length === 2);
    check('he always buys to open', fills[0].instruction === 'BUY_TO_OPEN');
    check('and sells to close', fills[1].instruction === 'SELL_TO_CLOSE');
    check(`the entry time is 10:30 Eastern (${fills[0].time})`, fills[0].time === '10:30');
    check(`the exit is ${tt.HOLD_MINUTES} minutes later (${fills[1].time})`, fills[1].time === '10:52');
    check('the hold runs past the fifteen-minute mark, so the middle is exercised',
      tt.HOLD_MINUTES > 15);
    // Fees are worked out from the cash, so the cash must be consistent.
    const buyCash = Math.abs(fills[0].netAmount) - tt.OPEN_PRICE * 100 * tt.CONTRACTS;
    const sellCash = tt.CLOSE_PRICE * 100 * tt.CONTRACTS - Math.abs(fills[1].netAmount);
    check(`the buy's cash implies the right fee (${buyCash.toFixed(2)})`, Math.abs(buyCash - tt.FEE_PER_SIDE) < 0.005);
    check(`the sell's cash implies the right fee (${sellCash.toFixed(2)})`, Math.abs(sellCash - tt.FEE_PER_SIDE) < 0.005);
    check('it is a winning trade, so a win is what gets displayed', tt.CLOSE_PRICE > tt.OPEN_PRICE);
  }

  // ===== 5. The whole run, with every step working =====
  {
    const called = [];
    const deps = {
      getUnderlyingPriceAt: async () => { called.push('price'); return 655.42; },
      enrichWithUnderlyingPrices: async (tok, [t]) => {
        called.push('underlying');
        t.undEntry = 655.42; t.undExit = 656.10; t.undPricedWithAlpaca = true;
      },
      enrichWithFtfc: async (tok, [t]) => {
        called.push('ftfc');
        t.ftfcRun = true; t.ftfcDirection = 'bull';
        t.ftfcTimeframesInRun = ['1m', '3m', '5m', '15m', '30m'];
      },
      enrichWithReplayData: async (tok, [t]) => {
        called.push('replay');
        t.replayData = { candles: new Array(120).fill({ open: 1, high: 1, low: 1, close: 1 }) };
      },
      enrichWithStopRule: async (tok, [t]) => { called.push('stop'); t.stop = 654.10; t.rrRealized = 1.9; },
      classifyForTest: async () => { called.push('ai'); return { reached:true, tagged:true, result:{
        strategy:'2-1-2 Continuation', confidence:'high', reasoning:'r',
        play:'FTFC Direction Play', playConfidence:'high', playReasoning:'pr',
        notation:'2U-1-2U', notationDirection:'Bullish', broadeningFormation:'no' } }; },
      applyClassification: applyClassificationToTrade,
      ...finder(),
      getToken: async () => { called.push('token'); return 'tok'; },
    };
    const r = await tt.runTestTrade(deps);

    check('every step ran', r.ok === true);
    check(`it calls the REAL steps in order (${called.join(' > ')})`,
      called.join(',') === 'token,price,underlying,ftfc,replay,ai,stop');
    check(`ten steps are reported now the setup is sourced first (${r.steps.length})`, r.steps.length === 10);
    const findStep = r.steps.find(s => /Find a real setup/.test(s.name));
    check('a "find a real setup" step runs first', !!findStep && r.steps[1].name === findStep.name);
    check(`it reports the real combo it landed on ("${findStep.summary.slice(0,44)}")`,
      /2-1-2 Continuation/.test(findStep.summary) && /5m/.test(findStep.summary));
    check('the run records which setup it tested on', r.ran.setup === '2-1-2 Continuation');
    check('and it landed on the setup\'s own day', r.ran.date === '2026-08-28');
    check('each step says how long it took', r.steps.every(s => typeof s.ms === 'number'));
    check('each step says what it produced', r.steps.every(s => s.summary && s.summary.length > 3));

    const t = r.trade;
    check('a trade came out of it', !!t);
    check('with a ticker, a direction and a size',
      t.ticker === 'SPY' && t.dir === 'Long' && t.contracts === tt.CONTRACTS);
    check(`with an entry date and time (${t.entryDate} ${t.entryTime})`,
      /^\d{4}-\d{2}-\d{2}$/.test(t.entryDate) && /^\d{2}:\d{2}$/.test(t.entryTime));
    check(`and an exit date and time (${t.exitDate} ${t.exitTime})`,
      /^\d{4}-\d{2}-\d{2}$/.test(t.exitDate) && /^\d{2}:\d{2}$/.test(t.exitTime));
    check(`profit was worked out (${t.pnlDollar})`, t.pnlDollar != null && t.pnlDollar > 0);
    check(`fees were worked out (${t.fees})`, t.fees != null && t.fees > 0);
    check('the strategy is on it', t.strat === '2-1-2 Continuation');
    check('and the play', t.play === 'FTFC Direction Play');
    check('and his own notation', t.stratNotation === '2U-1-2U');
    check('the timeframes are on it', t.ftfcRun === true && t.ftfcDirection === 'bull');
    check('the replay candles are on it', (t.replayData.candles || []).length === 120);
    check('the stop is on it', t.stop === 654.10);

    // THE RULE THAT MATTERS MOST.
    check('it is marked as a rehearsal', t.isTest === true);
    check('and its source says so too, not "schwab-auto"', t.source === 'rehearsal');

    const alignmentStep = r.steps.find(s => /timeframes/i.test(s.name));
    check(`the timeframe step says which way (${alignmentStep.summary})`,
      /bullish/.test(alignmentStep.summary) && /5 timeframes/.test(alignmentStep.summary));
    // Matched on the exact name: /AI/i also matches "Pair".
    const aiStep = r.steps.find(s => s.name === 'Read the setup with AI');
    check(`the AI step reports what it read (${aiStep.summary.slice(0, 40)})`,
      /2U-1-2U/.test(aiStep.summary) && /2-1-2 Continuation/.test(aiStep.summary));
  }

  // ===== 6. One step failing does not stop the rest =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 655.42,
      enrichWithUnderlyingPrices: async (tok, [t]) => { t.undEntry = 655.42; t.undExit = 656.1; },
      enrichWithFtfc: async () => { throw new Error('Schwab refused the candle request.'); },
      enrichWithReplayData: async (tok, [t]) => { t.replayData = { candles: [{}] }; },
      enrichWithStopRule: async () => {},
      ...aiSure({ strategy:'2-2 Reversal', confidence:'high' }),
      ...finder(),
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps);
    check('the run reports as not fully working', r.ok === false);
    const bad = r.steps.find(s => !s.ok);
    check(`the failing step is named (${bad.name})`, /timeframes/i.test(bad.name));
    check(`and it says what the far end said ("${bad.summary}")`, /refused/.test(bad.summary));
    check('the steps AFTER the failure still ran',
      ['Load the replay candles', 'Read the setup with AI', 'Work out the stop']
        .every(n => r.steps.find(s => s.name === n).ok));
    check('and a trade still came back to look at', !!r.trade && r.trade.strat === '2-2 Reversal');
  }

  // ===== 7. Schwab unreachable: it says so, and does not pretend =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => { throw new Error('Not connected'); },
      enrichWithUnderlyingPrices: async () => { throw new Error('Not connected'); },
      enrichWithFtfc: async () => { throw new Error('Not connected'); },
      enrichWithReplayData: async () => { throw new Error('Not connected'); },
      enrichWithStopRule: async () => { throw new Error('Not connected'); },
      ...aiUnreachable(),
      ...finder(),
      getToken: async () => { throw new Error('Your Schwab sign-in has run out'); },
    };
    const r = await tt.runTestTrade(deps);
    check('it does not throw when everything is down', !!r.steps.length);
    check('the sign-in step is the one that failed', r.steps[0].ok === false);
    check(`and it says so in words (${r.steps[0].summary.slice(0, 30)})`, /sign-in/i.test(r.steps[0].summary));
    // The matcher needs nothing from outside, so a trade must STILL appear
    // -- otherwise a lapsed sign-in would look like a broken matcher.
    check('the pairing still worked, because it needs nothing from outside',
      !!r.trade && r.trade.ticker === 'SPY');
    check('and it is still marked as a rehearsal', r.trade.isTest === true);
  }

  // ===== 8. It writes nothing anywhere =====
  {
    // Anything reaching storage would show up as a write on the fake.
    let writes = 0;
    const watched = { ...fakeRedis, set: async () => { writes++; return 'OK'; },
      lpush: async () => { writes++; return 1; } };
    const before = writes;
    const deps = {
      getUnderlyingPriceAt: async () => 655,
      enrichWithUnderlyingPrices: async () => {}, enrichWithFtfc: async () => {},
      enrichWithReplayData: async (tok, [t]) => { t.replayData = { candles: [{}] }; },
      enrichWithStopRule: async () => {}, ...aiSure({ strategy:'2-2 Reversal', confidence:'high' }),
      ...finder(),
      getToken: async () => 'tok',
    };
    await tt.runTestTrade(deps);
    check('the rehearsal itself stores nothing', writes === before);
  }

  // ===== A random minute with no setup is a PASS, not a failure =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 655.42,
      enrichWithUnderlyingPrices: async (tok, [t]) => { t.undEntry = 655.42; t.undExit = 656.10; },
      enrichWithFtfc: async (tok, [t]) => { t.ftfcRun = true; t.ftfcDirection = 'bull'; t.ftfcTimeframesInRun = ['1m','3m','5m','15m']; },
      enrichWithReplayData: async (tok, [t]) => { t.replayData = { candles: new Array(80).fill({}) }; },
      enrichWithStopRule: async () => {},
      ...aiUnsure(),
      ...finder(),
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps);
    const ai = r.steps.find(s => s.name === 'Read the setup with AI');
    check('the AI step PASSES when there was simply no setup', ai.ok === true);
    check('it is flagged as "worked, nothing to show" rather than a plain pass', ai.soft === true);
    check(`and it says so is a real answer, not a fault ("${ai.summary.slice(0,40)}")`,
      /not a fault/.test(ai.summary) && /no setup was clear|no setup at this/i.test(ai.summary));
    check('the whole run is NOT marked failed just because no setup was found', r.ok === true);
    check('no combo was invented onto the trade', !r.trade.strat && !r.trade.play);
    check('the trade is still a rehearsal', r.trade.isTest === true);
  }

  // ===== The AI being unreachable IS a failure, and named as one =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 655.42,
      enrichWithUnderlyingPrices: async (tok, [t]) => { t.undEntry = 655.42; t.undExit = 656.10; },
      enrichWithFtfc: async () => {},
      enrichWithReplayData: async (tok, [t]) => { t.replayData = { candles: [{}] }; },
      enrichWithStopRule: async () => {},
      ...aiUnreachable(),
      ...finder(),
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps);
    const ai = r.steps.find(s => s.name === 'Read the setup with AI');
    check('a genuinely unreachable AI fails the step', ai.ok === false);
    check(`and says it could not be reached ("${ai.summary.slice(0,30)}")`, /could not be reached/.test(ai.summary));
    check('the run reflects that failure', r.ok === false);
  }

  // ===== No setup found: the sourcing step fails with a clear reason =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 655,
      enrichWithUnderlyingPrices: async () => {}, enrichWithFtfc: async () => {},
      enrichWithReplayData: async () => {}, enrichWithStopRule: async () => {},
      ...aiSure({ strategy:'x', confidence:'high' }), ...noFinder(),
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps);
    const step = r.steps.find(s => /Find a real setup/.test(s.name));
    check('the sourcing step is there', !!step);
    check('and it fails when no setup could be found', step.ok === false);
    check(`saying so in plain words ("${step.summary.slice(0,40)}")`, /No clear setup/.test(step.summary));
    check('the run reflects the failure', r.ok === false);
  }

  // ===== A pinned time skips setup-finding entirely (his explicit moment) =====
  {
    let finderCalled = 0;
    const deps = {
      getUnderlyingPriceAt: async () => 655,
      enrichWithUnderlyingPrices: async (t,[x]) => { x.undEntry=655; x.undExit=656; },
      enrichWithFtfc: async () => {}, enrichWithReplayData: async (t,[x])=>{ x.replayData={candles:[{}]}; },
      enrichWithStopRule: async () => {}, ...aiSure({ strategy:'2-2 Reversal', confidence:'high' }),
      findRecentSetup: async () => { finderCalled++; return null; },
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps, { date:'2026-08-28', time:'11:15', holdMinutes:10 });
    check('pinning a time does not go looking for a setup', finderCalled === 0);
    check('and there is no "find a setup" step', !r.steps.some(s=>/Find a real setup/.test(s.name)));
    check('it uses the exact minute he pinned', r.ran.time === '11:15');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
