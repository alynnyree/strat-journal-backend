'use strict';
// DOING WHAT IS OWED: each picture and recording the planner listed, taken
// from the recording, checked, and sent. Kept on the camera until his
// service has it, so a dropped connection delays a picture, never loses it.
const fs = require('fs');
const path = require('path');
const { readIndex, locate } = require('./recorder');
const { frameAt, makeClip, archiveClip } = require('./frames');
const { nyClock, nyParts } = require('./clock');
const { noteProblem } = require('./state');

const MIN = 60 * 1000;
const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const word = m => (m === 'entry' ? 'entry' : m === 'exit' ? 'exit' : 'picture');

function settle(job, status, reason, now) {
  job.status = status; job.reason = reason || null; job.settledAt = now;
}
// Could not reach the service (or storage): try again later, kept on the
// camera meanwhile. Up to 10 minutes apart; never given up while unsent.
function later(job, reason, now) {
  job.tries = (job.tries || 0) + 1;
  job.reason = reason;
  job.nextTryAt = now + Math.min(10 * MIN, 10000 * Math.pow(2, Math.min(job.tries, 6)));
}
const retryable = r => !r.reached || r.status === 429 || (r.status >= 500 && r.status !== 503);

// Which moment's frame to keep for this picture, and what to say about it.
// The chart's symbol log decides; a picture of the wrong symbol is never sent.
function choose(ctx, job, target) {
  const { chart, cfg, state, now } = ctx;
  const at = chart.symbolAt(target);
  if (at && at.symbol === job.ticker) return { shot: target, note: null };
  const sw = chart.switchedTo(job.ticker, target);
  if (sw != null && sw - target <= cfg.lateSwitchWithinMs) {
    return { shot: sw, note: `taken ${Math.max(1, Math.round((sw - target) / 1000))} s after your ${word(job.moment)} at ${nyClock(job.at)}: the chart was switching to ${job.ticker}` };
  }
  if (!at) return { shot: target, note: `the camera has no record of which symbol was showing at ${nyClock(job.at)}` };
  // The chart showed another symbol and did not switch in time. A picture
  // of now, labelled as late, if the trade is recent and nothing else open
  // needs the chart; otherwise none, and why.
  if (now - job.at > cfg.latePictureWithinMs) return { none: `the chart was showing ${at.symbol}, not ${job.ticker}, at ${nyClock(job.at)}` };
  const others = Object.values(state.positions).filter(p => p.open && p.ticker !== job.ticker && p.legKey !== job.legKey);
  if (others.length) return { none: `the chart was showing ${at.symbol}, not ${job.ticker}, at ${nyClock(job.at)}, and is needed for the open ${others[0].ticker} trade` };
  return { switchFirst: true, note: `taken late: the chart was showing ${at.symbol} at your ${word(job.moment)} (${nyClock(job.at)})` };
}

async function doPicture(ctx, job, pieces) {
  const { cfg, service, chart, state, now } = ctx;
  const offset = state.clockOffsetMs || 0;                 // the camera's clock minus the true time
  let shot = job.shot, note = job.note;
  if (shot == null) {
    if (job.at + offset > now) return;                     // not that moment yet
    const c = choose(ctx, job, job.at + offset);
    if (c.none) { settle(job, 'failed', c.none, now); noteProblem(state, c.none, now); return; }
    if (c.switchFirst) {
      if (chart.symbol !== job.ticker) await chart.show(job.ticker);
      if (chart.symbol !== job.ticker) { later(job, chart.problem || `the chart would not switch to ${job.ticker}`, now); return; }
      const h = chart.symbolAt(Date.now());
      shot = h ? h.from : Date.now(); note = `${c.note}; taken at ${nyClock(shot - offset)}`;
    } else { shot = c.shot; note = c.note; }
    job.shot = shot; job.note = note;
  }
  const file = path.join(cfg.dataDir, 'outbox', safe(job.id) + '.jpg');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const f = await frameAt(cfg, pieces, shot, file);
    if (!f.ok) {
      if (f.wait) {
        // Not recorded yet. If the recorder is not running and the moment
        // is well past, it never will be.
        if (!ctx.recording && now - shot > 2 * MIN) { settle(job, 'failed', `the camera was not recording at ${nyClock(job.at)}`, now); noteProblem(state, job.reason, now); }
        return;
      }
      settle(job, 'failed', `${f.reason} (${nyClock(job.at)})`, now); noteProblem(state, job.reason, now); return;
    }
  }
  const r = await service.picture(file, { at: job.at, moment: job.moment, note, test: job.test });
  if (r.ok) { settle(job, 'done', null, now); try { fs.unlinkSync(file); } catch (e) { /* gone */ } return; }
  if (retryable(r)) { later(job, r.reason, now); return; }
  settle(job, 'failed', r.reason, now); noteProblem(state, `a picture was refused: ${r.reason}`, now);
}

