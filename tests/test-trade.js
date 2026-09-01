// The rehearsed trade: three moments, in order, marked so nothing they
// produce can reach his journal.
const Module = require('module');
const path = require('path');

let store = {}, list = [];
const fakeRedis = {
  set: async (k, v) => { store[k] = v; return 'OK'; },
  get: async (k) => (k in store ? store[k] : null),
  del: async (k) => { delete store[k]; return 1; },
  lpush: async (k, v) => { list.unshift(v); return list.length; },
  lrange: async (k, a, b) => list.slice(a, b === -1 ? undefined : b + 1),
  lrem: async (k, c, v) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); return 1; },
  ltrim: async (k, a, b) => { list = list.slice(a, b + 1); return 'OK'; },
};
class Redis { constructor() { return fakeRedis; } }
Redis.fromEnv = () => fakeRedis;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@upstash/redis') return { Redis };
  return origLoad.apply(this, arguments);
};

process.env.APP_SECRET = 'testkey';
const be = require(path.join(__dirname, '..', 'browserEvents.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

function callRoute(method, routePath, query) {
  return new Promise((resolve) => {
    const layer = be.router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    const handler = layer.route.stack[0].handle;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ query, params: {} }, res, (err) => resolve({ status: 500, body: err }));
  });
}

(async () => {
  const NOW = Date.parse('2026-09-01T14:00:00Z');
  const queued = await be.queueTestTrade(NOW);

  check('three moments, not one', queued.length === 3);
  check('in the order a real trade happens',
    queued.map(q => q.type).join(',') === 'opened,stillOpen,closed');
  check('the opening is due immediately', queued[0].timestamp === NOW);
  check('the middle comes after the opening', queued[1].timestamp > queued[0].timestamp);
  check('the close comes after the middle', queued[2].timestamp > queued[1].timestamp);
  check(`the whole thing finishes inside two minutes (${be.TEST_CLOSE_AFTER_MS / 1000}s)`,
    be.TEST_CLOSE_AFTER_MS <= 120 * 1000);
  check('EVERY moment is marked as a rehearsal', queued.every(q => q.test === true));
  check('nothing carries a real ticker', queued.every(q => q.ticker === 'TEST'));

  // The whole point: a rehearsal must be distinguishable at every step.
  const offered = await callRoute('get', '/events', { key: 'testkey' });
  check('all three are offered to the add-on', offered.body.events.length === 3);
  check('and they are still marked as a rehearsal when handed over',
    offered.body.events.every(e => e.test === true));

  // A real trade moment must NOT be marked, or the marking means nothing.
  store = {}; list = [];
  const real = await be.queueBrowserEvent('opened', { ticker: 'SPY', dir: 'Long', timestamp: NOW });
  check('a real moment carries no rehearsal mark', real.test === undefined);
  const realOffered = await callRoute('get', '/events', { key: 'testkey' });
  check('and is handed over without one', !realOffered.body.events[0].test);

  // The route itself.
  store = {}; list = [];
  const forbidden = await callRoute('post', '/test-trade', { key: 'wrong' });
  check('the wrong key cannot start a test', forbidden.status === 403);
  check('and nothing was queued by the attempt', list.length === 0);

  const started = await callRoute('post', '/test-trade', { key: 'testkey' });
  check('the right key starts it', started.status === 200 && started.body.ok === true);
  check('it says how many moments are coming', started.body.moments === 3);
  check(`and how long it takes (${started.body.finishesInSeconds}s)`,
    started.body.finishesInSeconds > 0 && started.body.finishesInSeconds <= 120);
  check('three moments are on the list', list.length === 3);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
