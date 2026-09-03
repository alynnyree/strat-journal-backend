const axios = require('axios');

// Gemini's free tier — no billing required. Uses schema-enforced JSON mode
// (responseSchema below), which guarantees the response matches the shape
// we ask for rather than just hoping the model formats it correctly.
// Updated 2026-08-23: gemini-2.5-flash started rejecting requests from
// newer API keys/projects with "no longer available to new users" —
// Google's own error response named this replacement directly.
const MODEL = 'gemini-3.6-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Which failures are worth trying again on their own, versus which are a
// real problem no amount of retrying will fix.
//
// Retry: Gemini capacity/rate limits (429, 503 "high demand" — the exact
// message the owner hit on 2026-08-23), Google-side server errors (500,
// 502, 504), and raw network failures (no HTTP response at all — timeouts,
// dropped connections).
// Never retry: a bad API key (401/403), a malformed request (400), or a
// model that doesn't exist (404) — those fail identically every time, and
// retrying only delays showing the owner the real reason.
function isRetryableGeminiError(err) {
  const status = err.response?.status;
  if (status == null) return true; // no response at all = network/timeout
  return status === 429 || status >= 500;
}

const RETRY_DELAYS_MS = [1000, 2500]; // 3 attempts total; kept short so the phone's own request doesn't time out waiting on us

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// imageParts (optional): array of {mimeType, data} (data = raw base64, no
// "data:...;base64," prefix) — Gemini reads these as inlineData parts
// alongside the text prompt, same request, same model. Order doesn't
// matter to the model; text goes first here just to keep the request body
// readable in logs.
//
// Retries transient failures automatically (see isRetryableGeminiError).
// Added 2026-08-23 after the owner hit Gemini's "currently experiencing
// high demand" response and had to sit and manually retry — exactly the
// kind of thing the server should absorb silently instead of surfacing.
// Marks an error as "the model ran out of room before finishing its
// answer" so callers can retry with a bigger budget instead of treating it
// like a permanent failure.
class TruncatedResponseError extends Error {
  constructor(message) {
    super(message);
    this.truncated = true;
  }
}

async function callGemini(prompt, responseSchema, maxOutputTokens = 1000, imageParts = [], opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server.');
  // Each attachment can carry a `label` — a short text part emitted just
  // before it. Without labels, several images in one request are an
  // unlabelled pile and the model has no way to tell the chart it is
  // being asked about from the past-correction charts travelling with it.
  const parts = [{ text: prompt }];
  for (const p of imageParts) {
    if (p.label) parts.push({ text: p.label });
    parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
  }

  // Newer Gemini models "think" before answering, and that internal
  // reasoning is billed against the SAME maxOutputTokens budget as the
  // visible answer. On 2026-08-23 this silently ate a 1200-token budget
  // and left ~20 tokens for the real response, which then arrived cut off
  // mid-word and failed to parse. These are structured classification
  // calls with a schema already enforcing the shape — they don't need
  // chain-of-thought — so thinking is disabled by default here.
  //
  // `disableThinking: false` opts back in (used automatically as a
  // fallback if a model rejects the parameter outright).
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema,
    maxOutputTokens,
  };
  if (opts.disableThinking !== false) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const resp = await axios.post(GEMINI_API, {
        contents: [{ parts }],
        generationConfig,
      }, {
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        timeout: 60000, // don't hang forever on a stalled connection; a real call with an image is well under this
      });
      const candidate = resp.data?.candidates?.[0];
      const responseParts = candidate?.content?.parts || [];
      const text = responseParts.map(p => p.text || '').join('').trim();

      // Gemini says so explicitly when it stopped because it hit the
      // ceiling. Catching it here means the caller can retry with more
      // room, rather than the truncated text failing later as a confusing
      // "not valid JSON" error the way it did on 2026-08-23.
      if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new TruncatedResponseError(`Gemini ran out of output room (maxOutputTokens=${maxOutputTokens}) before finishing.`);
      }
      if (!text) {
        throw new TruncatedResponseError(`Gemini returned an empty response (finishReason=${candidate?.finishReason || 'unknown'}).`);
      }
      return text;
    } catch (err) {
      lastErr = err;

      // Some models don't accept thinkingConfig. Drop it and retry on ANY
      // 400 while it's set, rather than trying to pattern-match the error
      // text: gemini-3.6-flash rejects it with a generic "Request contains
      // an invalid argument" that says nothing about thinking, so an
      // earlier version of this check (matching on the word "thinking")
      // never fired and the whole call failed. thinkingConfig is by far
      // the most likely cause of a 400 here — the rest of the request is
      // unchanged from calls that were already working — and if the real
      // cause is something else, the retry below simply fails the same
      // way and surfaces the same message.
      if (err.response?.status === 400 && generationConfig.thinkingConfig) {
        const detail = err.response?.data?.error?.message || err.message;
        console.log(`Gemini rejected the request with thinkingConfig set (${detail}) — retrying without it.`);
        delete generationConfig.thinkingConfig;
        // Correcting the request isn't a "retry" — don't spend one of the
        // transient-failure attempts on it. Safe from looping: the guard
        // above requires thinkingConfig to be set, and it was just deleted.
        attempt--;
        continue;
      }

      // A truncated answer is not a transient network problem — retrying
      // the same request unchanged would just truncate again. Hand it
      // straight back so the caller can retry with a bigger budget.
      if (err.truncated) break;

      const canRetry = attempt < RETRY_DELAYS_MS.length && isRetryableGeminiError(err);
      if (!canRetry) break;
      const detail = err.response?.data?.error?.message || err.message;
      console.log(`Gemini call failed (attempt ${attempt + 1}), retrying in ${RETRY_DELAYS_MS[attempt]}ms: ${detail}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

// Calls Gemini and parses the JSON, automatically retrying with a bigger
// output budget if the answer came back cut off. Every caller here wants
// exactly this — a complete, parsed object — and the truncation failure
// mode is the one that actually bit the owner in practice, so it's
// handled once here rather than repeated (and forgotten) at each call.
async function callGeminiJson(prompt, responseSchema, maxOutputTokens, imageParts = []) {
  const budgets = [maxOutputTokens, maxOutputTokens * 2];
  let lastErr;
  for (const budget of budgets) {
    try {
      const text = await callGemini(prompt, responseSchema, budget, imageParts);
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        // Schema-enforced JSON mode makes malformed-but-complete output
        // very unlikely, so an unparseable body almost always means it was
        // cut short. Treat it as truncation so the bigger-budget retry
        // below gets a chance.
        throw new TruncatedResponseError(`Gemini's response wasn't valid JSON (likely cut off before finishing) — raw response: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      lastErr = err;
      if (!err.truncated) throw err; // a real failure — don't waste a second call on it
      console.log(`Gemini response was cut off at ${budget} tokens; retrying with more room.`);
    }
  }
  throw lastErr;
}

