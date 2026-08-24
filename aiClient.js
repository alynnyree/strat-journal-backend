const axios = require('axios');

// Gemini's free tier — no billing required. Uses schema-enforced JSON mode
// (responseSchema below), which guarantees the response matches the shape
// we ask for rather than just hoping the model formats it correctly.
const MODEL = 'gemini-2.5-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// imageParts (optional): array of {mimeType, data} (data = raw base64, no
// "data:...;base64," prefix) — Gemini reads these as inlineData parts
// alongside the text prompt, same request, same model. Order doesn't
// matter to the model; text goes first here just to keep the request body
// readable in logs.
async function callGemini(prompt, responseSchema, maxOutputTokens = 1000, imageParts = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server.');
  const parts = [{ text: prompt }, ...imageParts.map(p => ({ inlineData: { mimeType: p.mimeType, data: p.data } }))];
  const resp = await axios.post(GEMINI_API, {
    contents: [{ parts }],
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
  const responseParts = (resp.data?.candidates?.[0]?.content?.parts) || [];
  return responseParts.map(p => p.text || '').join('').trim();
}

// Screenshots arrive from the frontend as data: URLs (e.g.
// "data:image/jpeg;base64,/9j/4AAQ...") — the same format the phone-side
// Shortcut's upload gets converted to on the way in (see media.js) and
// then carried on the trade object from that point on. Splits that back
// into the {mimeType, data} shape Gemini's inlineData wants. Returns null
// for anything that isn't a well-formed image data URL, so a corrupt or
// unexpected value just gets skipped rather than crashing the request.
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
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

// Shared by both the real automatic classifier and the sandbox "Test
// Classification" tool — builds the same prompt, calls Gemini, and always
// returns the raw result (never null), so callers decide for themselves
// whether/how to act on a low-confidence or "unclear" answer. Throws on a
// genuine failure (network error, malformed response) rather than
// swallowing it, so a caller that wants to surface real errors (like the
// test tool) can.
//
// Uses the real candle shapes from the bar-replay data around entry —
// since these setups are literally defined by candle patterns, that's the
// most relevant signal available, more so than FTFC/price alone. When a
// screenshot exists (trade.shotEntry, or trade.shotExit as a fallback), or
// a freeform description (trade.testDescription — only ever set by the
// test tool, never a real trade), it's included as extra evidence.
async function runClassification(trade) {
  const candles = ((trade.replayData && trade.replayData.candles) || []).slice(-15);
  const candleSummary = candles.map(c => `O:${c.open} H:${c.high} L:${c.low} C:${c.close}`).join(' | ');

  // Entry screenshot preferred — it's the chart at the moment the setup was
  // actually taken, matching what the candle data above already looks at.
  // Falls back to the exit screenshot only if no entry shot exists, since
  // some visual context is better than none.
  const screenshotSource = trade.shotEntry ? 'entry' : (trade.shotExit ? 'exit' : null);
  const imagePart = screenshotSource ? parseImageDataUrl(trade.shotEntry || trade.shotExit) : null;

  const prompt = `You are classifying a single options trade against a trader's own pre-defined Strat-methodology candle patterns. Each pattern below is defined purely by candle shape (numbered "1"=inside bar, "2"=directional bar, "3"=outside bar, per the trader's own rules). Only classify with high confidence if the evidence clearly matches — if the data is ambiguous or doesn't clearly support any of them, say "unclear" honestly rather than guessing.

Defined patterns:
${STRATEGIES.map(s => `- "${s.key}": ${s.desc}`).join('\n')}

FTFC alignment and whether this was taken off a Broadening Formation are tracked separately elsewhere — they are not one of the choices above and should not affect which pattern you pick. They're included below only as extra context about the trade.

Trade data:
- Direction: ${trade.dir || 'n/a'}
- FTFC confirmed: ${trade.ftfcConfirmed == null ? 'n/a' : (trade.ftfcConfirmed ? 'Yes' : 'No')} (direction: ${trade.ftfcDirection || 'n/a'}, run: ${(trade.ftfcTimeframesInRun || []).join('→') || 'n/a'})
- Taken off a Broadening Formation: ${trade.offBroadeningFormation == null ? 'n/a' : (trade.offBroadeningFormation ? 'Yes' : 'No')}
- Underlying price at entry: ${trade.undEntry ?? 'n/a'}, at exit: ${trade.undExit ?? 'n/a'}
- Last ~15 one-minute candles into entry: ${candleSummary || 'not available'}
${imagePart ? `- An attached screenshot/photo of the trader's own chart at ${screenshotSource === 'entry' ? 'entry' : 'exit (no entry screenshot was available)'} is included below — use it as supporting visual evidence for the candle pattern and any drawn lines/indicators visible on it, weighed together with the candle data above, not in place of it.` : '- No screenshot is available for this trade — classify from the candle data alone.'}${trade.testDescription ? `\n- The trader's own written description of the setup: "${trade.testDescription}"` : ''}`;

  // 300 was too tight — a real image plus a full "reasoning" explanation
  // can run past that and get cut off mid-JSON, which then fails to parse
  // and looks like a mystery server error with no useful detail. Never
  // caught in testing before this, since every test here used a short,
  // hand-written stand-in response instead of a real Gemini call against
  // a real photo.
  const text = await callGemini(prompt, CLASSIFY_SCHEMA, 800, imagePart ? [imagePart] : []);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini's response wasn't valid JSON (likely cut off before finishing) — raw response: ${text.slice(0, 300)}`);
  }
  return { strategy: parsed.strategy, confidence: parsed.confidence, reasoning: parsed.reasoning, usedScreenshot: !!imagePart };
}

// Classifies a single newly-matched trade against the trader's own defined
// Strat setups. Deliberately conservative: only returns a strategy when
// the model itself reports high confidence. A wrong auto-tag silently
// sitting in the Journal is worse than leaving a trade flagged "Needs
// Setup" for the trader to confirm by hand — this hasn't been tested at
// scale yet, so it should fail toward asking rather than guessing.
async function classifyStrategy(trade) {
  try {
    const result = await runClassification(trade);
    if (result.strategy && result.strategy !== 'unclear' && result.confidence === 'high' && STRATEGIES.some(s => s.key === result.strategy)) {
      return result;
    }
    console.log(`Strategy classification: not confident enough to auto-tag (confidence=${result.confidence}, strategy=${result.strategy}, usedScreenshot=${result.usedScreenshot}).`);
    return null;
  } catch (err) {
    console.log('Strategy classification failed:', err.response?.data || err.message);
    return null;
  }
}

// Sandbox version for the "Test Classification" tool (index.html) — always
// returns the model's real answer, even "unclear" or low confidence, since
// the whole point is to see what the AI actually thinks so the owner can
// judge it, not to silently hide anything below the high-confidence bar.
// Errors are NOT swallowed here — they're left for the route calling this
// to report back to whoever's testing, instead of failing silently.
async function testClassifyStrategy(trade) {
  return runClassification(trade);
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

module.exports = { classifyStrategy, testClassifyStrategy, runPortfolioAnalysis, STRATEGIES };
