// Every alert to his phone returned instantly and silently for months,
// because no key was set and sendPushcut's first line simply gave up. He
// had no way to learn the whole phone path was inert, and neither did I.
//
// So this marks the four outcomes that must never share one answer:
//   never asked  -- nothing is set up
//   accepted     -- Pushcut took it
//   refused      -- Pushcut answered, but has no alert by that name
//   unreachable  -- Pushcut did not answer at all
// and that the trade's OWN moment travels with each one, so a picture is
// stamped with when the trade happened rather than when he got to his phone.

const assert = require('assert');
const path = require('path');
const Module = require('module');

let checks = 0;
const ok = (cond, what) => { checks++; assert.ok(cond, what); };
const eq = (a, b, what) => { checks++; assert.strictEqual(a, b, what); };

// Stand-ins for the two things this file reaches out to, installed before
// pushcut.js is loaded so it picks them up instead of the real ones.
let posted = [];
let nextResult = { kind: 'ok' };
let stored = null;

const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') {
    return {
      post: async (url, payload, opts) => {
        posted.push({ url, payload, opts });
        if (nextResult.kind === 'ok') return { status: 200, data: {} };
        const err = new Error(nextResult.message || 'refused');
        if (nextResult.status) err.response = { status: nextResult.status, data: {} };
        throw err;
      },
    };
  }
  if (request === '@upstash/redis') {
    // A class, not a bare object: other files in this project construct it
    // with `new Redis(...)`, and a stand-in that cannot be constructed
    // fails somewhere far from what is being checked.
    class FakeRedis {
      static fromEnv() { return new FakeRedis(); }
      async set(k, v) { stored = { k, v }; }
      async get() { return stored ? stored.v : null; }
      async lpush() {}
      async ltrim() {}
      async del() {}
    }
    return { Redis: FakeRedis };
  }
  return realLoad.apply(this, arguments);
};

delete require.cache[require.resolve('../pushcut.js')];
const pushcut = require('../pushcut.js');

const ENV = ['PUSHCUT_API_KEY', 'PUSHCUT_NOTIFICATION_NAME', 'PUSHCUT_NOTIFICATION_NAME_OPENED',
  'PUSHCUT_NOTIFICATION_NAME_STILL_OPEN', 'PUSHCUT_NOTIFICATION_NAME_SIGNIN'];
function setEnv(obj) {
  for (const k of ENV) delete process.env[k];
  for (const k of Object.keys(obj)) process.env[k] = obj[k];
}

const TRADE = {
  id: 't1', ticker: 'SPY', dir: 'Long', pnlDollar: 42.5,
  heldMs: 6 * 60 * 1000, exitTimestamp: 1758000000000,
};
const LEG = { occ: 'SPY  260916C00650000', ticker: 'SPY', dir: 'Long', openTimestamp: 1757999000000 };

