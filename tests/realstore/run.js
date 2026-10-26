'use strict';
// THE REAL-STORE RUN (Deploy 2 real-store run plan v3.2, accepted as final by
// the owner on 26 Oct 2026). Implementation authorised the same day: "I
// authorize the Deploy 2 real-store harness implementation, including the
// writer-fence fix: test code only, same pull request #96, local tests only,
// no merge." THE RUN ITSELF is NOT authorised by that: this file refuses,
// sending nothing, unless DEPLOY2_REALSTORE_RUN=authorised is set for that
// run (set only on the owner's words naming the run).
//
// What it does, in order (plan section numbers in brackets):
//   1. checks Gate 1's two helpers are byte-identical to the accepted copies
//      (I-1) and that the product code is PR #96's 82f7cb4 (section 2);
//   2. creates a TEMPORARY no-account Upstash database with its own UUIDv4,
//      by Gate 1's creation code; the strict parse of the answer is the ONLY
//      source of the endpoint and token (I-2); every credential is blanked
//      from every line of output before it is shown or logged (section 7);
//   3. refuses unless the database is empty, then proves the endpoint is THIS
//      run's database through Upstash's metrics, read by the run's id (I-5);
//   4. STEP 0: a live protocol probe through both paths (v2, v3.1);
//   5. runs each check file as its own process group, with an environment
//      built from scratch (I-3), stopping on any fault, limit or stall (P-4a);
//   6. after each file: the group must be gone, a quiet period, the ledger
//      read, clean-up ALWAYS attempted, the verdict in two parts (v3 C);
//   7. a summary, a credential scan of the whole log, and its SHA-256.
// The runner's own identity object is the only authority: nothing reported
// by a child process is ever taken as identity, endpoint, token or verdict
// (v3 D).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const UR = require('../lib/upstashRest');

