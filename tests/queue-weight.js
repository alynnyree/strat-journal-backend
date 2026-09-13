// What the waiting queue costs to collect.
//
// His hosting was suspended on 2026-09-09 for going over its free 5GB, and
// the heaviest thing it serves is this: the phone asks every thirty seconds
// for the trades waiting to be imported, and the answer used to carry EVERY
// one of them WITH its chart bars.
//
// Measured here on the real routes, not reasoned about.
const Module = require('module');
const path = require('path');
const http = require('http');
const BACKEND = path.join(__dirname, '..');

process.env.APP_SECRET = 'testkey';
process.env.PORT = '8981';
process.env.SYNC_CRON = '0 0 31 2 *';
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.FRONTEND_ORIGIN = '*';

const store = {};
const fakeRedis = {
  get: async k => (k in store ? store[k] : null),
  set: async (k, v) => { store[k] = v; return 'OK'; },
  del: async k => { delete store[k]; return 1; },
  lpush: async () => 1, lrange: async () => [], lrem: async () => 0,
  rpop: async () => null, ltrim: async () => 'OK', incr: async () => 1,
  expire: async () => 1, keys: async () => [],
};
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === 'ws') return class FakeWs { constructor(){ this.readyState = 3; } on(){} send(){} close(){} terminate(){} };
  return origLoad.apply(this, arguments);
};

require(path.join(BACKEND, 'server.js'));
const tradeStore = require(path.join(BACKEND, 'tradeStore.js'));

const get = (p) => new Promise((resolve) => {
  const req = http.get({ host:'127.0.0.1', port:8981, path:p, timeout:8000 }, res => {
    let body = ''; res.on('data', d => body += d);
    res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.byteLength(body), body }));
  });
  req.on('error', e => resolve({ status: 0, bytes: 0, body: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, bytes: 0, body: 'timeout' }); });
});

