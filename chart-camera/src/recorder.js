'use strict';
// THE RECORDING. ffmpeg films the camera's own screen (the virtual display
// the chart is drawn on) into short pieces, every frame stamped with the
// real time it was captured, so any second can be found again exactly.
// Measured on the rehearsal machine: a frame asked for at a given moment
// came back within a tenth of a second of it.
//
// Pieces live in <dataDir>/raw/<run>/seg-NNNNN.mkv with a list.csv ffmpeg
// writes as each piece closes: file, start, end (seconds, real time).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function recordArgs(cfg, runDir) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'x11grab', '-framerate', String(cfg.fps), '-video_size', `${cfg.width}x${cfg.height}`, '-draw_mouse', '0',
    '-i', cfg.display,
    '-copyts',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(cfg.recordCrf),
    '-g', String(cfg.fps), '-keyint_min', String(cfg.fps), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-f', 'segment', '-segment_time', String(cfg.segmentSeconds), '-segment_format', 'matroska',
    '-segment_list', path.join(runDir, 'list.csv'), '-segment_list_type', 'csv', '-reset_timestamps', '0',
    path.join(runDir, 'seg-%05d.mkv'),
  ];
}

class Recorder {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log || (() => {});
    this.proc = null; this.runDir = null; this.lastExit = null; this.startedAt = null;
  }
  get running() { return !!this.proc; }
  start() {
    if (this.proc) return;
    const run = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    this.runDir = path.join(this.cfg.dataDir, 'raw', run);
    fs.mkdirSync(this.runDir, { recursive: true });
    const p = spawn(this.cfg.ffmpegPath, recordArgs(this.cfg, this.runDir), {
      env: Object.assign({}, process.env, { TZ: 'UTC' }), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('error', e => { this.lastExit = { at: Date.now(), why: `the recorder could not start (${e.message})` }; });
    p.on('exit', (code, signal) => {
      if (this.proc === p) this.proc = null;
      const asked = this.stopping;
      this.stopping = false;
      this.lastExit = asked ? null : { at: Date.now(), why: `the recorder stopped by itself (${signal || 'exit ' + code})${err ? ': ' + err.trim().split('\n').pop() : ''}` };
      if (!asked) this.log('recorder', this.lastExit.why);
    });
    this.proc = p; this.startedAt = Date.now();
    this.log('recorder', `recording into ${this.runDir}`);
  }
  stop() {
    if (!this.proc) return Promise.resolve();
    const p = this.proc; this.stopping = true;
    return new Promise(res => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 8000);
      p.once('exit', () => { clearTimeout(t); res(); });
      try { p.kill('SIGINT'); } catch (e) { clearTimeout(t); res(); }  // SIGINT lets ffmpeg close the last piece properly
    });
  }
}

// ---- What has been recorded: every finished piece and the seconds it covers.
const startCache = new Map();   // file -> its first frame's time (the first piece's list row says 0)
function fileStart(cfg, file) {
  if (startCache.has(file)) return startCache.get(file);
  let s = null;
  try {
    const out = execFileSync(cfg.ffprobePath, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file]).toString().trim();
    s = Number(out); if (!Number.isFinite(s)) s = null;
  } catch (e) { s = null; }
  if (s != null) startCache.set(file, s);
  return s;
}

function readIndex(cfg) {
  const root = path.join(cfg.dataDir, 'raw');
  const pieces = [];
  let runs = [];
  try { runs = fs.readdirSync(root); } catch (e) { return pieces; }
  for (const run of runs) {
    let csv;
    try { csv = fs.readFileSync(path.join(root, run, 'list.csv'), 'utf8'); } catch (e) { continue; }
    for (const line of csv.split('\n')) {
      const [f, a, b] = line.split(',');
      if (!f || b == null) continue;
      const file = path.join(root, run, f);
      if (!fs.existsSync(file)) continue;
      let start = Number(a), end = Number(b);
      if (!Number.isFinite(end)) continue;
      if (!(start > 1e9)) start = fileStart(cfg, file);   // the first piece of a run
      if (start == null) continue;
      pieces.push({ file, start: start * 1000, end: end * 1000 });
    }
  }
  return pieces.sort((x, y) => x.start - y.start);
}

// The piece holding moment `t` (ms), the newest recorded moment, and
// whether `t` falls in a stretch nothing was recorded.
function locate(pieces, t) {
  const piece = pieces.find(p => t >= p.start && t < p.end) || null;
  const lastEnd = pieces.length ? pieces[pieces.length - 1].end : null;
  return { piece, lastEnd, recordedPast: lastEnd != null && t < lastEnd, gap: !piece && lastEnd != null && t < lastEnd };
}

module.exports = { Recorder, readIndex, locate, recordArgs, fileStart };