// Screenshots arrive from the frontend as data: URLs (e.g.
// "data:image/jpeg;base64,/9j/4AAQ...") — the same format the phone-side
// Shortcut's upload gets converted to on the way in (see media.js) and
// then carried on the trade object from that point on. Splits that back
// into the {mimeType, data} shape Gemini's inlineData wants. Returns null
// for anything that isn't a well-formed image data URL, so a corrupt or
// unexpected value just gets skipped rather than crashing the request.
//
// Video is accepted too (test-tool uploads only — real trades only ever
// carry still screenshots). iOS hands .mov files over as
// "video/quicktime", which is the same container Gemini lists as
// "video/mov", so it's renamed rather than rejected.
const VIDEO_MIME_ALIASES = { 'video/quicktime': 'video/mov' };

function parseMediaDataUrl(dataUrl, { allowVideo = false } = {}) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const rawMime = match[1].toLowerCase();
  if (rawMime.startsWith('image/')) return { mimeType: rawMime, data: match[2] };
  if (allowVideo && rawMime.startsWith('video/')) {
    return { mimeType: VIDEO_MIME_ALIASES[rawMime] || rawMime, data: match[2] };
  }
  return null;
}

function parseImageDataUrl(dataUrl) {
  return parseMediaDataUrl(dataUrl);
}

