// THE CHART CAMERA'S SIDE OF THE SERVICE (cameraEvents.js): the durable,
// numbered list of trade moments, the heartbeat, and recordings that go
// straight to storage. Real route code, a stand-in database, a stand-in
// storage account.
const Module = require('module');
const path = require('path');

let store = {};
const lists = {};
const fakeRedis = {
  set: async (k, v) => { store[k] = v; return 'OK'; },
  get: async (k) => (k in store ? store[k] : null),
  del: async (k) => { delete store[k]; return 1; },
  incr: async (k) => { store[k] = String(Number(store[k] || 0) + 1); return Number(store[k]); },
  lpush: async (k, v) => { (lists[k] = lists[k] || []).unshift(v); return lists[k].length; },
  lrange: async (k, a, b) => (lists[k] || []).slice(a, b === -1 ? undefined : b + 1),
  lrem: async (k, c, v) => { const l = lists[k] || []; const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); return 1; },
  ltrim: async (k, a, b) => { lists[k] = (lists[k] || []).slice(a, b + 1); return 'OK'; },
};
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;

// Storage: switched on or off per case, and told which keys "exist".
const storage = { configured: true, objects: {}, asked: [] };
const fakeVideoStorage = {
  isConfigured: () => storage.configured,
  getUploadUrl: async (key, ct, exp) => { storage.asked.push({ key, ct, exp }); return `https://storage.example/${key}?signed=1&expires=${exp}`; },
  headVideo: async (key) => (key in storage.objects
    ? { found: true, sizeBytes: storage.objects[key], reason: null }
    : { found: false, sizeBytes: null, reason: 'That recording is not in storage.' }),
  uploadVideo: async () => {}, getPlaybackUrl: async () => 'x',
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (/(^|\/)videoStorage(\.js)?$/.test(request)) return fakeVideoStorage;
  return origLoad.apply(this, arguments);
};

process.env.APP_SECRET = 'testkey';
const cam = require(path.join(__dirname, '..', 'cameraEvents.js'));

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

function call(method, route, { query = {}, body = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    const req = { method: method.toUpperCase(), url: route, path: route, query, body, params: {}, headers,
      get(h) { return headers[String(h).toLowerCase()]; } };
    // Through the WHOLE router, the key check included, as a real request.
    cam.router.handle(req, res, (err) => resolve({ status: err ? 500 : 404, body: err || 'no route' }));
  });
}
const auth = { authorization: 'Bearer testkey' };

