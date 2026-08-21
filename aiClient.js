const axios = require('axios');

// Gemini's free tier — no billing required. Uses schema-enforced JSON mode
// (responseSchema below), which guarantees the response matches the shape
// we ask for rather than just hoping the model formats it correctly.
const MODEL = 'gemini-2.5-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function callGemini(prompt, responseSchema, maxOutputTokens = 1000) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server.');
  const resp = await axios.post(GEMINI_API, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens,
    },
  }, {
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
  });
  const parts = (resp.data?.candidates?.[0]?.content?.parts) || [];
  return parts.map(p => p.text || '').join('').trim();
}

// Must match the exact data-v values used in index.html's Strat Setup
// cards — this is what lets an auto-classified trade show up correctly
// tagged in the Journal without any frontend changes.
const STRATEGIES = [
  { key: '2-1-2 Continuation', desc: 'An inside bar (1, price consolidating, neither side in control) forms after consolidation, then a directional bar (2, one side aggressive enough to take out one side of the previous bar) breaks one side, followed by another directional bar (2) continuing that SAME direction.' },
  { key: '2-1-2 Reversal', desc: 'An inside bar (1) forms after consolidation, then a directional bar (2) breaks one side, followed by a directional bar (2) breaking the OPPOSITE side instead.' },
  { key: '3-1-2 Reversal', desc: 'Played the same as a 2-1-2, but the first candle is an outside bar (3, takes out both sides of the previous candle\'s range) instead of a directional bar.' },
  { key: '2-2 Continuation', desc: 'Two directional bars (2) back to back in the SAME direction, with no inside bar between them.' },
  { key: '2-2 Reversal', desc: 'A directional bar (2) in one direction, immediately followed by a directional bar (2) in the OPPOSITE direction (e.g. a "2 down" candle then a "2 up" candle, or vice versa).' },
  { key: '3-2-2 Reversal', desc: 'Played the same as a 2-2 Reversal, but preceded by an outside bar (3). Stop is placed at 50% of the trigger candle.' },
  { key: '1-2-2 Rev Strat', desc: 'Played the same as a 2-2 Reversal, but starting from an inside bar (1) rather than directly from a directional bar — has an extra target because of that. Stop is placed at 50% of the trigger candle.' },
  { key: '1 Bar Rev Strat', desc: 'One single candle retraces to the 50% (halfway) level of the PREVIOUS candle\'s range, then reverses to take out the OPPOSITE side of that previous candle\'s range. Can occur after either a "2" or a "3" candle. This is the "50% Rule."' },
  { key: 'PMG', desc: 'Pivot Machine Gun — a reversal occurring after 5 or more consecutive lower highs, or 5 or more consecutive higher lows.' },
];

// FTFC alignment and Broadening Formation context are tracked separately
// from which of the above patterns was taken (ftfcConfirmed is already
// computed elsewhere, and offBroadeningFormation is a trader-set toggle) —
// they are NOT strategy names of their own. Taking any pattern above in
// FTFC's direction, or off a Broadening Formation, is still that pattern;
// this list only needs to identify the candle pattern itself.

const CLASSIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    strategy: { type: 'STRING', enum: [...STRATEGIES.map(s => s.key), 'unclear'] },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'STRING' },
  },
  required: ['strategy', 'confidence', 'reasoning'],
};