// Must match the exact data-v values used in index.html's Strat Setup
// cards — this is what lets an auto-classified trade show up correctly
// tagged in the Journal without any frontend changes.
// The three PLAYS the owner actually takes — how he chooses a trade, as
// distinct from the candle combo he sees. These sit ALONGSIDE the nine
// combos, never instead of them: a trade has a combo AND a play. His
// words, 2026-08-29: "These strategies are in conjunction with the 9
// strat combos. Nothing should be disregarded."
//
// All three carry the same target — reward at least twice the risk.
const PLAYS = [
  { key: 'Broadening Formation Scalp',
    desc: 'A broadening formation on a higher timeframe. Drop to the 1-minute or 5-minute to scalp it, entering at one edge and targeting the OTHER side of the broadening formation. Reward at least 2x the risk.' },
  { key: 'FTFC Direction Play',
    desc: 'A Strat setup taken in the direction the timeframes already agree on (FTFC). First target is completion of the setup itself; second target is a gap or a major pivot point. Once a pivot point or the liquidity behind it has been taken out, looking to reverse. Reward at least 2x the risk.' },
  { key: '2s Turning Into 3s',
    desc: 'A directional bar (2) that expands into an outside bar (3) — one side taken out, then the other, so the bar takes out both sides of the previous range. Reward at least 2x the risk.' },
];

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
    // The play is a SEPARATE answer from the combo. A trade has both, and
    // each is allowed to be unclear without dragging the other down.
    play: { type: 'STRING', enum: [...PLAYS.map(p => p.key), 'unclear'] },
    playConfidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    playReasoning: { type: 'STRING' },
    // HIS OWN NOTATION. He told me on 2026-08-31: "I don't look at 2-2 as
    // 2-2 reversals or 2-2 continuations, I look at them as 2U-2D
    // (Bearish) or 2D-2U (Bullish). This applies to every combo." The
    // combo name stays as the thing performance is grouped by, because
    // renaming nine setups would relabel every trade he already has —
    // but the notation is what he actually reads, so it is asked for and
    // shown.
    notation: { type: 'STRING' },
    notationDirection: { type: 'STRING', enum: ['Bullish', 'Bearish', 'unclear'] },
    // Read by the model itself now. Until 2026-08-31 this was deliberately
    // NOT attempted — a Broadening Formation was called a multi-step
    // judgement call and left as his manual toggle. He has now asked for
    // the opposite: the AI must spot one itself, because it cannot pick
    // "Broadening Formation Scalp" as the play otherwise. His own toggle
    // is untouched and always wins; this is recorded beside it.
    broadeningFormation: { type: 'STRING', enum: ['yes', 'no', 'unclear'] },
    broadeningReasoning: { type: 'STRING' },
  },
  required: ['strategy', 'confidence', 'reasoning', 'play', 'playConfidence', 'playReasoning',
             'notation', 'notationDirection', 'broadeningFormation', 'broadeningReasoning'],
};

// The Test Classification tool's own schema — three separate layered
// answers instead of one, matching how the trader actually thinks about a
// setup: which candle combo it is, whether the timeframes are aligned
// (FTFC), and whether it's happening inside a Broadening Formation. All
// three are read from the chart itself here.
//
// This is a deliberate departure from the real trade classifier, where
// FTFC is computed mechanically from Schwab candle data and Broadening
// Formation is a manual toggle the trader sets himself (see task 10's
// finding that a Broadening Formation is a genuine multi-step judgment
// call). Here there is no Schwab data and no trade — only a picture — so
// the model is asked to read all three visually, and to say "unclear"
// rather than guess on any of them independently.
const TEST_CLASSIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    strategy: { type: 'STRING', enum: [...STRATEGIES.map(s => s.key), 'unclear'] },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'STRING' },
    // Timeframe continuity is not a yes/no question in the owner's method
    // — his rule confirms it at any 4+ CONSECUTIVE timeframes agreeing,
    // so a run of two or three is a real, readable state that a yes/no
    // answer was throwing away. "partial" is that state.
    ftfc: { type: 'STRING', enum: ['confirmed', 'partial', 'none', 'unclear'] },
    // A short per-timeframe read ("1m up, 5m up, 15m up, 1H down"), so a
    // wrong call can be corrected on the specific timeframe that was
    // misread rather than on the verdict as a whole.
    ftfcTimeframes: { type: 'STRING' },
    ftfcReasoning: { type: 'STRING' },
    broadeningFormation: { type: 'STRING', enum: ['yes', 'no', 'unclear'] },
    broadeningReasoning: { type: 'STRING' },
  },
  required: ['strategy', 'confidence', 'reasoning', 'ftfc', 'ftfcTimeframes', 'ftfcReasoning', 'broadeningFormation', 'broadeningReasoning'],
};

// Shared by both the real automatic classifier and the sandbox "Test
// Turns the owner's saved Test Classification corrections into a block of
// worked examples for the prompt.
//
// This is what makes the journal "learn" from the test tool, and it's
// worth being precise about the mechanism: the AI model itself has NO
// memory between calls and is never modified by anything we do. What
// actually happens is that the journal remembers the corrections and
// re-teaches the model on every single request. The practical effect
// matches the goal — the more the owner corrects in the test tool, the
// better real trades get classified — because these examples encode HIS
// readings of these patterns, which generic instructions can't.
//
// Pictures ride along too, but on a much tighter budget than the text.
// The asymmetry is the whole point of the design: text corrections are
// cheap enough that 20 of them barely register, whereas every attached
// picture is re-uploaded and re-read on EVERY future classification. So
// the text budget is wide and the picture budget is deliberately narrow:
//   - only CORRECTIONS carry pictures (a confirmed-correct read teaches
//     little that its text doesn't already say),
//   - at most MAX_TEACHING_IMAGES of them, newest first,
//   - and only the small `teachImage` copy the phone makes at save time,
//     never the full-size original, which stays in the log for viewing.
// A hard byte ceiling sits under all of that as a backstop, so no single
// oversized entry can quietly make every classification slow.
const MAX_TEACHING_IMAGES = 4;
const MAX_TEACHING_IMAGE_BYTES = 600 * 1024; // combined, base64 as sent

