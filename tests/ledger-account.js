// The auditor's condition for closing Blocker 2: which Schwab account the
// ledger is about is chosen by an explicit, deterministic rule, never
// "whichever Schwab lists first" (ledgerAccount.js).
//
// The case that matters most: the ledger already holds one account's records
// and Schwab starts listing a DIFFERENT account first. The old code would
// have copied the other account's history into his ledger without a word.
const Module = require('module');
process.env.APP_SECRET = 'right-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.R2_ACCOUNT_ID = 'acct'; process.env.R2_ACCESS_KEY_ID = 'id'; process.env.R2_SECRET_ACCESS_KEY = 'secret';
delete process.env.SCHWAB_LEDGER_ACCOUNT;

setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 120000).unref();
const tick = () => new Promise(r => setImmediate(r));

// ---- Pretend database: create-only SET NX, reads hand back copies ----------
const db = new Map();
const events = [];
let storageDown = false;   // the LEDGER's entries unreachable; the sign-in still reads
const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
class FakeRedis {
  constructor() {}
  async get(k) { await tick(); if (storageDown && k.startsWith('ledger:')) throw new Error('storage unreachable'); return db.has(k) ? JSON.parse(db.get(k)) : null; }
  async mget(...ks) { await tick(); return ks.map(k => (db.has(k) ? JSON.parse(db.get(k)) : null)); }
  async set(k, v, opt) {
    await tick();
    if (opt && opt.nx && db.has(k)) { events.push('refused ' + k); return null; }
    db.set(k, JSON.stringify(v)); events.push('set ' + k); return 'OK';
  }
  async lpush(k, v) { await tick(); const l = db.has(k) ? JSON.parse(db.get(k)) : []; l.unshift(v); db.set(k, JSON.stringify(l)); return l.length; }
  async lrange(k, a, b) { await tick(); const l = db.has(k) ? JSON.parse(db.get(k)) : []; return l.slice(a, b === -1 ? undefined : b + 1); }
  async scan(cursor, o) { await tick(); const re = globToRe(o.match || '*'); return ['0', [...db.keys()].filter(k => re.test(k))]; }
}
FakeRedis.fromEnv = () => new FakeRedis();

// ---- Pretend archive --------------------------------------------------------
const bucket = new Map();
class PutObjectCommand { constructor(input) { this.input = input; this.kind = 'put'; } }
class ListObjectsV2Command { constructor(input) { this.input = input; this.kind = 'list'; } }
class S3Client {
  async send(cmd) {
    await tick();
    if (cmd.kind === 'put') {
      if (cmd.input.IfNoneMatch === '*' && bucket.has(cmd.input.Key)) { const e = new Error('PreconditionFailed'); e.$metadata = { httpStatusCode: 412 }; throw e; }
      bucket.set(cmd.input.Key, String(cmd.input.Body)); return {};
    }
    return { Contents: [...bucket.keys()].filter(k => k.startsWith(cmd.input.Prefix)).map(Key => ({ Key })), IsTruncated: false };
  }
}

// ---- Pretend Schwab: the account list is whatever the case sets -----------
const A = { accountNumber: '11112222', hashValue: 'HASH-OF-ACCOUNT-A' };
const B = { accountNumber: '33334444', hashValue: 'HASH-OF-ACCOUNT-B' };
const A_REHASHED = { accountNumber: '11112222', hashValue: 'SCHWAB-CHANGED-ITS-REFERENCE' };
let accounts = [A];
let asked = [];            // which account each transactions request went to
const DAY = 86400000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const recFor = (hash) => [{ activityId: hash === A.hashValue ? 101 : 202, accountNumber: 'x', type: 'CASH_RECEIPT', status: 'VALID', tradeDate: '2026-09-20T13:31:00+0000', netAmount: 5, transferItems: [] }];
const http = {
  async get(url, cfg) {
    await tick();
    // The ledger asks for text (to keep Schwab's bytes); the inspection for parsed JSON.
    const answer = v => ({ data: cfg && cfg.responseType === 'text' ? JSON.stringify(v) : JSON.parse(JSON.stringify(v)) });
    if (url.endsWith('/accounts/accountNumbers')) return answer(accounts);
    const m = url.match(/\/accounts\/([^/]+)\/transactions$/);
    asked.push(m && m[1]);
    const s = Date.parse(cfg.params.startDate), e = Date.parse(cfg.params.endDate);
    const out = recFor(m[1]).filter(t => { const d = Date.parse(t.tradeDate); return d >= s && d <= e; });
    return answer(out);
  },
  async post() { throw new Error('nothing here may renew the sign-in'); },
};

const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') return { Redis: FakeRedis };
  if (req === '@aws-sdk/client-s3') return { S3Client, PutObjectCommand, ListObjectsV2Command };
  if (req === 'axios') return Object.assign(http, { create: () => http });
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 400)); } };