// Classifies a single newly-matched trade against the trader's own defined
// Strat setups. Uses the real candle shapes from the bar-replay data around
// entry — since these setups are literally defined by candle patterns,
// that's the most relevant signal available, more so than FTFC/price alone.
// Deliberately conservative: only returns a strategy when the model itself
// reports high confidence. A wrong auto-tag silently sitting in the
// Journal is worse than leaving a trade flagged "Needs Setup" for the
// trader to confirm by hand — this hasn't been tested at scale yet, so it
// should fail toward asking rather than guessing.
async function classifyStrategy(trade) {
  const candles = ((trade.replayData && trade.replayData.candles) || []).slice(-15);
  const candleSummary = candles.map(c => `O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ');

  const prompt = `You are classifying a single options trade against a trader's own pre-defined Strat-methodology candle patterns. Each pattern below is defined purely by candle shape (numbered "1"=inside bar, "2"=directional bar, "3"=outside bar, per the trader's own rules). Only classify with high confidence if the candle evidence clearly matches — if the data is ambiguous or doesn't clearly support any of them, say "unclear" honestly rather than guessing.

Defined patterns:
${STRATEGIES.map(s => `- "${s.key}": ${s.desc}`).join('\n')}

FTFC alignment and whether this was taken off a Broadening Formation are tracked separately elsewhere — they are not one of the choices above and should not affect which pattern you pick. They're included below only as extra context about the trade.

Trade data:
- Direction: ${trade.dir}
- FTFC confirmed: ${trade.ftfcConfirmed} (direction: ${trade.ftfcDirection || 'n/a'}, run: ${(trade.ftfcTimeframesInRun || []).join('→') || 'n/a'})
- Underlying price at entry: ${trade.undEntry}, at exit: ${trade.undExit}
- Last ~15 one-minute candles into entry: ${candleSummary || 'not available'}`;

  try {
    const text = await callGemini(prompt, CLASSIFY_SCHEMA, 300);
    const parsed = JSON.parse(text);
    if (parsed.strategy && parsed.strategy !== 'unclear' && parsed.confidence === 'high' && STRATEGIES.some(s => s.key === parsed.strategy)) {
      return { strategy: parsed.strategy, confidence: parsed.confidence, reasoning: parsed.reasoning };
    }
    console.log(`Strategy classification: not confident enough to auto-tag (confidence=${parsed.confidence}, strategy=${parsed.strategy}).`);
    return null;
  } catch (err) {
    console.log('Strategy classification failed:', err.response?.data || err.message);
    return null;
  }
}

const ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    insights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          body: { type: 'STRING' },
        },
        required: ['title', 'body'],
      },
    },
  },
  required: ['summary', 'insights'],
};

// The AI Analyst feature — server-side, same as classification, so the key
// never has to live in the browser.
async function runPortfolioAnalysis(trades) {
  const compact = trades.map(t => ({
    ticker: t.ticker, dir: t.dir, strat: t.strat, entryDate: t.entryDate, exitDate: t.exitDate,
    optEntry: t.optEntry, optExit: t.optExit, undEntry: t.undEntry, undExit: t.undExit,
    stop: t.stop, rrPlanned: t.rrPlanned, ftfcConfirmed: t.ftfcConfirmed, ftfcRun: t.ftfcRun,
    pnlDollar: t.pnlDollar != null ? Math.round(t.pnlDollar * 100) / 100 : null,
    pnlPercent: t.pnlPercent != null ? Math.round(t.pnlPercent * 10) / 10 : null,
    winLoss: t.winLoss, notes: t.notes,
  }));

  const prompt = `You are a trading performance analyst reviewing a trader's Strat-methodology options journal.
Data (JSON array of trades): ${JSON.stringify(compact)}

Analyze for:
1. Most profitable vs least profitable Strat setup types (by $ and win rate)
2. Whether FTFC-confirmed trades outperform non-confirmed ones
3. Signs of late or early entries (infer from notes and stop/entry/exit spread)
4. Trades taken with planned R:R below 2:1 and how those performed vs trades at/above 2:1
5. Signs the trader exited before a reasonable target (infer from notes and small realized gains relative to planned R:R)
6. One or two concrete, specific recommendations

Write "summary" as a 2-3 sentence overview, and "insights" as a list of specific, data-grounded findings — not generic advice.`;

  const text = await callGemini(prompt, ANALYSIS_SCHEMA, 1200);
  return JSON.parse(text);
}

module.exports = { classifyStrategy, runPortfolioAnalysis, STRATEGIES };
