'use strict';
// THE CHART CAMERA'S FULL REHEARSAL, on one machine, before any camera
// exists. Everything real except three stand-ins:
//   - TradingView is fake-chart.html, whose colour says the moment it was
//     painted (to a tenth of a second) and which symbol it shows;
//   - the service's database is a stand-in (the real /media and /camera
//     route code runs on it);
//   - video storage is a folder on this machine.
// The real recorder (ffmpeg), the real browser (Chromium, on a virtual
// screen) and the real camera program do the rest. Every picture the
// camera sends is read back and its colour decoded, so "the picture shows
// the second of the fill" is measured, not assumed.
//
//   node chart-camera/test/rehearsal.js        (needs Xvfb, ffmpeg, Chromium)
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BACKEND = path.join(__dirname, '..', '..');
const CAM = path.join(__dirname, '..');
const PW = process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core';
const BROWSER = process.env.REHEARSAL_BROWSER || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DISPLAY = process.env.REHEARSAL_DISPLAY || ':95';
const W = 1280, H = 720;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
setTimeout(() => { console.log('FAIL: the rehearsal stalled'); process.exit(1); }, 12 * 60 * 1000).unref();

// ---- The service's database and storage, stood in for.
const store = {}, lists = {};
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-camera-rehearsal-'));
const STORAGE = path.join(WORK, 'storage');
fs.mkdirSync(STORAGE, { recursive: true });
let base = null;
const fakeStorage = {
  isConfigured: () => true,
  getUploadUrl: async (key) => `${base}/storage/${encodeURIComponent(key)}`,
  headVideo: async (key) => { const f = path.join(STORAGE, encodeURIComponent(key)); return fs.existsSync(f) ? { found: true, sizeBytes: fs.statSync(f).size, reason: null } : { found: false, sizeBytes: null, reason: 'That recording is not in storage.' }; },
  uploadVideo: async () => {}, getPlaybackUrl: async () => 'x',
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (/(^|\/)videoStorage(\.js)?$/.test(request)) return fakeStorage;
  return origLoad.apply(this, arguments);
};
process.env.APP_SECRET = 'rehearsal-key';
const express = require(path.join(BACKEND, 'node_modules', 'express'));
const mediaRouter = require(path.join(BACKEND, 'media.js'));
const camEvents = require(path.join(BACKEND, 'cameraEvents.js'));

// ---- The service, with a switch that makes it unreachable (a dropped line).
let down = false;
const app = express();
app.use((req, res, next) => { if (down && !req.path.startsWith('/chart')) { req.socket.destroy(); return; } next(); });
app.use(express.json());
app.get('/chart/', (req, res) => res.sendFile(path.join(CAM, 'test', 'fake-chart.html')));
app.put('/storage/:key', (req, res) => {
  const out = fs.createWriteStream(path.join(STORAGE, encodeURIComponent(req.params.key)));
  req.pipe(out); out.on('finish', () => res.status(200).end());
});
app.use('/media', mediaRouter);
app.use('/camera', camEvents.router);

