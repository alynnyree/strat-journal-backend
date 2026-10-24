// A REAL older build of this service, taken from its own history, for the
// checks that must run it (Queue plan v14.1 rev 3.2: Q-T11 and Q-T24 run
// "the REAL older builds", generation 1 = eb3880b and generation 0 =
// 6cb24a4, never a copy written for the test).
//
// The commit's files are written to a fresh folder exactly as committed
// (git archive), and that folder is given this checkout's installed packages,
// so `require` inside it loads the old code and nothing else.
//
// A history without the commit (a shallow clone) is a FAILURE of the check,
// not a reason to skip it: the automatic checks fetch the whole history.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.join(__dirname, '..', '..');
const GEN1 = 'eb3880b83b3e90ceda0b458533d579148d9fbd53';   // Deploy 1, main since 23 Oct 2026
const GEN0 = '6cb24a4';                                     // main before Deploy 1

const made = [];
function olderBuild(commit) {
  try { execFileSync('git', ['-C', BACKEND, 'cat-file', '-e', commit + '^{commit}'], { stdio: 'ignore' }); }
  catch (e) { throw new Error(`commit ${commit} is not in this checkout's history (a shallow clone?); the older build cannot be run`); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'older-build-'));
  // Streamed through a pipe: the archive is larger than a captured buffer.
  execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', BACKEND, commit, dir], { stdio: 'ignore' });
  if (!fs.existsSync(path.join(dir, 'tradeStore.js'))) throw new Error('the older build at ' + commit + ' could not be written out');
  // This repository keeps its installed packages in history, so the old build
  // normally brings its own; only if it does not are this checkout's lent to it.
  if (!fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  made.push(dir);
  return dir;
}
function removeOlderBuilds() {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

module.exports = { olderBuild, removeOlderBuilds, GEN1, GEN0 };
