// Every Alpaca-served trade was read by the AI with no chart at all, and
// nothing recorded that -- so a blind answer and a properly-read one were
// indistinguishable on the card, for ever. A reading now says what it was
// actually given.
const Module = require('module');
const realLoad = Module._load;
process.env.GEMINI_API_KEY = 'test-key';
let sent = null;
Module._load = function (req, parent, isMain) {
  if (req === 'axios') {
    return { post: async (url, body) => {
      sent = body;
      return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({
        strategy: '2-1-2 Continuation', confidence: 'high', reasoning: 'r',
        play: 'FTFC Direction Play', playConfidence: 'high', playReasoning: 'p',
        notation: '2U-1-2U', notationDirection: 'bullish', broadeningFormation: 'no',
      }) }] } }] } };
    } };
  }
  if (req.endsWith('tradeStore')) return { getState: async () => ({}), saveState: async () => {} };
  return realLoad(req, parent, isMain);
};
const ai = require('../aiClient');
const cron = require('../cron');
Module._load = realLoad;

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// Step 1: the AI is shown only bars that STARTED before the entry minute.
const ENTRY = Date.now() - 3600000;
const MINUTE = Math.floor(ENTRY / 60000) * 60000;
// n bars before the entry minute, then 20 more from the entry minute on.
const bars = n => new Array(n + 20).fill(0).map((_, i) => ({ open: 1, high: 2, low: 0.5, close: 1.5, datetime: MINUTE + (i - n) * 60000 }));

(async () => {
  // ===== 1. A reading with a chart says how much chart it had ==========
  {
    const trade = { ticker: 'SPY', dir: 'Short', entryTimestamp: ENTRY + 20000, replayData: { candles: bars(36) } };
    const r = await ai.classifyStrategy(trade);
    check('a full reading reports the candles it saw: 30 from before the entry, none after', r.sawCandles === 30);
    cron.applyClassificationToTrade(trade, r);
    check('and that is written onto the trade', trade.stratSawCandles === 30);
    check('the tag itself still lands', trade.strat === '2-1-2 Continuation' && trade.play === 'FTFC Direction Play');
    check('the prompt carries exactly those 30 bars', (JSON.stringify(sent).match(/O:1 H:2/g) || []).length === 30);
  }

  // ===== 2. A blind reading is identifiable as blind ===================
  {
    // Bars present, in a shape this cannot open.
    const trade = { ticker: 'SPY', dir: 'Short', entryTimestamp: ENTRY, replayData: bars(36) };
    const r = await ai.classifyStrategy(trade);
    check('a reading with no chart says so rather than looking normal', r.sawCandles === 0);
    cron.applyClassificationToTrade(trade, r);
    check('and the trade carries that, so it can be told apart later', trade.stratSawCandles === 0);
    check('it is not simply left absent, which would read as "never asked"',
      Object.prototype.hasOwnProperty.call(trade, 'stratSawCandles'));
    check('and with nothing to read, the AI is not asked: no-data', r.setupReading.outcome === 'no-data');
  }

  // ===== 3. A trade with no replay at all ==============================
  {
    const trade = { ticker: 'SPY', dir: 'Short', entryTimestamp: ENTRY, replayData: null };
    const r = await ai.classifyStrategy(trade);
    cron.applyClassificationToTrade(trade, r);
    check('no replay at all is recorded as no chart', trade.stratSawCandles === 0);
  }

  // ===== 4. The count is what was SENT, not what was on the trade =====
  {
    sent = null;
    const trade = { ticker: 'SPY', dir: 'Short', entryTimestamp: ENTRY, replayData: { candles: bars(4) } };
    const r = await ai.classifyStrategy(trade);
    check('only the 4 bars before the entry are reported, not the 20 after', r.sawCandles === 4);
    check('and the prompt really did carry them', /O:1 H:2/.test(JSON.stringify(sent)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