function formatTeachingExamples(examples) {
  return buildTeaching(Array.isArray(examples) ? { examples } : examples).text;
}

// Returns { text, imageParts } — the written corrections, plus whichever
// of their charts earned a place inside the picture budget above.
function buildTeaching({ examples, digest = '', total = 0 } = {}) {
  if ((!examples || !examples.length) && !digest) return { text: '', imageParts: [] };
  examples = examples || [];
  const yn = v => v === true ? 'yes' : (v === false ? 'no' : v);
  // Continuity answers changed from yes/no to a four-state answer, so old
  // saved values are translated rather than dropped.
  let ftfcOf = v => (v === true ? 'confirmed' : (v === false ? 'none' : v));
  try { ftfcOf = require('./aiTestFeedback').normaliseFtfc || ftfcOf; } catch (e) { /* keep the local fallback */ }

  // Decide the pictures FIRST, so each example's text can say whether its
  // chart is attached and which numbered teaching chart it is.
  const imageParts = [];
  const attachedIndexById = new Map();
  let budget = MAX_TEACHING_IMAGE_BYTES;
  for (const f of examples) {
    if (imageParts.length >= MAX_TEACHING_IMAGES) break;
    if (f.wasCorrect !== false) continue; // corrections only
    const part = parseMediaDataUrl(f.teachImage);
    if (!part) continue; // no small copy saved (older entries, or a video upload)
    if (part.data.length > budget) continue;
    budget -= part.data.length;
    const n = imageParts.length + 1;
    attachedIndexById.set(f.id, n);
    imageParts.push({ ...part, label: `TEACHING CHART ${n} — a PAST chart the trader corrected. This is reference material only. Do NOT classify this one.` });
  }

  const lines = examples.map((f, i) => {
    const predicted = `combo ${f.predictedStrategy || 'unclear'}`
      + (f.predictedFtfc ? `, timeframe continuity ${ftfcOf(f.predictedFtfc)}` : '')
      + (f.predictedFtfcTimeframes ? ` (read as: ${f.predictedFtfcTimeframes})` : '')
      + (f.predictedBroadeningFormation ? `, Broadening Formation ${f.predictedBroadeningFormation}` : '');
    if (f.wasCorrect === false) {
      const actual = `combo ${f.actualStrategy || 'unclear'}`
        + (f.actualFtfc != null ? `, timeframe continuity ${ftfcOf(f.actualFtfc)}` : '')
        + (f.actualFtfcTimeframes ? ` (he reads the timeframes as: ${f.actualFtfcTimeframes})` : '')
        + (f.actualBroadeningFormation != null ? `, Broadening Formation ${yn(f.actualBroadeningFormation)}` : '');
      const shotNo = attachedIndexById.get(f.id);
      return `${i + 1}. WRONG — the AI read it as: ${predicted}\n   The trader says it was actually: ${actual}`
        + (f.userNotes ? `\n   The trader's explanation: "${f.userNotes}"` : '')
        + (f.description ? `\n   The chart was described as: "${f.description}"` : '')
        + (shotNo ? `\n   Its chart is attached as TEACHING CHART ${shotNo} — look at it to see what he actually meant.` : '');
    }
    return `${i + 1}. RIGHT — the AI read it as: ${predicted}, and the trader confirmed that was correct.`
      + (f.description ? `\n   The chart was described as: "${f.description}"` : '');
  });

  const text = `${digest}${examples.length ? `

THE MOST RECENT CORRECTIONS IN FULL — study these before answering.
These are real charts this same AI classified previously, followed by the trader's own verdict. They show how HE reads these patterns, which matters more than any general definition. Where a past reading was marked wrong, do not repeat that same mistake here.${total > examples.length ? ` (These ${examples.length} are the latest of ${total}; the running summary above covers all of them.)` : ''}
${lines.join('\n')}` : ''}${imageParts.length ? `
Some of those corrections have their chart attached, labelled TEACHING CHART 1 to ${imageParts.length}. Those are PAST examples for reference only — never classify one of them. Your answer must be about the chart labelled as the one to classify (or, if none is attached, about the written description).` : ''}
`;
  return { text, imageParts };
}

// Loads the corrections, never letting a failure there break the actual
// classification — teaching examples are an improvement, not a
// requirement, so a Redis hiccup should degrade to "classify without
// them" rather than fail the trade.
async function loadTeachingBlock() {
  try {
    const { getTeachingExamples } = require('./aiTestFeedback');
    return buildTeaching(await getTeachingExamples());
  } catch (err) {
    console.log('Could not load teaching examples (classifying without them):', err.message);
    return { text: '', imageParts: [] };
  }
}

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
  const teaching = await loadTeachingBlock();
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

