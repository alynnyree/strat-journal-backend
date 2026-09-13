// What a WAITING PICTURE costs to check on, over and over.
//
// A picture that matches no trade yet is deliberately left waiting -- the
// trade may not have reached his journal. But the phone asks for that list
// every thirty seconds it is open, and the answer used to carry every
// waiting picture IN FULL. So one mistimed picture that would never match
// anything was downloaded again on every check for the thirty days it is
// kept, and nothing anywhere said so.
//
// Measured on the real route, and measured ACROSS REPEATED CHECKS, which is
// the only way this fault shows itself -- one check looks fine.
const Module = require('module');
const path = require('path');
const http = require('http');
const BACKEND = path.join(__dirname, '..');

process.env.APP_SECRET = 'testkey';
process.env.PORT = '8983';
process.env.SYNC_CRON = '0 0 31 2 *';
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.FRONTEND_ORIGIN = '*';

// A store that actually keeps lists, because the sweeping and the ceiling
// are part of what is being checked.
const kv = {};
const lists = {};
const fakeRedis = {
  get: async k => (k in kv ? kv[k] : null),
  set: async (k, v) => { kv[k] = v; return 'OK'; },
  del: async k => { delete kv[k]; return 1; },
  lpush: async (k, v) => { (lists[k] = lists[k] || []).unshift(v); return lists[k].length; },
  lrange: async (k, a, b) => (lists[k] || []).slice(a, b === -1 ? undefined : b + 1),
  lrem: async (k, _n, v) => {
    const l = lists[k] || []; const i = l.indexOf(v);
    if (i >= 0) l.splice(i, 1);
    return i >= 0 ? 1 : 0;
  },
  ltrim: async (k, a, b) => { if (lists[k]) lists[k] = lists[k].slice(a, b + 1); return 'OK'; },
  rpop: async () => null, incr: async () => 1, expire: async () => 1, keys: async () => [],
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

const get = (p) => new Promise((resolve) => {
  const req = http.get({ host:'127.0.0.1', port:8983, path:p, timeout:8000 }, res => {
    let body = ''; res.on('data', d => body += d);
    res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.byteLength(body), body }));
  });
  req.on('error', e => resolve({ status: 0, bytes: 0, body: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, bytes: 0, body: 'timeout' }); });
});

