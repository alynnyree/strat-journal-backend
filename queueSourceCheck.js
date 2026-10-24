'use strict';
// THE SOURCE CHECK (Queue plan v14.1 rev 3.2, 5.5 "THE SOURCE CHECK", 5.8.3
// (D5), Q-T9, Q-T24 (f) and (i)). Run by guardCheck.js on every change, so a
// writer added later that saves the shared record any other way FAILS its
// pull request -- the protection is not a promise to remember.
//
// It fails if:
//   1. any file other than tradeStore.js names "trades:state", its fence or
//      the exhaustion log, unless it is a read-only tool that never loads the
//      storage client (tools/ reading a backup FILE);
//   2. tradeStore.js runs any script other than its four pinned ones, sends
//      any write command of the client (set, del, multi, pipeline, ...), or
//      exports either storage client;
//   3. any of the four scripts is not its pinned text -- in particular THE
//      COMMIT without step (S0), the fence check (5.8.3 (D5));
//   4. the fence is written by anything but THE RAISE, which only ever sets
//      it to "2" (nothing lowers it: Q-T24 (f));
//   5. anything maps over a list of waiting trades to replace entries in
//      place -- the deleted refreshWaiting (Q-T9).
// What it does NOT prove: that a running process is this code. That is the
// deploy check (5.8.3 (D5)) and /health.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_NAMES = ['trades:state', '{trades:state}:fence', 'queue:casFailures'];
const PINNED = {
  RAISE: '8bab7b6be6738459a7decfa3bcdc489b759e974e',
  COMMIT: '2ed6d703b781a328059b4f2eb515a9fb61a6b248',
  RESOLUTION_READ: 'a25e8b7ba49778dacf7f34b9a47ae10cb7dcc4b6',
  LOG: 'e2585315c7a488bcdd8ce65a51838f3e529bd3d4',
};
const WRITE_CALLS = ['set', 'setex', 'setnx', 'getset', 'del', 'unlink', 'append', 'incr', 'incrby', 'decr', 'decrby', 'expire', 'pexpire',
  'rename', 'renamenx', 'lpush', 'rpush', 'lset', 'ltrim', 'lrem', 'linsert', 'hset', 'hdel', 'hmset', 'sadd', 'srem', 'zadd', 'zrem',
  'multi', 'pipeline', 'exec', 'evalsha', 'flushall', 'flushdb', 'copy', 'restore', 'json'];
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function listFiles(root) {
  const out = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      if (n === 'node_modules' || n === 'tests' || n.startsWith('.')) continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) out.push(p);
    }
  })(root);
  return out.sort();
}

// files: {relativePath: text}. Returns a list of problems (empty: pass).
function checkSources(files) {
  const problems = [];
  for (const [rel, text] of Object.entries(files)) {
    if (rel === 'tradeStore.js' || rel === 'queueSourceCheck.js') continue;
    const code = strip(text);
    const named = KEY_NAMES.filter(k => code.includes(k));
    if (!named.length) continue;
    const readOnlyTool = rel.startsWith('tools/') && !/@upstash\/redis|require\(['"][^'"]*tradeStore/.test(code);
    if (!readOnlyTool) problems.push(`${rel} names ${named.join(', ')}: only tradeStore.js may touch the shared record, its fence or its log`);
  }
  const ts = files['tradeStore.js'];
  if (!ts) { problems.push('tradeStore.js is missing'); return problems; }
  const code = strip(ts);
  // 2. Script calls only with the four constants; no write commands.
  const evals = [...code.matchAll(/\b(raw|redis)\.eval\s*\(\s*([A-Za-z_]+)/g)].map(m => m[2]);
  for (const e of evals) if (!Object.keys(PINNED).includes(e)) problems.push(`tradeStore.js runs a script other than the four pinned ones: ${e}`);
  if (!evals.includes('COMMIT')) problems.push('tradeStore.js never saves through THE COMMIT');
  for (const w of WRITE_CALLS) {
    const re = new RegExp('\\b(raw|redis)\\.' + w + '\\s*\\(');
    if (re.test(code)) problems.push(`tradeStore.js sends a write command outside the scripts: ${w}()`);
  }
  if (/module\.exports[\s\S]*\b(raw|redis)\b\s*[,}]/.test(code.slice(code.lastIndexOf('module.exports')))) problems.push('tradeStore.js exports a storage client');
  // 3. The scripts are their pinned texts.
  let scripts = null;
  try {
    const sandbox = {};
    for (const name of Object.keys(PINNED)) {
      const m = new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\])\\.join\\(\'\\\\n\'\\);').exec(ts);
      if (!m) { problems.push(`tradeStore.js: the script ${name} is not written as an array of lines`); continue; }
      sandbox[name] = JSON.parse(m[1].replace(/,\s*\]$/, ']').replace(/^\[\s*/, '[')).join('\n');
    }
    scripts = sandbox;
  } catch (e) { problems.push('tradeStore.js: the scripts could not be read: ' + e.message); }
  if (scripts) {
    for (const [name, sha] of Object.entries(PINNED)) {
      if (scripts[name] === undefined) continue;
      const got = crypto.createHash('sha1').update(scripts[name], 'utf8').digest('hex');
      if (got !== sha) problems.push(`tradeStore.js: ${name} is not its pinned text (SHA-1 ${got}, pinned ${sha})${name === 'COMMIT' ? ' -- THE COMMIT must keep step (S0)' : ''}`);
    }
    if (scripts.COMMIT !== undefined && !/redis\.call\('GET', KEYS\[2\]\)[\s\S]*return 'FENCED'/.test(scripts.COMMIT)) problems.push('tradeStore.js: THE COMMIT has no fence check (S0)');
    // 4. Only THE RAISE writes the fence, and only "2".
    const fenceSets = [...(scripts.RAISE || '').matchAll(/redis\.call\('SET', KEYS\[1\], '([^']*)'\)/g)].map(m => m[1]);
    if (fenceSets.join() !== '2') problems.push('tradeStore.js: THE RAISE must set the fence to "2" and nothing else');
  }
  const fenceUses = [...code.matchAll(/FENCE_KEY/g)].length;
  const fenceInScripts = [...code.matchAll(/\[(KEY,\s*)?FENCE_KEY\]/g)].length;
  if (fenceUses - fenceInScripts > 2) problems.push('tradeStore.js uses the fence key outside THE RAISE and THE COMMIT');
  // 5. Q-T9: no in-place replacement of waiting entries.
  for (const [rel, text] of Object.entries(files)) {
    if (rel.startsWith('tools/') || rel === 'queueSourceCheck.js') continue;
    const c = strip(text);
    if (/pending\s*\|\|\s*\[\]\)\s*\.map\s*\(|\.pending\s*\.map\s*\(\s*\w+\s*=>\s*\{[\s\S]{0,200}return\s+byId/.test(c) || /function\s+refreshWaiting/.test(c)) {
      problems.push(`${rel} maps over the waiting trades replacing entries in place (refreshWaiting, Q-T9)`);
    }
  }
  return problems;
}

function checkTree(root) {
  const files = {};
  for (const p of listFiles(root)) files[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
  return checkSources(files);
}

module.exports = { checkSources, checkTree, PINNED, KEY_NAMES };
