// Step 1A: every reading says how it came out (plan v4).
//   A9      the AI cannot pick a combo outside the measured list
//   A10-2..8 tagged-by-ai, unsure, unreachable, daily-limit, no-data,
//           outside-candidates, waiting-for-data -- each stored, each distinct
//   A11     the prompt actually sent holds no bar from the entry minute on
//   A14     the 1 Bar Rev Strat text is his own rule
//   plus: his named timeframe waits for him (the AI is not asked), trades
//   from before the switch-on are not read, an unreadable switch-on reads
//   nothing, and the referee marks the app's bars against the provider's.
const Module = require('module');
process.env.GEMINI_API_KEY = 'test-key';
let sent = null, answer = null, failWith = null;
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'axios') {
    return { get: async () => ({ data: {} }), post: async (url, body) => {
      sent = body;
      if (failWith) { const e = new Error('stand-in failure'); e.response = { status: failWith, data: {} }; throw e; }
      return { data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }] } };
    } };
  }
  return realLoad(req, parent, isMain);
};
const ai = require('../aiClient');
const { referee, readSetupFacts } = require('../setupReader');
const sw = require('../setupSwitch');
Module._load = realLoad;

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

const NOW = Date.UTC(2026, 10, 16, 18, 0);
const ENTRY = Date.UTC(2026, 10, 16, 16, 8, 34);
const MINUTE = Math.floor(ENTRY / 60000) * 60000;
const candles = []; for (let m = -20; m <= 20; m++) candles.push({ datetime: MINUTE + m * 60000, open: 269 + m / 100, high: 269.2, low: 268.8, close: 269.1 });
const trade = { id: 't1', ticker: 'IWM', dir: 'Short', occ: 'IWM   261120P00269000', entryTimestamp: ENTRY, fills: ['133716429407', '133716430001'], replayData: { candles } };
const CANDS = [
  { timeframe: '5m', direction: 'bearish', combo: '2-2 Continuation', notation: '2D-2D', length: 2, borderline: false, orderUnknown: false, confirmed: true },
  { timeframe: '15m', direction: 'bearish', combo: '2-2 Reversal', notation: '2U-2D', length: 2, borderline: false, orderUnknown: false, confirmed: true },
];
const facts = { ok: true, facts: { candidates: CANDS, notes: [], timeframes: { '5m': { status: 'confirmed', bars: [{ label: '2D' }, { label: '2D' }], candidates: [] } } } };
const readFacts = async () => facts;
const reply = o => Object.assign({ strategy: 'unclear', confidence: 'low', reasoning: 'r', play: 'unclear', playConfidence: 'low', playReasoning: 'p',
  notation: 'unclear', notationDirection: 'unclear', broadeningFormation: 'unclear', broadeningReasoning: 'b', timeframe: 'unclear' }, o);