async function doClip(ctx, job, pieces) {
  const { cfg, service, state, now } = ctx;
  const offset = state.clockOffsetMs || 0;
  const to = job.to + offset;
  const loc = locate(pieces, to);
  if (!job.made) {
    if (to > now) return;                                   // the trade's last minute is still being recorded
    if (!loc.recordedPast && (ctx.recording || now - to < 2 * MIN)) return;
    const work = path.join(cfg.dataDir, 'work', safe(job.id));
    const parts = job.parts.map(([a, b]) => [a + offset, b + offset]);
    const phone = path.join(cfg.dataDir, 'outbox', safe(job.id) + '.mp4');
    fs.mkdirSync(path.dirname(phone), { recursive: true });
    const c = await makeClip(cfg, pieces, parts, phone, work);
    if (!c.ok) { settle(job, 'failed', `${c.reason} (${job.ticker}, entered ${nyClock(job.entryTs)})`, now); noteProblem(state, job.reason, now); return; }
    const p = nyParts(job.entryTs);
    const archive = path.join(cfg.dataDir, 'archive', p.date, `${safe(job.ticker)}-${nyClock(job.entryTs).replace(/:/g, '')}-${safe(job.id).slice(-24)}.mkv`);
    const a = await archiveClip(cfg, pieces, job.from + offset, to, archive, work);
    job.archive = a.ok ? archive : null;
    if (!a.ok) noteProblem(state, a.reason, now);
    job.made = { file: phone, missedMs: c.missedMs };
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* only tidying */ }
  }
  const meta = { entryTimestamp: job.entryTs, exitTimestamp: job.exitTs, ticker: job.ticker, test: !!job.test };
  if (job.cut) meta.cut = job.cut;
  const r = await service.video(job.made.file, meta);
  if (r.ok) { settle(job, 'done', job.made.missedMs ? `the camera missed ${Math.round(job.made.missedMs / 60000)} minute(s) of this trade` : null, now); try { fs.unlinkSync(job.made.file); } catch (e) { /* gone */ } return; }
  if (r.status === 503) { settle(job, 'failed', `${r.reason}; the full-quality copy is kept on the camera`, now); noteProblem(state, job.reason, now); return; }
  if (retryable(r)) { later(job, r.reason, now); return; }
  settle(job, 'failed', r.reason, now); noteProblem(state, `a recording was refused: ${r.reason}`, now);
}

const due = (ctx, kind) => Object.values(ctx.state.jobs)
  .filter(j => j.kind === kind && j.status === 'waiting' && (j.nextTryAt || 0) <= ctx.now).sort((a, b) => a.at - b.at);

// Every picture that is due. Pictures and recordings run on separate
// tracks: a recording takes minutes to prepare and must never hold up the
// next picture.
async function runPictures(ctx) {
  const pieces = readIndex(ctx.cfg);
  for (const j of due(ctx, 'picture')) {
    try { await doPicture(ctx, j, pieces); }
    catch (e) { later(j, `the picture could not be prepared (${e.message})`, ctx.now); }
  }
}

// At most one recording per round; the next round takes the next one.
async function runOneClip(ctx) {
  const clip = due(ctx, 'clip')[0];
  if (!clip) return;
  try { await doClip(ctx, clip, readIndex(ctx.cfg)); }
  catch (e) { later(clip, `the recording could not be prepared (${e.message})`, ctx.now); }
}

module.exports = { runPictures, runOneClip, doPicture, doClip, choose };
