// The queue of trade moments the laptop add-on reads. Records expire on
// their own after twenty minutes but their ids used to be left behind for
// ever, so every check dragged the whole history along with it.
const Module = require('module');
const path = require('path');

let store = {};          // key -> value, with expiry simulated by deletion
let list = [];           // the pending list, newest first
const fakeRedis = {
  set: async (k, v) => { store[k] = v; return 'OK'; },
  get: async (k) => (k in store ? store[k] : null),
  del: async (k) => { delete store[k]; return 1; },
  lpush: async (k, v) => { list.unshift(v); return list.length; },
  lrange: async (k, a, b) => list.slice(a, b === -1 ? undefined : b + 1),
  lrem: async (k, count, v) => { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); return 1; },
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
const { router, queueBrowserEvent } = require(path.join(__dirname, '..', 'browserEvents.js'));

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l); } };

// Calls the real route handler directly with a fake request/response.
function callGet(key) {
  return new Promise((resolve) => {
    const layer = router.stack.find(l => l.route && l.route.path === '/events' && l.route.methods.get);
    const handler = layer.route.stack[0].handle;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ query: { key }, params: {} }, res, (err) => resolve({ status: 500, body: err }));
  });
}

(async () => {
  // ===== 1. The basics still work =====
  await queueBrowserEvent('opened', { ticker: 'SPY', dir: 'Long', timestamp: 1756742400000 });
  let r = await callGet('testkey');
  check('a queued moment comes back', r.body.events.length === 1 && r.body.events[0].ticker === 'SPY');
  check('it carries the trade\'s own time', r.body.events[0].timestamp === 1756742400000);

  r = await callGet('wrong');
  check('the wrong key is turned away', r.status === 403);

  // ===== 2. Expired records leave no litter behind =====
  await queueBrowserEvent('closed', { ticker: 'IWM', dir: 'Short', timestamp: 1756742500000 });
  check('two moments are on the list', list.length === 2);
  // Twenty minutes pass: the records expire, the ids do not.
  store = {};
  r = await callGet('testkey');
  check('nothing is offered once the records have expired', r.body.events.length === 0);
  check('and the dead ids are swept off the list', list.length === 0);

  // ===== 3. A mix of live and dead =====
  const live = await queueBrowserEvent('opened', { ticker: 'SPY', dir: 'Long', timestamp: 1 });
  const dead = await queueBrowserEvent('closed', { ticker: 'SPY', dir: 'Long', timestamp: 2 });
  delete store[`browserEvent:${dead.id}`];   // this one aged out; the other did not
  r = await callGet('testkey');
  check('the live one is still offered', r.body.events.length === 1 && r.body.events[0].id === live.id);
  check('and only the dead one is swept', list.length === 1 && list[0] === live.id);

  // ===== 4. Unreadable is no more use than absent =====
  store[`browserEvent:${live.id}`] = '{not json';
  r = await callGet('testkey');
  check('an unreadable record is not offered', r.body.events.length === 0);
  check('and it is swept too', list.length === 0);

  // ===== 5. The list cannot grow without limit =====
  for (let i = 0; i < 500; i++) {
    await queueBrowserEvent('opened', { ticker: 'SPY', dir: 'Long', timestamp: i });
  }
  check(`five hundred moments do not make a five-hundred-long list (${list.length})`, list.length <= 200);
  r = await callGet('testkey');
  check(`and a single check never reads more than the ceiling (${r.body.events.length})`,
    r.body.events.length <= 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
