// Every private route refuses a caller without the app key -- checked by
// asking the REAL server for its own list of routes, not a hand-written one,
// so a route added later cannot slip past this check by being forgotten.
//
// Phase 1 of the repair (30 September 2026). Before it, eighteen routes --
// including the one that wipes the server's trade list -- answered anyone.
//
// Also checked here, because they are the rest of Phase 1:
//   - the key is accepted in a header and (for now) in the address, and the
//     address use is recorded without recording the key
//   - a server with no APP_SECRET refuses everything instead of letting
//     everything through
//   - which web pages may read the answers (never "*")
//   - /health says only "up" to a stranger
//   - the Schwab sign-in carries a one-time check value
//   - two changes to the sign-in record at once do not lose either one
//   - two renewals at once become one
//   - the backup copy never contains his sign-in or his Alpaca keys
const Module = require('module');
process.env.APP_SECRET = 'right-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.SCHWAB_CLIENT_ID = 'client';
process.env.SCHWAB_REDIRECT_URI = 'https://example.invalid/cb';
delete process.env.FRONTEND_ORIGIN;

// One shared pretend database, so every file sees the same entries.
const db = new Map(); // key -> { type, value }
let slowWrites = 0;   // ms each set() waits, to open the race window
const sleep = ms => new Promise(r => setTimeout(r, ms));
class FakeRedis {
  constructor() {}
  // A fresh copy each time, as the real database gives -- handing back the
  // same object would let two changes "share" one and hide the race below.
  async get(k) { const e = db.get(k); return e && e.type === 'string' ? structuredClone(e.value) : null; }
  async set(k, v) { if (slowWrites) await sleep(slowWrites); db.set(k, { type: 'string', value: structuredClone(v) }); return 'OK'; }
  async del(k) { return db.delete(k) ? 1 : 0; }
  async type(k) { return db.has(k) ? db.get(k).type : 'none'; }
  async lpush(k, v) { const e = db.get(k) || { type: 'list', value: [] }; e.value.unshift(v); db.set(k, e); }
  async rpop(k) { const e = db.get(k); return e && e.value.length ? e.value.pop() : null; }
  async lrange(k) { const e = db.get(k); return e ? e.value.slice() : []; }
  async ltrim() {}
  async llen(k) { const e = db.get(k); return e ? e.value.length : 0; }
  async hset(k, obj) { const e = db.get(k) || { type: 'hash', value: {} }; Object.assign(e.value, obj); db.set(k, e); }
  async hgetall(k) { const e = db.get(k); return e ? { ...e.value } : null; }
  async hget(k, f) { const e = db.get(k); return e ? e.value[f] ?? null : null; }
  async smembers(k) { const e = db.get(k); return e ? [...e.value] : []; }
  async zrange() { return []; }
  async expire() { return 1; }
  async incr(k) { const e = db.get(k) || { type: 'string', value: 0 }; e.value = Number(e.value) + 1; db.set(k, e); return e.value; }
  // Hands keys back in pages, as the real one does.
  async scan(cursor) {
    const keys = [...db.keys()].sort();
    const start = Number(cursor);
    const page = keys.slice(start, start + 3);
    const next = start + 3 >= keys.length ? 0 : start + 3;
    return [String(next), page];
  }
}
const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') return { Redis: Object.assign(FakeRedis, { fromEnv: () => new FakeRedis() }) };
  return orig.apply(this, arguments);
};

// The server's crash guard keeps a failed step from ending the process; a
// check that stalls must still fail rather than hang.
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 120000).unref();

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, detail !== undefined ? '-> ' + JSON.stringify(detail) : ''); }
};