(async () => {
  // ===== 1. The key is required on every route =====
  for (const [m, r] of [['get', '/events'], ['post', '/heartbeat'], ['get', '/status'], ['post', '/video-upload-url'], ['post', '/video-uploaded'], ['post', '/test-trade']]) {
    const res = await call(m, r, {});
    check(`${m.toUpperCase()} ${r} without the key is turned away`, res.status === 403 || res.status === 401, res.status);
  }

  // ===== 2. The moments: numbered, kept, never deleted by reading =====
  const a = await cam.queueCameraEvent('opened', { ticker: 'IWM', dir: 'Short', legKey: 'X-1', entryTimestamp: 1000 });
  const b = await cam.queueCameraEvent('closed', { ticker: 'IWM', dir: 'Short', legKey: 'X-1', entryTimestamp: 1000, exitTimestamp: 2000, stillOpen: false });
  check('moments are numbered 1, 2 in order', a.seq === 1 && b.seq === 2);
  let r = await call('get', '/events', { query: { after: '0' }, headers: auth });
  check('everything after 0 comes back, oldest first', r.status === 200 && r.body.events.map(e => e.seq).join() === '1,2', r.body);
  check('each moment carries its exact times', r.body.events[1].entryTimestamp === 1000 && r.body.events[1].exitTimestamp === 2000);
  check('the answer says the newest and oldest numbers kept, and the service\'s clock', r.body.latestSeq === 2 && r.body.oldestSeq === 1 && typeof r.body.serverTime === 'number');
  r = await call('get', '/events', { query: { after: '1' }, headers: auth });
  check('after 1: only the closing', r.body.events.length === 1 && r.body.events[0].seq === 2);
  r = await call('get', '/events', { query: { after: '0' }, headers: auth });
  check('reading deletes nothing: both are still there for a second reader', r.body.events.length === 2);
  r = await call('get', '/events', { query: { after: 'nonsense' }, headers: auth });
  check('a cursor that is not a number reads as "from the start", never an error', r.status === 200 && r.body.events.length === 2);

  // Unreadable entries are skipped, not fatal.
  lists[cam.EVENTS_KEY].unshift('{not json');
  r = await call('get', '/events', { query: { after: '0' }, headers: auth });
  check('an unreadable entry is skipped; the rest still come back', r.status === 200 && r.body.events.length === 2);

  // The ceiling: no more than MAX_EVENTS kept, and a camera far behind can tell.
  for (let i = 0; i < cam.MAX_EVENTS + 20; i++) await cam.queueCameraEvent('opened', { ticker: 'SPY', entryTimestamp: i });
  check('no more than the ceiling is kept', lists[cam.EVENTS_KEY].length === cam.MAX_EVENTS);
  r = await call('get', '/events', { query: { after: '0' }, headers: auth });
  check('a camera that was gone a long time can see moments were dropped (oldestSeq > its cursor + 1)', r.body.oldestSeq > 1 && r.body.events.length === cam.MAX_EVENTS);

  // ===== 3. Heartbeat and status =====
  r = await call('get', '/status', { headers: auth });
  check('before any heartbeat: "never", not "offline"', r.body.state === 'never' && r.body.heartbeat === null);
  r = await call('post', '/heartbeat', { headers: auth, body: { version: '1', recording: true, diskFreeBytes: 123, junk: { a: 1 }, problem: 'x'.repeat(1000), misses: ['a', 'b'] } });
  check('a heartbeat is accepted and answered with the service\'s clock', r.body.ok === true && typeof r.body.serverTime === 'number');
  const beat = JSON.parse(store['camera:heartbeat']);
  check('only the known fields are kept, text cut short', beat.version === '1' && beat.recording === true && !('junk' in beat) && beat.problem.length === 300 && beat.misses.length === 2);
  r = await call('get', '/status', { headers: auth });
  check('just after a heartbeat: "online"', r.body.state === 'online' && r.body.secondsSince <= 1);
  beat.receivedAt -= (cam.ONLINE_WITHIN_SECONDS + 60) * 1000; store['camera:heartbeat'] = JSON.stringify(beat);
  r = await call('get', '/status', { headers: auth });
  check('a camera silent for over three minutes reads "quiet", with how long', r.body.state === 'quiet' && r.body.secondsSince >= cam.ONLINE_WITHIN_SECONDS + 60);

  // ===== 4. Recordings straight to storage =====
  storage.configured = false;
  r = await call('post', '/video-upload-url', { headers: auth });
  check('storage not switched on: refused with a reason in plain words', r.status === 503 && /not switched on/.test(r.body.error));
  storage.configured = true;
  r = await call('post', '/video-upload-url', { headers: auth });
  const up = r.body;
  check('a link for ONE named recording, expiring in 15 minutes', r.status === 200 && /^camera-\d+-[0-9a-f]{8}$/.test(up.id) && up.r2Key === `videos/${up.id}.mp4` && up.expiresInSeconds === 900 && up.uploadUrl.includes(up.r2Key));
  r = await call('post', '/video-uploaded', { headers: auth, body: { id: 'other', r2Key: 'videos/other.mp4', entryTimestamp: 5 } });
  check('a recording the service never handed a link for is refused', r.status === 400);
  r = await call('post', '/video-uploaded', { headers: auth, body: { id: up.id, r2Key: up.r2Key } });
  check('a recording with no entry time is refused, saying why', r.status === 400 && /entered/.test(r.body.error));
  r = await call('post', '/video-uploaded', { headers: auth, body: { id: up.id, r2Key: up.r2Key, entryTimestamp: 1000 } });
  check('a recording that never reached storage is NOT offered to the journal', r.status === 409 && /not in storage/.test(r.body.error) && !(lists['videos:pending'] || []).length);
  storage.objects[up.r2Key] = 4242;
  r = await call('post', '/video-uploaded', { headers: auth, body: { id: up.id, r2Key: up.r2Key, entryTimestamp: 1000, exitTimestamp: 2000, ticker: 'IWM', cut: { skippedFrom: 1100, skippedTo: 1500 } } });
  const pv = store[`video:${up.id}`] && JSON.parse(store[`video:${up.id}`]);
  check('once in storage, it joins the journal\'s waiting list, matched by ENTRY time', r.status === 200 && (lists['videos:pending'] || [])[0] === up.id && pv.timestamp === 1000 && pv.r2Key === up.r2Key && pv.sizeBytes === 4242, pv);
  check('...marked as the camera\'s, with its exit time and the minutes left out', pv.source === 'camera' && pv.exitTimestamp === 2000 && pv.cut.skippedFrom === 1100 && pv.ticker === 'IWM');

  // A PRACTICE recording is kept aside, never offered to the journal.
  r = await call('post', '/video-upload-url', { headers: auth });
  const tv = r.body; storage.objects[tv.r2Key] = 99;
  const waitingBefore = (lists['videos:pending'] || []).length;
  r = await call('post', '/video-uploaded', { headers: auth, body: { id: tv.id, r2Key: tv.r2Key, entryTimestamp: 1000, exitTimestamp: 2000, test: true } });
  check('a practice recording is accepted but NOT put on the journal\'s waiting list', r.status === 200 && r.body.test === true && (lists['videos:pending'] || []).length === waitingBefore && !store[`video:${tv.id}`]);
  r = await call('get', '/status', { headers: auth });
  check('...it is kept to one side, where the status shows it', r.body.lastTestVideo && r.body.lastTestVideo.r2Key === tv.r2Key && r.body.lastTestVideo.test === true);

  // ===== 5. The practice trade =====
  const before = Number(store['camera:seq']);
  const t0 = Date.now();
  r = await call('post', '/test-trade', { headers: auth, body: { ticker: 'iwm' } });
  r = await call('get', '/events', { query: { after: String(before) }, headers: auth });
  const [po, pc] = r.body.events;
  check('a practice trade is an opening and a closing, both marked test', r.body.events.length === 2 && po.type === 'opened' && pc.type === 'closed' && po.test && pc.test);
  check('...on the asked symbol, closing six minutes after it opens (so a 5-minute picture falls inside)', po.ticker === 'IWM' && pc.exitTimestamp - pc.entryTimestamp === cam.TEST_CLOSE_AFTER_MS && Math.abs(po.entryTimestamp - t0) < 5000);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: crashed', e && e.stack || e); process.exit(1); });