(async () => {
  // ===== A10-2 tagged-by-ai =============================================
  answer = reply({ strategy: '2-2 Continuation', confidence: 'high', timeframe: '5m', play: 'FTFC Direction Play', playConfidence: 'high' });
  let r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A10-2 a measured candidate chosen with confidence: tagged-by-ai', r.outcome === 'tagged-by-ai' && r.aiChoice.combo === '2-2 Continuation' && r.aiChoice.timeframe === '5m', r);
  let l = ai.legacyFrom(r);
  check('A10-2 stored, and the setup marked as the AI\'s on its timeframe', l.strategy === '2-2 Continuation' && l.stratTimeframe === '5m' && l.notation === '2D-2D' && l.setupReading.outcome === 'tagged-by-ai');
  // ===== A9 outside the list ============================================
  const schema = sent.generationConfig.responseSchema;
  check('A9 the answer form only offers the measured combos', JSON.stringify(schema.properties.strategy.enum) === JSON.stringify(['2-2 Continuation', '2-2 Reversal', 'unclear']), schema.properties.strategy.enum);
  answer = reply({ strategy: '3-1-2 Reversal', confidence: 'high' });
  r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A9/A10-7 a combo not measured is refused: outside-candidates, no tag', r.outcome === 'outside-candidates' && r.aiChoice.refused === true && !ai.legacyFrom(r).strategy, r);
  answer = reply({ strategy: '2-2 Continuation', confidence: 'high', timeframe: '15m' });
  r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A9 a measured combo on a timeframe where it was NOT measured is refused too', r.outcome === 'outside-candidates', r.outcome);
  // ===== A10-3 unsure ====================================================
  answer = reply({ strategy: '2-2 Continuation', confidence: 'medium' });
  r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A10-3 not confident: unsure, stored, no setup', r.outcome === 'unsure' && !ai.legacyFrom(r).strategy);
  // ===== A10-4 / A10-5 the AI cannot answer =============================
  failWith = 503;
  r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A10-4 the AI could not be reached: unreachable, with the reason', r.outcome === 'unreachable' && /503/.test(r.dataNotes.join(' ')), r);
  failWith = 429;
  r = await ai.readSetup(trade, { now: NOW, readFacts });
  check('A10-5 the AI is at its limit: daily-limit, its own answer', r.outcome === 'daily-limit', r.outcome);
  let threw = null; try { await ai.classifyForTest({ ...trade, entryTimestamp: ENTRY }); } catch (e) { threw = e; }
  failWith = null;
  // ===== A10-6 no-data ==================================================
  sent = null;
  r = await ai.readSetup({ ...trade, replayData: null }, { now: NOW, readFacts: async () => ({ ok: false, outcome: 'no-data', reason: 'no market-data key' }) });
  check('A10-6 nothing to read: no-data, and the AI is not asked', r.outcome === 'no-data' && sent === null && /no market-data key/.test(r.dataNotes.join(' ')), r);
  // ===== A10-8 waiting-for-data =========================================
  sent = null;
  r = await ai.readSetup(trade, { now: ENTRY + 5 * 60000 });
  check('A10-8 entry under 15 minutes ago: waiting-for-data, AI not asked', r.outcome === 'waiting-for-data' && sent === null, r);
  // ===== the fallback (Bar Replay as the last resort) ===================
  answer = reply({ strategy: '2-2 Reversal', confidence: 'high' });
  r = await ai.readSetup(trade, { now: NOW, readFacts: async () => ({ ok: false, outcome: 'no-data', reason: 'bars could not be fetched' }) });
  check('fallback: no measurement, bars from before the entry are the only evidence, and it says so', r.outcome === 'tagged-by-ai' && /weakest evidence/.test(r.dataNotes.join(' ')) && r.aiChoice.confirmed === false, r);
  // ===== his named timeframe =============================================
  sent = null;
  r = await ai.readSetup(trade, { now: NOW, readFacts, ownerAnswer: { play: 'FTFC Direction Play', timeframe: '5m' } });
  check('he named the timeframe: the AI is not asked, the reading waits for him', r.pendingOwner === true && r.outcome === null && r.ownerTimeframe === '5m' && sent === null && r.candidates.length === 2, r);
  // ===== the switch-on ===================================================
  r = await ai.readSetup(trade, { now: NOW, readFacts, switchOnAt: ENTRY + 1 });
  check('a trade from before the switch-on is not read at all', r.skipped === 'before-switch-on');
  check('and classifyStrategy hands back nothing for it', (await ai.classifyStrategy(trade, { now: NOW, readFacts, switchOnAt: ENTRY + 1 })) === null);
  sw.resetForTests();
  check('an unreadable switch-on moment reads as unknown (so nothing is read)', (await sw.switchOnAt({ redis: { set: async () => { throw new Error('down'); }, get: async () => null } })) === null);
  sw.resetForTests();
  let setCalls = [];
  const fake = { v: null, set: async (k, v, o) => { setCalls.push(o); if (!(o && o.nx && fake.v != null)) fake.v = v; return 'OK'; }, get: async () => fake.v };
  const first = await sw.switchOnAt({ redis: fake, now: 1000 });
  sw.resetForTests();
  const second = await sw.switchOnAt({ redis: fake, now: 5000 });
  check('the switch-on is set once and never moved', first === 1000 && second === 1000 && setCalls.every(o => o && o.nx), { first, second });
  // ===== A11 the prompt holds no post-entry bar ==========================
  answer = reply({});
  await ai.readSetup(trade, { now: NOW, readFacts });
  const prompt = sent.contents[0].parts.map(p => p.text || '').join('\n');
  const line = (prompt.match(/One-minute bars that started BEFORE his entry minute[^\n]*/) || [''])[0];
  const shown = (line.match(/O:/g) || []).length;
  const afterOpens = candles.filter(c => c.datetime >= MINUTE).map(c => 'O:' + c.open + ' ');
  check('A11 the prompt shows the 20 bars before the entry minute', shown === 20, shown);
  check('A11 and not one from the entry minute or after', afterOpens.every(o => !line.includes(o)));
  check('A11 the old "last 15 candles" line is gone', !/Last ~15 one-minute candles/.test(prompt));
  check('the measured candidates are in the prompt as the only choices', /The ONLY combos you may choose/.test(prompt) && /5m: 2D-2D = "2-2 Continuation"/.test(prompt));
  // ===== A14 his 1 Bar Rev Strat rule ===================================
  check('A14 the 1 Bar Rev Strat text is his own rule', /I take my entry at 50% level of previous candle and target the high of previous candle/.test(prompt));
  check('A14 no "retrace" wording left', !/1 Bar Rev Strat[^\n]*retrace/i.test(prompt));
  check('PMG is not offered to the AI', !/- "PMG"/.test(prompt));
  // ===== classifyForTest still tells "could not reach" apart =============
  check('the rehearsal still throws when the AI could not be reached (never a quiet "unsure")', !!threw && /limit|could not/.test(threw.message), threw && threw.message);
  // ===== the referee =====================================================
  const bar = (t, o) => ({ datetime: t, open: o, high: o + 1, low: o - 1, close: o + 0.5 });
  const ours = [bar(0, 1), bar(1, 2), bar(2, 3), bar(3, 4)];
  check('referee: matching bars agree (first and last, maybe partial, not marked)', referee(ours, [bar(1, 2), bar(2, 3)]).agreed === true);
  check('referee: one bar a cent out disagrees', referee(ours, [bar(1, 2), bar(2, 3.01)]).agreed === false);
  check('referee: nothing of theirs is not agreement', referee(ours, []).agreed === false);
  const notReady = await readSetupFacts(trade, { now: NOW, alpaca: { isReady: async () => false } });
  check('no market-data key: no-data, saying so', notReady.ok === false && notReady.outcome === 'no-data' && /key/.test(notReady.reason));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASHED', e); process.exit(1); });
