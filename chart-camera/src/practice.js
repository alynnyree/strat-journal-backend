#!/usr/bin/env node
'use strict';
// A PRACTICE TRADE, run on the camera:  node chart-camera/src/practice.js [SYMBOL]
// Asks his service for a labelled practice trade (an opening now, a closing
// six minutes later), then watches the camera deal with it and says, in
// plain words, what arrived and what did not. Practice pictures and the
// practice recording are marked as practice the whole way, so nothing from
// this is ever filed against a real trade.
const { loadConfig } = require('./config');
const { loadState } = require('./state');
const { Service } = require('./service');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const loaded = loadConfig();
  if (!loaded.ok) { console.log('Cannot start the practice: ' + loaded.why); process.exit(1); }
  const cfg = loaded.cfg;
  const symbol = (process.argv[2] || cfg.defaultSymbol || 'SPY').toUpperCase();
  const svc = new Service(cfg);
  const r = await svc.request('POST', '/camera/test-trade', { json: { ticker: symbol } });
  if (!r.ok) { console.log('The practice trade could not be started: ' + r.reason); process.exit(1); }
  console.log(`Practice trade on ${symbol} started. It "closes" in ${Math.round(r.body.closesInSeconds / 60)} minutes;`);
  console.log('the recording takes a few minutes more to prepare and send. Leave this running (about 10 minutes).\n');
  const started = Date.now();
  const seen = new Set();
  while (Date.now() - started < 20 * 60 * 1000) {
    const st = loadState(cfg);
    const jobs = Object.values(st.jobs).filter(j => j.test && j.legKey && j.legKey.startsWith(`TEST-${symbol}-`) && Number(j.legKey.split('-').pop()) >= started - 60000);
    for (const j of jobs) {
      const key = j.id + j.status;
      if (seen.has(key) || j.status === 'waiting') continue;
      seen.add(key);
      const what = j.kind === 'clip' ? 'the recording' : `the ${j.moment} picture`;
      console.log(j.status === 'done' ? `  ARRIVED: ${what}${j.note ? ` (${j.note})` : ''}` : `  NOT SENT: ${what}: ${j.reason}`);
    }
    if (jobs.length >= 4 && jobs.every(j => j.status !== 'waiting')) {
      const ok = jobs.filter(j => j.status === 'done').length;
      console.log(`\nPractice finished: ${ok} of ${jobs.length} arrived.${ok === jobs.length ? ' Everything works.' : ' Send Claude the lines above.'}`);
      process.exit(ok === jobs.length ? 0 : 1);
    }
    await sleep(5000);
  }
  console.log('\nThe practice did not finish within 20 minutes. Is the camera running? Try: node chart-camera/src/status.js');
  process.exit(1);
})();
