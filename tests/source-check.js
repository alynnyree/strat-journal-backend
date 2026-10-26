'use strict';
// THE SOURCE CHECK (Queue plan v14.1 rev 3.2, 5.5; 5.8.3 (D5); Q-T9; Q-T24 (f)
// and (i); Q-T19 (b)'s source half). It passes on this tree, and each broken
// copy below -- a change that saves the record some other way -- FAILS it,
// both through queueSourceCheck.js and through guardCheck.js itself (the
// automatic check "guard-check" every pull request must pass).
//
// Also the source checks that used to be part A9 of tests/writer-fence.js:
// only tradeStore.js and read-only tools name the record.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BACKEND = path.join(__dirname, '..');
const { checkSources, checkTree } = require(path.join(BACKEND, 'queueSourceCheck.js'));

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); } };

const tree = () => {
  const files = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      if (n === 'node_modules' || n === 'tests' || n.startsWith('.')) continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) files[path.relative(BACKEND, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  })(BACKEND);
  return files;
};

const real = tree();
check('this tree passes the source check', checkTree(BACKEND).length === 0, checkTree(BACKEND));
const naming = Object.keys(real).filter(f => ['trades:state', '{trades:state}:fence', 'queue:casFailures'].some(k => real[f].includes(k)));
check('only tradeStore.js and read-only tools (that never load the storage client) name the record', naming.every(f => f === 'tradeStore.js' || f === 'queueSourceCheck.js'
  || (f.startsWith('tools/') && !/@upstash\/redis/.test(real[f]))), naming);

const broken = {
  'a save that bypasses THE COMMIT (a plain SET)': f => { f['tradeStore.js'] = f['tradeStore.js'].replace("try { reply = await raw.eval(COMMIT,", "try { await raw.set(KEY, text); reply = await raw.eval(COMMIT,"); },
  'THE COMMIT without step (S0), the fence check': f => { f['tradeStore.js'] = f['tradeStore.js'].replace(/  "local f = redis.call\('GET', KEYS\[2\]\)",\n  "if \(not f\)[^\n]*\n/, ''); },
  'another file writing the record with its own client': f => { f['cron.js'] = f['cron.js'] + "\nconst { Redis } = require('@upstash/redis');\nasync function sneak(d) { await Redis.fromEnv().set('trades:state', d); }\n"; },
  'a raise that sets the fence to anything but 2': f => { f['tradeStore.js'] = f['tradeStore.js'].replace("\"redis.call('SET', KEYS[1], '2')\",", "\"redis.call('SET', KEYS[1], '1')\","); },
  'a script that deletes the fence': f => { f['tradeStore.js'] = f['tradeStore.js'].replace("const SCRIPTS = { RAISE, COMMIT, RESOLUTION_READ, LOG };", "const LOWER = ['redis.call(\\'DEL\\', KEYS[1])'].join('\\n');\nconst SCRIPTS = { RAISE, COMMIT, RESOLUTION_READ, LOG };\nasync function lower() { return raw.eval(LOWER, [FENCE_KEY], []); }"); },
  'exporting the raw storage client': f => { f['tradeStore.js'] = f['tradeStore.js'].replace('  _resetProcessState,\n};', '  _resetProcessState, raw,\n};'); },
  'refreshWaiting brought back (in-place replacement, Q-T9)': f => { f['cron.js'] = f['cron.js'] + '\nfunction refreshWaiting(trades) { return trades; }\n'; },
};
for (const [label, mut] of Object.entries(broken)) {
  const f = JSON.parse(JSON.stringify(real));
  mut(f);
  const changed = JSON.stringify(f) !== JSON.stringify(real);
  const p = checkSources(f);
  check(`BROKEN COPY, ${label}: the edit took, and the source check FAILS it`, changed && p.length > 0, { changed, p });
}

// The same, through guardCheck.js itself, on a copy of the tree.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-check-'));
try {
  for (const [rel, text] of Object.entries(real)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const run = () => { try { execFileSync(process.execPath, [path.join(dir, 'guardCheck.js')], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  check('guardCheck.js passes on an unchanged copy of the tree', run() === 0);
  fs.writeFileSync(path.join(dir, 'tradeStore.js'), real['tradeStore.js'].replace("try { reply = await raw.eval(COMMIT,", "try { await raw.set(KEY, text); reply = await raw.eval(COMMIT,"));
  check('Q-T24 (i): guardCheck.js FAILS a copy whose save bypasses THE COMMIT', run() === 1);
  fs.writeFileSync(path.join(dir, 'tradeStore.js'), real['tradeStore.js'].replace(/  "local f = redis.call\('GET', KEYS\[2\]\)",\n  "if \(not f\)[^\n]*\n/, ''));
  check('Q-T24 (i): guardCheck.js FAILS a copy whose COMMIT omits (S0)', run() === 1);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