FTFC alignment and Broadening Formation are still NOT patterns — the nine above remain the only valid answers for the combo. But as of 2026-08-31 the trader has asked that you USE them as supporting evidence when the bars alone leave the combo genuinely ambiguous. The timeframe alignment below was measured from real price data at the minute he entered, so it is evidence, not a guess. Weigh it; never let it override what the bars plainly show.

ALSO REPORT THE COMBO IN HIS OWN NOTATION. He does not read "2-2 Reversal" or "2-2 Continuation" — he reads the direction of each bar:
  2U = a directional bar that took out the previous bar's HIGH
  2D = a directional bar that took out the previous bar's LOW
  1  = an inside bar   ·   3 = an outside bar
So a bearish 2-2 reversal is "2U-2D" and a bullish one is "2D-2U"; a bullish 2-1-2 continuation is "2U-1-2U". This applies to EVERY combo. Put the bar sequence you actually read in 'notation' using exactly that form (hyphen-separated, e.g. "2U-1-2D", "3-2D-2U"), and put Bullish or Bearish in 'notationDirection'. If you cannot read the individual bars confidently, set notation to "unclear".

AND JUDGE THE BROADENING FORMATION YOURSELF. Look for a compound outside bar structure — successively wider swings making both higher highs AND lower lows, so price is expanding from a central axis rather than trending. Answer yes, no, or unclear in 'broadeningFormation', and say what you saw in 'broadeningReasoning'. This matters beyond context: "Broadening Formation Scalp" is one of his three plays, and you cannot choose it without recognising the formation. If the trader has set his own Broadening toggle (shown below), treat his answer as the truth and say so in your reasoning — yours is recorded alongside his, never over it.

Trade data:
- Direction: ${trade.dir || 'n/a'}
- FTFC confirmed: ${trade.ftfcConfirmed == null ? 'n/a' : (trade.ftfcConfirmed ? 'Yes' : 'No')} (direction: ${trade.ftfcDirection || 'n/a'}, run: ${(trade.ftfcTimeframesInRun || []).join('→') || 'n/a'})
- Taken off a Broadening Formation: ${trade.offBroadeningFormation == null ? 'n/a' : (trade.offBroadeningFormation ? 'Yes' : 'No')}
- Underlying price at entry: ${trade.undEntry ?? 'n/a'}, at exit: ${trade.undExit ?? 'n/a'}
- Last ~15 one-minute candles into entry: ${candleSummary || 'not available'}

SECOND QUESTION, answered separately. Which of the trader's three PLAYS was this? The play is HOW he chose the trade; the combo above is WHAT he saw. A trade has both, and they are independent — answer "unclear" for this one if the evidence does not support a choice, even where the combo is obvious.
${PLAYS.map(p => `- "${p.key}": ${p.desc}`).join('\n')}

