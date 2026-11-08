'use strict';
// KEEPING THE DRIVE FROM FILLING. The all-day recording is only raw
// material: kept `keepRawHours`, and never deleted while a picture or
// recording still owed needs it. Trade copies (archive/) are kept until the
// drive runs short. Everything removed is counted and reported.
const fs = require('fs');
const path = require('path');
const { readIndex } = require('./recorder');

function disk(dir) {
  try { const s = fs.statfsSync(dir); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; }
  catch (e) { return { free: null, total: null }; }
}

// The earliest moment any owed job still needs from the recording.
function neededFrom(state) {
  let t = Infinity;
  for (const j of Object.values(state.jobs)) {
    if (j.status !== 'waiting') continue;
    t = Math.min(t, j.kind === 'clip' ? j.from : (j.shot != null ? j.shot : j.at) - 60000);
  }
  return t;
}

function removePiece(p) { try { fs.unlinkSync(p.file); return true; } catch (e) { return false; } }

function tidy(cfg, state, now = Date.now()) {
  const report = { removedPieces: 0, removedArchives: 0, note: null };
  const pieces = readIndex(cfg);
  const needed = neededFrom(state);
  for (const p of pieces) {
    if (p.end < now - cfg.keepRawHours * 3600 * 1000 && p.end < needed) { if (removePiece(p)) report.removedPieces++; }
  }
  // Short of room: the oldest raw recording beyond the last 6 hours first,
  // then the oldest trade copies. Below 5% free, said plainly.
  let d = disk(cfg.dataDir);
  const short = () => d.free != null && d.total && d.free / d.total < 0.10;
  if (short()) {
    for (const p of readIndex(cfg)) {
      if (!short()) break;
      if (p.end < now - 6 * 3600 * 1000 && p.end < needed && removePiece(p)) { report.removedPieces++; d = disk(cfg.dataDir); }
    }
  }
  if (short()) {
    const root = path.join(cfg.dataDir, 'archive');
    const files = [];
    try { for (const day of fs.readdirSync(root).sort()) for (const f of fs.readdirSync(path.join(root, day)).sort()) files.push(path.join(root, day, f)); } catch (e) { /* none */ }
    for (const f of files) {
      if (!short()) break;
      try { fs.unlinkSync(f); report.removedArchives++; d = disk(cfg.dataDir); } catch (e) { /* skip */ }
    }
  }
  if (d.free != null && d.total && d.free / d.total < 0.05) report.note = `the camera's drive is almost full (${Math.round(d.free / 1e9)} GB left)`;
  // Empty run folders left behind.
  try {
    const raw = path.join(cfg.dataDir, 'raw');
    for (const run of fs.readdirSync(raw)) {
      const dir = path.join(raw, run);
      const left = fs.readdirSync(dir).filter(f => f.endsWith('.mkv'));
      if (!left.length && run !== path.basename(state.currentRun || '')) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) { /* nothing to tidy */ }
  report.disk = d;
  return report;
}

module.exports = { tidy, disk, neededFrom };
