// Picking the day, the time, how long it ran, which way and which ticker.
// A bad choice must come back as a sentence he can act on, BEFORE
// anything is fetched -- not as two steps quietly failing later.
const Module = require('module');
const path = require('path');
const fakeRedis = { get: async()=>null, set: async()=>'OK', del: async()=>1,
  lpush: async()=>1, lrange: async()=>[], lrem: async()=>0, ltrim: async()=>'OK' };
class Redis { constructor(){ return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  if (request === './auth') return { getValidAccessToken: async () => 'tok', router: null };
  return origLoad.apply(this, arguments);
};
const tt = require(path.join(__dirname, '..', 'testTrade.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// A weekday inside the data window, so the "too old" and "weekend"
// warnings do not fire unless a case is deliberately testing them.
const RECENT = (() => {
  const d = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  for (let i = 0; i < 7; i++) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
    if (wd !== 'Sat' && wd !== 'Sun') break;
    d.setTime(d.getTime() - 24 * 3600 * 1000);
  }
  const p = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
})();

(async () => {
  // ===== 1. Choosing nothing keeps exactly the old behaviour =====
  {
    const c = tt.readChoices({});
    check('with no choices it still picks a recent weekday', !!c.session && !c.error);
    check('and defaults to SPY Long', c.ticker === 'SPY' && c.dir === 'Long');
    check('at 10:30', c.hour === 10 && c.minute === 30);
    check('held 22 minutes, past the fifteen-minute mark', c.holdMinutes === 22);
    check('with nothing to warn about', c.warnings.length === 0);
  }

  // ===== 2. Choosing a day and a time =====
  {
    const c = tt.readChoices({ date: RECENT, time: '14:05', holdMinutes: 8, dir: 'Short', ticker: 'iwm' });
    check(`the day he picked is used (${c.session.year}-${c.session.month}-${c.session.day})`,
      `${c.session.year}-${c.session.month}-${c.session.day}` === RECENT);
    check('the time he picked is used', c.hour === 14 && c.minute === 5);
    check('how long it ran is used', c.holdMinutes === 8);
    check('Short is understood', c.dir === 'Short');
    check('a lower-case ticker is tidied up', c.ticker === 'IWM');
    check('nothing to warn about for a normal midday trade', c.warnings.length === 0);
  }
  {
    const c = tt.readChoices({ time: '9:35' });
    check('a single-digit hour works', c.hour === 9 && c.minute === 35);
  }

  // ===== 3. Bad choices are refused in words, before anything runs =====
  const bad = [
    [{ date: '28/08/2026' }, /date should look like/],
    [{ date: '2026-13-01' }, /not a real date/],
    [{ date: 'yesterday' }, /date should look like/],
    [{ time: '10.30' }, /time should look like/],
    [{ time: '25:00' }, /not a real time/],
    [{ time: '10:75' }, /not a real time/],
    [{ holdMinutes: 0 }, /between 1 minute and 390/],
    [{ holdMinutes: 500 }, /between 1 minute and 390/],
    [{ holdMinutes: 'ages' }, /between 1 minute and 390/],
    [{ dir: 'sideways' }, /Long or Short/],
    [{ ticker: 'NOT A TICKER' }, /look like a ticker/],
    [{ ticker: 'TOOLONGSYM' }, /look like a ticker/],
  ];
  for (const [raw, expect] of bad) {
    const c = tt.readChoices(raw);
    check(`${JSON.stringify(raw)} is refused in plain words ("${(c.error||'').slice(0,34)}")`,
      !!c.error && expect.test(c.error));
  }
  {
    // Never a raw error, never a word he would not use.
    const banned = /server|parse|invalid|null|undefined|exception|NaN/i;
    const messages = bad.map(([raw]) => tt.readChoices(raw).error);
    const bads = messages.filter(m => banned.test(m));
    check(`no technical words in any refusal (${bads.join(' | ') || 'none'})`, bads.length === 0);
  }

  // ===== 4. Awkward but allowed choices WARN, they do not refuse =====
  {
    // A Saturday.
    const sat = tt.readChoices({ date: '2026-08-29' });
    check('a weekend is allowed but warned about',
      !sat.error && sat.warnings.some(w => /weekend/.test(w)));

    const night = tt.readChoices({ date: RECENT, time: '03:00' });
    check('the middle of the night is warned about',
      !night.error && night.warnings.some(w => /9:30 to 4:00/.test(w)));

    const preMarket = tt.readChoices({ date: RECENT, time: '09:00' });
    check('before the open is warned about', preMarket.warnings.some(w => /9:30 to 4:00/.test(w)));

    const late = tt.readChoices({ date: RECENT, time: '15:50', holdMinutes: 60 });
    check('a trade running past the close is warned about',
      late.warnings.some(w => /past the 4:00 close/.test(w)));

    const old = tt.readChoices({ date: '2026-01-15' });
    check('a day older than a month is warned about, and told it is not a fault',
      old.warnings.some(w => /minute-by-minute/.test(w) && /not a fault/.test(w)));
    check('and it is still allowed to run', !old.error);
  }
  {
    check('9:30 exactly is fine', tt.readChoices({ date: RECENT, time: '09:30' }).warnings.length === 0);
    check('15:59 is inside the day', !tt.readChoices({ date: RECENT, time: '15:59', holdMinutes: 1 })
      .warnings.some(w => /9:30 to 4:00/.test(w)));
    check('16:00 is not', tt.readChoices({ date: RECENT, time: '16:00' })
      .warnings.some(w => /9:30 to 4:00/.test(w)));
  }

  // ===== 5. Short builds a PUT, Long builds a CALL =====
  {
    const session = { year:'2026', month:'09', day:'01' };
    const entry = tt.easternMoment(session, 10, 30);
    const long = tt.buildFills(session, 655, entry, entry+600000, { ticker:'SPY', dir:'Long' });
    const short = tt.buildFills(session, 220, entry, entry+600000, { ticker:'IWM', dir:'Short' });
    check(`Long is a call (${long[0].occ})`, long[0].putCall === 'CALL' && /C00655000$/.test(long[0].occ));
    check(`Short is a put (${short[0].occ})`, short[0].putCall === 'PUT' && /P00220000$/.test(short[0].occ));
    check('the chosen ticker is on the fills', short[0].ticker === 'IWM' && short[0].occ.startsWith('IWM'));
    check('he still BUYS to open on a Short', short[0].instruction === 'BUY_TO_OPEN');
    check('and sells to close', short[1].instruction === 'SELL_TO_CLOSE');
  }

  // ===== 6. End to end with his choices, through the real matcher =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 221.40,
      // Must actually set the price it claims to fetch -- a stub that does
      // nothing makes the step fail for the stub's reasons, not the code's.
      enrichWithUnderlyingPrices: async (t, [x]) => { x.undEntry = 221.40; x.undExit = 221.05; },
      enrichWithFtfc: async () => {},
      enrichWithReplayData: async (t, [x]) => { x.replayData = { candles:[{}] }; },
      enrichWithStopRule: async () => {}, enrichWithStrategy: async ([x]) => { x.strat = '2-2 Reversal'; },
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps, { date: RECENT, time: '13:15', holdMinutes: 9, dir: 'Short', ticker: 'IWM' });
    check('it runs with his choices', r.ok === true);
    check(`the trade is a Short (${r.trade.dir})`, r.trade.dir === 'Short');
    check(`on his ticker (${r.trade.ticker})`, r.trade.ticker === 'IWM');
    check(`entering at the time he picked (${r.trade.entryTime})`, r.trade.entryTime === '13:15');
    check(`and leaving nine minutes later (${r.trade.exitTime})`, r.trade.exitTime === '13:24');
    check(`on the day he picked (${r.trade.entryDate})`, r.trade.entryDate === RECENT);
    check('the strike came from where the stock really was', /P00221000$/.test(r.trade.occ));
    check('it still cannot reach his journal', r.trade.isTest === true && r.trade.source === 'rehearsal');
    check('it hands back what it actually ran, so he need not remember',
      r.ran.date === RECENT && r.ran.time === '13:15' && r.ran.holdMinutes === 9
      && r.ran.dir === 'Short' && r.ran.ticker === 'IWM');
    const step = r.steps.find(s => /Find where/.test(s.name));
    check(`the price step names his ticker and time ("${step.summary}")`,
      /IWM/.test(step.summary) && /13:15/.test(step.summary));
  }

  // ===== 7. A bad choice never reaches the outside world =====
  {
    let touched = 0;
    const deps = {
      getUnderlyingPriceAt: async () => { touched++; return 1; },
      enrichWithUnderlyingPrices: async () => { touched++; },
      enrichWithFtfc: async () => { touched++; }, enrichWithReplayData: async () => { touched++; },
      enrichWithStopRule: async () => { touched++; }, enrichWithStrategy: async () => { touched++; },
      getToken: async () => { touched++; return 'tok'; },
    };
    const r = await tt.runTestTrade(deps, { time: '99:99' });
    check('a bad time stops it before anything is fetched', touched === 0);
    check('and says why, in one sentence', /not a real time/.test(r.error || ''));
    check('with no half-finished steps to puzzle over', r.steps.length === 0 && r.trade === null);
  }

  // ===== 8. Warnings travel back with the result =====
  {
    const deps = {
      getUnderlyingPriceAt: async () => 655,
      enrichWithUnderlyingPrices: async (t, [x]) => { x.undEntry = 655; x.undExit = 656; },
      enrichWithFtfc: async () => {},
      enrichWithReplayData: async (t,[x]) => { x.replayData = { candles:[{}] }; },
      enrichWithStopRule: async () => {}, enrichWithStrategy: async ([x]) => { x.strat='x'; },
      getToken: async () => 'tok',
    };
    const r = await tt.runTestTrade(deps, { date: '2026-01-15' });
    check('the too-old warning reaches the answer', (r.warnings||[]).some(w=>/minute-by-minute/.test(w)));
    check('and the run still happened', !!r.trade);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
