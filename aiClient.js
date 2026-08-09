const axios = require('axios');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
// Corrected from the old frontend code's 'claude-sonnet-4-6', which isn't
// a current model string — the current Sonnet-tier model is 'claude-sonnet-5'.
const MODEL = 'claude-sonnet-5';

async function callClaude(prompt, maxTokens = 1000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const resp = await axios.post(ANTHROPIC_API, {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });
  return (resp.data.content || []).map(c => c.text || '').join('\n').trim();
}

// Must match the exact data-v values used in index.html's Strat Setup
// cards — this is what lets an auto-classified trade show up correctly
// tagged in the Journal without any frontend changes.
const STRATEGIES = [
  { key: '2-2 Reversal', desc: 'A "2" candle turning into a "3" (outside bar) on the working timeframe.' },
  { key: 'FTFC Continuation', desc: 'Setup in the direction of Full Time Frame Continuity, targeting setup completion, unfilled gaps, or pivots.' },
  { key: 'Broadening Reversal', desc: 'Clear broadening formation on a higher TF (15m-4H) + liquidity taken out, reversing on a lower TF Strat setup (1m-5m).' },
];

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

  const prompt = `You are classifying a single options trade against a trader's own pre-defined Strat-methodology setups. Only classify if the evidence clearly matches — if the data is ambiguous or doesn't clearly support any of them, say so honestly rather than guessing.

Defined setups:
${STRATEGIES.map(s => `- "${s.key}": ${s.desc}`).join('\n')}

Trade data:
- Direction: ${trade.dir}
- FTFC confirmed: ${trade.ftfcConfirmed} (direction: ${trade.ftfcDirection || 'n/a'}, run: ${(trade.ftfcTimeframesInRun || []).join('→') || 'n/a'})
- Underlying price at entry: ${trade.undEntry}, at exit: ${trade.undExit}
- Last ~15 one-minute candles into entry: ${candleSummary || 'not available'}

Respond ONLY as JSON, no markdown fences:
{"strategy": "<one of the exact setup key strings above, or null if unclear>", "confidence": "<high|medium|low>", "reasoning": "<1-2 sentences>"}`;

  try {
    let text = await callClaude(prompt, 300);
    text = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.strategy && parsed.confidence === 'high' && STRATEGIES.some(s => s.key === parsed.strategy)) {
      return { strategy: parsed.strategy, confidence: parsed.confidence, reasoning: parsed.reasoning };
    }
    console.log(`Strategy classification: not confident enough to auto-tag (confidence=${parsed.confidence}, strategy=${parsed.strategy}).`);
    return null;
  } catch (err) {
    console.log('Strategy classification failed:', err.response?.data || err.message);
    return null;
  }
}

// The AI Analyst feature — moved server-side. The previous frontend
// implementation called Anthropic directly from the browser with no API
// key attached at all, which is why "Analyze My Trades" never actually
// worked; browsers also can't call Anthropic's API directly regardless,
// due to CORS.
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

Respond ONLY as JSON, no markdown fences, in this exact shape:
{"summary": "2-3 sentence overview", "insights": [{"title": "short title", "body": "2-4 sentences, specific and grounded in the data, not generic advice"}]}`;

  let text = await callClaude(prompt, 1200);
  text = text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

module.exports = { classifyStrategy, runPortfolioAnalysis, STRATEGIES };
