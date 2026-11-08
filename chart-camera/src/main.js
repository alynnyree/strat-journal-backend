#!/usr/bin/env node
'use strict';
// THE CHART CAMERA. Runs all day on the small computer at home:
//   - keeps his TradingView chart on its (virtual) screen and records it
//     during market hours;
//   - asks his service every few seconds for trade moments, switching the
//     chart to a traded symbol when nothing else open needs it;
//   - keeps a picture from the exact second of each entry and exit, one
//     every 5 minutes in between, and a recording of each trade, and sends
//     them to his journal, holding them until they are delivered;
//   - checks in once a minute, so "is it running, and if not, why?" always
//     has an answer.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { loadState, saveState, noteProblem } = require('./state');
const { applyEvents, planDuring, prune } = require('./planner');
const { Recorder, readIndex } = require('./recorder');
const { Chart } = require('./chart');
const { Service } = require('./service');
const { runPictures, runOneClip } = require('./jobs');
const { tidy, disk } = require('./retention');
const { isRecordingTime } = require('./clock');

const VERSION = require('../package.json').version;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function start(opts = {}) {
  const loaded = loadConfig(opts.configFile, opts.overrides);
  if (!loaded.ok) {
    console.error('THE CHART CAMERA CANNOT START: ' + loaded.why);
    return { ok: false, why: loaded.why };
  }
  const cfg = loaded.cfg;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const log = opts.log || ((part, msg) => console.log(`${new Date().toISOString()} [${part}] ${msg}`));
  const state = loadState(cfg);
  if (state.loadNote) noteProblem(state, state.loadNote);
  state.startedAt = Date.now();
  const service = opts.service || new Service(cfg);
  const chart = new Chart(cfg, log, opts.playwright);
  chart.history = (state.symbolHistory || []).slice();
  const recorder = new Recorder(cfg, log);
  const shouldRecord = t => (opts.alwaysRecord ? true : isRecordingTime(t, cfg));

  let stopping = false, lastPoll = 0, lastBeat = 0, lastTidy = 0, lastSignInCheck = 0, chartRetryAt = 0, recorderRetryAt = 0;
  let pollOkAt = null, dropFrom = null, picturesBusy = false, clipBusy = false;
  const offset = () => state.clockOffsetMs || 0;

  function clockSample(serverTime, rtt) {
    if (!Number.isFinite(serverTime) || !Number.isFinite(rtt)) return;
    state.clockSamples.push(Date.now() - rtt / 2 - serverTime);
    if (state.clockSamples.length > 9) state.clockSamples.shift();
    const m = median(state.clockSamples);
    state.measuredOffsetMs = Math.round(m);
    // A second or more is a clock that is genuinely off (the network alone
    // does not do that); smaller is left alone rather than chased.
    state.clockOffsetMs = Math.abs(m) >= 1000 ? Math.round(m) : 0;
  }

  async function poll(now) {
    const r = await service.events(state.cursor);
    if (!r.ok) {
      if (pollOkAt != null && dropFrom == null) dropFrom = now;
      state.lastPollProblem = r.reason;
      return;
    }
    if (dropFrom != null) {
      state.drops.push({ from: dropFrom, to: now });
      if (state.drops.length > 20) state.drops.shift();
      dropFrom = null;
    }
    pollOkAt = now; state.lastPollProblem = null;
    clockSample(r.body && r.body.serverTime, r.rtt);
    const before = state.cursor;
    const events = (r.body && r.body.events) || [];
    const added = applyEvents(state, events, r.body && r.body.oldestSeq, cfg);
    if (added.length) log('plan', added.join(', '));
    if (state.missedEvents.length && !state.missedNoted) {
      noteProblem(state, 'the camera was away so long that some trade moments were no longer kept by the service');
      state.missedNoted = true;
    }
    // A newly opened trade: put its symbol on screen now, unless another
    // open trade on a different symbol needs the chart.
    for (const e of events) {
      if (e.seq <= before || e.type !== 'opened') continue;
      const others = Object.values(state.positions).filter(p => p.open && p.legKey !== e.legKey && p.ticker !== e.ticker);
      if (chart.symbol !== e.ticker && !others.length && chart.isOpen) await chart.show(e.ticker);
    }
  }

  async function beat(now) {
    const pieces = readIndex(cfg);
    const d = disk(cfg.dataDir);
    let outbox = 0; try { outbox = fs.readdirSync(path.join(cfg.dataDir, 'outbox')).length; } catch (e) { outbox = 0; }
    const problems = [];
    if (chart.problem) problems.push(chart.problem);
    if (chart.signedOut === true) problems.push('TradingView is signed out on the camera: the chart may show a sign-in page');
    if (recorder.lastExit && !recorder.running && shouldRecord(now)) problems.push(recorder.lastExit.why);
    if (Math.abs(state.measuredOffsetMs || 0) >= 2000) problems.push(`the camera's clock is ${Math.round(state.measuredOffsetMs / 1000)} s off`);
    const b = {
      version: VERSION, recording: recorder.running, chart: chart.problem || (chart.symbol ? `showing ${chart.symbol}` : 'not open'),
      symbol: chart.symbol, signedOut: chart.signedOut, lastFrameAt: pieces.length ? pieces[pieces.length - 1].end : null,
      clockOffsetMs: state.measuredOffsetMs ?? null, diskFreeBytes: d.free, diskTotalBytes: d.total, outbox,
      pendingJobs: Object.values(state.jobs).filter(j => j.status === 'waiting').length, lastSeq: state.cursor,
      drops: state.drops.slice(-5).map(x => `${new Date(x.from).toISOString()} for ${Math.round((x.to - x.from) / 1000)} s`),
      misses: state.problems.slice(-5).map(p => `${new Date(p.at).toISOString()} ${p.why}${p.count > 1 ? ` (x${p.count})` : ''}`),
      problem: problems[0] || null, startedAt: state.startedAt,
    };
    const r = await service.heartbeat(b);
    if (r.ok) clockSample(r.body && r.body.serverTime, r.rtt);
    state.lastBeat = { at: now, ok: r.ok, reason: r.reason };
    return b;
  }

  async function round() {
    const now = Date.now();
    // The recording: on during the recording hours, restarted if it stops.
    if (shouldRecord(now) && !recorder.running && now >= recorderRetryAt) { recorder.start(); state.currentRun = recorder.runDir; recorderRetryAt = now + 10000; }
    if (!shouldRecord(now) && recorder.running) await recorder.stop();
    // The chart: reopened if the browser went away.
    if (!chart.isOpen && now >= chartRetryAt) { chartRetryAt = now + 30000; await chart.open(chart.symbol || state.lastSymbol || cfg.defaultSymbol); }
    if (now - lastPoll >= cfg.pollSeconds * 1000) { lastPoll = now; await poll(now); }
    planDuring(state, now - offset(), cfg);
    const ctx = { cfg, state, chart, service, now: Date.now(), recording: recorder.running };
    if (!picturesBusy) { picturesBusy = true; runPictures(ctx).catch(e => noteProblem(state, `pictures: ${e.message}`)).finally(() => { picturesBusy = false; }); }
    if (!clipBusy) { clipBusy = true; runOneClip(Object.assign({}, ctx)).catch(e => noteProblem(state, `recordings: ${e.message}`)).finally(() => { clipBusy = false; }); }
    if (now - lastSignInCheck >= 5 * 60 * 1000) { lastSignInCheck = now; await chart.checkSignedIn(); }
    if (now - lastBeat >= cfg.heartbeatSeconds * 1000) { lastBeat = now; await beat(now); }
    if (now - lastTidy >= 30 * 60 * 1000) {
      lastTidy = now;
      const t = tidy(cfg, state, now);
      if (t.note) noteProblem(state, t.note, now);
      prune(state, now - offset());
    }
    state.symbolHistory = chart.history.slice(-200);
    state.lastSymbol = chart.symbol || state.lastSymbol || null;
    saveState(cfg, state);
  }

  const loop = (async () => {
    log('camera', `chart camera ${VERSION} starting`);
    while (!stopping) {
      try { await round(); }
      catch (e) { noteProblem(state, `the camera hit a fault and carried on: ${e.message}`); log('camera', e.stack || e.message); }
      await sleep(opts.roundMs || 1000);
    }
  })();

  async function stop() {
    stopping = true;
    await loop;
    while (picturesBusy || clipBusy) await sleep(100);
    await recorder.stop();
    await chart.close();
    saveState(cfg, state);
    log('camera', 'stopped');
  }
  return { ok: true, cfg, state, chart, recorder, stop, beat: () => beat(Date.now()) };
}

module.exports = { start, VERSION };

if (require.main === module) {
  process.on('unhandledRejection', e => console.error('unhandled:', e && e.stack || e));
  process.on('uncaughtException', e => console.error('uncaught:', e && e.stack || e));
  start().then(cam => {
    if (!cam.ok) { setTimeout(() => process.exit(2), 1000); return; }
    const quit = () => { cam.stop().then(() => process.exit(0), () => process.exit(1)); };
    process.on('SIGTERM', quit); process.on('SIGINT', quit);
  });
}
