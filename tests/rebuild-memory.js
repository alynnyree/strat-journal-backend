// Rebuilding the journal must not use up the server's memory.
//
// Render killed the server repeatedly with "exceeded its memory limit".
// Measured cause: reading the thirteen timeframes built a fresh date
// formatter for every candle -- about 23,000 per trade -- and re-scanned
// the whole candle series once per timeframe. That churned 476MB across a
// single batch of twenty-five trades while holding only 27MB, and a
// process never hands churned memory back to the machine.
//
// This runs the real enrichment over 200 trades and fails if the memory
// climbs anywhere near where it did.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL='https://x'; process.env.UPSTASH_REDIS_REST_TOKEN='t';
process.env.ALPACA_KEY_ID='k'; process.env.ALPACA_SECRET_KEY='s';

const bar=(t)=>({t:new Date(t).toISOString(),o:1.1,h:1.2,l:1.0,c:1.15,v:100});
function bars(startMs, endMs, stepMs){
  const out=[]; let n=0;
  for(let t=startMs; t<endMs && n<20000; t+=stepMs){ out.push(bar(t)); n++; }
  return out;
}
const STEP = { '1Min':60e3, '3Min':180e3, '5Min':300e3, '15Min':900e3, '30Min':1800e3, '1Hour':3600e3 };
const orig = Module._load;
Module._load = function(req){
  if(req==='@upstash/redis'){
    class R{constructor(){}async get(){return null;}async set(){}async del(){}async lrange(){return [];}async lpush(){}async ltrim(){}}
    return {Redis:Object.assign(R,{fromEnv:()=>new R()})};
  }
  if(req==='axios'){
    return { get: async (url,cfg)=>{
      const p=cfg.params||{};
      if(/alpaca/.test(url) && /\/bars/.test(url))
        return { data:{ bars: bars(Date.parse(p.start), Date.parse(p.end), STEP[p.timeframe] || 60e3), next_page_token:null } };
      if(/alpaca/.test(url)) return { data:{ trades:[{t:new Date().toISOString(), p:570.1}] } };
      const out=[]; for(let i=0;i<500;i++) out.push({datetime:Date.now()-i*86400e3, open:1, close:1.1});
      return { data:{ candles: out } };
    }, post: async()=>({data:{}}) };
  }
  return orig.apply(this, arguments);
};

let pass=0, fail=0;
const check=(l,c)=>{ if(c){pass++;console.log('PASS:',l);} else {fail++;console.log('FAIL:',l);} };
const rss = () => Math.round(process.memoryUsage().rss/1048576);

(async()=>{
  const cron = require('../cron.js');
  const { getFtfcForTrade } = require('../ftfcCheck.js');
  const { getReplayCandles } = require('../replayData.js');

  const trades=[];
  for(let i=0;i<200;i++){
    const entry = Date.parse('2026-06-01T13:35:00Z') + i*3600e3;
    const longHold = i % 50 === 0;           // a few held for weeks, like his NIO
    trades.push({ id:'t'+i, ticker:'SPY', dir:'Long',
      entryTimestamp: entry, exitTimestamp: entry + (longHold ? 25*86400e3 : 45*60e3) });
  }

  const before = rss();
  let peak = before;
  const started = Date.now();
  for(let i=0;i<trades.length;i+=25){
    const batch = trades.slice(i,i+25);
    await cron.enrichWithUnderlyingPrices('tok', batch);
    for(const t of batch){
      const r = await getFtfcForTrade('tok', t.ticker, t.entryTimestamp, null);
      t.ftfc=r.timeframes; t.ftfcRun=r.runLength; t.ftfcDirection=r.direction;
    }
    for(const t of batch){
      t.replayData = { candles: await getReplayCandles('tok', t.ticker, t.entryTimestamp, t.exitTimestamp) || [] };
    }
    if(rss() > peak) peak = rss();
  }
  const grew = peak - before;
  const seconds = Math.round((Date.now()-started)/1000);

  check(`rebuilding 200 trades grows memory by ${grew}MB, not hundreds`, grew < 150);
  check(`and finishes quickly (${seconds}s)`, seconds < 120);

  const totalCandles = trades.reduce((s,t)=>s+(t.replayData.candles||[]).length,0);
  check(`no single replay is unbounded (${totalCandles.toLocaleString()} candles across 200 trades)`,
    trades.every(t => (t.replayData.candles||[]).length <= 1200));
  check('a position held for weeks still has a replay, just in bigger candles',
    (trades[0].replayData.candles||[]).length > 0);
  check(`the whole journal stays small enough to save (${Math.round(JSON.stringify(trades).length/1048576)}MB)`,
    JSON.stringify(trades).length < 20*1048576);

  // The specific mistake, guarded directly: the date formatter must be
  // built once, not inside the function that runs per candle.
  const src = require('fs').readFileSync(__dirname + '/../ftfcCheck.js','utf8');
  const insideFn = /function easternDate\([\s\S]{0,400}?new Intl\.DateTimeFormat/.test(src);
  check('the date formatter is not rebuilt on every candle', !insideFn);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
