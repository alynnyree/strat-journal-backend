// AUDIT STEP E: the command that runs tools/stepE-compare.js on local files.
// It is NOT part of the running server.
//
//   node tools/stepE-compare-cli.js <approval.json> <X0 journal export.json> <B0 backup copy.json> <X_n journal export.json> <P_n prepared journal.json> <report.txt>
//
// Every input is opened READ-ONLY. It writes exactly one file, the report, and
// refuses to write it over an existing file. Exit 0 = PASS, 1 = STOP, 2 = usage.
// The inputs and the report are owner data: keep them outside any repository.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compare } = require('./stepE-compare');

function readBytes(file) {
  const fd = fs.openSync(file, 'r');           // read-only
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

const args = process.argv.slice(2);
const [approvalFile, x0File, b0File, xnFile, pnFile, reportFile] = args;
if (args.length !== 6) {
  console.log('Usage: node tools/stepE-compare-cli.js <approval.json> <X0.json> <B0.json> <X_n.json> <P_n.json> <report.txt>');
  process.exit(2);
}
const inputs = [approvalFile, x0File, b0File, xnFile, pnFile].map(f => path.resolve(f));
if (inputs.includes(path.resolve(reportFile))) { console.log('The report may not be written over an input.'); process.exit(2); }
if (fs.existsSync(reportFile)) { console.log(`${reportFile} already exists; nothing was written. Choose a new report name.`); process.exit(2); }

const approvalBytes = readBytes(approvalFile);
let approval = null;
try { approval = JSON.parse(approvalBytes.toString('utf8')); } catch (e) { approval = null; }
// The code actually loaded, hashed from the files Node resolved.
const codeHashes = {
  'stepE-prepare.js': sha256(readBytes(require.resolve('./stepE-prepare'))),
  'tradeRebuild.js': sha256(readBytes(require.resolve('../tradeRebuild'))),
};
const r = compare({
  approval, approvalBytes, codeHashes,
  x0Bytes: readBytes(x0File), b0Bytes: readBytes(b0File), xnBytes: readBytes(xnFile), pnBytes: readBytes(pnFile),
});
fs.writeFileSync(reportFile, r.report, { flag: 'wx' });   // never over an existing file
console.log(`${r.result}${r.stops.length ? ` (${r.stops.length} reason${r.stops.length === 1 ? '' : 's'})` : ''}; report written.`);
process.exit(r.result === 'PASS' ? 0 : 1);
