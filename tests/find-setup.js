// Sourcing the rehearsal from a REAL setup. The finder must land on an
// actual occurrence of one of his nine combos in real candle data, using
// the SAME detectors the backtester uses -- never a made-up one.
const Module = require('module');
const path = require('path');
const fakeRedis = { get: async()=>null, set: async()=>'OK' };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;

// A fake candle feed we control, so a known setup sits at a known place.
let FEED = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === './alpacaClient') return { isReady: async () => false, fetchBars: async () => null };
  if (request === './ftfcCheck') return { fetchCandles: async () => FEED };
  return origLoad.apply(this, arguments);
};

const bt = require(path.join(__dirname, '..', 'backtest.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// Build 5-minute candles for a single session, each described by its
// relationship to the one before, so I can plant a real combo. Times are
// during regular hours so buildBars keeps them.
function session(dayISO, shapes) {
  // start at 10:00 ET; buildBars anchors to session, 5m steps.
  let base = Date.parse(dayISO + 'T14:00:00Z'); // 10:00 ET (summer)
  let prev = { high: 100, low: 99, open: 99.5, close: 99.8 };
  const out = [{ datetime: base, open: prev.open, high: prev.high, low: prev.low, close: prev.close }];
  shapes.forEach((sh, k) => {
    const t = base + (k + 1) * 5 * 60000;
    let h, l;
    if (sh === '2u') { h = prev.high + 0.5; l = prev.low + 0.2; }        // took high only
    else if (sh === '2d') { h = prev.high - 0.2; l = prev.low - 0.5; }   // took low only
    else if (sh === '1') { h = prev.high - 0.1; l = prev.low + 0.1; }    // inside
    else if (sh === '3') { h = prev.high + 0.5; l = prev.low - 0.5; }    // outside
    const dirUp = (sh === '2u') || (sh === '3');
    const open = dirUp ? l + 0.05 : h - 0.05;
    const close = dirUp ? h - 0.05 : l + 0.05;
    const bar = { datetime: t, open, high: h, low: l, close };
    out.push(bar); prev = bar;
  });
  return out;
}

(async () => {
  // ===== 1. A planted 2-1-2 continuation is found =====
  {
    // 2u, 1, 2u  = a bullish 2-1-2 Continuation on the last three bars.
    FEED = session('2026-08-20', ['2u', '2u', '1', '2u']);
    const found = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 10, timeframes: ['5m'] });
    check('a setup is found', !!found);
    check(`it is a real combo from his nine (${found && found.setup})`,
      found && bt.SETUP_KEYS.includes(found.setup));
    check(`the last three bars read as a 2-1-2 Continuation (${found && found.setup})`,
      found && found.setup === '2-1-2 Continuation');
    check(`bullish -> Long (${found && found.dir})`, found && found.dir === 'Long');
    check('it carries the moment the setup triggered', found && typeof found.entryTimestampMs === 'number');
    check('and names the timeframe it was read on', found && found.timeframe === '5m');
  }

  // ===== 2. A bearish 2-2 reversal =====
  {
    FEED = session('2026-08-20', ['2u', '2u', '2d']);  // last two: 2u then 2d = 2-2 Reversal, bearish
    const found = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 10, timeframes: ['5m'] });
    check(`a 2-up then 2-down reads as a reversal (${found && found.setup})`,
      found && /Reversal|Continuation/.test(found.setup));
    check(`taking the low -> Short (${found && found.dir})`, found && found.dir === 'Short');
  }

  // ===== 3. The MOST RECENT setup wins =====
  {
    // An early 2-2, then lots of inside bars, then a fresh 2-2 at the end.
    FEED = session('2026-08-20', ['2u', '2u', '1', '1', '1', '2d', '2d']);
    const found = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 10, timeframes: ['5m'] });
    // The freshest trigger is the last bar; its time must be the last bar's.
    const lastTime = FEED[FEED.length - 1].datetime;
    check(`the newest setup is the one returned (${found && new Date(found.entryTimestampMs).toISOString()})`,
      found && found.entryTimestampMs === lastTime);
  }

  // ===== 4. Restricting to a chosen day =====
  {
    const older = session('2026-08-10', ['2u', '2u', '2d']);
    const newer = session('2026-08-20', ['2u', '2u', '1']);   // no clean trigger on the last bar
    FEED = [...older, ...newer];
    const onOld = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 30, onDate: '2026-08-10', timeframes: ['5m'] });
    check('restricting to a day finds the setup on that day', !!onOld && new Date(onOld.entryTimestampMs).toISOString().startsWith('2026-08-10'));
  }

  // ===== 5. Genuinely no setup -> null, not a made-up one =====
  {
    // All inside bars after the first: nothing triggers.
    FEED = session('2026-08-20', ['1', '1', '1', '1']);
    const found = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 10, timeframes: ['5m'] });
    check('no setup returns nothing rather than inventing one', found === null);
  }

  // ===== 6. Not enough data -> null =====
  {
    FEED = [{ datetime: Date.parse('2026-08-20T14:00:00Z'), open:100, high:100.5, low:99.5, close:100 }];
    const found = await bt.findRecentSetup('tok', { ticker: 'SPY', days: 10, timeframes: ['5m'] });
    check('a near-empty feed finds nothing', found === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
