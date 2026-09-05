// Bar Replay came back empty for every trade Alpaca served, and had done
// since Alpaca was added. Not a feed problem, not a data problem: Alpaca's
// path returned a bare LIST of bars while Schwab's returned a labelled
// package, and every reader in the app asks for `.candles`.
//
// So these checks ask one question of every path out of getReplayCandles:
// does the caller get the same shape? Plus: does an empty answer say which
// part came up empty, rather than leaving that to be guessed at later.
const Module = require('module');
const realLoad = Module._load;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

const ENTRY = Date.parse('2026-01-29T16:01:00Z');
const EXIT  = Date.parse('2026-01-29T16:06:00Z');

function bars(n, startMs = ENTRY - 15 * 60000, stepMs = 60000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ open: 685 + i * 0.01, high: 685.9, low: 684.8, close: 685.4, volume: 10,
               datetime: startMs + i * stepMs });
  }
  return out;
}

// Loads a fresh copy of replayData with Alpaca and Schwab stubbed however
// this particular case needs them.
function load({ alpacaReady = false, alpacaBars = null, alpacaThrows = null,
                schwabBars = [], schwabThrows = null, feed = 'iex' } = {}) {
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('alpacaClient')) {
      return {
        isReady: async () => alpacaReady,
        isConfigured: () => alpacaReady,
        feedState: () => ({ feed, downgraded: feed === 'iex' }),
        fetchBars: async () => { if (alpacaThrows) throw new Error(alpacaThrows); return alpacaBars; },
      };
    }
    if (req.endsWith('ftfcCheck')) {
      return { fetchCandles: async () => { if (schwabThrows) throw new Error(schwabThrows); return schwabBars; } };
    }
    return realLoad(req, parent, isMain);
  };
  delete require.cache[require.resolve('../replayData')];
  const mod = require('../replayData');
  Module._load = realLoad;
  return mod;
}

(async () => {
  // ===== 1. The bug itself: one shape, both paths ======================
  {
    const viaAlpaca = await load({ alpacaReady: true, alpacaBars: bars(36) })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    const viaSchwab = await load({ alpacaReady: false, schwabBars: bars(36) })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);

    check('Alpaca no longer hands back a bare list', !Array.isArray(viaAlpaca));
    check('the caller gets candles from Alpaca', (viaAlpaca.candles || []).length === 36);
    check('the caller gets candles from Schwab', (viaSchwab.candles || []).length === 36);
    check('both paths return exactly the same set of fields',
      JSON.stringify(Object.keys(viaAlpaca).sort()) === JSON.stringify(Object.keys(viaSchwab).sort()));
    check('the entry is marked on a real bar (Alpaca)', typeof viaAlpaca.entryIndex === 'number');
    check('the entry is marked on a real bar (Schwab)', typeof viaSchwab.entryIndex === 'number');
    check('the exit is marked too', typeof viaAlpaca.exitIndex === 'number' && typeof viaSchwab.exitIndex === 'number');
    check('the entry lands on the right bar', viaAlpaca.candles[viaAlpaca.entryIndex].datetime <= ENTRY
      && viaAlpaca.candles[viaAlpaca.entryIndex].datetime > ENTRY - 60000);
    check('and it says where the bars came from', /Alpaca/.test(viaAlpaca.source) && /Schwab/.test(viaSchwab.source));
    check('the free plan is named when that is what is in use', /free market data/.test(viaAlpaca.source));
  }

  // ===== 2. The exact reproduction of what he saw ======================
  {
    // His run: Alpaca connected and holding 36 bars for those minutes, and
    // Bar Replay reporting nothing to show.
    const r = await load({ alpacaReady: true, alpacaBars: bars(36) })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    const whatTheAppReads = ((r || {}).candles || []).length;
    check('his own case: 36 bars in, 36 bars out', whatTheAppReads === 36);
    check('and nothing is left over to explain', r.reason === null);
  }

  // ===== 3. The AI reads the same candles ==============================
  {
    // aiClient takes the last 15 of trade.replayData.candles. With a bare
    // list that was always zero, so every Alpaca-served trade was read
    // with no chart at all.
    const r = await load({ alpacaReady: true, alpacaBars: bars(36) })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    const forTheAI = ((r.replayData && r.replayData.candles) || r.candles || []).slice(-15);
    check('the setup reading gets 15 candles, not none', forTheAI.length === 15);
  }

  // ===== 4. An empty answer says which part came up empty =============
  {
    const noAlpaca = await load({ alpacaReady: false, schwabBars: [] })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    check('Schwab having nothing says so', /Schwab has no minute-by-minute data/.test(noAlpaca.reason));
    check('and it says how old the trade is', /days old/.test(noAlpaca.reason));

    const refused = await load({ alpacaReady: false, schwabThrows: 'Bad Request' })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    check('Schwab refusing is NOT reported as "has nothing"', !/has no minute-by-minute data/.test(refused.reason));
    check('a refusal is reported as a refusal', /turned down/.test(refused.reason));

    const alpacaEmpty = await load({ alpacaReady: true, alpacaBars: [], schwabBars: [] })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    check('Alpaca answering with nothing is named separately',
      /Alpaca/.test(alpacaEmpty.reason) && /no bars for those minutes/.test(alpacaEmpty.reason));
    check('and Schwab is named too, having also been asked', /Schwab/.test(alpacaEmpty.reason));

    const alpacaRefused = await load({ alpacaReady: true, alpacaThrows: 'forbidden', schwabBars: [] })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    check('Alpaca refusing reads differently from Alpaca being empty',
      /could not complete/.test(alpacaRefused.reason));
    check('every empty answer carries a reason', [noAlpaca, refused, alpacaEmpty, alpacaRefused]
      .every(r => typeof r.reason === 'string' && r.reason.length > 20));
    check('and none of them is a bare null', [noAlpaca, refused, alpacaEmpty, alpacaRefused]
      .every(r => r && Array.isArray(r.candles)));
  }

  // ===== 5. Alpaca refusing still lets Schwab answer ===================
  {
    const r = await load({ alpacaReady: true, alpacaThrows: 'forbidden', schwabBars: bars(20) })
      .getReplayCandles('tok', 'SPY', ENTRY, EXIT);
    check('a refusal from Alpaca falls through to Schwab', r.candles.length === 20);
    check('and the answer says it came from Schwab', /Schwab/.test(r.source));
  }

  // ===== 6. A bigger candle still marks the entry ======================
  {
    // A month-long hold steps up to hourly bars, and an hourly bar can
    // begin after the minute it ought to mark. The marker belongs on that
    // bar, not thrown away.
    const longExit = ENTRY + 30 * 24 * 60 * 60000;
    const r = await load({ alpacaReady: true, alpacaBars: bars(700, ENTRY + 60000, 60 * 60000) })
      .getReplayCandles('tok', 'SPY', ENTRY, longExit);
    check('a long hold still comes back with bars', r.candles.length === 700);
    check('and the entry is still marked rather than dropped', r.entryIndex === 0);
  }

  // ===== 7. No entry time at all ======================================
  {
    const r = await load({ alpacaReady: true, alpacaBars: bars(10) }).getReplayCandles('tok', 'SPY', null, EXIT);
    check('a trade with no entry time says that, and does not crash', /no entry time/.test(r.reason));
    check('and still comes back the same shape', Array.isArray(r.candles) && r.candles.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
