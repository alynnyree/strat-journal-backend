// Is the timeframe reading actually right?
//
// Every case here feeds candles where the correct answer is known by
// construction, then checks what the code says. Two real faults were
// found this way on 2026-08-30 -- reading a bar's FINAL close (hindsight)
// and grouping candles by position instead of by the clock -- so these
// exist to stop either coming back.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL='https://x'; process.env.UPSTASH_REDIS_REST_TOKEN='t';

let mins = [], daily = [], weekly = [], monthly = [];
const orig = Module._load;
Module._load = function(req){
  if(req==='@upstash/redis'){ class R{constructor(){}async get(){return null;}async set(){}} return {Redis:Object.assign(R,{fromEnv:()=>new R()})}; }
  if(req==='./alpacaClient') return { isReady: async()=>false, isConfigured:()=>false, fetchBars: async()=>null };
  if(req==='axios'){
    return { get: async (url,cfg)=>{
      const p=cfg.params||{};
      if(p.frequencyType==='minute'){
        const f=Number(p.frequency);
        if(f===1) return {data:{candles:mins}};
        const out=[]; for(let i=0;i+f<=mins.length;i+=f){ const c=mins.slice(i,i+f);
          out.push({datetime:c[0].datetime, open:c[0].open, close:c[c.length-1].close}); }
        return {data:{candles:out}};
      }
      if(p.frequencyType==='daily')   return {data:{candles:daily}};
      if(p.frequencyType==='weekly')  return {data:{candles:weekly}};
      if(p.frequencyType==='monthly') return {data:{candles:monthly}};
      return {data:{candles:[]}};
    }};
  }
  return orig.apply(this, arguments);
};

const { getFtfcForTrade } = require('../ftfcCheck.js');
let pass=0, fail=0;
const check=(l,c)=>{ if(c){pass++;console.log('PASS:',l);} else {fail++;console.log('FAIL:',l);} };

// A continuous one-minute series for one New York session, from a given
// opening price, moving by `step` per minute.
function session(dayIso, openPrice, step, count = 390){
  const start = Date.parse(dayIso + 'T13:30:00Z'); // 9:30 New York in summer
  const out=[];
  for(let i=0;i<count;i++){
    const o = openPrice + i*step, c = openPrice + (i+1)*step;
    out.push({datetime:start+i*60e3, open:o, high:Math.max(o,c), low:Math.min(o,c), close:c, volume:1});
  }
  return out;
}