let pass = 0, fail = 0;
const check = (l, c) => { if(c){ pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };
const K = 'key=testkey';

// A real captured chart picture is a data: URL of a PNG. 300KB is modest
// for a full browser tab at retina size; the cap on the route that accepts
// them is 3MB.
function fakeImage(kb){ return 'data:image/png;base64,' + 'A'.repeat(kb * 1024); }

async function seed(n, kb){
  for (const k of Object.keys(kv)) delete kv[k];
  for (const k of Object.keys(lists)) delete lists[k];
  for (let i = 0; i < n; i++){
    const id = 'pic' + i;
    kv['screenshot:' + id] = JSON.stringify({
      id, image: fakeImage(kb), timestamp: 1757000000000 + i * 60000, moment: 'entry',
    });
    await fakeRedis.lpush('screenshots:pending', id);
  }
}

(async () => {
  await new Promise(r => setTimeout(r, 700));

  // ---- 1. What one check costs, with and without the pictures ----
  await seed(20, 300);
  const full = await get('/media/pending?' + K);
  const slim = await get('/media/pending?slim=1&' + K);
  console.log(`\n20 waiting pictures at ~300KB each:`);
  console.log(`  every picture sent : ${Math.round(full.bytes/1024)}KB`);
  console.log(`  pictures left out  : ${Math.round(slim.bytes/1024)}KB`);

  check('both answers arrive', full.status === 200 && slim.status === 200);
  check('sending every picture is heavy (over 5MB)', full.bytes > 5 * 1024 * 1024);
  check('leaving them out is under 4KB', slim.bytes < 4 * 1024);
  check('leaving them out is at least 1000x lighter', full.bytes / slim.bytes > 1000);

  const slimBody = JSON.parse(slim.body);
  check('the slim answer still lists all 20', slimBody.screenshots.length === 20);
  check('it says how many are waiting', slimBody.waiting === 20);
  // The key stays present and null. Dropping it would let a reader mistake
  // "not sent this time" for "there is no picture".
  check('every entry still HAS an image key', slimBody.screenshots.every(s => 'image' in s));
  check('every image key is null, not missing', slimBody.screenshots.every(s => s.image === null));
  check('each one says whether a picture exists', slimBody.screenshots.every(s => s.hasImage === true));
  check('each one says how big it is', slimBody.screenshots.every(s => s.bytes > 300000));
  // The timestamp is the whole reason the slim list is enough: working out
  // which trade a picture belongs to needs nothing else.
  check('each one still carries its timestamp', slimBody.screenshots.every(s => typeof s.timestamp === 'number'));
  check('each one still carries its moment', slimBody.screenshots.every(s => s.moment === 'entry'));

  const fullBody = JSON.parse(full.body);
  check('the old answer is unchanged for an older phone', fullBody.screenshots.every(s => typeof s.image === 'string' && s.image.length > 300000));

  // ---- 2. One picture, fetched on its own ----
  const one = await get('/media/pic3/image?' + K);
  check('a single picture can be asked for', one.status === 200);
  const oneBody = JSON.parse(one.body);
  check('it hands back the image', typeof oneBody.image === 'string' && oneBody.image.length > 300000);
  check('it hands back its timestamp too', oneBody.timestamp === 1757000000000 + 3 * 60000);
  check('a picture that IS there carries no reason', oneBody.reason === null);
  check('asking for one costs roughly one picture', one.bytes < 420 * 1024 && one.bytes > 280 * 1024);

  // ---- 3. Three different faults, three different answers ----
  const gone = await get('/media/nosuchid/image?' + K);
  check('a picture that has left the queue answers 404', gone.status === 404);
  const goneBody = JSON.parse(gone.body);
  check('...and says so in plain words', /no longer waiting/i.test(goneBody.reason || ''));
  check('...with no image and no invented cause', goneBody.image === null);

  kv['screenshot:noimage'] = JSON.stringify({ id: 'noimage', timestamp: 1757000000000 });
  await fakeRedis.lpush('screenshots:pending', 'noimage');
  const blank = await get('/media/noimage/image?' + K);
  check('a record stored with no picture answers 200', blank.status === 200);
  const blankBody = JSON.parse(blank.body);
  check('...and says THAT, which is a different fault', /without any image/i.test(blankBody.reason || ''));
  check('...rather than a bare nothing', blankBody.image === null && blankBody.reason);

  const noKey = await get('/media/pic3/image');
  check('the wrong key is refused', noKey.status === 403);
  await fakeRedis.lrem('screenshots:pending', 0, 'noimage');
  delete kv['screenshot:noimage'];

  // ---- 4. THE ACTUAL FAULT: what a picture that never matches costs
  //         over the thirty days it is kept.
  // One check looks fine either way. This is only visible across many.
  await seed(1, 300);
  let fullRepeat = 0, slimRepeat = 0;
  for (let i = 0; i < 30; i++){
    fullRepeat += (await get('/media/pending?' + K)).bytes;
    slimRepeat += (await get('/media/pending?slim=1&' + K)).bytes;
  }
  console.log(`\nONE unmatched picture, checked on 30 times:`);
  console.log(`  every picture sent : ${Math.round(fullRepeat/1024)}KB`);
  console.log(`  pictures left out  : ${slimRepeat} bytes`);
  // The phone checks every thirty seconds, so thirty checks is fifteen
  // minutes -- and it is kept for thirty DAYS.
  const perDay = (slimRepeat / 30) * 2 * 60 * 24;
  console.log(`  left out, a whole day of checking: ${Math.round(perDay/1024)}KB`);
  check('repeating the old way keeps costing the full picture every time', fullRepeat > 8 * 1024 * 1024);
  check('repeating the new way stays under 20KB for all thirty', slimRepeat < 20 * 1024);
  check('a whole day of checking one stray picture stays under 1MB', perDay < 1024 * 1024);

  // ---- 5. The video list had the same unbounded fault ----
  for (let i = 0; i < 150; i++){
    const id = 'vid' + i;
    kv['video:' + id] = JSON.stringify({ id, r2Key: 'videos/'+id+'.webm', timestamp: 1757000000000 + i*60000, sizeBytes: 5e6 });
    await fakeRedis.lpush('videos:pending', id);
  }
  const vids = await get('/media/pending-videos?' + K);
  check('the recordings list answers', vids.status === 200);
  const vidBody = JSON.parse(vids.body);
  check('it is capped at 100 rather than handing back all 150', vidBody.videos.length === 100);
  check('it says how many are waiting', vidBody.waiting === 100);
  // It carries a POINTER to each recording, never the recording -- which is
  // why there is nothing to slim here.
  check('it carries no video data at all', !/base64/.test(vids.body));
  check('every entry has the pointer the phone needs', vidBody.videos.every(v => v.r2Key && typeof v.timestamp === 'number'));
  check('a hundred recordings still cost under 20KB to list', vids.bytes < 20 * 1024);

  // An id whose record has expired is swept as it is found, so it is not
  // asked about for ever.
  // The newest is at the front, so this one is inside the hundred that are
  // actually looked at. An id further down is not read and so not swept --
  // which is correct: nothing pretends to have checked what it never saw.
  delete kv['video:vid149'];
  const before = (lists['videos:pending'] || []).length;
  await get('/media/pending-videos?' + K);
  const after = (lists['videos:pending'] || []).length;
  check('an expired recording id is swept off the list', after === before - 1);
  check('...and is not handed back', !JSON.parse((await get('/media/pending-videos?' + K)).body).videos.some(v => v.id === 'vid149'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
