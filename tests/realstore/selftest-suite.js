'use strict';
// S-3 (plan v2 2B, v3.2): THE WHOLE REAL-STORE RUN, REHEARSED WITHOUT ANY
// NETWORK. The runner drives every one of its eight files in store mode
// against tests/lib/upstashStandIn.js (Upstash's documented REST format over a
// local Redis), exactly as it would against the real database. Each file must
// pass as it does locally, with only its local-Redis stop check replaced by a
// LOCAL ONLY line; every clean-up must be VERIFIED; the run must pass.
// Not part of tests/run-all.js (it takes several minutes): run by hand,
//   REQUIRE_REAL_REDIS=1 node tests/realstore/selftest-suite.js <outDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { upstashStandIn } = require('../lib/upstashStandIn');
const { run, FILES } = require('./run.js');

let pass = 0, fail = 0;
const check = (label, ok, d) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };

(async () => {
  const S = await upstashStandIn();
  // --e1-bare: the stand-in words E-1 as "wrong-type" (no "ERR "), the older
  // Redis form, so the whole suite is shown to run with that wording (C-5).
  if (process.argv.includes('--e1-bare')) { S.errorText = t => t.replace(/^ERR wrong-type/, 'wrong-type'); console.log('STAND-IN: E-1 is worded "wrong-type" (no ERR prefix)'); }
  const outDir = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null) || fs.mkdtempSync(path.join(os.tmpdir(), 'realstore-s3-'));
  fs.mkdirSync(outDir, { recursive: true });
  const r = await run({ selftest: { id: S.id, endpoint: S.endpoint, token: S.token, metricsUrl: S.metricsUrl }, outDir, quietMs: 1000, secondScanMs: 1000, identityWaitMs: 5000, quiet: true });
  const log = fs.readFileSync(r.logFile, 'utf8');
  console.log('the runner\'s log:', r.logFile);
  for (const [file] of FILES) {
    const f = r.files.find(x => x.file === file);
    check(`${file}: ran in store mode, exit ${f ? f.exit : '-'}, ${f ? f.passed + ' passed, ' + f.failed + ' failed' : 'NOT RUN'}; LOCAL ONLY ${f ? f.localOnly : '-'}`, !!f && f.exit === 0 && f.failed === 0 && f.fails.length === 0 && f.passed > 0 && f.localOnly >= 1 && !f.fault && !f.timedOut, f && { fails: f.fails, fault: f.fault });
    check(`${file}: its clean-up VERIFIED`, new RegExp(`CLEAN-UP ${file.replace('.', '\\.')}: VERIFIED`).test(log));
  }
  check('step 0 matched on the stand-in', /CLEAN-UP after step 0: VERIFIED/.test(log) && !/STEP 0 DIFF/.test(log));
  check('the run passed, with no credential in its log', r.ok && /TESTS: PASSED/.test(log) && !log.includes(S.token) && !log.includes(S.endpoint));
  const st = await S.close();
  check('the stand-in\'s local Redis was stopped by SHUTDOWN NOSAVE and its folder removed', st.exited && st.folderGone, st);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: TEST CRASHED', e && e.stack || e); process.exit(1); });
