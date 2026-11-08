'use strict';
// The camera's memory between restarts: how far it has read the service's
// list, the positions it is watching, every picture and recording it still
// owes, and which symbol was on screen when. Written whole to a new file and
// then renamed over the old, so a power cut can never leave half a file.
const fs = require('fs');
const path = require('path');
const { emptyState } = require('./planner');

function statePath(cfg) { return path.join(cfg.dataDir, 'state.json'); }

function loadState(cfg) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
    return Object.assign(emptyState(), { symbolHistory: [], drops: [], problems: [], clockSamples: [] }, s);
  } catch (e) {
    return Object.assign(emptyState(), { symbolHistory: [], drops: [], problems: [], clockSamples: [], fresh: true,
      loadNote: e.code === 'ENOENT' ? null : `the camera's memory file could not be read (${e.message}); it started afresh` });
  }
}

function saveState(cfg, state) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = statePath(cfg), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// A short list of what went wrong recently, in plain words, for the
// heartbeat. Repeats of the same reason are counted, not listed again.
function noteProblem(state, why, now = Date.now()) {
  const last = state.problems[state.problems.length - 1];
  if (last && last.why === why) { last.count = (last.count || 1) + 1; last.at = now; return; }
  state.problems.push({ at: now, why, count: 1 });
  if (state.problems.length > 20) state.problems.splice(0, state.problems.length - 20);
}

module.exports = { loadState, saveState, noteProblem, statePath };
