// His own notation, and the AI judging a Broadening Formation itself.
//
// On 2026-08-31 he corrected two things: he does not read "2-2 Reversal"
// or "2-2 Continuation", he reads 2U-2D (Bearish) / 2D-2U (Bullish), and
// that applies to every combo; and the AI SHOULD spot a Broadening
// Formation itself, reversing the earlier decision to leave it to his
// manual toggle -- because it cannot pick "Broadening Formation Scalp" as
// the play otherwise.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL='https://x'; process.env.UPSTASH_REDIS_REST_TOKEN='t';
process.env.GEMINI_API_KEY='k';

let sentPrompt = '', sentSchema = null, reply = {};
const orig = Module._load;
Module._load = function(r){
  if(r==='@upstash/redis'){ class R{constructor(){}async get(){return null;}async set(){}async lrange(){return [];}} return {Redis:Object.assign(R,{fromEnv:()=>new R()})}; }
  if(r==='axios'){
    return { get: async()=>({data:{}}), post: async (url, body)=>{
      const parts = body.contents[0].parts;
      sentPrompt = parts.map(p=>p.text||'').join('\n');
      sentSchema = body.generationConfig.responseSchema;
      return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] } };
    }};
  }
  return orig.apply(this, arguments);
};

const { classifyStrategy } = require('../aiClient');
let pass=0, fail=0;
const check=(l,c)=>{ if(c){pass++;console.log('PASS:',l);} else {fail++;console.log('FAIL:',l);} };

(async()=>{
  reply = { strategy:'2-2 Reversal', confidence:'high', reasoning:'r',
            play:'Broadening Formation Scalp', playConfidence:'high', playReasoning:'pr',
            notation:'2U-2D', notationDirection:'Bearish',
            broadeningFormation:'yes', broadeningReasoning:'higher highs and lower lows' };
  const trade = { id:'t1', ticker:'SPY', dir:'Short', ftfcConfirmed:true, ftfcDirection:'bear',
                  ftfcTimeframesInRun:['1D','4H','2H','1H'], undEntry:570,
                  replayData:{candles:[{open:1,high:2,low:0.5,close:1.5}]} };
  const out = await classifyStrategy(trade);

  // ===== what comes back =====
  check(`his notation comes back (${out.notation})`, out.notation === '2U-2D');
  check(`with its direction (${out.notationDirection})`, out.notationDirection === 'Bearish');
  check('the combo name is still one of his nine', out.strategy === '2-2 Reversal');
  check(`the AI's own Broadening answer comes back (${out.broadeningFormation})`, out.broadeningFormation === 'yes');
  check('with its reasoning', /higher highs/.test(out.broadeningReasoning || ''));
  check('and it can pick the Broadening play', out.play === 'Broadening Formation Scalp');

  // ===== the answer shape demands all of it =====
  const req = sentSchema.required;
  for(const f of ['notation','notationDirection','broadeningFormation','broadeningReasoning']){
    check(`the model must answer "${f}"`, req.includes(f));
  }
  check('and Bullish/Bearish is a fixed choice, not free text',
    JSON.stringify(sentSchema.properties.notationDirection.enum) === JSON.stringify(['Bullish','Bearish','unclear']));

  // ===== the instructions actually changed =====
  check('alignment is no longer forbidden as evidence',
    !/should not affect which pattern you pick/.test(sentPrompt));
  check('it is explicitly allowed as supporting evidence',
    /USE them as supporting evidence/.test(sentPrompt));
  check('but must not override what the bars show',
    /never let it override what the bars plainly show/.test(sentPrompt));
  check('the nine combos are still the only valid combo answer',
    /the nine above remain the only valid answers for the combo/.test(sentPrompt));
  check('his notation is spelled out for the model',
    /2U = a directional bar that took out the previous bar's HIGH/.test(sentPrompt) &&
    /2D = a directional bar that took out the previous bar's LOW/.test(sentPrompt));
  check('with his own example', /bearish 2-2 reversal is "2U-2D"/.test(sentPrompt));
  check('and it is told this applies to every combo', /applies to EVERY combo/.test(sentPrompt));
  check('the model is told to judge the Broadening Formation itself',
    /JUDGE THE BROADENING FORMATION YOURSELF/.test(sentPrompt));
  check('and what one looks like', /higher highs AND lower lows/.test(sentPrompt));
  check('and why it matters — it gates the Scalp play',
    /cannot choose it without recognising the formation/.test(sentPrompt));
  check('his own toggle still wins over the AI',
    /treat his answer as the truth/.test(sentPrompt) && /never over it/.test(sentPrompt));

  // ===== an unreadable answer claims nothing =====
  reply = { strategy:'unclear', confidence:'low', reasoning:'r', play:'unclear',
            playConfidence:'low', playReasoning:'pr', notation:'unclear',
            notationDirection:'unclear', broadeningFormation:'unclear', broadeningReasoning:'could not tell' };
  const vague = await classifyStrategy({ id:'t2', ticker:'SPY' });
  check('an unreadable chart claims no notation', vague === null || vague.notation === 'unclear');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
