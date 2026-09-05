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

const bars = n => new Array(n).fill(0).map((_, i) => ({ open: 1, high: 2, low: 0.5, close: 1.5, datetime: i }));

(async () => {
  // ===== 1. A reading with a chart says how much chart it had ==========
  {
    const trade = { ticker: 'SPY', dir: 'Short', replayData: { candles: bars(36) } };
    const r = await ai.classifyStrategy(trade);
    check('a full reading reports the candles it saw', r.sawCandles === 15);
    cron.applyClassificationToTrade(trade, r);
    check('and that is written onto the trade', trade.stratSawCandles === 15);
    check('the tag itself still lands', trade.strat === '2-1-2 Continuation' && trade.play === 'FTFC Direction Play');
  }

  // ===== 2. A blind reading is identifiable as blind ===================
  {
    // Exactly the state every Alpaca-served trade was in: bars present,
    // in a shape this cannot open.
    const trade = { ticker: 'SPY', dir: 'Short', replayData: bars(36) };
    const r = await ai.classifyStrategy(trade);
    check('a reading with no chart says so rather than looking normal', r.sawCandles === 0);
    cron.applyClassificationToTrade(trade, r);
    check('and the trade carries that, so it can be told apart later', trade.stratSawCandles === 0);
    check('it is not simply left absent, which would read as "never asked"',
      Object.prototype.hasOwnProperty.call(trade, 'stratSawCandles'));
  }

  // ===== 3. A trade with no replay at all ==============================
  {
    const trade = { ticker: 'SPY', dir: 'Short', replayData: null };
    const r = await ai.classifyStrategy(trade);
    cron.applyClassificationToTrade(trade, r);
    check('no replay at all is recorded as no chart', trade.stratSawCandles === 0);
  }

  // ===== 4. The count is what was SENT, not what was on the trade =====
  {
    const trade = { ticker: 'SPY', dir: 'Short', replayData: { candles: bars(4) } };
    const r = await ai.classifyStrategy(trade);
    check('fewer candles than the fifteen it asks for is reported honestly', r.sawCandles === 4);
    check('and the prompt really did carry them', /O:1 H:2/.test(JSON.stringify(sent)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