(async () => {
  const LA = require('../ledgerAccount');
  const L = require('../brokerLedger');
  const { inspectBrokerHistory } = require('../brokerInspect');
  const refA = LA.refOf(A.hashValue), refB = LA.refOf(B.hashValue);
  const choose = (list, o) => LA.chooseAccount(list, o);
  const noSecrets = s => !JSON.stringify(s).includes('11112222') && !JSON.stringify(s).includes('33334444') && !JSON.stringify(s).includes('HASH-OF');

  // ---- 1. The rule on its own ---------------------------------------------
  let c = choose([A]);
  check('one account, nothing else said: that account, and it says why', c.ok && c.ref === refA && /only account/.test(c.how), c);
  c = choose([B, A]);
  check('two accounts and nothing says which: REFUSED, not "the first one"', !c.ok && /returned 2 accounts/.test(c.reason) && c.reason.includes(refA) && c.reason.includes(refB), c);
  check('...and the refusal shows the last four digits, never the full number or Schwab\'s reference', /ending 2222/.test(c.reason) && noSecrets(c.reason), c.reason);
  check('...and the same two accounts in the other order give the identical answer', JSON.stringify(choose([A, B])) === JSON.stringify(c));
  check('no account at all: refused, and says so', !choose([]).ok && /no account/.test(choose([]).reason));
  check('a malformed answer (not a list) is "no account", not a crash', !choose({ oops: 1 }).ok);

  c = choose([B, A], { setting: refA });
  check('the setting by reference picks that account, whichever Schwab lists first', c.ok && c.ref === refA && /setting/.test(c.how), c);
  check('...in both orders', choose([A, B], { setting: refA }).ref === refA);
  c = choose([B, A], { setting: '2222' });
  check('the setting by the last four digits picks that account', c.ok && c.ref === refA, c);
  c = choose([A, { accountNumber: '99992222', hashValue: 'H3' }], { setting: '2222' });
  check('last four digits shared by two accounts: refused as not saying which', !c.ok && /matches 2/.test(c.reason), c);
  c = choose([B], { setting: refA });
  check('the setting names an account Schwab did not return: refused', !c.ok && /did not return/.test(c.reason), c);
  c = choose([A], { setting: 'my main one' });
  check('a setting in a form it does not accept: refused, never guessed at', !c.ok && /not in a form/.test(c.reason), c);

  c = choose([B, A], { tie: { ref: refA } });
  check('the ledger\'s tie picks its account when Schwab lists another first', c.ok && c.ref === refA && c.how === 'tied', c);
  c = choose([B], { tie: { ref: refA } });
  check('the tied account missing from Schwab\'s answer: refused, never switched', !c.ok && /tied to account/.test(c.reason) && /never an automatic switch/.test(c.reason), c);
  c = choose([A_REHASHED], { tie: { ref: refA, numberRef: LA.numberRefOf('11112222') } });
  check('same account number under a new Schwab reference: its OWN reason, not "a different account"', !c.ok && /changed how it refers/.test(c.reason), c);
  c = choose([A, B], { tie: { ref: refA }, setting: refB });
  check('a setting that disagrees with the tie: refused, a setting cannot move the ledger', !c.ok && /cannot move the ledger/.test(c.reason), c);
  c = choose([A, B], { tie: { ref: refA }, setting: refA });
  check('a setting that agrees with the tie: used, and says both agree', c.ok && c.ref === refA && /setting agrees/.test(c.how), c);

  // ---- 2. The import --------------------------------------------------------
  const run = () => L.importLedger({ http, now: NOW, noPause: true, years: 1 });
  db.set('schwab:tokens', JSON.stringify({ access_token: 'T', refresh_token: 'R', expires_at: Date.now() + 3600000 }));

  // The ledger already holds A's records, copied before this rule existed
  // (no account entry yet) -- exactly the position on 30 Sept.
  accounts = [A];
  let s = await run();
  check('first import on an empty ledger with one account: complete', s.status === 'complete' && s.records.inserted === 1, s);
  db.delete(LA.TIE_KEY);                     // as the ledger stood before this rule
  events.length = 0; asked = [];
  accounts = [B, A];                          // Schwab now lists ANOTHER account first
  s = await run();
  check('Schwab lists another account first: the import still copies HIS ledger\'s account', s.status === 'complete' && asked.length > 0 && asked.every(h => h === A.hashValue), { status: s.status, reason: s.reason, asked: [...new Set(asked)] });
  check('...because the records already in the ledger settle it (established evidence, R19)', s.account && s.account.ref === refA && /records already in the ledger/.test(s.account.basis), s.account);
  check('...and no record of the other account was written', !db.has(L.REC(202)));
  const tie = JSON.parse(db.get(LA.TIE_KEY) || 'null');
  check('...and the ledger is now tied to it, in an entry that records how', tie && tie.ref === refA && tie.importId === s.importId && /records already/.test(tie.basis), tie);
  check('...and the tie was written BEFORE anything was asked of Schwab\'s history', events.indexOf('set ' + LA.TIE_KEY) === 0, events.slice(0, 3));

  events.length = 0;
  s = await run();
  check('the next import leaves the tie exactly as it was (create-only, never rewritten)', JSON.stringify(JSON.parse(db.get(LA.TIE_KEY))) === JSON.stringify(tie) && events.includes('refused ' + LA.TIE_KEY) && !events.includes('set ' + LA.TIE_KEY), events.slice(0, 3));

  // The tied account disappears from Schwab's answer.
  accounts = [B];
  asked = []; events.length = 0;
  const recsBefore = [...db.keys()].filter(k => k.startsWith(L.PREFIX + 'rec:')).sort().join();
  s = await run();
  check('the tied account missing: the import fails and says why', s.status === 'failed' && /tied to account/.test(s.reason), s.reason);
  check('...having asked Schwab for NOTHING and written no record', asked.length === 0 && [...db.keys()].filter(k => k.startsWith(L.PREFIX + 'rec:')).sort().join() === recsBefore, asked);
  check('...and the reason carries no account number and no Schwab reference', noSecrets(s.reason), s.reason);

  // An empty ledger with two accounts and nothing to say which.
  for (const k of [...db.keys()]) if (k.startsWith(L.PREFIX)) db.delete(k);
  accounts = [A, B]; asked = [];
  s = await run();
  check('empty ledger, two accounts, no setting: refused before anything is fetched', s.status === 'failed' && /returned 2 accounts/.test(s.reason) && asked.length === 0, s.reason);
  check('...and no tie was written', !db.has(LA.TIE_KEY));

  process.env.SCHWAB_LEDGER_ACCOUNT = refB;
  s = await run();
  check('...the setting names one: that one is copied, and the tie records it came from the setting', s.status === 'complete' && asked.every(h => h === B.hashValue) && JSON.parse(db.get(LA.TIE_KEY)).how === 'named by the server setting', { status: s.status, reason: s.reason });
  delete process.env.SCHWAB_LEDGER_ACCOUNT;

  // Records naming two different accounts: a person has to look.
  for (const k of [...db.keys()]) if (k.startsWith(L.PREFIX)) db.delete(k);
  db.set(L.REC(1), JSON.stringify({ provenance: { accountRef: refA } }));
  db.set(L.REC(2), JSON.stringify({ provenance: { accountRef: refB } }));
  accounts = [A]; asked = [];
  s = await run();
  check('records already in the ledger name two accounts: refused, never picked between', s.status === 'failed' && /name 2 different accounts/.test(s.reason) && asked.length === 0, s.reason);
  db.set(L.REC(2), JSON.stringify({ provenance: {} }));
  s = await run();
  check('a record that does not say its account: refused, not assumed', s.status === 'failed' && /do not say which account/.test(s.reason), s.reason);

  // Storage unreachable while settling the account: its own reason.
  for (const k of [...db.keys()]) if (k.startsWith(L.PREFIX)) db.delete(k);
  storageDown = true;
  s = await run();
  storageDown = false;
  check('storage unreachable while settling the account: says THAT, not "Schwab failed"', s.status === 'failed' && /Could not read or record which account/.test(s.reason) && !/Fetching from Schwab/.test(s.reason), s.reason);

  // ---- 3. Status and verify report the account --------------------------------
  accounts = [A];
  s = await run();
  const st = await L.ledgerStatus();
  check('status shows which account the ledger is tied to', st.account && st.account.ref === refA, st.account);
  let v = await L.verifyLedger();
  check('verify checks every record belongs to the tied account', v.account === refA && v.accountMismatches.length === 0 && v.checked === 1, v);
  const e = JSON.parse(db.get(L.REC(101)));
  e.provenance.accountRef = refB;
  db.set(L.REC(101), JSON.stringify(e));
  v = await L.verifyLedger();
  check('...and names a record that does not', v.accountMismatches.length === 1 && v.accountMismatches[0] === L.REC(101), v.accountMismatches);

  // ---- 4. The inspection uses the same rule and writes nothing -----------------
  for (const k of [...db.keys()]) if (k.startsWith(L.PREFIX)) db.delete(k);
  db.set(L.REC(101), JSON.stringify({ provenance: { accountRef: refA } }));
  accounts = [B, A]; asked = []; events.length = 0;
  let r = await inspectBrokerHistory({ http, now: NOW, noPause: true, lookbackDays: 60 });
  check('the inspection, with another account listed first, looks at the ledger\'s account', r.ok && asked.length > 0 && asked.every(h => h === A.hashValue) && r.account.ref === refA, { ok: r.ok, reason: r.reason, asked: [...new Set(asked)] });
  check('...and writes nothing at all, not even the tie', events.length === 0 && !db.has(LA.TIE_KEY), events);
  accounts = [B]; asked = [];
  r = await inspectBrokerHistory({ http, now: NOW, noPause: true, lookbackDays: 60 });
  check('the inspection refuses the same way the import does', !r.ok && /tied to account/.test(r.reason) && asked.length === 0, r.reason);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL: crashed', e && e.stack); process.exit(1); });