// ---- Collect every route the real server has ------------------------------
function routesOf(app) {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
      } else if (layer.name === 'router' && layer.handle.stack) {
        // Express keeps the mount path only as a pattern; recover it.
        const src = layer.regexp.source;
        const m = /^\^\\(\/[^?\\]*(?:\\\/[^?\\]*)*)/.exec(src);
        const mount = m ? m[1].replace(/\\\//g, '/').replace(/\/$/, '') : '';
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk(app._router.stack, '');
  return out;
}

// Routes a stranger is meant to reach, and why.
const PUBLIC = {
  'GET /health': 'says only "up" to a stranger (checked below)',
  'GET /auth/schwab/callback': 'Schwab sends the browser here; protected by the one-time check value instead',
};

(async () => {
  const { buildApp, originAllowed } = require('../server');
  const app = buildApp();
  const routes = routesOf(app);
  check('found all of the server\'s routes (46 on 30 Sept 2026)', routes.length >= 46, routes.length);

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (method, path, { headers = {}, body } = {}) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const fill = p => p.replace(/:[A-Za-z_]+/g, 'x');

  // ---- 1. No key, wrong key: every private route refuses ----------------
  const openNoKey = [], openWrongKey = [];
  for (const r of routes) {
    const name = `${r.method} ${r.path}`;
    if (PUBLIC[name]) continue;
    const a = await call(r.method, fill(r.path), { body: {} });
    if (a.status !== 403) openNoKey.push(`${name} -> ${a.status}`);
    const b = await call(r.method, fill(r.path), { headers: { Authorization: 'Bearer wrong-key' }, body: {} });
    if (b.status !== 403) openWrongKey.push(`${name} -> ${b.status}`);
    const c = await call(r.method, fill(r.path) + '?key=wrong-key', { body: {} });
    if (c.status !== 403) openWrongKey.push(`${name} (address) -> ${c.status}`);
  }
  check('every private route refuses a caller with NO key', openNoKey.length === 0, openNoKey);
  check('every private route refuses a WRONG key (header and address)', openWrongKey.length === 0, openWrongKey);
  check('the reset route is among those checked', routes.some(r => r.path === '/api/trades/reset'));

  // A right key in the address does not rescue a wrong one in the header.
  const mixed = await call('GET', '/api/trades/pending?key=right-key', { headers: { Authorization: 'Bearer wrong-key' } });
  check('a wrong header key is not rescued by a right address key', mixed.status === 403, mixed.status);

  // ---- 2. The right key gets in, both ways -------------------------------
  const viaHeader = await call('GET', '/api/trades/pending', { headers: { Authorization: 'Bearer right-key' } });
  check('right key in the header is accepted', viaHeader.status === 200, viaHeader.status);
  const viaAddress = await call('GET', '/api/trades/pending?key=right-key', { headers: { 'User-Agent': 'Shortcuts/1 CFNetwork' } });
  check('right key in the address is still accepted (temporary, decision D)', viaAddress.status === 200, viaAddress.status);
  await sleep(20);
  const used = db.get('auth:queryKeyUse');
  check('address use was recorded, by kind of caller', used && used.value['iPhone Shortcut'], used && used.value);
  check('the record never contains the key', !JSON.stringify(used ? used.value : {}).includes('right-key'));
  const mediaHeader = await call('GET', '/media/pending', { headers: { Authorization: 'Bearer right-key' } });
  check('pictures route accepts the header key too', mediaHeader.status !== 403, mediaHeader.status);

  // ---- 3. /health --------------------------------------------------------
  const hs = await (await call('GET', '/health')).json();
  check('/health to a stranger says only up and the time', JSON.stringify(Object.keys(hs).sort()) === '["ok","time"]', hs);
  const hk = await (await call('GET', '/health', { headers: { Authorization: 'Bearer right-key' } })).json();
  check('/health with the key gives the full picture', 'uptimeSeconds' in hk && 'recentFailures' in hk && 'keyInAddress' in hk, Object.keys(hk));
  check('/health reports who still uses the address key', hk.keyInAddress && hk.keyInAddress['iPhone Shortcut'], hk.keyInAddress);

  // ---- 4. Which pages may read answers -----------------------------------
  const acao = async origin => (await call('GET', '/health', { headers: { Origin: origin } })).headers.get('access-control-allow-origin');
  check('the app\'s own page may read answers', await acao('https://alynnyree.github.io') === 'https://alynnyree.github.io');
  check('his Chrome add-on may read answers', await acao('chrome-extension://abcdefghijklmnopabcdefghijklmnop') === 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  const stranger = await acao('https://example.com');
  check('an unrelated website may NOT read answers', stranger === null, stranger);
  check('never "*"', stranger !== '*' && (await acao('https://alynnyree.github.io')) !== '*');
  process.env.FRONTEND_ORIGIN = '*';
  check('"*" in the settings is ignored', originAllowed('https://example.com') === false);
  process.env.FRONTEND_ORIGIN = 'http://localhost:8080/';
  check('an extra page can be allowed in settings', originAllowed('http://localhost:8080') === true);
  delete process.env.FRONTEND_ORIGIN;
  check('a request with no page (Shortcut, script) is unaffected', originAllowed(undefined) === true);

  // ---- 5. Schwab sign-in check value -------------------------------------
  const login = await call('GET', '/auth/schwab/login?key=right-key');
  const where = login.headers.get('location') || '';
  const state = new URL(where).searchParams.get('state');
  check('sign-in sends Schwab a check value', login.status === 302 && !!state && state.length >= 32, where);
  check('the check value is remembered', db.has('oauth:state:' + state));
  const noLoginKey = await call('GET', '/auth/schwab/login');
  check('sign-in cannot be started without the key', noLoginKey.status === 403, noLoginKey.status);
  const noState = await call('GET', '/auth/schwab/callback?code=abc');
  check('a sign-in coming back WITHOUT a check value is refused', noState.status === 400, noState.status);
  const badState = await call('GET', '/auth/schwab/callback?code=abc&state=madeup');
  const badText = await badState.text();
  check('a sign-in with an unknown check value is refused, in plain words', badState.status === 400 && /Reconnect to Schwab/.test(badText), badText);
  // The real one is accepted once: it reaches the token exchange (which has
  // no Schwab to talk to here, so it fails there -- past the check).
  const axiosForCb = require('axios');
  const postBefore = axiosForCb.post;
  axiosForCb.post = async () => { throw new Error('no Schwab in this test'); };
  const good = await call('GET', '/auth/schwab/callback?code=abc&state=' + state);
  axiosForCb.post = postBefore;
  const goodText = await good.text();
  check('the real check value gets past the check', !/check value|has expired|not started from your journal/.test(goodText), goodText.slice(0, 120));
  check('...and is used up', !db.has('oauth:state:' + state));
  const again = await call('GET', '/auth/schwab/callback?code=abc&state=' + state);
  check('the same check value cannot be used twice', again.status === 400, again.status);
  const statusNoKey = await call('GET', '/auth/status');
  check('sign-in status needs the key', statusNoKey.status === 403, statusNoKey.status);

  // ---- 6. Two changes to the sign-in record at once ----------------------
  const tokenStore = require('../tokenStore');
  db.set('schwab:tokens', { type: 'string', value: { access_token: 'old', refresh_token: 'r0', expires_at: 0 } });
  slowWrites = 30;
  await Promise.all([
    tokenStore.saveTokens({ access_token: 'NEW', refresh_token: 'r1', expires_in: 1800 }),
    tokenStore.setLastCheck('2026-09-30T12:00:00Z'),
    tokenStore.saveTokenFields({ last_refresh_ok: true }),
  ]);
  slowWrites = 0;
  const rec = db.get('schwab:tokens').value;
  check('a renewal saved alongside other changes is not lost', rec.access_token === 'NEW' && rec.refresh_token === 'r1', rec);
  check('...and neither are the other two changes', rec.last_transaction_check === '2026-09-30T12:00:00Z' && rec.last_refresh_ok === true, rec);
  // A failing change must not jam the queue for the ones after it.
  const realGet = FakeRedis.prototype.get;
  FakeRedis.prototype.get = async () => { throw new Error('db hiccup'); };
  const failed = await tokenStore.setLastCheck('x').then(() => 'ok', e => e.message);
  FakeRedis.prototype.get = realGet;
  check('a failed change reports its failure', failed === 'db hiccup', failed);
  await tokenStore.setLastCheck('after');
  check('...and the next change still goes through', db.get('schwab:tokens').value.last_transaction_check === 'after');

  // ---- 7. Two renewals at once become one --------------------------------
  const axios = require('axios');
  let exchanges = 0;
  const realPost = axios.post;
  axios.post = async () => { exchanges++; await sleep(40); return { data: { access_token: 'R' + exchanges, refresh_token: 'rr', expires_in: 1800 } }; };
  db.set('schwab:tokens', { type: 'string', value: { access_token: 'stale', refresh_token: 'r1', expires_at: 1 } });
  const { getValidAccessToken } = require('../auth');
  const got = await Promise.all([getValidAccessToken(), getValidAccessToken(), getValidAccessToken()]);
  axios.post = realPost;
  check('three callers finding the sign-in expired renew it ONCE', exchanges === 1, exchanges);
  check('...and all three get the same new sign-in', got.every(t => t === 'R1'), got);

  // ---- 8. Backup copy ----------------------------------------------------
  db.set('trades:state', { type: 'string', value: { openLegs: [1, 2], lastProcessedIds: ['a'] } });
  db.set('stopRule:settings', { type: 'string', value: { rule: 'x' } });
  db.set('schwab:tokens', { type: 'string', value: { access_token: 'SECRET-A', refresh_token: 'SECRET-R' } });
  db.set('alpaca:keys', { type: 'string', value: { keyId: 'SECRET-K', secret: 'SECRET-S' } });
  db.set('some:newApiKey', { type: 'string', value: 'SECRET-N' });
  db.set('oauth:state:abc', { type: 'string', value: '1' });
  db.set('ai:classifyQueue', { type: 'list', value: ['q1'] });
  const noKeyBackup = await call('GET', '/api/backup/export');
  check('backup cannot be taken without the key', noKeyBackup.status === 403, noKeyBackup.status);
  const bk = await call('GET', '/api/backup/export', { headers: { Authorization: 'Bearer right-key' } });
  const bkText = await bk.text();
  const copy = JSON.parse(bkText);
  check('backup answers with the key', bk.status === 200, bk.status);
  check('backup is offered as a file to save', /attachment; filename="server-backup-/.test(bk.headers.get('content-disposition') || ''));
  check('backup holds the trade state', copy.keys['trades:state'] && copy.keys['trades:state'].value.lastProcessedIds[0] === 'a');
  check('backup holds lists too', copy.keys['ai:classifyQueue'] && copy.keys['ai:classifyQueue'].value[0] === 'q1');
  check('backup NEVER contains any secret value', !/SECRET-/.test(bkText), bkText.match(/SECRET-\w/g));
  const excl = copy.excluded.map(e => e.key).sort();
  check('backup names what it left out', ['alpaca:keys', 'oauth:state:abc', 'schwab:tokens', 'some:newApiKey'].every(k => excl.includes(k)), excl);
  check('backup walked every page of keys', copy.totals.copied + copy.totals.excluded + copy.totals.notCopied === db.size, copy.totals);
  check('backup wrote nothing', db.get('trades:state').value.openLegs.length === 2 && db.has('oauth:state:abc'));

  // ---- 9. No APP_SECRET: everything refuses, with its own answer ---------
  delete process.env.APP_SECRET;
  const ns = await call('GET', '/api/trades/pending');
  const nsBody = await ns.json().catch(() => null);
  check('with no APP_SECRET a private route refuses (503, not open)', ns.status === 503 && /APP_SECRET/.test(nsBody && nsBody.error), [ns.status, nsBody]);
  const nsReset = await call('POST', '/api/trades/reset');
  check('...including the reset route', nsReset.status === 503, nsReset.status);
  const nsHealth = await (await call('GET', '/health')).json();
  check('...and /health says only "up"', Object.keys(nsHealth).length === 2, nsHealth);
  process.env.APP_SECRET = 'right-key';

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
