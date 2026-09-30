// Runs EVERY check in tests/ (Blocker 1, 30 Sept 2026). The automatic checks
// used to name twelve of the files one by one, so the other fifteen -- among
// them the whole-trade rehearsal, the price feed and the phone alerts -- could
// break with nothing on GitHub noticing. Reading the folder means a check
// added later is run without anyone having to remember to list it.
//
// A file fails when it ends badly, prints a FAIL line, crashes, or stalls.
// All are checked, not just the ending: the server's crash guard can keep a
// half-finished check alive and let it end as a "success" (found 30 Sept).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const LIMIT_MS = 8 * 60 * 1000;

function run(file){
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file], { cwd: path.join(DIR, '..'), env: process.env });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    const timer = setTimeout(() => { out += '\nSTALLED past the time limit'; child.kill('SIGKILL'); }, LIMIT_MS);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

(async () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== 'run-all.js').sort();
  const problems = [];
  for(const f of files){
    const t0 = Date.now();
    const { code, out } = await run(path.join(DIR, f));
    const lines = out.split('\n');
    const mine = [];
    lines.filter(l => /^(FAIL|✗)/.test(l)).forEach(l => mine.push(l.slice(0, 200)));
    if(/STALLED past the time limit/.test(out)) mine.push('stalled past ' + LIMIT_MS / 60000 + ' minutes');
    if(/TEST CRASHED/.test(out)) mine.push('crashed');
    if(code !== 0 && !mine.length) mine.push(`ended badly (exit ${code}): ` + lines.filter(Boolean).slice(-3).join(' | ').slice(0, 300));
    const total = (lines.find(l => /\d+ (passed|checks passed)/.test(l)) || '').trim();
    console.log(`${mine.length ? 'PROBLEM' : 'ok     '}  ${f.replace(/\.js$/, '').padEnd(36)} ${total}  ${Math.round((Date.now() - t0) / 1000)}s`);
    mine.forEach(m => console.log('           ' + m));
    if(mine.length) problems.push(f);
  }
  console.log(`\n${files.length} check files run; ${problems.length} with problems${problems.length ? ': ' + problems.join(', ') : ''}`);
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.log('RUNNER CRASHED:', e); process.exit(1); });