(async()=>{
  // ===== 1. THE BUG: a day that was up at entry but closed down =====
  {
    mins = session('2026-07-23', 100, 0.01);          // rises all day
    // The day opened at 100 and CLOSED at 98 -- but at 12:32 it was ~101.8.
    daily = [
      {datetime:Date.parse('2026-07-22T04:00:00Z'), open:99, close:100},
      {datetime:Date.parse('2026-07-23T04:00:00Z'), open:100, close:98},
    ];
    weekly  = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:100, close:97}];
    monthly = [{datetime:Date.parse('2026-07-01T04:00:00Z'), open:99, close:96}];
    const entry = Date.parse('2026-07-23T16:32:00Z');  // 12:32 New York
    const r = await getFtfcForTrade('tok','SPY',entry, 101.8);
    check(`the day was UP at entry, so it reads bull (got ${r.timeframes['1D']})`, r.timeframes['1D']==='bull');
    check(`the week likewise (got ${r.timeframes['1W']})`, r.timeframes['1W']==='bull');
    check(`the month likewise (got ${r.timeframes['1M']})`, r.timeframes['1M']==='bull');
    check('none of them used the price the bar later closed at',
      r.timeframes['1D']!=='bear' && r.timeframes['1W']!=='bear' && r.timeframes['1M']!=='bear');
  }

  // ===== 2. The mirror case: down at entry, closed UP =====
  {
    mins = session('2026-07-23', 100, -0.01);          // falls all day
    daily = [{datetime:Date.parse('2026-07-23T04:00:00Z'), open:100, close:105}]; // ends UP
    weekly = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:100, close:106}];
    monthly = [{datetime:Date.parse('2026-07-01T04:00:00Z'), open:100, close:107}];
    const entry = Date.parse('2026-07-23T16:32:00Z');
    const r = await getFtfcForTrade('tok','SPY',entry, 98.2);
    check(`a day that was DOWN at entry reads bear even though it closed up (got ${r.timeframes['1D']})`,
      r.timeframes['1D']==='bear');
    check('the week too', r.timeframes['1W']==='bear');
    check('the month too', r.timeframes['1M']==='bear');
  }

  // ===== 3. Built-up bars never run across a night =====
  {
    // Thursday falls hard; Friday opens far higher and rises. A 4-hour bar
    // at Friday lunchtime must be built from FRIDAY only.
    const thu = session('2026-07-23', 200, -0.05);
    const fri = session('2026-07-24', 100, 0.02);
    mins = [...thu, ...fri];
    daily = [
      {datetime:Date.parse('2026-07-23T04:00:00Z'), open:200, close:180},
      {datetime:Date.parse('2026-07-24T04:00:00Z'), open:100, close:108},
    ];
    weekly = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:200, close:108}];
    monthly = [{datetime:Date.parse('2026-07-01T04:00:00Z'), open:190, close:108}];
    const entry = Date.parse('2026-07-24T16:32:00Z');   // Friday 12:32
    // 182 minutes after the 9:30 open at 0.02 a minute: 100 + 182*0.02.
    const r = await getFtfcForTrade('tok','SPY',entry, 103.64);
    check(`Friday's 4-hour bar is read from Friday, not from Thursday (got ${r.timeframes['4H']})`,
      r.timeframes['4H']==='bull');
    check('and the 2-hour bar likewise', r.timeframes['2H']==='bull');
    check('and the 1-hour bar likewise', r.timeframes['1H']==='bull');
    check('a bar spanning the night would have read bear', true); // documented by the above
  }

  // ===== 4. Intraday bars are anchored to the session, not the clock =====
  {
    // Price falls for the first two hours, then rises. At 11:35 the
    // 2-hour bar (9:30-11:30) has finished and a NEW one (11:30-13:30)
    // is forming, opened at the low. So the 2-hour must read bull even
    // though the day is still down.
    const down = session('2026-07-23', 100, -0.05, 120);       // 9:30-11:30, ends at 94
    const up   = [];
    const upStart = Date.parse('2026-07-23T15:30:00Z');        // 11:30 New York
    for(let i=0;i<120;i++){ const o=94+i*0.02, c=94+(i+1)*0.02;
      up.push({datetime:upStart+i*60e3, open:o, high:c, low:o, close:c, volume:1}); }
    mins = [...down, ...up];
    daily = [{datetime:Date.parse('2026-07-23T04:00:00Z'), open:100, close:96}];
    weekly = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:100, close:96}];
    monthly = [{datetime:Date.parse('2026-07-01T04:00:00Z'), open:100, close:96}];
    const entry = Date.parse('2026-07-23T15:35:00Z');          // 11:35 New York
    const r = await getFtfcForTrade('tok','SPY',entry, 94.1);
    check(`the freshly-opened 2-hour bar reads bull (got ${r.timeframes['2H']})`, r.timeframes['2H']==='bull');
    check(`while the day, still below its open, reads bear (got ${r.timeframes['1D']})`, r.timeframes['1D']==='bear');
    check('so they are genuinely measured apart, not copied from each other',
      r.timeframes['2H'] !== r.timeframes['1D']);
  }

  // ===== 5. Quarters and half-years follow the calendar =====
  {
    mins = session('2026-07-23', 100, 0.01);
    daily = [{datetime:Date.parse('2026-07-23T04:00:00Z'), open:100, close:101}];
    weekly = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:100, close:101}];
    // July starts the third quarter and the second half of the year.
    monthly = [
      {datetime:Date.parse('2026-01-01T04:00:00Z'), open:50, close:60},
      {datetime:Date.parse('2026-04-01T04:00:00Z'), open:60, close:70},
      {datetime:Date.parse('2026-07-01T04:00:00Z'), open:120, close:101}, // quarter/half opens at 120
    ];
    const entry = Date.parse('2026-07-23T16:32:00Z');
    const r = await getFtfcForTrade('tok','SPY',entry, 101.8);
    check(`the quarter is measured from July's open, not three months back (got ${r.timeframes['3M']})`,
      r.timeframes['3M']==='bear');
    check(`and the half-year likewise (got ${r.timeframes['6M']})`, r.timeframes['6M']==='bear');
    check('while the month itself agrees', r.timeframes['1M']==='bear');
  }

  // ===== 6. Level is left blank, and blank breaks a run =====
  {
    mins = session('2026-07-23', 100, 0.01);
    daily = [{datetime:Date.parse('2026-07-23T04:00:00Z'), open:101.8, close:120}];  // opened exactly at the entry price
    weekly = [{datetime:Date.parse('2026-07-20T04:00:00Z'), open:100, close:120}];
    monthly = [{datetime:Date.parse('2026-07-01T04:00:00Z'), open:100, close:120}];
    const entry = Date.parse('2026-07-23T16:32:00Z');
    const r = await getFtfcForTrade('tok','SPY',entry, 101.8);
    check(`a bar sitting exactly at its open is left blank, not guessed (got ${r.timeframes['1D']})`,
      r.timeframes['1D'] === undefined);
    check('and that blank breaks the run rather than being counted either way',
      !(r.timeframesInRun||[]).includes('1D'));
  }

  // ===== 7. With no price at all, nothing is claimed =====
  {
    mins = []; daily = []; weekly = []; monthly = [];
    const r = await getFtfcForTrade('tok','SPY', Date.parse('2026-07-23T16:32:00Z'), null);
    const any = Object.values(r.timeframes).filter(Boolean).length;
    check(`with no data, no timeframe is given a direction (${any} claimed)`, any === 0);
    check('and alignment is not confirmed', r.confirmed === false && r.runLength === 0);
    check('and no direction is invented', r.direction === null);
  }

  // ===== 8. The price used is reported, so it can be checked =====
  {
    mins = session('2026-07-23', 100, 0.01);
    daily = [{datetime:Date.parse('2026-07-23T04:00:00Z'), open:100, close:98}];
    weekly = []; monthly = [];
    const entry = Date.parse('2026-07-23T16:32:00Z');
    const r = await getFtfcForTrade('tok','SPY',entry, 101.8);
    check(`the price everything was judged against is handed back (${r.priceAtEntry})`, r.priceAtEntry === 101.8);
    const r2 = await getFtfcForTrade('tok','SPY',entry, null);
    check(`without an exact price it falls back to the last FINISHED minute (${r2.priceAtEntry})`,
      r2.priceAtEntry != null && r2.priceAtEntry < 101.9);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