${imagePart ? `- An attached screenshot/photo of the trader's own chart at ${screenshotSource === 'entry' ? 'entry' : 'exit (no entry screenshot was available)'} is included below — use it as supporting visual evidence for the candle pattern and any drawn lines/indicators visible on it, weighed together with the candle data above, not in place of it.` : '- No screenshot is available for this trade — classify from the candle data alone.'}${trade.testDescription ? `\n- The trader's own written description of the setup: "${trade.testDescription}"` : ''}${teaching.text}`;

  // 300 was too tight — a real image plus a full "reasoning" explanation
  // can run past that and get cut off mid-JSON, which then fails to parse
  // and looks like a mystery server error with no useful detail. Never
  // caught in testing before this, since every test here used a short,
  // hand-written stand-in response instead of a real Gemini call against
  // a real photo.
  const attachments = [];
  if (imagePart) attachments.push({ ...imagePart, label: 'THE CHART TO CLASSIFY — this trade\'s own screenshot. Your answer is about this one.' });
  attachments.push(...teaching.imageParts);
  const parsed = await callGeminiJson(prompt, CLASSIFY_SCHEMA, 6000, attachments);
  // Everything the model was asked for, not a hand-picked three.
  //
  // This line used to return strategy, confidence and reasoning only. The
  // PLAY was added to the schema on 2026-08-29, the model has been
  // answering it ever since, and this threw it away every single time --
  // so classifyStrategy always saw result.play as undefined, always failed
  // its check, and always set the play to null. Not one trade could ever
  // have been given a play by the automatic reading. Same shape of fault
  // as the others in CLAUDE.md: a second answer added later, invisible to
  // code written for the first.
  return { ...parsed, usedScreenshot: !!imagePart };
}

// Classifies a single newly-matched trade against the trader's own defined
// Strat setups. Deliberately conservative: only returns a strategy when
// the model itself reports high confidence. A wrong auto-tag silently
// sitting in the Journal is worse than leaving a trade flagged "Needs
// Setup" for the trader to confirm by hand — this hasn't been tested at
// scale yet, so it should fail toward asking rather than guessing.
// The one bar both the real tagging and the full-test rehearsal judge
// confidence by, so they can never drift apart. Mutates the result to null
// out anything that did not clear the bar, and reports what survived. The
// combo and the play are judged on their own merits: a confident combo
// with an unsure play still gets the combo, and the other way round.
function applyConfidenceBar(result) {
  const playOk = result.play && result.play !== 'unclear'
    && result.playConfidence === 'high' && PLAYS.some(p => p.key === result.play);
  if (!playOk) { result.play = null; result.playConfidence = null; }
  const comboOk = result.strategy && result.strategy !== 'unclear'
    && result.confidence === 'high' && STRATEGIES.some(s => s.key === result.strategy);
  if (!comboOk) { result.strategy = null; }
  return { comboOk, playOk };
}

async function classifyStrategy(trade) {
  try {
    const result = await runClassification(trade);
    const { comboOk, playOk } = applyConfidenceBar(result);
    if (comboOk || playOk) return result;
    console.log(`Strategy classification: not confident enough to auto-tag (confidence=${result.confidence}, strategy=${result.strategy}, usedScreenshot=${result.usedScreenshot}).`);
    return null;
  } catch (err) {
    console.log('Strategy classification failed:', err.response?.data || err.message);
    return null;
  }
}

// The full-test rehearsal's version. Unlike classifyStrategy, it must tell
// three outcomes apart rather than two:
//   - the AI could not be reached          -> it THROWS (a real failure)
//   - the AI read the chart and was sure   -> reached:true, tagged:true
//   - the AI read the chart and was unsure -> reached:true, tagged:false
// That last one is NOT a failure. At a random minute there may simply be
// no setup, and the AI honestly saying so proves the whole transfer works
// -- candles in, a real structured answer back. Only silence proves it
// broken. classifyStrategy folds the last two together into null, which
// made an empty minute look like a broken reader.
async function classifyForTest(trade) {
  const result = await runClassification(trade);   // throws only if the AI cannot be reached
  const { comboOk, playOk } = applyConfidenceBar(result);
  return { reached: true, tagged: comboOk || playOk, result };
}

// Sandbox version for the "Test Classification" tool (index.html).
//
// Rewritten 2026-08-23 after the first real run came back "unclear," with
// the model correctly explaining why: it was being handed the REAL TRADE
// classifier's prompt, which asks "what setup was this trade?" and leans
// on knowing which bar triggered the entry. In the test tool there is no
// trade and no entry bar — only a picture — so that question was
// unanswerable by construction, not a model failure.
//
// This prompt asks the actually-answerable question instead: "read this
// chart and tell me what you see." It also returns three layered answers
// rather than one — the candle combo, whether the timeframes look aligned
// (FTFC), and whether this is happening inside a Broadening Formation —
// each judged independently, each allowed to be "unclear" on its own.
//
// Always returns the model's real answer, even "unclear" or low
// confidence, since the whole point is to see what the AI actually thinks
// so the owner can judge it. Errors are NOT swallowed — they're left for
// the route calling this to report back, instead of failing silently.
// `marketFtfc`, when given, is the REAL timeframe alignment worked out
// from actual candle data for a named ticker at a named moment — not a
// reading off the picture. The owner's instruction is that classification
// should use both: the measured facts where they exist, and the eye for
// everything a chart shows that no data feed carries (his own drawn
// lines, a broadening formation, where price sits in a range).
//
// Optional on purpose. Given a picture with no ticker or time, the tool
// still works exactly as it did — reading everything visually — because
// most of what he tests is a screenshot from somewhere with no date on
// it at all.
async function testClassifyStrategy({ image, description, marketFtfc }) {
  const teaching = await loadTeachingBlock();
  // The sandbox tool accepts a short video as well as a still, since a
  // clip shows the candles actually forming — which is how the trader
  // reads a setup live, and something a single frozen frame can't convey.
  const imagePart = image ? parseMediaDataUrl(image, { allowVideo: true }) : null;
  const isVideo = !!imagePart && imagePart.mimeType.startsWith('video/');

  const prompt = `You are reading a candlestick chart and identifying what you actually see in it, using a trader's own Strat-methodology definitions. This is NOT a record of a specific trade — there is no entry marker, no direction, and no trade data. Do not ask for or assume any of that. Judge only from the chart itself (and the written description, if one is given).

