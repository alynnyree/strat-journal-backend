// The day-6 Schwab sign-in reminder. Runs the real code against a fake
// store and a fake phone alert, so what is checked is the behaviour, not
// the shape of the source.
const Module = require('module');
const path = require('path');

let store = {};
let sentAlerts = [];

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './tokenStore' || request.endsWith('/tokenStore')) {
    return {
      getTokens: async () => JSON.parse(JSON.stringify(store)),
      saveTokenFields: async (fields) => { store = { ...store, ...fields }; },
      saveTokens: async () => {}, setLastCheck: async () => {},
    };
  }
  if (request === './pushcut' || request.endsWith('/pushcut')) {
    return {
      notifySignInExpiring: async (stage, hoursLeft) => { sentAlerts.push({ stage, hoursLeft }); },
      notifyTradeOpened: async () => {}, notifyTradeStillOpen: async () => {}, notifyTradeClosed: async () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

const watch = require(path.join(__dirname, '..', 'signInWatch.js'));

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A sign-in made at a fixed moment, so every "how long is left" below is
// arithmetic rather than a guess.
const CONNECTED = '2026-09-01T00:00:00.000Z';
const CONNECTED_MS = Date.parse(CONNECTED);
const at = (hoursAfterConnect) => CONNECTED_MS + hoursAfterConnect * HOUR;

function reset(extra = {}) {
  store = { refresh_token: 'r', connected_at: CONNECTED, ...extra };
  sentAlerts = [];
}

(async () => {
  // ===== 1. The countdown itself =====
  check('a fresh sign-in has 7 days', watch.hoursLeftFrom(CONNECTED, at(0)) === 168);
  check('six days in leaves 24 hours', watch.hoursLeftFrom(CONNECTED, at(144)) === 24);
  check('rounds DOWN: 40 hours left is 40, never 41',
    watch.hoursLeftFrom(CONNECTED, at(128)) === 40);
  check('a half hour past the end is negative, not zero',
    watch.hoursLeftFrom(CONNECTED, at(168.5)) < 0);
  check('no sign-in date gives no countdown', watch.hoursLeftFrom(null, at(0)) === null);
  check('nonsense sign-in date gives no countdown', watch.hoursLeftFrom('not a date', at(0)) === null);

  // ===== 2. Which reminder is due =====
  check('nothing due with five days left', watch.stageDue(120, []) === null);
  check('nothing due with 25 hours left', watch.stageDue(25, []) === null);
  check('day six is due at exactly 24 hours', watch.stageDue(24, []) === 'daySix');
  check('day six is due at 20 hours if it never went out', watch.stageDue(20, []) === 'daySix');
  check('the last-hours one takes over at 6', watch.stageDue(6, ['daySix']) === 'lastHours');
  check('and the gone one at zero', watch.stageDue(0, ['daySix', 'lastHours']) === 'gone');
  check('long past the end still reports gone', watch.stageDue(-40, ['daySix', 'lastHours']) === 'gone');
  check('an unknown countdown is never a reminder', watch.stageDue(null, []) === null);

  // ===== 3. It never repeats itself =====
  check('day six does not go out twice', watch.stageDue(20, ['daySix']) === null);
  check('nor does the gone one', watch.stageDue(-5, ['daySix', 'lastHours', 'gone']) === null);

  // ===== 4. A late start skips the ones it missed =====
  // If the server was down all through day 6 and comes back with 3 hours
  // left, he must get "runs out today" -- not "runs out tomorrow".
  check('coming back late sends the urgent one, not the stale one',
    watch.stageDue(3, []) === 'lastHours');
  check('and marks the gentler one as spent so it never arrives after it',
    watch.stagesToMark('lastHours').includes('daySix'));
  check('the gone one marks all three', watch.stagesToMark('gone').length === 3);
  check('day six marks only itself', watch.stagesToMark('daySix').join() === 'daySix');

  // ===== 5. End to end, through the real store and the real alert =====
  reset();
  let r = await watch.checkSignInAndNotify(at(100)); // 68 hours left
  check('nothing buzzes three days out', sentAlerts.length === 0 && r.sent === null);

  r = await watch.checkSignInAndNotify(at(145)); // 23 hours left
  check('the day-six buzz goes out', sentAlerts.length === 1 && sentAlerts[0].stage === 'daySix');
  check('and it reports the real hours left', sentAlerts[0].hoursLeft === 23);

  await watch.checkSignInAndNotify(at(146));
  await watch.checkSignInAndNotify(at(150));
  check('it does not buzz again an hour later, or four', sentAlerts.length === 1);

  r = await watch.checkSignInAndNotify(at(164)); // 4 hours left
  check('the last-hours buzz goes out on its own', sentAlerts.length === 2 && sentAlerts[1].stage === 'lastHours');

  r = await watch.checkSignInAndNotify(at(169)); // gone
  check('the signed-out buzz goes out', sentAlerts.length === 3 && sentAlerts[2].stage === 'gone');

  await watch.checkSignInAndNotify(at(200));
  await watch.checkSignInAndNotify(at(400));
  check('and then it stops for good, however long he leaves it', sentAlerts.length === 3);

  // ===== 6. Signing in again resets it, with nothing to clear by hand ==
  const FRESH = new Date(at(170)).toISOString();
  store.connected_at = FRESH;   // he signed in; the old record still names the old sign-in
  sentAlerts = [];
  await watch.checkSignInAndNotify(at(171));
  check('a fresh sign-in buzzes about nothing', sentAlerts.length === 0);
  await watch.checkSignInAndNotify(at(170 + 145));
  check('but the next day-six comes round again', sentAlerts.length === 1 && sentAlerts[0].stage === 'daySix');

  // ===== 7. The cases where it must say nothing at all =====
  reset(); store.refresh_token = null;
  await watch.checkSignInAndNotify(at(200));
  check('never connected: nothing is sent', sentAlerts.length === 0);

  reset(); delete store.connected_at;
  const r2 = await watch.checkSignInAndNotify(at(200));
  check('no sign-in date on file: nothing is sent', sentAlerts.length === 0);
  check('and it says why rather than going quiet', /no sign-in date/.test(r2.reason || ''));

  // ===== 8. It can never take the trade sync down with it =====
  reset();
  const broken = require(path.join(__dirname, '..', 'signInWatch.js'));
  const realGet = store;
  store = null;  // makes getTokens hand back null
  let threw = false;
  try { await broken.checkSignInAndNotify(at(150)); } catch (e) { threw = true; }
  check('a broken read is swallowed, never thrown', threw === false);
  store = realGet;

  // ===== 9. What the messages actually say =====
  const m6 = watch.messageFor('daySix', 23);
  const mL = watch.messageFor('lastHours', 4);
  const mG = watch.messageFor('gone', -2);
  const all = [m6, mL, mG];
  check('every message says what to do', all.every(m => /Sign In to Schwab/i.test(m.text)));
  check('the day-six one says trades still arrive', /keep arriving/.test(m6.text));
  check(`the last-hours one counts the hours ("${mL.text.slice(0, 30)}")`, /4 hours/.test(mL.text));
  check('the signed-out one says trades have stopped', /No new trades/.test(mG.text));
  const banned = ['server', 'token', 'refresh', 'memory', 'endpoint', 'api', 'cache'];
  const found = all.flatMap(m => banned.filter(w => (m.title + ' ' + m.text).toLowerCase().includes(w)));
  check(`no technical words reach his phone (${found.join(', ') || 'none'})`, found.length === 0);
  check('a negative countdown never prints as "-2 hours"', !/-\d/.test(mG.text) && !/-\d/.test(mL.text));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
