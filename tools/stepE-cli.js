// AUDIT STEP E, part E1: the command that runs tools/stepE-prepare.js on two
// local files. It is NOT part of the running server.
//
//   node tools/stepE-cli.js <journal export.json> <backup copy.json> <output folder> [range start YYYY-MM-DD]
//
// Both inputs are opened READ-ONLY and never modified. It always writes the
// dry-run log; only when nothing stopped it does it also write the prepared
// journal and the restore file. Owner data: the output folder must be outside
// any repository (these files are never committed).
const fs = require('fs');
const path = require('path');
const { prepare, REFERENCE_B } = require('./stepE-prepare');

function readJson(file) {
  const fd = fs.openSync(file, 'r');           // read-only
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}

const [journalFile, backupFile, outDir, rangeStart] = process.argv.slice(2);
if (!journalFile || !backupFile || !outDir) {
  console.log('Usage: node tools/stepE-cli.js <journal export.json> <backup copy.json> <output folder> [range start YYYY-MM-DD]');
  process.exit(2);
}
const r = prepare({ journal: readJson(journalFile), backup: readJson(backupFile), rangeStart: rangeStart || undefined, reference: REFERENCE_B });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'stepE-dry-run-log.txt'), r.log);
if (!r.stopped) {
  fs.writeFileSync(path.join(outDir, 'stepE-prepared-journal.json'), JSON.stringify(r.prepared));
  fs.writeFileSync(path.join(outDir, 'stepE-restore.json'), JSON.stringify(r.restore));
}
console.log(r.stopped ? `STOPPED (${r.stops.length}); log written, no prepared journal.` : 'Prepared; log, prepared journal and restore file written.');
process.exit(r.stopped ? 1 : 0);