async function run() {
  // ---- 1. Never asked: no key at all. This is the state it was in for months.
  posted = []; stored = null;
  setEnv({ PUSHCUT_NOTIFICATION_NAME: 'Take Trade Screenshot' });
  await pushcut.notifyTradeClosed(TRADE);
  eq(posted.length, 0, 'with no key, nothing is sent');
  let a = await pushcut.lastPhoneAlert();
  ok(a, 'an alert with no key still writes down what happened');
  eq(a.ok, false, 'not sent is not a success');
  eq(a.asked, false, 'nothing was asked of Pushcut');
  ok(/no key is set/i.test(a.reason), 'the reason names the missing key: ' + a.reason);
  ok(!/undefined|null|\[object/i.test(a.reason), 'the reason is plain words, not a stray value');
  eq(a.moment, 'a trade closing', 'it says WHICH moment this was');

  // ---- 2. Never asked: key but no name for this moment.
  posted = []; stored = null;
  setEnv({ PUSHCUT_API_KEY: 'k' });
  await pushcut.notifyTradeClosed(TRADE);
  eq(posted.length, 0, 'with no name, nothing is sent');
  a = await pushcut.lastPhoneAlert();
  eq(a.asked, false, 'still nothing asked');
  ok(/no alert name/i.test(a.reason), 'the reason names the missing name: ' + a.reason);
  eq(a.name, null, 'and does not invent a name it never had');

  // ---- 3. Accepted. What he should see after a real trade.
  posted = []; stored = null;
  setEnv({ PUSHCUT_API_KEY: 'k', PUSHCUT_NOTIFICATION_NAME: 'Take Trade Screenshot' });
  nextResult = { kind: 'ok' };
  await pushcut.notifyTradeClosed(TRADE);
  eq(posted.length, 1, 'one alert sent');
  ok(posted[0].url.includes(encodeURIComponent('Take Trade Screenshot')), 'sent to the name he actually has');
  eq(posted[0].opts.headers['API-Key'], 'k', 'the key travels as a header');
  a = await pushcut.lastPhoneAlert();
  eq(a.ok, true, 'accepted');
  eq(a.asked, true, 'and it really was asked');
  eq(a.reason, null, 'a success invents no fault');
  eq(a.name, 'Take Trade Screenshot', 'the name is recorded');
  ok(typeof a.at === 'number' && a.at > 0, 'and when');

  // The trade's OWN moment must travel, or the picture gets stamped with
  // whenever he happened to pick up his phone.
  let input = JSON.parse(posted[0].payload.input);
  eq(input.timestamp, TRADE.exitTimestamp, 'the closing alert carries the exit moment');
  eq(input.mode, 'video', 'a six-minute trade is still a video trade');

  // ---- 4. Refused: Pushcut answered, but has no alert by that name.
  //         This is the one fault he can fix himself, so it must not read
  //         like a connection problem.
  posted = []; stored = null;
  nextResult = { kind: 'fail', status: 404 };
  await pushcut.notifyTradeClosed(TRADE);
  a = await pushcut.lastPhoneAlert();
  eq(a.ok, false, 'refused is not a success');
  eq(a.asked, true, 'it WAS asked -- the key worked');
  eq(a.status, 404, 'the refusal is recorded');
  ok(a.reason.includes('Take Trade Screenshot'), 'the reason names the alert that is missing: ' + a.reason);
  ok(!/could not be reached/i.test(a.reason), 'a refusal must not read as unreachable');

  // ---- 5. Key rejected -- a third, different fault.
  posted = []; stored = null;
  nextResult = { kind: 'fail', status: 401 };
  await pushcut.notifyTradeClosed(TRADE);
  a = await pushcut.lastPhoneAlert();
  ok(/key was not accepted/i.test(a.reason), 'a bad key says so: ' + a.reason);

  // ---- 6. Unreachable: no answer at all.
  posted = []; stored = null;
  nextResult = { kind: 'fail', message: 'ECONNRESET' };
  await pushcut.notifyTradeClosed(TRADE);
  a = await pushcut.lastPhoneAlert();
  eq(a.status, null, 'nothing answered, so there is no status to report');
  ok(/could not be reached/i.test(a.reason), 'unreachable says so: ' + a.reason);
  ok(!/nothing called/i.test(a.reason), 'and must not read as a missing name');
  ok(!/ECONNRESET/.test(a.reason), 'never his screen, never raw text from elsewhere');

  // ---- 7. The other three moments each carry their own time and label.
  nextResult = { kind: 'ok' };
  setEnv({
    PUSHCUT_API_KEY: 'k',
    PUSHCUT_NOTIFICATION_NAME: 'Take Trade Screenshot',
    PUSHCUT_NOTIFICATION_NAME_OPENED: 'Trade Opened',
    PUSHCUT_NOTIFICATION_NAME_STILL_OPEN: 'Trade Still Open',
  });

  posted = []; stored = null;
  await pushcut.notifyTradeOpened(LEG);
  input = JSON.parse(posted[0].payload.input);
  eq(input.timestamp, LEG.openTimestamp, 'the opening alert carries the entry moment');
  a = await pushcut.lastPhoneAlert();
  eq(a.moment, 'a trade opening', 'labelled as the open');

  posted = []; stored = null;
  await pushcut.notifyTradeStillOpen(LEG);
  input = JSON.parse(posted[0].payload.input);
  eq(input.timestamp, LEG.openTimestamp + 15 * 60 * 1000,
    'the fifteen-minute alert carries the fifteen-minute mark, not the open');
  a = await pushcut.lastPhoneAlert();
  eq(a.moment, 'a trade passing fifteen minutes', 'labelled as the middle');

  posted = []; stored = null;
  await pushcut.notifySignInExpiring('twoDays', 40);
  a = await pushcut.lastPhoneAlert();
  eq(a.moment, 'the weekly sign-in running out', 'labelled as the sign-in');
  eq(a.name, 'Take Trade Screenshot',
    'with no dedicated name it falls back to the one he already has');

  // ---- 8. A trade held past fifteen minutes is a picture, not a video,
  //         and a trade with no exit time on file says so rather than
  //         inventing one.
  posted = []; stored = null;
  await pushcut.notifyTradeClosed({ ...TRADE, heldMs: 40 * 60 * 1000, exitTimestamp: undefined });
  input = JSON.parse(posted[0].payload.input);
  eq(input.mode, 'screenshot', 'a forty-minute trade is a picture trade');
  eq(input.timestamp, null, 'an unknown moment is null, never a made-up one');

  // ---- 9. Storing the outcome may never break an alert, and reading it
  //         back may never throw. Exercised on a store that fails on both.
  {
    delete require.cache[require.resolve('../pushcut.js')];
    Module._load = function (request) {
      if (request === 'axios') {
        return { post: async (url, payload, opts) => { posted.push({ url, payload, opts }); return { status: 200 }; } };
      }
      if (request === '@upstash/redis') {
        class DeadRedis {
          static fromEnv() { return new DeadRedis(); }
          async set() { throw new Error('storage down'); }
          async get() { throw new Error('storage down'); }
        }
        return { Redis: DeadRedis };
      }
      return realLoad.apply(this, arguments);
    };
    const fragile = require('../pushcut.js');
    posted = [];
    await fragile.notifyTradeClosed(TRADE);
    eq(posted.length, 1, 'the alert still goes out when its record cannot be stored');
    eq(await fragile.lastPhoneAlert(), null, 'a store that refuses answers null, it does not throw');
    Module._load = realLoad;
  }

  console.log(`phone alert: ${checks} checks passed`);
}

run().then(() => {
  Module._load = realLoad;
  Module._resolveFilename = realResolve;
}).catch(err => {
  Module._load = realLoad;
  console.error('FAILED:', err.message);
  process.exit(1);
});