// ---- Reading a picture back: its colour says when it was painted and what.
const SYMBOL_CODE = { SPY: 40, IWM: 200 };
function readPicture(dataUrlOrFile, nearMs) {
  let file = dataUrlOrFile;
  if (dataUrlOrFile.startsWith('data:')) {
    file = path.join(WORK, `pic-${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(file, Buffer.from(dataUrlOrFile.split(',')[1], 'base64'));
  }
  const rgb = [...execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=40:40:${W / 2 - 20}:${H - 120},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
  const tenth = Math.floor(nearMs / 100);
  const d = ((rgb[0] - (tenth % 250)) % 250 + 375) % 250 - 125;
  const symbol = Object.keys(SYMBOL_CODE).find(s => Math.abs(SYMBOL_CODE[s] - rgb[2]) < 25) || `unknown(${rgb[2]})`;
  return { shows: (tenth + d) * 100, symbol, rgb };
}
const pictures = () => (lists['screenshots:pending'] || []).map(id => JSON.parse(store[`screenshot:${id}`])).sort((a, b) => a.timestamp - b.timestamp);
const fmt = ms => new Date(ms).toISOString().slice(11, 23);

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); }
  console.log(`   (waited ${ms / 1000} s for: ${label})`);
  return false;
}

(async () => {
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(800);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const CFG = path.join(WORK, 'config.json');
  fs.writeFileSync(CFG, JSON.stringify({ serviceUrl: base, appKey: 'rehearsal-key', chartUrl: `${base}/chart/` }));
  const overrides = {
    dataDir: path.join(WORK, 'data'), display: DISPLAY, width: W, height: H, browserPath: BROWSER,
    fps: 5, segmentSeconds: 5, symbolSettleMs: 1500, pollSeconds: 1, heartbeatSeconds: 3,
    intervalMinutes: 0.25, duringStopsBeforeExitSeconds: 5, preRollSeconds: 5, postRollSeconds: 5,
    maxVideoMinutes: 1, keepHeadMinutes: 0.5, keepTailMinutes: 0.25,
  };
  const { start } = require(path.join(CAM, 'src', 'main.js'));
  const quietLog = () => {};
  let cam = await start({ configFile: CFG, overrides, playwright: require(PW), alwaysRecord: true, log: quietLog, roundMs: 300 });
  check('the camera starts with the rehearsal settings', cam.ok, cam.why);
  if (!cam.ok) process.exit(1);
  await waitFor(() => cam.chart.symbol === 'SPY', 30000, 'the chart to open on SPY');
  check('the chart opens on the default symbol, SPY', cam.chart.symbol === 'SPY', cam.chart.problem);
  // Recording well before the first trade, so the minute of lead-in a
  // recording keeps shows the chart, not the browser still opening.
  await sleep(12000);

  // ===== A. A SPY trade, the chart already on SPY =====
  console.log('\n--- A. SPY, the chart already showing SPY: pictures at the exact seconds ---');
  const aEntry = Date.now() - 1500;                                   // the fill happened a moment before the service heard
  await camEvents.queueCameraEvent('opened', { ticker: 'SPY', dir: 'Long', legKey: 'A-leg', entryTimestamp: aEntry });
  await sleep(17000);
  // The camera restarts mid-trade (a power blip): it must carry on.
  await cam.stop();
  check('A: the camera stops cleanly mid-trade (a restart)', true);
  cam = await start({ configFile: CFG, overrides, playwright: require(PW), alwaysRecord: true, log: quietLog, roundMs: 300 });
  await waitFor(() => cam.chart.symbol === 'SPY', 30000, 'the chart to reopen');
  await sleep(14000);
  const aExit = Date.now() - 1000;
  await camEvents.queueCameraEvent('closed', { ticker: 'SPY', dir: 'Long', legKey: 'A-leg', tradeId: 'A-trade', entryTimestamp: aEntry, exitTimestamp: aExit, stillOpen: false });
  await waitFor(() => pictures().filter(p => p.timestamp >= aEntry && p.timestamp <= aExit).length >= 4, 60000, 'A pictures');
  const aPics = pictures().filter(p => p.timestamp >= aEntry && p.timestamp <= aExit);
  const aEntryPic = aPics.find(p => p.moment === 'entry'), aExitPic = aPics.find(p => p.moment === 'exit');
  const aDuring = aPics.filter(p => p.moment === 'during');
  for (const [label, pic, at] of [['entry', aEntryPic, aEntry], ['exit', aExitPic, aExit]]) {
    if (!pic) { check(`A: an ${label} picture arrived`, false); continue; }
    const r = readPicture(pic.image, at);
    check(`A: the ${label} picture shows SPY at ${fmt(r.shows)} for a fill at ${fmt(at)} (off by ${((r.shows - at) / 1000).toFixed(2)} s; must be within 0.3 s)`,
      r.symbol === 'SPY' && Math.abs(r.shows - at) <= 300 && pic.source === 'camera' && !pic.note, { r, note: pic.note });
  }
  check(`A: during pictures every 15 s (rehearsal speed) across the restart: ${aDuring.map(p => '+' + Math.round((p.timestamp - aEntry) / 1000) + 's').join(' ')}`,
    aDuring.length === 2 && Math.round((aDuring[0].timestamp - aEntry) / 1000) === 15 && Math.round((aDuring[1].timestamp - aEntry) / 1000) === 30, aDuring.map(p => p.timestamp - aEntry));
  for (const p of aDuring) {
    const r = readPicture(p.image, p.timestamp);
    check(`A: the during picture for ${fmt(p.timestamp)} shows that moment (off by ${((r.shows - p.timestamp) / 1000).toFixed(2)} s)`, r.symbol === 'SPY' && Math.abs(r.shows - p.timestamp) <= 300, r);
  }

  // ===== B. An IWM trade while SPY is on screen; the line drops mid-trade =====
  console.log('\n--- B. IWM while SPY is showing; the connection drops mid-trade; longer than the kept length ---');
  const bEntry = Date.now() - 1500;
  await camEvents.queueCameraEvent('opened', { ticker: 'IWM', dir: 'Short', legKey: 'B-leg', entryTimestamp: bEntry });
  await waitFor(() => cam.chart.symbol === 'IWM', 20000, 'the chart to switch to IWM');
  check('B: the chart switches to IWM when the trade opens', cam.chart.symbol === 'IWM');
  await sleep(10000);
  down = true;
  console.log('   (the service is unreachable for 20 s)');
  await sleep(20000);
  down = false;
  await sleep(40000);
  const bExit = Date.now() - 1000;
  await camEvents.queueCameraEvent('closed', { ticker: 'IWM', dir: 'Short', legKey: 'B-leg', tradeId: 'B-trade', entryTimestamp: bEntry, exitTimestamp: bExit, stillOpen: false });
  await waitFor(() => pictures().some(p => p.moment === 'exit' && p.timestamp === bExit), 60000, 'B exit picture');
  const bPics = pictures().filter(p => p.timestamp >= bEntry && p.timestamp <= bExit);
  const bEntryPic = bPics.find(p => p.moment === 'entry');
  if (bEntryPic) {
    const r = readPicture(bEntryPic.image, bEntry + 3000);
    const switchedAt = cam.chart.switchedTo('IWM', bEntry);
    check(`B: the entry picture shows IWM, never SPY (painted ${fmt(r.shows)}; the chart settled on IWM at ${fmt(switchedAt)})`, r.symbol === 'IWM' && Math.abs(r.shows - switchedAt) <= 400, r);
    check(`B: and it SAYS it was taken after the fill: "${bEntryPic.note}"`, /after your entry/.test(bEntryPic.note || '') && /switching to IWM/.test(bEntryPic.note || ''));
    check('B: it is still filed at the moment of the fill, so the journal matches it to the entry', bEntryPic.timestamp === bEntry);
  } else check('B: an entry picture arrived', false);
  const bDuring = bPics.filter(p => p.moment === 'during');
  const expected = []; for (let k = 1; bEntry + k * 15000 <= bExit - 5000; k++) expected.push(k * 15);
  check(`B: every during picture arrived, including those due while the line was down: ${bDuring.map(p => '+' + Math.round((p.timestamp - bEntry) / 1000)).join(' ')} (expected ${expected.map(x => '+' + x).join(' ')})`,
    bDuring.map(p => Math.round((p.timestamp - bEntry) / 1000)).join() === expected.join(), bDuring.map(p => p.timestamp - bEntry));
  let worst = 0;
  for (const p of bDuring) { const r = readPicture(p.image, p.timestamp); worst = Math.max(worst, Math.abs(r.shows - p.timestamp)); if (r.symbol !== 'IWM') worst = Infinity; }
  check(`B: each during picture shows IWM at its own moment, even those sent after the line came back (worst ${(worst / 1000).toFixed(2)} s)`, worst <= 300);
  const bExitPic = bPics.find(p => p.moment === 'exit');
  if (bExitPic) { const r = readPicture(bExitPic.image, bExit); check(`B: the exit picture shows IWM at the second of the sale (off by ${((r.shows - bExit) / 1000).toFixed(2)} s)`, r.symbol === 'IWM' && Math.abs(r.shows - bExit) <= 300, r); }
  else check('B: an exit picture arrived', false);
  const beat = cam.state;
  check(`B: the dropped connection was recorded (${(beat.drops || []).length} drop(s))`, (beat.drops || []).some(d => d.to - d.from >= 15000), beat.drops);

  // ===== Recordings =====
  console.log('\n--- Recordings: one per trade, the long one cut to the kept length ---');
  await waitFor(() => (lists['videos:pending'] || []).length >= 2, 180000, 'both recordings');
  const vids = (lists['videos:pending'] || []).map(id => JSON.parse(store[`video:${id}`]));
  const vA = vids.find(v => v.timestamp === aEntry), vB = vids.find(v => v.timestamp === bEntry);
  check('a recording arrived for each trade, filed at its ENTRY time, marked as the camera\'s', !!vA && !!vB && vA.source === 'camera' && vB.source === 'camera', vids);
  const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  if (vA) {
    const fA = path.join(STORAGE, encodeURIComponent(vA.r2Key)); const dA = dur(fA);
    const want = (aExit - aEntry) / 1000 + 10;
    check(`A's recording runs from 5 s before the buy to 5 s after the sale: ${dA.toFixed(1)} s (wanted ${want.toFixed(1)} s, uncut)`, Math.abs(dA - want) <= 1.5 && !vA.cut, { dA, want });
    const first = path.join(WORK, 'vA-first.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fA, '-frames:v', '1', first]);
    const r = readPicture(first, aEntry - 5000);
    check(`A's recording starts at ${fmt(r.shows)} (5 s before the fill at ${fmt(aEntry)})`, Math.abs(r.shows - (aEntry - 5000)) <= 400, r);
  }
  if (vB) {
    const fB = path.join(STORAGE, encodeURIComponent(vB.r2Key)); const dB = dur(fB);
    check(`B's recording is cut to the kept length: ${dB.toFixed(1)} s (30 s from the start + 15 s at the end = 45 s)`, Math.abs(dB - 45) <= 1.5, dB);
    check('...and says exactly which stretch was left out', vB.cut && vB.cut.skippedTo - vB.cut.skippedFrom === (bExit + 5000 - 15000) - (bEntry - 5000 + 30000), vB.cut);
    const last = path.join(WORK, 'vB-last.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.3', '-i', fB, '-frames:v', '1', last]);
    const r = readPicture(last, bExit + 5000);
    check(`B's recording ends at ${fmt(r.shows)}, 5 s after the sale (the exit is always in it)`, r.symbol === 'IWM' && Math.abs(r.shows - (bExit + 5000)) <= 600, r);
  }
  const archives = [];
  (function walk(d) { try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : archives.push(p); } } catch (e) { /* none */ } })(path.join(overrides.dataDir, 'archive'));
  check(`a full-quality copy of each trade is kept on the camera (${archives.length} file(s))`, archives.length === 2);

  // ===== The heartbeat, and a signed-out chart =====
  console.log('\n--- The check-in, and TradingView signed out ---');
  const b1 = await cam.beat();
  check(`the check-in reports recording, the chart, the drive and the clock (offset ${b1.clockOffsetMs} ms)`, b1.recording === true && /showing IWM/.test(b1.chart) && b1.diskFreeBytes > 0 && Math.abs(b1.clockOffsetMs) < 1000 && b1.pendingJobs === 0, b1);
  const status = JSON.parse(store['camera:heartbeat']);
  check('...and the service keeps it', status.recording === true && status.version === b1.version);
  await cam.chart.page.goto(`${base}/chart/?symbol=IWM&signedout=1`);
  await cam.chart.checkSignedIn();
  const b2 = await cam.beat();
  check(`a TradingView "Sign in" button is noticed and reported: "${b2.problem}"`, cam.chart.signedOut === true && /signed out/.test(b2.problem || ''));
  await cam.chart.page.goto(`${base}/chart/?symbol=IWM`);
  await cam.chart.checkSignedIn();
  check('...and cleared when signed in again', cam.chart.signedOut === false);

  await cam.stop();
  srv.close(); xvfb.kill();
  const leftovers = fs.readdirSync(path.join(overrides.dataDir, 'outbox'));
  check('nothing is left waiting in the outbox', leftovers.length === 0, leftovers);
  console.log(`\n(work folder: ${WORK})`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: the rehearsal crashed', e && e.stack || e); process.exit(1); });
