#!/usr/bin/env node
'use strict';
// "Is the camera working?" in plain words:  node chart-camera/src/status.js
// Read from the camera's own memory, so it works even when the internet
// is down.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { loadState } = require('./state');
const { readIndex } = require('./recorder');
const { disk } = require('./retention');
const { nyClock } = require('./clock');

const loaded = loadConfig();
if (!loaded.ok) { console.log('The camera cannot start: ' + loaded.why); process.exit(1); }
const cfg = loaded.cfg;
const st = loadState(cfg);
const pieces = readIndex(cfg);
const last = pieces.length ? pieces[pieces.length - 1].end : null;
const d = disk(cfg.dataDir);
const waiting = Object.values(st.jobs).filter(j => j.status === 'waiting');
const failed = Object.values(st.jobs).filter(j => j.status === 'failed').sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
let outbox = 0; try { outbox = fs.readdirSync(path.join(cfg.dataDir, 'outbox')).length; } catch (e) { outbox = 0; }

const lines = [];
lines.push(last ? `Last recorded: ${nyClock(last)} New York time (${Math.round((Date.now() - last) / 1000)} s ago)` : 'Nothing has been recorded yet.');
lines.push(`Chart: ${st.lastSymbol ? 'showing ' + st.lastSymbol : 'not known'}`);
lines.push(d.free != null ? `Drive: ${Math.round(d.free / 1e9)} GB free of ${Math.round(d.total / 1e9)} GB` : 'Drive: could not be read');
lines.push(`Waiting to be sent: ${waiting.length} (${outbox} file(s) held on the camera)`);
if (st.lastPollProblem) lines.push(`Talking to your service: NOT WORKING right now -- ${st.lastPollProblem}`);
else lines.push('Talking to your service: working');
if (Math.abs(st.measuredOffsetMs || 0) >= 2000) lines.push(`Clock: ${Math.round(st.measuredOffsetMs / 1000)} s off`);
if (failed.length) {
  lines.push('Recently not sent:');
  for (const j of failed.slice(0, 5)) lines.push(`  - ${j.kind === 'clip' ? 'recording' : j.moment + ' picture'} ${j.ticker}: ${j.reason}`);
}
if (st.problems.length) {
  lines.push('Recent problems:');
  for (const p of st.problems.slice(-5)) lines.push(`  - ${new Date(p.at).toLocaleString()}: ${p.why}${p.count > 1 ? ` (${p.count} times)` : ''}`);
}
console.log(lines.join('\n'));