const BACKEND = path.join(__dirname, '..', '..');
const GATE1 = {
  'creation.js': 'd9b525706dfbfc99b7ba03cd7befd947c6a45f572df4af617341e54452869b30',
  'redactor.js': '3cce0c67e94bbe91b97f4b059a1bf9abe4d51ea7698022f7057caa66f0b4247b',
};
const PRODUCT_COMMIT = '82f7cb4c7604c62c19b73d861b2eac847e7a8d0d';
const PRODUCT = {
  'tradeStore.js': 'f9829a890165da40f52f1253b1f548d38318ee06bacf195517c4f43c0a22384d',
  'queueOps.js': '564da702e674bab5eccd8c8286af95213317dc1886ed29409c0538862bab90c2',
  'cron.js': '56890b15c84cc6411147cb10e9a4fd070f19fc6dd7aae9526d22c10c4b3c27cc',
  'api.js': '730237dc8b05db755d3137827acd52187c58250397a16f712023816e97380335',
  'server.js': '2f998d1918a74065e642b2bbff02f29633f4b2ae8c5258f2f7cb6a102ad4a66d',
  'queueSourceCheck.js': '42d644bef6ad5426c4b6fadfa0060f355935a07b6359d727db6633515d40503c',
  'guardCheck.js': 'e699ea8e590fb93d1aaedb5b6d74ca8051b03b6690f56d15149f2e20dc44f537',
};
// The plan's files, with the commands each sent on local Redis (plan v1
// section 1), used only for the budget's look-ahead.
const FILES = [
  ['gen2-store.js', 15334], ['gen2-processes.js', 15328], ['gen2-stale-reads.js', 4888], ['gen2-reset.js', 1459],
  ['gen2-p2.js', 1376], ['gen2-older-builds.js', 685], ['gen2-routes.js', 517], ['writer-fence.js', 329],
];
const IDENTITY = Object.freeze({ waitMs: 5 * 60000, pollMs: 10000 });   // the real run's identity wait (after run 1)
const BUDGET = { commands: 250000, bytes: 5 * 1024 ** 3 };   // upper STOP limits, not capacity (v2 section 8)
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(opts = {}) {
  const selftest = opts.selftest || null;          // ONLY the self-tests pass this
  const files = opts.files || FILES;
  const quietMs = opts.quietMs !== undefined ? opts.quietMs : 40000;     // Q-4: 30 s beyond the 10 s request limit
  const secondScanMs = opts.secondScanMs !== undefined ? opts.secondScanMs : 30000;
  const stallMs = opts.stallMs || 25 * 60000;
  // The identity wait (run 1 stopped at 60 s with the readings unrecorded):
  // up to 5 minutes, a reading every 10 s, EVERY reading written to the log.
  const identityWaitMs = opts.identityWaitMs || IDENTITY.waitMs;
  const identityPollMs = opts.identityPollMs || (selftest ? 50 : IDENTITY.pollMs);
  const testsDir = opts.testsDir || path.join(BACKEND, 'tests');
  const outDir = opts.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-run-'));
  const runTag = crypto.randomBytes(4).toString('hex');
  const logFile = path.join(outDir, `realstore-${runTag}.log`);
  const { makeLineRedactor, addSecretTo, scrubWith } = require('./gate1/redactor.js');
  const secrets = [];
  const emit = t => { fs.appendFileSync(logFile, t); if (!opts.quiet) process.stdout.write(t); };
  const out = makeLineRedactor(secrets, emit);
  const say = line => out.write(line + '\n');
  const result = { tag: runTag, logFile, files: [], stopped: null, verdicts: [], ok: false };
  const stop = why => { if (!result.stopped) result.stopped = why; say('STOP: ' + why); };

  say(`REAL-STORE RUN ${runTag}${selftest ? ' (SELF-TEST: a local stand-in of Upstash, no network)' : ''}  ${new Date().toISOString()}`);
  // ---- Authorisation: the run itself needs the owner's words.
  if (!selftest && process.env.DEPLOY2_REALSTORE_RUN !== 'authorised') {
    stop('REFUSED: DEPLOY2_REALSTORE_RUN is not "authorised" for this run; nothing was created or sent');
    out.flush(); return result;
  }
  // ---- 1. Helpers and product code.
  for (const [f, want] of Object.entries(GATE1)) {
    const got = sha256(fs.readFileSync(path.join(__dirname, 'gate1', f)));
    say(`HELPER ${f} ${got === want ? 'identical to Gate 1 v13' : 'DIFFERENT from Gate 1 v13'} (${got})`);
    if (got !== want) { stop('a Gate 1 helper is not byte-identical'); out.flush(); return result; }
  }
  for (const [f, want] of Object.entries(PRODUCT)) {
    const got = sha256(fs.readFileSync(path.join(BACKEND, f)));
    say(`PRODUCT ${f} ${got === want ? 'identical to ' + PRODUCT_COMMIT.slice(0, 7) : 'DIFFERENT'} (${got.slice(0, 16)}...)`);
    if (got !== want) { stop('the product code is not PR #96 at ' + PRODUCT_COMMIT.slice(0, 7)); out.flush(); return result; }
  }
  let diff = '';
  try { diff = execFileSync('git', ['-C', BACKEND, 'diff', '--name-only', PRODUCT_COMMIT, '--', '.', ':!tests'], { encoding: 'utf8' }); }
  catch (e) { stop('git diff against the product commit could not be run'); out.flush(); return result; }
  say(`PRODUCT DIFF against ${PRODUCT_COMMIT.slice(0, 7)} outside tests/: ${diff.trim() ? diff.trim().split('\n').join(', ') : '(empty)'}`);
  if (diff.trim()) { stop('product files differ from ' + PRODUCT_COMMIT.slice(0, 7)); out.flush(); return result; }

  // ---- 2. The run's identity: created, strictly parsed, frozen.
  let identity;
  if (selftest) {
    for (const v of [selftest.id, selftest.token, selftest.endpoint]) addSecretTo(secrets, v);
    identity = Object.freeze({ id: selftest.id, endpoint: selftest.endpoint, token: selftest.token, metricsUrl: selftest.metricsUrl });
  } else {
    const { requestCreation, parseCreationAnswer, credentialCandidates } = require('./gate1/creation.js');
    const id = crypto.randomUUID();
    addSecretTo(secrets, id);
    say('SETUP: creation requested (Gate 1 procedure; the id is registered as a secret first)');
    let text;
    try { ({ text } = await requestCreation({ id })); }
    catch (e) {
      stop(`creation answer not usable (${e && e.message}). A database may exist that this run cannot reach; Upstash deletes it 3 days after creation unless claimed, which is a fallback, NOT proof of clean-up -- NOT VERIFIED. TRACKING: id fingerprint ${sha256(id).slice(0, 12)}`);
      out.flush(); return result;
    }
    for (const v of credentialCandidates(text)) addSecretTo(secrets, v);
    const p = parseCreationAnswer(text, id, Date.now());
    if (!p.ok) { stop(`creation answer refused: ${p.why}. A database may exist; NOT VERIFIED. TRACKING: id fingerprint ${sha256(id).slice(0, 12)}`); out.flush(); return result; }
    for (const v of [p.endpoint, p.host, p.token, p.metricsUrl, p.consoleUrl]) addSecretTo(secrets, v);
    identity = Object.freeze({ id, endpoint: p.endpoint, token: p.token, metricsUrl: p.metricsUrl, expires: p.expires });
    say(`SETUP: database created; expires ${p.expires}; regions: NOT REPORTED by the creation answer`);
  }
  const binding = UR.bindingOf(identity.id, identity.endpoint, identity.token);
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-ledger-'));
  const runnerLedger = path.join(ledgerRoot, 'runner'); fs.mkdirSync(runnerLedger);
  const D = UR.directClient(identity, { ledgerDir: runnerLedger });

  // One metrics reading: the numbers, or WHY there are none (never a bare null).
  const metricsRead = async () => {
    const a = await UR.send(identity.metricsUrl, { method: 'GET', headers: { 'User-Agent': 'claude-code' } });
    if (a.transport) return { m: null, why: 'no answer (' + a.transport + ')' };
    if (a.status !== 200) return { m: null, why: 'HTTP ' + a.status };
    try {
      const m = JSON.parse(a.body);
      for (const k of ['commands_total', 'keys', 'bytes_in', 'bytes_out']) if (!Number.isSafeInteger(m[k])) return { m: null, why: 'the field ' + k + ' is not a whole number' };
      return { m, why: null };
    } catch (e) { return { m: null, why: 'the answer is not JSON' }; }
  };
  const metrics = async () => (await metricsRead()).m;
  const fmtM = m => (m ? `commands ${m.commands_total}, keys ${m.keys}, bytes in ${m.bytes_in}, out ${m.bytes_out}` : 'NOT AVAILABLE');

  // ---- 3. Empty, then THIS run's database (I-5).
  // I-5, the identity check. Identity is confirmed ONLY when, after this run
  // writes one nonce key through its client, the metrics read by this run's id
  // show BOTH keys and commands_total risen; and, after the nonce is deleted,
  // keys back where they were. Every reading is logged as plain numbers, with
  // the client's answers to the SET and DEL, so a stop names its cause:
  // frozen numbers (slow metrics) read differently from numbers that move
  // without the nonce (another database).
  const fmtR = (r, t0) => `t+${((Date.now() - t0) / 1000).toFixed(0)}s ` + (r.m ? `keys ${r.m.keys}, commands_total ${r.m.commands_total}, uptime_seconds ${r.m.uptime_seconds}` : 'NO READING: ' + r.why);
  const identityCheck = async (label) => {
    const t0 = Date.now();
    const r0 = await metricsRead();
    say(`IDENTITY ${label}: before the nonce: ${fmtR(r0, t0)}`);
    if (!r0.m) return 'the metrics could not be read (' + r0.why + ')';
    const m0 = r0.m;
    const nonce = 'realstore-nonce:' + crypto.randomBytes(8).toString('hex');
    const setAnswer = await D.call('SET', nonce, '1');
    say(`IDENTITY ${label}: SET nonce answered ${JSON.stringify(setAnswer)}`);
    let seen = false, last = r0; const t1 = Date.now();
    while (Date.now() - t1 < identityWaitMs) {
      await sleep(identityPollMs);
      last = await metricsRead();
      say(`IDENTITY ${label}: reading ${fmtR(last, t0)}`);
      if (last.m && last.m.keys >= m0.keys + 1 && last.m.commands_total >= m0.commands_total + 1) { seen = true; break; }
    }
    const delAnswer = await D.call('DEL', nonce);
    say(`IDENTITY ${label}: DEL nonce answered ${JSON.stringify(delAnswer)}`);
    if (!seen) {
      const moved = last.m ? `keys ${m0.keys} -> ${last.m.keys}, commands_total ${m0.commands_total} -> ${last.m.commands_total}` : 'the last reading failed';
      return `the metrics read by this run's id did not show the nonce write (keys and commands both rising) within ${identityWaitMs / 1000} s (first to last: ${moved}; every reading is above)`;
    }
    let back = false; const t2 = Date.now();
    while (Date.now() - t2 < identityWaitMs) {
      await sleep(identityPollMs);
      const r = await metricsRead();
      say(`IDENTITY ${label}: after the DEL, reading ${fmtR(r, t0)}`);
      if (r.m && r.m.keys === m0.keys) { back = true; break; }
    }
    if (!back) return `the metrics' key count did not return to ${m0.keys} within ${identityWaitMs / 1000} s after the nonce was deleted (every reading is above)`;
    say(`IDENTITY ${label}: the endpoint is this run's database (nonce seen through the metrics by id, then removed) after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return null;
  };

  const ledgerSummary = dir => {
    const starts = new Map(); const unknown = []; let ends = 0;
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.ledger')) : []) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
        const p = l.split(' ');
        if (p[0] === 'start') starts.set(f + ':' + p[1], p[2]);
        else if (p[0] === 'end') {
          ends++;
          const k = f + ':' + p[1];
          if (!['RESULT', 'COMMAND_ERROR'].includes(p[2])) unknown.push(`${f.replace('.ledger', '')} #${p[1]} ${p[2]} step ${p[3]}`);
          starts.delete(k);
        }
      }
    }
    for (const [k, v] of starts) unknown.push(`${k.replace('.ledger', '')} (${v}) started, never ended`);
    return { forwards: ends + starts.size, unknown };
  };
  const faultsIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.faults')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) : []);

  // CLEAN-UP, ALWAYS ATTEMPTED (v3 C, Q-6/Q-7).
  const cleanup = async (label, ledgerDirs, groupEnded) => {
    const st = { label, scan1: null, scan2: null, deleted: 0, refused: [], metricsKeys: null, unknown: [], groupEnded };
    for (const d of ledgerDirs) st.unknown.push(...ledgerSummary(d).unknown);
    const scanAll = async () => {
      const keys = []; let cursor = '0';
      do { const r = await D.call('SCAN', cursor, 'COUNT', '1000'); if (!Array.isArray(r)) throw new Error('SCAN did not answer a list'); cursor = String(r[0]); keys.push(...r[1]); } while (cursor !== '0');
      return keys;
    };
    try {
      const t0 = Date.now();
      const k1 = await scanAll();
      for (const k of k1) { const r = await D.call('DEL', k); if (r && r.error) st.refused.push(k); else st.deleted++; if (Date.now() - t0 > 120000) throw new Error('clean-up passed its 2-minute limit'); }
      st.scan1 = { found: k1.length, names: k1.slice(0, 20), dbsize: await D.call('DBSIZE') };
      await sleep(secondScanMs);
      const k2 = await scanAll();
      st.scan2 = { found: k2.length, names: k2.slice(0, 20), dbsize: await D.call('DBSIZE') };
    } catch (e) { st.error = e && e.message; }
    const m = await metrics(); st.metricsKeys = m ? m.keys : null;
    st.verified = !st.error && st.groupEnded && st.unknown.length === 0 && st.refused.length === 0
      && st.scan1 && st.scan1.dbsize === 0 && st.scan2 && st.scan2.found === 0 && st.scan2.dbsize === 0;
    say(`CLEAN-UP ${label}: (a) DATABASE: first scan found ${st.scan1 ? st.scan1.found : '?'} key(s)${st.scan1 && st.scan1.found ? ' [' + st.scan1.names.join(', ') + ']' : ''}, deleted ${st.deleted}, DBSIZE ${st.scan1 ? st.scan1.dbsize : '?'}; second scan after ${secondScanMs / 1000} s found ${st.scan2 ? st.scan2.found : '?'}, DBSIZE ${st.scan2 ? st.scan2.dbsize : '?'}; metrics keys ${st.metricsKeys === null ? 'NOT AVAILABLE' : st.metricsKeys} (corroboration only)${st.refused.length ? '; deletions refused: ' + st.refused.join(', ') : ''}${st.error ? '; ERROR: ' + st.error : ''}`);
    say(`CLEAN-UP ${label}: (b) LEDGER: ${st.unknown.length === 0 ? 'every request has a known outcome' : st.unknown.length + ' request(s) of UNKNOWN OUTCOME: ' + st.unknown.slice(0, 10).join('; ')}; process group ${st.groupEnded ? 'confirmed ended' : 'NOT confirmed ended'}`);
    say(`CLEAN-UP ${label}: ${st.verified ? 'VERIFIED' : 'NOT VERIFIED'}${st.verified ? '' : ' -- a request of unknown outcome, an unconfirmed process, a refused deletion or an error means a late write cannot be excluded, even when the scans read 0. The 3-day expiry is a fallback, not proof.'}`);
    result.verdicts.push(st);
    return st;
  };

  try {
    const size = await D.call('DBSIZE');
    say(`EMPTY CHECK: DBSIZE ${size}`);
    if (size !== 0) { stop('the database is not empty: it may not be this run\'s new database'); return finish(); }
    const idErr = await identityCheck('before step 0');
    if (idErr) { stop('IDENTITY: ' + idErr); return finish(); }
    const sz2 = await D.call('DBSIZE');
    if (sz2 !== 0) { stop('the database is not empty again after the identity check'); return finish(); }

    // ---- 4. STEP 0: the live protocol probe.
    const probe = await protocolProbe(identity, D, runnerLedger, say);
    if (probe) { stop('STEP 0: ' + probe); await cleanup('after step 0', [runnerLedger], true); return finish(); }
    await cleanup('after step 0', [runnerLedger], true);

    // ---- 5. The files.
    for (const [file, expected] of files) {
      const m = await metrics();
      if (m && (m.commands_total + expected * 2 > BUDGET.commands || m.bytes_in + m.bytes_out > BUDGET.bytes)) { stop(`BUDGET: ${file} could take the run past its own stop limit (${BUDGET.commands} commands or 5 GB); ${fmtM(m)}`); break; }
      const ie = await identityCheck('before ' + file);
      if (ie) { stop('IDENTITY: ' + ie); break; }
      const fr = { file, before: m, after: null, exit: null, passed: null, failed: null, localOnly: 0, fails: [], fault: null, timedOut: false };
      result.files.push(fr);
      const dir = path.join(ledgerRoot, file.replace(/\W/g, '_')); fs.mkdirSync(dir);
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(),
        QUEUE_REALSTORE_RUN: 'authorised', QUEUE_REALSTORE_ID: identity.id, QUEUE_REALSTORE_ENDPOINT: identity.endpoint,
        QUEUE_REALSTORE_TOKEN: identity.token, QUEUE_REALSTORE_BINDING: binding, QUEUE_REALSTORE_LEDGER: dir,
        REQUIRE_REAL_REDIS: '1',
      };
      if (selftest) env.QUEUE_REALSTORE_SELFTEST = '1';
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) if (process.env[k] !== undefined) env[k] = process.env[k];
      const args = selftest ? [path.join(testsDir, file)] : ['--use-env-proxy', path.join(testsDir, file)];
      say(`FILE ${file}: started (its own process group; environment built from scratch)`);
      const child = spawn(process.execPath, args, { cwd: BACKEND, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const so = makeLineRedactor(secrets, t => { emit(t.split('\n').map(l => (l ? '  | ' + l : l)).join('\n')); });
      const outLines = [];
      child.stdout.on('data', d => { outLines.push(String(d)); so.write(d); });
      child.stderr.on('data', d => so.write(d));
      const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ } };
      const exited = new Promise(r => child.on('exit', code => r(code)));
      const t0 = Date.now();
      let done = false; exited.then(() => { done = true; });
      while (!done) {
        const f = faultsIn(dir);
        if (f.length) { fr.fault = f[0]; say(`FILE ${file}: FAULT -- ${f[0]}; ending its process group`); killGroup(); break; }
        if (Date.now() - t0 > stallMs) { fr.timedOut = true; say(`FILE ${file}: STALLED past ${stallMs / 60000} min; ending its process group`); killGroup(); break; }
        await sleep(200);
      }
      fr.exit = await exited;
      so.flush();
      // The whole group gone (Q-3)?
      let groupEnded = false;
      for (let i = 0; i < 50 && !groupEnded; i++) { try { process.kill(-child.pid, 0); await sleep(100); } catch (e) { groupEnded = e.code === 'ESRCH'; } }
      if (!groupEnded) { killGroup(); for (let i = 0; i < 50 && !groupEnded; i++) { try { process.kill(-child.pid, 0); await sleep(100); } catch (e) { groupEnded = e.code === 'ESRCH'; } } }
      const text = outLines.join('');
      const tot = /(\d+) passed, (\d+) failed\s*$/m.exec(text);
      if (tot) { fr.passed = Number(tot[1]); fr.failed = Number(tot[2]); }
      fr.localOnly = (text.match(/^LOCAL ONLY:/gm) || []).length;
      fr.fails = (text.match(/^FAIL:.*$/gm) || []).map(l => scrubWith(secrets, l).slice(0, 200));
      const ls = ledgerSummary(dir);
      say(`FILE ${file}: ended (exit ${fr.exit}); ${fr.passed === null ? 'no total line' : fr.passed + ' passed, ' + fr.failed + ' failed'}; LOCAL ONLY ${fr.localOnly}; forwards to the store ${ls.forwards}`);
      await sleep(quietMs);                                        // Q-4
      const c = await cleanup(file, [dir, runnerLedger], groupEnded);
      fr.after = await metrics();
      say(`METRICS ${file}: before ${fmtM(fr.before)}; after ${fmtM(fr.after)}`);
      if (fr.fault) { stop(`a fault in ${file}: ${fr.fault}`); break; }
      if (fr.timedOut) { stop(`${file} stalled`); break; }
      if (fr.passed === null) { stop(`${file} ended without its total line (a crash)`); break; }
      // A file passes only if its process ENDED SUCCESSFULLY (exit 0) and printed
      // no FAIL line, whatever its total says (auditor, harness review: a
      // printed total alone could pass a file whose process then failed).
      if (fr.exit !== 0) { stop(`${file} ended with exit ${fr.exit}, not 0`); break; }
      if (fr.fails.length) { stop(`${file} printed ${fr.fails.length} FAIL line(s) although its total said ${fr.failed} failed`); break; }
      if (!c.groupEnded) { stop(`${file}'s process group could not be confirmed ended`); break; }
    }
  } catch (e) {
    stop('the runner itself failed: ' + (e && e.message));
    try { await cleanup('after a runner failure', [runnerLedger], true); } catch (x) { /* reported */ }
  }
  return finish();

  function finish() {
    const passedAll = result.files.length === files.length && result.files.every(f => f.exit === 0 && f.failed === 0 && f.passed > 0 && f.fails.length === 0);
    const cleanAll = result.verdicts.length > 0 && result.verdicts.every(v => v.verified);
    say('SUMMARY:');
    for (const f of result.files) say(`  ${f.file}: exit ${f.exit}; ${f.passed === null ? 'NO TOTAL' : f.passed + ' passed, ' + f.failed + ' failed'}; LOCAL ONLY ${f.localOnly}${f.fails.length ? '; FAIL lines: ' + f.fails.length : ''}`);
    for (const [f] of files) if (!result.files.some(x => x.file === f)) say(`  ${f}: NOT RUN`);
    say(`  run: ${result.stopped ? 'PARTIAL -- stopped: ' + result.stopped : 'every file ran'}; clean-up: ${cleanAll ? 'VERIFIED after every step' : 'NOT VERIFIED (see the CLEAN-UP lines)'}`);
    out.flush();
    const log = fs.readFileSync(logFile, 'utf8');
    const leaked = secrets.filter(s => s.length >= 8 && log.includes(s)).length;
    const tail = `CREDENTIAL SCAN: ${leaked === 0 ? 'no registered credential appears in this log' : leaked + ' registered value(s) FOUND -- the log must not be shared'}\n`;
    fs.appendFileSync(logFile, tail); if (!opts.quiet) process.stdout.write(tail);
    result.ok = !result.stopped && passedAll && cleanAll && leaked === 0;
    const fin = `TESTS: ${result.ok ? 'PASSED' : 'FAILED'}\nLOG SHA-256 (everything above this line): ${sha256(fs.readFileSync(logFile))}\n`;
    fs.appendFileSync(logFile, fin); if (!opts.quiet) process.stdout.write(fin);
    try { fs.rmSync(ledgerRoot, { recursive: true, force: true }); } catch (e) { /* temporary folder only */ }
    return result;
  }
}

