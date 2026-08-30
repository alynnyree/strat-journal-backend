#!/usr/bin/env node
// Refuses to let the "Exited with status 1" crash come back.
//
// On 2026-08-30 the owner's server shut itself down. The cause was a rule
// in Node: if a job fails and nothing catches it, the WHOLE program ends.
// Fourteen places in this backend could do that, including the route his
// phone asks for new trades every thirty seconds.
//
// They are all fixed. The problem is that nothing stopped them being
// written in the first place, and nothing would stop the next one. A
// promise to remember is not a safeguard -- this is. It reads every file
// here and fails if any of the three patterns that caused the crash have
// come back. It runs automatically on every change (.github/workflows).
//
// What it deliberately does NOT claim: this catches the three shapes that
// actually bit us, not every possible way a program can fail. It is a
// floor, not a proof.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const skip = new Set(['node_modules', '.git', '.github']);
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && !skip.has(f) && f !== path.basename(__filename))
  .sort();

const problems = [];

for (const file of files) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;

    // 1. An async route handler that is not wrapped. Express 4 does not
    //    catch a handler that fails -- the failure ends the process.
    if (/(router|app)\.(get|post|put|patch|delete|all)\s*\(/.test(line) && /async\s*\(/.test(line)) {
      if (!/wrap\s*\(\s*async/.test(line)) {
        problems.push(`${at}  async route handler is not inside wrap() — a failed request would end the server.\n      ${line.trim().slice(0, 90)}`);
      }
    }

    // 2. An async function handed to something that will not wait for it,
    //    and so will never see it fail.
    const droppers = /(setTimeout|setInterval|cron\.schedule|\.on)\s*\([^)]*?,\s*async\s*(\(|function)/;
    if (droppers.test(line)) {
      problems.push(`${at}  an async function is handed to something that never waits for it — if it fails, nothing catches it.\n      ${line.trim().slice(0, 90)}`);
    }
  });
}

// 3. A file that uses wrap() but never imported it. This is not
//    hypothetical: it happened while writing this check, and the server
//    would not start at all. The crash guard kept the program alive but
//    it never reached the point of answering anything -- proof that the
//    guard is a floor, not a substitute for the code being right.
for (const file of files) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  if (/\bwrap\s*\(\s*async/.test(src) && !/require\(['"]\.\/asyncRoute['"]\)/.test(src)) {
    problems.push(`${file}  uses wrap() but never imported it — this file would fail the moment it is loaded.`);
  } else if (/\bwrap\s*\(\s*async/.test(src) && !/\bwrap\b[^\n]*=[^\n]*require\(['"]\.\/asyncRoute['"]\)/.test(src)) {
    problems.push(`${file}  uses wrap() but does not take wrap from asyncRoute — this file would fail the moment it is loaded.`);
  }
}

// 4. The floor under the whole program must actually be installed.
const server = fs.readFileSync(path.join(DIR, 'server.js'), 'utf8');
if (!/installCrashGuards\s*\(\s*\)/.test(server)) {
  problems.push('server.js  installCrashGuards() is not called — one unhandled failure would end the whole server.');
}
if (!/app\.use\s*\(\s*errorHandler\s*\)/.test(server)) {
  problems.push('server.js  errorHandler is not mounted — a failed request would hang the phone instead of answering.');
}
// Mounted last, or it catches nothing.
const errIdx = server.indexOf('app.use(errorHandler)');
const lastRoute = Math.max(
  server.lastIndexOf("app.use('/"),
  server.lastIndexOf('app.get('),
);
if (errIdx !== -1 && lastRoute > errIdx) {
  problems.push('server.js  errorHandler is mounted before a route — it only catches what is mounted above it.');
}

if (problems.length) {
  console.error(`\nFound ${problems.length} way(s) the server could shut itself down again:\n`);
  problems.forEach(p => console.error('  - ' + p));
  console.error('\nSee CLAUDE.md: "One unwrapped failure anywhere ended the ENTIRE server."\n');
  process.exit(1);
}
console.log(`Checked ${files.length} files: nothing here can shut the server down the way it did on 30 August.`);