In the Strat, each candle is numbered by how it relates to the PREVIOUS candle:
- "1" = inside bar (its high is lower than the previous high AND its low is higher than the previous low — neither side taken out)
- "2" = directional bar (takes out exactly ONE side of the previous candle's range — "2 up" takes out the high, "2 down" takes out the low)
- "3" = outside bar (takes out BOTH sides of the previous candle's range)

${marketFtfc ? `MEASURED FACTS. The following was worked out from real candle data for ${marketFtfc.ticker} at ${marketFtfc.when}, not read off the picture. Where it covers a question below, it is the ANSWER to that question — say so, and set that answer's confidence to "high". Your eye is for what the data cannot carry: drawn lines, a broadening formation, where price sits in its range.
- Timeframes aligned: ${marketFtfc.confirmed ? 'YES' : 'NO'}${marketFtfc.direction ? ` (${marketFtfc.direction})` : ''}
- Longest run of agreeing timeframes: ${marketFtfc.run || 0} of 13${(marketFtfc.timeframesInRun || []).length ? ` — ${marketFtfc.timeframesInRun.join(' → ')}` : ''}
- If that run is 4 or more, timeframe continuity is CONFIRMED; if it is 2 or 3, it is PARTIAL; if 0 or 1, NONE.

` : ''}Answer three separate questions independently:

1. WHICH CANDLE COMBO is present? Choose from these, or "unclear":
${STRATEGIES.map(s => `- "${s.key}": ${s.desc}`).join('\n')}
Read the most recent/rightmost candles in the chart to find the combo. If several could fit, pick the clearest one and say so in your reasoning. Only say "unclear" if genuinely no combo above is identifiable from the candles shown.

2. WHAT IS THE TIMEFRAME CONTINUITY? This trader's ladder runs 6M, 3M, 1M, 1W, 1D, 4H, 2H, 1H, 30m, 15m, 5m, 3m, 1m. A timeframe is "up" when price is above that period's open and "down" when below. His rule: continuity is CONFIRMED when any 4 or more CONSECUTIVE timeframes in that ladder agree — the run can start anywhere in the ladder, it does not have to begin at the largest.

Work out every timeframe you can genuinely establish, then answer:
- "confirmed" — you can see 4 or more consecutive timeframes agreeing.
- "partial" — some agree but the longest agreeing run is only 2 or 3, or the ladder is split with larger and smaller timeframes disagreeing. This is a real and common state; say "partial" rather than forcing it to a yes or no.
- "none" — the timeframes you can read visibly conflict with no run at all.
- "unclear" — you genuinely cannot establish any timeframes from what is shown.

A single-timeframe screenshot is NOT automatically "unclear". You can often read several timeframes off one chart, and you should try before giving up:
- The chart's own timeframe, from its most recent candles.
- Larger timeframes that the visible range covers — if a 5-minute chart spans the whole session, the current day's candle is visible in it (where price sits against the session open), and so are the current hour and 4-hour.
- Any higher-timeframe levels, opens, or session markers drawn on the chart.
Do not invent timeframes you cannot see. If the visible range only covers one hour, you cannot establish the daily or weekly — say so and answer from what you do have.

In "ftfcTimeframes" list each timeframe you established and its direction, comma-separated, largest to smallest, e.g. "1D up, 4H up, 1H up, 15m up, 5m down". Put nothing else in that field. In "ftfcReasoning" say what the longest agreeing run was and why that gives the verdict you chose.

3. IS THIS INSIDE A BROADENING FORMATION? A Broadening Formation is a compound outside bar structure — successively wider swings, each new high higher than the last high AND each new low lower than the last low, forming a visibly widening megaphone shape. It takes at least three swing points to establish and usually shows as price alternately taking out the previous high, then the previous low, then a higher high, then a lower low.

Two things to weigh heavily:
- If the trader has DRAWN diverging lines on the chart — two trendlines spreading apart around the price action, often dashed — that is him marking the formation himself, and it is strong evidence for "yes".
- The widening does not have to be symmetrical. A formation that expands mostly on one side while the other stays roughly flat still counts as broadening, as long as the range is genuinely getting wider.

Answer "yes" if that widening structure is genuinely there; "no" if the range is flat, narrowing, or in a clean one-directional trend; "unclear" if there aren't enough swings shown to tell.

For each of the three answers give an honest, specific reason referring to what you actually see in the chart — but keep each reason SHORT, one or two sentences at most. Never guess to be helpful — "unclear" is a perfectly good answer.
${description ? `\nThe trader also wrote this description of the setup: "${description}"` : ''}${imagePart ? (isVideo
    ? '\nA short screen recording of the chart is attached below. Watch how the candles form over the clip and judge the combo from the LAST completed candles at the end of it, not from a mid-clip moment.'
    : '\nThe chart image is attached below.') : '\nNo image was provided — judge only from the written description above.'}${teaching.text}`;

  // Seven fields to fill, three of them free-text reasoning — the most
  // output-hungry call in the app, so the most generous budget.
  const attachments = [];
  if (imagePart) {
    attachments.push({ ...imagePart, label: isVideo
      ? 'THE RECORDING TO CLASSIFY — your answer is about this clip.'
      : 'THE CHART TO CLASSIFY — your answer is about this image.' });
  }
  attachments.push(...teaching.imageParts);
  const parsed = await callGeminiJson(prompt, TEST_CLASSIFY_SCHEMA, 8000, attachments);
  return {
    strategy: parsed.strategy,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    ftfc: parsed.ftfc,
    ftfcTimeframes: parsed.ftfcTimeframes,
    ftfcReasoning: parsed.ftfcReasoning,
    broadeningFormation: parsed.broadeningFormation,
    broadeningReasoning: parsed.broadeningReasoning,
    usedScreenshot: !!imagePart,
  };
}

// ---- Reading a backtest ---------------------------------------------
// The model is handed FINISHED numbers, counted from real candles by
// backtest.js, and asked only to read them. It is told explicitly that it
// must not produce a figure of its own, because a model asked for a win
// rate will invent a convincing one — and a fabricated win rate presented
// next to real ones is worse than no backtest at all.
const BACKTEST_READ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    timeframeComparison: { type: 'STRING' },
    patterns: { type: 'ARRAY', items: { type: 'STRING' } },
    cautions: { type: 'ARRAY', items: { type: 'STRING' } },
    verdict: { type: 'STRING', enum: ['promising', 'mixed', 'poor', 'not enough data'] },
  },
  required: ['headline', 'timeframeComparison', 'patterns', 'cautions', 'verdict'],
};

async function interpretBacktest(results) {
  const teaching = await loadTeachingBlock();
  const rows = results.results.map(r => {
    const s = r.summary;
    return `- ${r.setup} on the ${r.timeframe}: ${s.occurrences} occurrence(s), ${s.wins} win / ${s.losses} loss`
      + (s.winRate == null ? '' : ` (${s.winRate}% win rate)`)
      + `, total ${s.totalR}R, average ${s.avgR}R per trade`
      + ` — reached target ${s.hitTarget}, stopped out ${s.stoppedOut}, ran out of time ${s.ranOut}`
      + ` — searched ${r.barsSearched} candles from ${r.from.slice(0,10)} to ${r.to.slice(0,10)}`;
  }).join('\n');

  const samples = results.results.flatMap(r =>
    r.trades.slice(0, 6).map(t =>
      `  ${r.setup} ${r.timeframe} ${t.when.slice(0,16).replace('T',' ')} ${t.dir} entry ${t.entry} stop ${t.stop} (${t.stopBasis}) -> ${t.outcome} ${t.r}R after ${t.barsHeld} bar(s)`)
  ).join('\n');

  const prompt = `You are reading the results of a backtest for a discretionary options trader who trades The Strat on ${results.ticker}.

THE NUMBERS BELOW ARE ALREADY COUNTED. They were produced by walking real Schwab candles bar by bar, finding every occurrence of each setup, and playing each one forward using the trader's own stop rule until it hit its stop or its ${results.targetR}R target. YOU MUST NOT PRODUCE ANY FIGURE OF YOUR OWN. Do not estimate, do not extrapolate, do not invent a win rate, a count, or a return. Every number you mention must be copied from the results below. If something is not in the results, say it is not known rather than filling the gap.

RESULTS (${results.days} days requested):
${rows || '(nothing was found)'}

${samples ? `A SAMPLE OF THE INDIVIDUAL TRADES:\n${samples}` : ''}
${results.notes.length ? `\nLIMITS THAT APPLIED:\n${results.notes.map(n => `- ${n}`).join('\n')}` : ''}

Write, for a trader with no interest in statistics jargon:
1. "headline" — what these results actually say, in two or three plain sentences. Lead with the thing that matters most.
2. "timeframeComparison" — if the same setup was tested on more than one timeframe, say which did better and by how much, using only the numbers above. If only one timeframe was tested, say so plainly instead of guessing.
3. "patterns" — up to four things you notice in the results or in the sample trades: a setup that stops out far more than it reaches target, a direction that does better than the other, a timeframe where the sample is too small to trust, and so on. Ground each one in the numbers.
4. "cautions" — up to three honest warnings. ALWAYS include a caution about sample size when a setup has fewer than 30 occurrences, because a win rate on 8 trades tells nobody anything. Also note that this simulation counts a bar containing both the stop and the target as a loss, and that a real discretionary trader would not have taken every one of these.
5. "verdict" — one of: promising, mixed, poor, not enough data.

Be direct. If the results are bad, say so. A backtest that flatters a strategy is worse than useless to someone risking money on it.${teaching.text}`;

  const parsed = await callGeminiJson(prompt, BACKTEST_READ_SCHEMA, 6000);
  return parsed;
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

  return callGeminiJson(prompt, ANALYSIS_SCHEMA, 8000);
}

module.exports = { classifyStrategy, classifyForTest, testClassifyStrategy, runPortfolioAnalysis, interpretBacktest, STRATEGIES, PLAYS };