let pass = 0, fail = 0;
const check = (l, c) => { if(c){ pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// A trade shaped the way the real matcher and enrichment leave one, with a
// realistic run of chart bars behind it.
function trade(i){
  const candles = [];
  for(let n = 0; n < 300; n++){
    candles.push({ time: 1757000000 + n*60, open: 601.1+n*0.01, high: 601.4+n*0.01,
                   low: 600.9+n*0.01, close: 601.2+n*0.01, volume: 12345 });
  }
  return {
    id: 'p' + i, ticker: 'SPY', dir: 'Long', occ: 'SPY   260609C0074500' + (i % 10),
    entryDate: '2026-06-09', entryTime: '09:31', exitDate: '2026-06-09', exitTime: '09:36',
    entryTimestamp: 1757000000000, exitTimestamp: 1757000300000,
    optEntry: 1.11, optExit: 1.22, contracts: 1, fees: 1.33, pnlDollar: 11, pnlNet: 9.67,
    undEntry: 601.2, undExit: 601.5, ftfc: {'1D':'BULLISH'}, ftfcRun: 4,
    fills: ['b'+i, 's'+i],
    replayData: { candles, entryIndex: 10, exitIndex: 20 },
  };
}

(async () => {
  await new Promise(r => setTimeout(r, 700));

  const N = 100;
  await tradeStore.saveState({ openLegs: [], pending: Array.from({length:N}, (_,i) => trade(i)), lastProcessedIds: [] });

  const full = await get('/api/trades/pending');
  const slim = await get('/api/trades/pending?slim=1');
  const page = await get('/api/trades/pending?slim=1&limit=25');

  const kb = b => (b/1024).toFixed(0) + 'KB';
  console.log(`\n  ${N} trades waiting: whole queue ${kb(full.bytes)} · without chart bars ${kb(slim.bytes)} · 25 at a time ${kb(page.bytes)}\n`);

  check(`the old answer still works unchanged (${full.status})`, full.status === 200);
  const fullBody = JSON.parse(full.body);
  check(`and still carries the chart bars (${(fullBody.pending[0].replayData||{}).candles.length} bars)`,
    fullBody.pending[0].replayData.candles.length === 300);

  const slimBody = JSON.parse(slim.body);
  check(`asking without the bars hands back all ${N} trades (${slimBody.pending.length})`, slimBody.pending.length === N);
  check('the chart key is still there, and empty — never missing',
    slimBody.pending.every(t => 'replayData' in t && t.replayData === null));
  check('and each says whether bars are waiting for it',
    slimBody.pending.every(t => t.replayWaiting === true));
  check(`which costs a twentieth of the weight (${kb(slim.bytes)} against ${kb(full.bytes)})`,
    slim.bytes < full.bytes / 10);

  const pageBody = JSON.parse(page.body);
  check(`asking for 25 hands back 25 (${pageBody.pending.length})`, pageBody.pending.length === 25);
  check(`and says how many are really waiting (${pageBody.waiting})`, pageBody.waiting === N);
  check(`no single answer is large (${kb(page.bytes)})`, page.bytes < 40 * 1024);

  // The money and everything else must survive the slimming untouched.
  const a = fullBody.pending[0], b = slimBody.pending[0];
  check('nothing else about the trade is changed',
    ['id','occ','entryTime','exitTime','optEntry','optExit','contracts','fees','pnlNet','undEntry']
      .every(k => JSON.stringify(a[k]) === JSON.stringify(b[k])));
  check('and its broker references survive', JSON.stringify(a.fills) === JSON.stringify(b.fills));

  // One trade's bars, on demand.
  const one = await get('/api/trades/pending/p3/replay');
  check(`the bars for one trade come back on their own (${one.status})`, one.status === 200);
  const oneBody = JSON.parse(one.body);
  check(`with all 300 of them (${(oneBody.replayData||{}).candles.length})`,
    oneBody.replayData.candles.length === 300);
  check('and no reason, because nothing went wrong', oneBody.reason === null);

  // Collecting the whole queue 25 at a time costs ONE pass, not one per poll.
  let collected = 0, bytes = 0, rounds = 0;
  while(rounds++ < 20){
    const r = await get('/api/trades/pending?slim=1&limit=25');
    bytes += r.bytes;
    const body = JSON.parse(r.body);
    if(!body.pending.length) break;
    for(const t of body.pending){
      const bars = await get('/api/trades/pending/' + t.id + '/replay');
      bytes += bars.bytes;
      collected++;
      await new Promise((res) => {
        const req = http.request({ host:'127.0.0.1', port:8981, path:'/api/trades/pending/'+t.id, method:'DELETE' }, x => { x.resume(); x.on('end', res); });
        req.on('error', res); req.end();
      });
    }
  }
  console.log(`\n  collecting all ${N}: ${collected} trades for ${kb(bytes)} in ${rounds} rounds\n`);
  check(`every trade is collected (${collected})`, collected === N);
  check(`the queue is empty afterwards`, JSON.parse((await get('/api/trades/pending')).body).pending.length === 0);
  check(`and the whole collection costs about one pass (${kb(bytes)} against ${kb(full.bytes)} for one old answer)`,
    bytes < full.bytes * 1.3);

  // A trade that is gone, and one with no bars, must not share an answer.
  const gone = await get('/api/trades/pending/nope/replay');
  check(`a trade no longer in the queue answers 404 (${gone.status})`, gone.status === 404);
  check('and says which fault it is', /no longer waiting/.test(JSON.parse(gone.body).reason || ''));

  await tradeStore.saveState({ openLegs: [], pending: [Object.assign(trade(99), { replayData: null })], lastProcessedIds: [] });
  const bare = await get('/api/trades/pending?slim=1');
  check('a trade with no bars says so rather than promising some',
    JSON.parse(bare.body).pending[0].replayWaiting === false);
  const nobars = await get('/api/trades/pending/p99/replay');
  check(`asking for bars it does not have is not an error (${nobars.status})`, nobars.status === 200);
  check('and gives a different reason from "it is gone"',
    /no chart bars were saved/i.test(JSON.parse(nobars.body).reason || ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