// STEP 0 (plan v2; E-1 and E-2 from v3): the live protocol probe, through the
// tests' direct client (PATH D) and the service's own client through a
// store-mode shim (PATH P). Returns null, or what differed.
async function protocolProbe(identity, D, ledgerDir, say) {
  const { restShim } = require('../lib/localRedis');
  const { Redis } = require('@upstash/redis');
  const k = 'realstore-probe:' + crypto.randomBytes(6).toString('hex');
  const expect = [];
  // Every answer is logged as received (C-4), not only the ones that differ.
  const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); expect.push(ok); say(`STEP 0 ${ok ? 'ok  ' : 'DIFF'} ${label}: got ${JSON.stringify(got).slice(0, 160)}`); };
  const like = (label, got, test) => { const ok = test(got); expect.push(ok); say(`STEP 0 ${ok ? 'ok  ' : 'DIFF'} ${label}: got ${JSON.stringify(got).slice(0, 160)}`); };
  // PATH D
  eq('D SET', await D.call('SET', k + ':s', 'café ✓ "q"'), 'OK');
  eq('D GET (not plain ASCII)', await D.call('GET', k + ':s'), 'café ✓ "q"');
  eq('D EVAL string', await D.call('EVAL', "return 'abc'", '0'), 'abc');
  eq('D EVAL status OK', await D.call('EVAL', "return redis.status_reply('OK')", '0'), 'OK');
  eq('D EVAL integer', await D.call('EVAL', 'return 42', '0'), 42);
  eq('D EVAL nil', await D.call('EVAL', 'return nil', '0'), null);
  eq('D EVAL array', await D.call('EVAL', "return {'a', 1, {'b'}}", '0'), ['a', 1, ['b']]);
  like('D E-1 (error_reply wrong-type; either accepted form, C-5)', await D.call('EVAL', "return redis.error_reply('wrong-type')", '0'), r => !!r && typeof r.error === 'string' && UR.ACCEPTED_ERRORS[0](r.error));
  eq('D RPUSH', await D.call('RPUSH', k + ':l', 'x'), 1);
  like('D E-2 (WRONGTYPE)', await D.call('GET', k + ':l'), r => r && UR.ACCEPTED_ERRORS[1](r.error));
  like('D E-2 inside a script', await D.call('EVAL', "return redis.call('GET', KEYS[1])", '1', k + ':l'), r => r && UR.ACCEPTED_ERRORS[1](r.error));
  // PATH P: the service's own client, through a store-mode shim.
  const shim = restShim(null, { store: Object.freeze({ ...identity, ledgerDir }) });
  const url = await shim.listen();
  try {
    const c = new Redis({ url, token: 'local-only-not-sent', automaticDeserialization: false, retry: { retries: 0, backoff: () => 0 } });
    eq('P set', await c.set(k + ':p', 'ü-text'), 'OK');
    eq('P get', await c.get(k + ':p'), 'ü-text');
    eq('P eval array', await c.eval("return {'x', 7}", [], []), ['x', 7]);
    let e1 = null; try { await c.eval("return redis.error_reply('wrong-type')", [], []); } catch (e) { e1 = e && e.message; }
    like('P E-1 surfaces as a command error', e1, m => typeof m === 'string' && m.includes('wrong-type'));
    const p = c.pipeline(); p.set(k + ':q', '1'); p.get(k + ':l'); p.get(k + ':q');
    const pr = await p.exec({ keepErrors: true });
    like('P pipeline of 3, error in the middle', pr, r => Array.isArray(r) && r.length === 3 && r[0].result === 'OK' && r[1].error && UR.ACCEPTED_ERRORS[1](r[1].error) && r[2].result === '1');
  } finally { await shim.close(); }
  for (const s of [':s', ':l', ':p', ':q']) await D.call('DEL', k + s);
  return expect.every(Boolean) ? null : 'the real answers differ from the expected ones (see the DIFF lines)';
}

module.exports = { run, FILES, GATE1, PRODUCT, PRODUCT_COMMIT, IDENTITY };

if (require.main === module) {
  run({ outDir: process.argv[2] }).then(r => process.exit(r.ok ? 0 : 1), e => { console.log('RUNNER CRASHED', e && e.message); process.exit(1); });
}
