'use strict';
// Pictures and recordings cut out of the recorded pieces.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { locate } = require('./recorder');

function run(bin, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise(res => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      res({ ok: !err, err: err ? String(stderr || err.message).trim().split('\n').pop() : null, stdout: String(stdout || '') });
    });
  });
}

// THE PICTURE AT MOMENT `t` (ms, real time). Answers with the moment the
// frame actually shows -- never just "a frame" -- and with a reason when
// there is none: "nothing recorded yet", "the camera was not recording
// then" and "the recording could not be read" are different faults.
async function frameAt(cfg, pieces, t, outFile) {
  const loc = locate(pieces, t);
  if (!loc.recordedPast) return { ok: false, wait: true, reason: 'not recorded yet' };
  if (!loc.piece) return { ok: false, wait: false, reason: 'the camera was not recording at that moment' };
  const step = 1000 / cfg.fps;
  // A moment after a piece's last frame (the last fifth of a second) is
  // looked for one frame earlier, then at the start of the next piece.
  const next = pieces.find(p => p.start >= loc.piece.end - 1 && p.start <= t + 2 * step);
  const tries = [[loc.piece, t], [loc.piece, t - step]].concat(next ? [[next, next.start]] : []);
  for (const [piece, at] of tries) {
    const offset = Math.max(0, (at - piece.start) / 1000);
    try { fs.unlinkSync(outFile); } catch (e) { /* none yet */ }
    const r = await run(cfg.ffmpegPath, ['-v', 'error', '-y', '-ss', offset.toFixed(3), '-i', piece.file, '-frames:v', '1',
      '-vf', `scale='min(${cfg.pictureWidth},iw)':-2`, '-q:v', '3', outFile], 60 * 1000);
    if (r.ok && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return { ok: true, shows: at, file: outFile };
  }
  return { ok: false, wait: false, reason: 'the recording of that moment could not be read' };
}

// The recorded pieces overlapping [a, b), joined into stretches with no
// hole in them (the recorder may have been stopped in between).
function stretches(pieces, a, b) {
  const over = pieces.filter(p => p.end > a && p.start < b);
  const groups = [];
  for (const p of over) {
    const g = groups[groups.length - 1];
    if (g && p.start - g.end < 1000) { g.pieces.push(p); g.end = p.end; }
    else groups.push({ start: p.start, end: p.end, pieces: [p] });
  }
  return groups.map(g => Object.assign(g, { from: Math.max(a, g.start), to: Math.min(b, g.end) })).filter(g => g.to > g.from);
}

// THE PHONE VERSION OF ONE TRADE'S RECORDING: the kept stretches of time
// (`parts`, from the planner), smaller and lighter, one file. Says how much
// of what was asked for the camera actually has.
async function makeClip(cfg, pieces, parts, outFile, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const wanted = parts.reduce((t, [a, b]) => t + (b - a), 0);
  const bits = [];
  let have = 0, n = 0;
  for (const [a, b] of parts) {
    for (const g of stretches(pieces, a, b)) {
      const list = path.join(workDir, `list-${n}.txt`);
      fs.writeFileSync(list, g.pieces.map(p => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      const bit = path.join(workDir, `bit-${n}.mp4`);
      const r = await run(cfg.ffmpegPath, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-ss', ((g.from - g.start) / 1000).toFixed(3), '-t', ((g.to - g.from) / 1000).toFixed(3),
        '-vf', `scale=-2:${cfg.phoneVideoHeight},fps=${cfg.fps}`, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', String(cfg.phoneVideoCrf), '-pix_fmt', 'yuv420p', '-an', bit]);
      if (!r.ok) return { ok: false, reason: `a stretch of the recording could not be prepared (${r.err})` };
      bits.push(bit); have += g.to - g.from; n++;
    }
  }
  if (!bits.length) return { ok: false, reason: 'the camera was not recording during this trade' };
  if (have < wanted * 0.5) return { ok: false, reason: `the camera recorded only ${Math.round(have / 60000)} of ${Math.round(wanted / 60000)} minutes of this trade` };
  const joinList = path.join(workDir, 'join.txt');
  fs.writeFileSync(joinList, bits.map(b => `file '${b.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const r = await run(cfg.ffmpegPath, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', joinList, '-c', 'copy', '-movflags', '+faststart', outFile]);
  if (!r.ok) return { ok: false, reason: `the recording could not be put together (${r.err})` };
  return { ok: true, file: outFile, missedMs: Math.max(0, wanted - have), wantedMs: wanted, haveMs: have };
}

// The FULL-QUALITY copy kept on the camera's own drive: the recorded pieces
// covering the whole trade, joined without re-encoding (quick, no loss).
async function archiveClip(cfg, pieces, from, to, outFile, workDir) {
  const over = pieces.filter(p => p.end > from && p.start < to);
  if (!over.length) return { ok: false, reason: 'nothing was recorded during this trade' };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const list = path.join(workDir, 'archive.txt');
  fs.writeFileSync(list, over.map(p => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const r = await run(cfg.ffmpegPath, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile]);
  return r.ok ? { ok: true, file: outFile } : { ok: false, reason: `the full-quality copy could not be made (${r.err})` };
}

async function durationOf(cfg, file) {
  const r = await run(cfg.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60 * 1000);
  const d = Number(r.stdout.trim());
  return Number.isFinite(d) ? d : null;
}

module.exports = { frameAt, makeClip, archiveClip, stretches, durationOf };
