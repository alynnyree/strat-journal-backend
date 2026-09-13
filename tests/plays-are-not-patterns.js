// The play is NOT a candle pattern.
//
// He read the three play descriptions back on 2026-09-13 and named the fault:
// two of the three had been written as candle shapes when they are nothing of
// the kind. His words: "Broadening formation is more so about location rather
// than the actual strat combo", and "FTFC is not combo specific either, it is
// mainly based off trading in the direction of FTFC with ANY combo."
//
// That wording was actively harmful, because the prompt hands over the nine
// candle patterns and asks for the PLAY immediately afterwards -- so a play
// described as a shape pushes the model to answer a location question by
// pattern-matching.
//
// This checks what the model is ACTUALLY SENT, by standing in for the network
// and reading the prompt off the request. Checking the source text instead
// would pass on a description that never reaches the far end.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const BACKEND = __dirname + '/..';

let captured = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return {
      post: async (url, body) => {
        captured = body;
        return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({
          strategy: '2-2 Reversal', confidence: 'high', reasoning: 'r',
          play: 'Broadening Formation Scalp', playConfidence: 'high', playReasoning: 'r',
          notation: '2U-2D', notationDirection: 'Bearish',
          broadeningFormation: 'yes', broadeningReasoning: 'r',
        }) }] }, finishReason: 'STOP' }] } };
      },
      get: async () => ({ data: {} }),
    };
  }
  return origLoad.apply(this, arguments);
};

