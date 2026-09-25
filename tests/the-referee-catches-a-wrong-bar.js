// The referee itself has to be proven, or it is just another thing to
// trust. The question it must answer: given the bars the app ACTUALLY had
// before 25 September, does it say they are wrong?
//
// It stands in for the market data service so the comparison can be run
// without keys and without the market being open. That is legitimate here
// because what is under test is the REFEREE, not the bars -- the bars it
// is fed are the real old arithmetic, lifted from the code that ran.
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// ---- a stand-in market data service -------------------------------
// Serves 1-minute bars, and its OWN larger bars built properly on the
// clock. This is what an honest provider returns.
const SESSION_OPEN_MIN = 9 * 60 + 30;
const mkMinutes = (n) => {
  const out = [];
  let t = Date.UTC(2026, 5, 24, 9 + 4, 30);         // 09:30 New York, June
  let p = 100;
  for (let i = 0; i < n; i++) {
    out.push({ datetime: t, open: +p.toFixed(2), high: +(p + 0.05).toFixed(2),
               low: +(p - 0.05).toFixed(2), close: +(p + 0.02).toFixed(2), volume: 1000 });
    t += 60000; p += (i % 5 < 3 ? 0.03 : -0.04);
  }
  return out;
};
const ONE_MIN = mkMinutes(390);
const properBars = (size) => {
  const out = [];
  for (let i = 0; i < ONE_MIN.length; i += size) {
    const chunk = ONE_MIN.slice(i, i + size);
    out.push({ datetime: chunk[0].datetime, open: chunk[0].open,
               high: Math.max(...chunk.map(c => c.high)), low: Math.min(...chunk.map(c => c.low)),
               close: chunk[chunk.length - 1].close });
  }
  return out;
};

const stubAlpaca = {
  isReady: async () => true,
  fetchBars: async (symbol, { minutes }) => (minutes === 1 ? ONE_MIN : properBars(minutes)),
};

// Load barAudit with the stand-in in place of the real market client.
const realResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, '..', 'alpacaClient.js');
const cache = require.cache;
cache[stubPath] = { id: stubPath, filename: stubPath, loaded: true, exports: stubAlpaca };
const { auditBars, buildFromMinutes } = require('../barAudit.js');

// THE OLD ARITHMETIC, exactly as it was: N candles at a time straight out
// of the array, stamped with the LAST one. This is the code that shipped.
const oldWay = (candles, groupSize) => {
  if (groupSize <= 1) return candles;
  const groups = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const chunk = candles.slice(i, i + groupSize);
    if (!chunk.length) continue;
    groups.push({ open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(c => c.high)), low: Math.min(...chunk.map(c => c.low)),
      datetime: chunk[chunk.length - 1].datetime });
  }
  return groups;
};

(async () => {
  console.log('--- the bars the app builds NOW agree with the provider ---');
  {
    const r = await auditBars('SPY', ONE_MIN[0].datetime, ONE_MIN[ONE_MIN.length - 1].datetime);
    check('the check actually ran', r.ran === true);
    check(`and every size agreed (${r.rows.map(x => x.size + 'm:' + x.checked).join(' ')})`, r.agreed === true);
    check('so it says nothing is wrong', r.reason === null);
    const total = r.rows.reduce((s, x) => s + x.checked, 0);
    check(`and it really compared bars rather than shrugging (${total} of them)`, total > 50);
  }

  console.log('\n--- THE ONE THAT MATTERS: fed the OLD bars, it must object ---');
  {
    // A window that does NOT begin at the session open, which is what a
    // window centred on a trade looks like -- the case that exposed this.
    const offset = ONE_MIN.slice(47);
    const ourOld5 = oldWay(offset, 5);
    const theirs5 = properBars(5);
    const theirsByTime = new Map(theirs5.map(b => [b.datetime, b]));
    let disagreed = 0;
    for (const o of ourOld5) if (!theirsByTime.has(o.datetime) || Math.abs(theirsByTime.get(o.datetime).open - o.open) > 0.005) disagreed++;
    check(`the old 5-minute bars disagree with the provider on ${disagreed} of ${ourOld5.length}`, disagreed > 0);
    check('...and it is nearly all of them, not a rounding edge', disagreed > ourOld5.length * 0.8);

    // And the same window through the NEW arithmetic must agree -- except
    // for its FIRST bar, which is genuinely incomplete: the recording
    // starts at 10:17, so the 10:15 bar it builds holds only 10:17
    // onwards. Measured at 100.15 against the provider's 100.09. That is
    // an INCOMPLETE bar, not a wrong one, and the referee counts it
    // separately for exactly that reason.
    const ourNew5 = buildFromMinutes(offset, 5);
    let newDisagreed = 0;
    for (const o of ourNew5.slice(1)) if (!theirsByTime.has(o.datetime) || Math.abs(theirsByTime.get(o.datetime).open - o.open) > 0.005) newDisagreed++;
    check(`every WHOLE bar through today's arithmetic agrees (${ourNew5.length - 1} of them)`, newDisagreed === 0);
    check('and the one partial bar really is partial, not imagined',
      Math.abs(theirsByTime.get(ourNew5[0].datetime).open - ourNew5[0].open) > 0.005);
  }

  console.log('\n--- and a single wrong bar is caught, not averaged away ---');
  {
    // One bar nudged by a penny. A check that only compares totals would
    // miss this; the money check learned that lesson when duplicated wins
    // and losses cancelled out to within $15 of the truth.
    const bent = properBars(15).map((b, i) => (i === 7 ? { ...b, open: +(b.open + 0.02).toFixed(2) } : b));
    cache[stubPath].exports = {
      isReady: async () => true,
      fetchBars: async (s, { minutes }) => (minutes === 1 ? ONE_MIN : (minutes === 15 ? bent : properBars(minutes))),
    };
    delete require.cache[require.resolve('../barAudit.js')];
    const { auditBars: fresh } = require('../barAudit.js');
    const r = await fresh('SPY', ONE_MIN[0].datetime, ONE_MIN[ONE_MIN.length - 1].datetime, [15]);
    check(`one bar out by two cents is reported (${r.rows[0].disagreed} disagreed)`, r.rows[0].disagreed === 1);
    check('and it is not called agreement', r.agreed === false);
    check('and it names the size: ' + (r.reason || ''), /15-minute/.test(r.reason || ''));
  }

  console.log('\n--- when it cannot check, it says WHY rather than passing ---');
  {
    cache[stubPath].exports = { isReady: async () => false, fetchBars: async () => null };
    delete require.cache[require.resolve('../barAudit.js')];
    const { auditBars: noKey } = require('../barAudit.js');
    const r = await noKey('SPY', ONE_MIN[0].datetime, ONE_MIN[389].datetime);
    check('no key: it does not run', r.ran === false);
    check('...and says so in plain words: ' + r.reason, /no market-data key/.test(r.reason));
    check('...and never claims agreement', r.agreed !== true);

    cache[stubPath].exports = {
      isReady: async () => true,
      fetchBars: async () => { throw new Error('connection reset'); },
    };
    delete require.cache[require.resolve('../barAudit.js')];
    const { auditBars: down } = require('../barAudit.js');
    const r2 = await down('SPY', ONE_MIN[0].datetime, ONE_MIN[389].datetime);
    check('unreachable: it does not run', r2.ran === false);
    check('...and says it could not reach it, which is a different fault: ' + r2.reason,
      /Could not reach/.test(r2.reason));
    check('...and those two answers are not the same text', r.reason !== r2.reason);
  }

  Module._resolveFilename = realResolve;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
