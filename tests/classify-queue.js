// The phone must never wait on the AI. It hands a trade over, gets an
// answer at once, and collects the reading later.
const Module = require('module');
process.env.APP_SECRET = 'secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://x';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

let store = {};           // key -> value
let lists = {};           // key -> array
let aiDelayMs = 0, aiFails = null, aiCalls = 0;

const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') {
    class Redis {
      constructor(){}
      async get(k){ return store[k] ?? null; }
      async set(k,v){ store[k]=v; }
      async lpush(k,v){ (lists[k] = lists[k]||[]).unshift(v); }
      async rpop(k){ const l=lists[k]||[]; return l.length ? l.pop() : null; }
      async lrange(k){ return (lists[k]||[]).slice(); }
      async ltrim(k,a,b){ lists[k] = (lists[k]||[]).slice(a,b+1); }
      async del(k){ delete store[k]; delete lists[k]; }
    }
    return { Redis: Object.assign(Redis, { fromEnv: () => new Redis() }) };
  }
  if (req === './aiClient') {
    return {
      classifyStrategy: async (t) => {
        aiCalls++;
        await new Promise(r => setTimeout(r, aiDelayMs));
        if (aiFails) { const e = new Error('nope'); e.response = { status: aiFails }; throw e; }
        return { strategy: '2-2 Reversal', confidence: 'high', play: 'FTFC Direction Play' };
      },
      testClassifyStrategy: async () => ({}), runPortfolioAnalysis: async () => ({}),
      interpretBacktest: async () => ({}), STRATEGIES: [], PLAYS: [],
    };
  }
  return orig.apply(this, arguments);
};

const express = require('express');
const { wrap, errorHandler } = require('../asyncRoute');
const aiRoutes = require('../aiRoutes');
const queue = require('../classifyQueue');

let pass=0, fail=0;
const check=(l,c)=>{ if(c){pass++;console.log('PASS:',l);} else {fail++;console.log('FAIL:',l);} };
const app = express(); app.use(express.json()); app.use('/ai', aiRoutes); app.use(errorHandler);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (trade) => {
    const t0 = Date.now();
    const r = await fetch(base + '/ai/classify?key=secret', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ trade }) });
    return { ms: Date.now()-t0, status: r.status, body: await r.json().catch(()=>null) };
  };
  const results = async () => {
    const r = await fetch(base + '/ai/classify/results?key=secret');
    return { status: r.status, body: await r.json().catch(()=>null) };
  };

  // ===== 1. The phone is answered at once, however slow the AI is =====
  aiDelayMs = 3000;                        // the AI takes three seconds
  let r = await post({ id: 't1', ticker: 'SPY' });
  check(`the phone is answered immediately (${r.ms}ms, AI takes 3000ms)`, r.status === 200 && r.ms < 800);
  check('and told the trade was taken', r.body && r.body.queued === true);

  // ===== 2. The answer turns up afterwards =====
  await sleep(6000);
  let res = await results();
  check(`the reading is there once it is done (status ${res.status})`, res.status === 200);
  check('and carries the setup', res.body.results.t1 && res.body.results.t1.strategy === '2-2 Reversal');
  check('and the play', res.body.results.t1.play === 'FTFC Direction Play');

  // ===== 3. Collecting clears them, so nothing is applied twice =====
  res = await results();
  check('collecting an answer clears it', Object.keys(res.body.results).length === 0);

  // ===== 4. The same trade is not queued twice =====
  aiDelayMs = 1500;
  await post({ id: 't2', ticker: 'SPY' });
  const dup = await post({ id: 't2', ticker: 'SPY' });
  check(`the same trade is not taken twice (waiting ${dup.body.waiting})`, dup.body.waiting <= 1);
  await sleep(5000);
  await results();

  // ===== 5. Out of allowance pauses, and the trade is not lost =====
  aiCalls = 0; aiFails = 429; aiDelayMs = 0;
  await post({ id: 't3', ticker: 'SPY' });
  await post({ id: 't4', ticker: 'SPY' });
  await sleep(2500);
  res = await results();
  check('no trade is marked read when the AI refuses', Object.keys(res.body.results).length === 0);
  check(`and they are still waiting, not thrown away (${res.body.waiting})`, res.body.waiting === 2);
  check(`it stopped at the first refusal rather than burning the queue (${aiCalls} call)`, aiCalls === 1);

  // ===== 6. A trade with no id is refused, not silently dropped =====
  const bad = await fetch(base + '/ai/classify?key=secret', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ trade: { ticker:'SPY' } }) });
  check(`a trade with no id is refused (${bad.status})`, bad.status === 400);

  // ===== 7. The key still guards both routes =====
  const noKey = await fetch(base + '/ai/classify?key=wrong', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ trade:{id:'x'} }) });
  const noKey2 = await fetch(base + '/ai/classify/results?key=wrong');
  check('a wrong key is refused on both routes', noKey.status === 403 && noKey2.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
});