process.env.GEMINI_API_KEY = 'test-key';
const ai = require(path.join(BACKEND, 'aiClient.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

const candles = Array.from({ length: 20 }, (_, i) => ({
  open: 601 + i * 0.1, high: 601.4 + i * 0.1, low: 600.8 + i * 0.1, close: 601.2 + i * 0.1,
}));
const trade = {
  ticker: 'SPY', dir: 'Long', entryTimestamp: Date.now(),
  ftfcConfirmed: true, ftfcDirection: 'BULLISH', ftfcTimeframesInRun: ['1D', '1H', '30m', '15m'],
  undEntry: 601.2, undExit: 601.9,
  replayData: { candles, entryIndex: 5, exitIndex: 15 },
};

(async () => {
  const result = await ai.classifyStrategy(trade);
  check('the reading still works end to end', !!result && result.strategy === '2-2 Reversal');
  check('and the play still comes back', !!result && result.play === 'Broadening Formation Scalp');

  const prompt = captured && captured.contents && captured.contents[0]
    && captured.contents[0].parts.map(p => p.text || '').join('\n');
  check('a prompt actually reached the far end', !!prompt && prompt.length > 500);

  // ---- The three plays are still exactly the three, by name -------------
  check(`three plays, unchanged names (${ai.PLAYS.map(p => p.key).join(' · ')})`,
    ai.PLAYS.length === 3
    && ai.PLAYS[0].key === 'Broadening Formation Scalp'
    && ai.PLAYS[1].key === 'FTFC Direction Play'
    && ai.PLAYS[2].key === '2s Turning Into 3s');

  // The names are the stable key his performance is grouped by. Renaming one
  // would relabel every trade already in his journal.
  const appHtml = fs.readFileSync('/home/user/strat-journal-app/index.html', 'utf8');
  const inApp = [...appHtml.matchAll(/class="strat-opt play-opt" data-v="([^"]+)"/g)].map(m => m[1]);
  check(`the app's own picker offers the same three (${inApp.join(' · ')})`,
    inApp.length === 3 && inApp.every((k, i) => k === ai.PLAYS[i].key));

  // ---- What the prompt now tells the model ------------------------------
  check('it says outright that a play is not a candle pattern',
    /THE PLAY IS NOT A CANDLE PATTERN/.test(prompt));
  check('and that ANY of the nine combos can be ANY of the three plays',
    /ANY of the nine combos above can be ANY of the three plays/i.test(prompt));
  check('and forbids identifying a play by which combo appeared',
    /[Nn]ever identify a play by which combo appeared/.test(prompt));
  check('and forbids ruling a play out because the combo looks wrong',
    /never rule a play out because the combo/i.test(prompt));

  // ---- Broadening Formation Scalp: LOCATION ----------------------------
  const bf = ai.PLAYS[0].desc;
  check('the broadening scalp leads with LOCATION, not a combo',
    /DEFINED BY LOCATION, NOT BY THE COMBO/.test(bf));
  check('it says a broadening formation can form on ANY timeframe',
    /can form and be recognised on ANY timeframe/i.test(bf));
  check('it states his actual method: spot it on a LARGER timeframe',
    /recognise the formation on a LARGER timeframe/i.test(bf) && /30-minute or 1-hour/.test(bf));
  check('and trade it on a LOWER one',
    /trade it on a LOWER one/i.test(bf) && /1-minute or 5-minute/.test(bf));
  check('it says any of the nine can trigger it',
    /ANY of the nine combos can trigger it/i.test(bf));
  check('and tells the model not to reject it over the combo shape',
    /do not reject this play because the combo is not a reversal shape/i.test(bf));
  check('exhaustion is kept as supporting evidence, not a gate',
    /[Ww]orth weighing as supporting evidence/.test(bf) && /exhaustion/i.test(bf));
  check('the broadening scalp no longer names a specific combo as its trigger',
    !/2-Down to 2-Up/i.test(bf) && !/2-Up to 2-Down/i.test(bf));

  // ---- FTFC Direction Play: DIRECTION ----------------------------------
  const ftfc = ai.PLAYS[1].desc;
  check('the FTFC play leads with DIRECTION, not a combo',
    /DEFINED BY DIRECTION, NOT BY THE COMBO/.test(ftfc));
  check('it says ANY of the nine combos',
    /ANY of the nine combos/i.test(ftfc));
  check('and explicitly drops the old shape requirements',
    /[Dd]o not require a continuation shape/.test(ftfc) && /do not require an inside-bar break/i.test(ftfc));
  check('the play is the alignment, not the pattern',
    /the play is the alignment, not the pattern/i.test(ftfc));
  check('its targets survive', /completion of the setup/i.test(ftfc) && /gap or a major pivot/i.test(ftfc));

  // HIS RULE, UNCHANGED: FTFC is four consecutive timeframes. He said
  // plainly "FTFC is still 4 timeframes consecutively, do not change that."
  const ftfcCheck = fs.readFileSync(path.join(BACKEND, 'ftfcCheck.js'), 'utf8');
  check('FTFC is still confirmed at 4 or more consecutive timeframes',
    /confirmed:\s*bestRun\s*>=\s*4/.test(ftfcCheck));

  // ---- 2s Turning Into 3s: both routes --------------------------------
  const twos = ai.PLAYS[2].desc;
  check('it keeps the original route — a 2 expanding into a 3',
    /directional bar \(2\) that expands into an outside bar \(3\)/i.test(twos));
  check('and adds the Rev Strat route',
    /Rev Strat/.test(twos) && /inside bar \(1\) must break out of one side FIRST/i.test(twos));
  check('saying WHY that makes it a 2 first',
    /which is what makes it a 2/i.test(twos));
  check('then fails and reverses through the opposite side',
    /fails to hold that break and reverses through the OPPOSITE side/i.test(twos));
  check('THE FAILURE AND THE REVERSAL ARE THE TRADE — his own emphasis',
    /THE FAILURE AND THE REVERSAL ARE THE TRADE/.test(twos));
  check('and it says there is more than one route',
    /MORE THAN ONE ROUTE to it and both count/i.test(twos));

  // ---- All three still aim for 2x -------------------------------------
  check('all three still state reward at least 2x the risk',
    ai.PLAYS.every(p => /Reward at least 2x the risk/.test(p.desc)));

  // ---- And every play description genuinely reaches the model ---------
  check('every play description is in the prompt verbatim',
    ai.PLAYS.every(p => prompt.includes(p.desc)));
  check('the nine combos are still sent alongside them',
    /2-1-2 Continuation/.test(prompt) && /PMG/.test(prompt));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('THREW:', e.message); process.exit(1); });
