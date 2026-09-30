// BLOCKER 2: the immutable broker ledger. Covers the auditor's twelve
// required tests (M1-M12) and the safety conditions around them, against a
// pretend database (create-only SET NX emulated faithfully), a pretend
// archive (create-only puts, 412 when the name is taken) and a pretend
// Schwab that answers by the records' own dates.
const Module = require('module');
process.env.APP_SECRET = 'right-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.R2_ACCOUNT_ID = 'acct'; process.env.R2_ACCESS_KEY_ID = 'id'; process.env.R2_SECRET_ACCESS_KEY = 'secret';

setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 180000).unref();
const tick = () => new Promise(r => setImmediate(r));

// ---- Event log shared by the pretend database and archive -----------------
const events = [];

// ---- Pretend database (Upstash-like: stores JSON, hands back objects) -----
const db = new Map();
let failAfterSets = null, setsDone = 0;
const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
class FakeRedis {
  constructor() {}
  async get(k) { await tick(); return db.has(k) ? JSON.parse(db.get(k)) : null; }
  async mget(...ks) { await tick(); return ks.map(k => (db.has(k) ? JSON.parse(db.get(k)) : null)); }
  async set(k, v, opt) {
    await tick();
    if (failAfterSets != null && setsDone >= failAfterSets) throw new Error('storage hiccup');
    if (opt && opt.nx && db.has(k)) { events.push('redis-set-refused ' + k); return null; }
    setsDone++;
    db.set(k, JSON.stringify(v)); events.push('redis-set ' + k); return 'OK';
  }
  async lpush(k, v) { await tick(); const l = db.has(k) ? JSON.parse(db.get(k)) : []; l.unshift(v); db.set(k, JSON.stringify(l)); events.push('redis-lpush ' + k); return l.length; }
  async lrange(k, a, b) { await tick(); const l = db.has(k) ? JSON.parse(db.get(k)) : []; return l.slice(a, b === -1 ? undefined : b + 1); }
  async scan(cursor, o) {
    await tick();
    const re = globToRe(o.match || '*');
    return ['0', [...db.keys()].filter(k => re.test(k))];
  }
}
for (const m of ['del', 'hset', 'hdel', 'rpush', 'rpop', 'ltrim', 'incr', 'expire', 'sadd', 'hsetnx']) {
  FakeRedis.prototype[m] = async function (k) { events.push('redis-UNEXPECTED-' + m + ' ' + k); return 'OK'; };
}
FakeRedis.fromEnv = () => new FakeRedis();

// ---- Pretend archive -------------------------------------------------------
const bucket = new Map();
let archiveDown = false;
class PutObjectCommand { constructor(input) { this.input = input; this.kind = 'put'; } }
class ListObjectsV2Command { constructor(input) { this.input = input; this.kind = 'list'; } }
class S3Client {
  constructor() {}
  async send(cmd) {
    await tick();
    if (archiveDown) { const e = new Error('archive unreachable'); e.$metadata = { httpStatusCode: 503 }; throw e; }
    if (cmd.kind === 'put') {
      const { Key, Body, IfNoneMatch } = cmd.input;
      if (IfNoneMatch === '*' && bucket.has(Key)) { const e = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e; }
      bucket.set(Key, String(Body)); events.push('archive-put ' + Key); return {};
    }
    if (cmd.kind === 'list') {
      const keys = [...bucket.keys()].filter(k => k.startsWith(cmd.input.Prefix)).sort();
      const start = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
      const page = keys.slice(start, start + 1000);
      return { Contents: page.map(Key => ({ Key })), IsTruncated: start + 1000 < keys.length, NextContinuationToken: String(start + 1000) };
    }
  }
}

// ---- Pretend Schwab -------------------------------------------------------
const DAY = 86400000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const BOUNDARY = new Date(NOW - 30 * DAY).toISOString();
let posts = 0;
const sentBytes = [];   // every answer exactly as the pretend Schwab sent it
const opt = o => Object.assign({ instrument: { assetType: 'OPTION', symbol: 'SPY   260609C00740000', underlyingSymbol: 'SPY', putCall: 'CALL' } }, o);
const fee = (feeType, cost) => ({ instrument: { assetType: 'CURRENCY', symbol: 'CURRENCY_USD' }, feeType, cost, amount: 0 });
const rec = o => Object.assign({ accountNumber: '12345678', type: 'TRADE', status: 'VALID', tradeDate: '2026-09-09T13:31:00+0000', positionId: 9001, orderId: 5550001 }, o);
let data;
function resetData() {
  data = [
    rec({ activityId: 101, netAmount: -111.66, transferItems: [opt({ amount: 1, price: 1.11, cost: -111, positionEffect: 'OPENING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
    rec({ activityId: 102, positionId: 9001, netAmount: 121.34, tradeDate: '2026-09-09T13:36:00+0000', transferItems: [opt({ amount: -1, price: 1.22, cost: 122, positionEffect: 'CLOSING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
    rec({ activityId: 103, netAmount: -1001.00, transferItems: [{ instrument: { assetType: 'EQUITY', symbol: 'NIO' }, amount: 200, price: 5.0, cost: -1000 }, fee('COMMISSION', -1.00)] }),
    rec({ activityId: 104, type: 'DIVIDEND_OR_INTEREST', netAmount: 0.42, transferItems: [{ instrument: { assetType: 'CURRENCY' }, amount: 0.42 }] }),
    rec({ activityId: 105, type: 'WIRE_OUT', netAmount: -500, transferItems: [{ instrument: { assetType: 'CURRENCY' }, amount: -500 }] }),
    rec({ activityId: 106, type: 'JOURNAL', netAmount: 10, transferItems: [] }),
    rec({ activityId: 107, type: 'CASH_RECEIPT', netAmount: 250, transferItems: [] }),
    // no activityId, but an orderId: R1 says the orderId must NOT be used
    rec({ activityId: undefined, orderId: 777, netAmount: -55.66, transferItems: [opt({ amount: 1, price: 0.55, cost: -55, positionEffect: 'OPENING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
    // on the window boundary: returned by two windows, one record
    rec({ activityId: 108, tradeDate: BOUNDARY, netAmount: 55.34, transferItems: [opt({ amount: -1, price: 0.56, cost: 56, positionEffect: 'CLOSING' }), fee('COMMISSION', -0.65), fee('OPT_REG_FEE', -0.01)] }),
    rec({ activityId: 109, tradeDate: '2021-05-01T14:00:00+0000', type: 'DIVIDEND_OR_INTEREST', netAmount: 0.01, transferItems: [] }),
  ];
}
resetData();
const DISTINCT = 10;
const http = {
  async get(url, cfg) {
    await tick();
    if (url.endsWith('/accounts/accountNumbers')) return { data: JSON.stringify([{ accountNumber: '12345678', hashValue: 'HASHVALUE' }]) };
    const p = cfg.params;
    const s = Date.parse(p.startDate), e = Date.parse(p.endDate);
    const out = data.filter(t => { const d = Date.parse(t.tradeDate); return d >= s && d <= e; });
    // Schwab's own spacing, to prove the archive keeps the bytes as sent
    const text = JSON.stringify(out, null, 1);
    sentBytes.push(text);
    return { data: text };
  },
  async post() { posts++; return { data: {} }; },
};

const orig = Module._load;
Module._load = function (req) {
  if (req === '@upstash/redis') return { Redis: FakeRedis };
  if (req === '@aws-sdk/client-s3') return { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand: class {} };
  if (req === 'axios') return Object.assign(http, { create: () => http });
  return orig.apply(this, arguments);
};

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 400)); } };
const ledgerKeys = pre => [...db.keys()].filter(k => k.startsWith(pre)).sort();
const snapshot = pre => JSON.stringify(ledgerKeys(pre).map(k => [k, db.get(k)]));

(async () => {
  const L = require('../brokerLedger');
  const run = o => L.importLedger(Object.assign({ http, now: NOW, noPause: true, years: 10 }, o || {}));

  // The journal's own state, and his secrets: must never change.
  const JOURNAL_KEYS = {
    'trades:state': { openLegs: [{ occ: 'X' }], pending: [{ id: 'p1' }], lastProcessedIds: ['a', 'b'] },
    'stopRule:settings': { rule: 'mine' },
    'schwab:tokens': { access_token: 'TOKEN', refresh_token: 'R', expires_at: Date.now() + 3600000 },
    'alpaca:keys': { keyId: 'K' },
  };
  for (const [k, v] of Object.entries(JOURNAL_KEYS)) db.set(k, JSON.stringify(v));
  const journalBefore = JSON.stringify(Object.keys(JOURNAL_KEYS).map(k => db.get(k)));

  // ---- Safety before anything: archive missing / pass expired -------------
  const saved = process.env.R2_ACCOUNT_ID; delete process.env.R2_ACCOUNT_ID;
  let s = await run();
  process.env.R2_ACCOUNT_ID = saved;
  check('with no archive set up it refuses, writing nothing to the ledger', s.status === 'failed' && /not set up/.test(s.reason) && ledgerKeys(L.PREFIX + 'rec:').length === 0, s);
  db.set('schwab:tokens', JSON.stringify(Object.assign({}, JOURNAL_KEYS['schwab:tokens'], { expires_at: Date.now() - 1000 })));
  s = await run();
  check('with the Schwab pass expired it refuses, writing nothing and renewing nothing', s.status === 'failed' && /does not renew/.test(s.reason) && ledgerKeys(L.PREFIX + 'rec:').length === 0 && posts === 0, s);
  db.set('schwab:tokens', JSON.stringify(JOURNAL_KEYS['schwab:tokens']));
  archiveDown = true;
  s = await run();
  archiveDown = false;
  check('if the archive refuses Schwab\'s answer, NOTHING is written to the ledger', s.status === 'failed' && /archive refused/.test(s.reason) && ledgerKeys(L.PREFIX + 'rec:').length === 0, s);

  // ---- M1: a new record is inserted ---------------------------------------
  events.length = 0;
  s = await run();
  check('M1 every new record is inserted', s.status === 'complete' && s.records.inserted === DISTINCT && ledgerKeys(L.PREFIX + 'rec:').length === DISTINCT, s.records);
  check('M1 ...the boundary record fetched twice is ONE record', s.records.fetched === DISTINCT + 1 && s.records.distinctInThisImport === DISTINCT, s.records);
  check('M1 ...a record with no activityId gets an uncertain composite identity, never its orderId',
    s.records.uncertainIdentity === 1 && ledgerKeys(L.PREFIX + 'rec:U-').length === 1 && !db.has(L.REC('777')), ledgerKeys(L.PREFIX + 'rec:'));
  const u = JSON.parse(db.get(ledgerKeys(L.PREFIX + 'rec:U-')[0]));
  check('M1 ...and it is marked uncertain', u.identity.uncertain === true && u.identity.kind === 'composite', u.identity);

  // ---- M4: raw preserved, M5 fees, M6 positionId, M7 all kinds -------------
  const e101 = JSON.parse(db.get(L.REC('101')));
  const orig101 = data.find(t => t.activityId === 101);
  check('M4 the raw Schwab record is kept exactly (every field, every value)', JSON.stringify(e101.raw) === JSON.stringify(orig101), e101.raw);
  check('M4 ...and it still produces its own fingerprint', L.canonical && require('../brokerInspect').fingerprint(e101.raw) === e101.fingerprint);
  check('M5 the original fee lines are kept in the raw record', e101.raw.transferItems.filter(t => t.feeType).length === 2);
  const f = e101.normalized.fees;
  check('M5 normalized fee = Schwab\'s itemised lines; cash check and difference kept beside it',
    f.normalizedFee === 0.66 && f.cashDerivedFee === 0.66 && f.difference === 0 && f.netAmount === -111.66 && f.lines.length === 2 && /never 0/.test(f.provenance), f);
  const e103 = JSON.parse(db.get(L.REC('103')));
  check('M5 a stock trade\'s cash check uses x1, not x100', e103.normalized.fees.cashDerivedFee === 1 && e103.normalized.fees.normalizedFee === 1, e103.normalized.fees);
  const e106 = JSON.parse(db.get(L.REC('106')));
  check('M5 a record with no fee lines has fee UNKNOWN (null), never 0', e106.normalized.fees.normalizedFee === null && e106.normalized.fees.cashDerivedFee === null, e106.normalized.fees);
  check('M6 positionId is preserved exactly as Schwab sent it', e101.raw.positionId === 9001 && JSON.parse(db.get(L.REC('102'))).raw.positionId === 9001);
  const kinds = new Set(ledgerKeys(L.PREFIX + 'rec:').map(k => JSON.parse(db.get(k)).raw.type));
  check('M7 every kind is stored: trades, stock, dividends/interest, wires, journal, cash',
    ['TRADE', 'DIVIDEND_OR_INTEREST', 'WIRE_OUT', 'JOURNAL', 'CASH_RECEIPT'].every(k => kinds.has(k)), [...kinds]);
  check('provenance: first-seen time, import, source, window, account reference, archive keys',
    e101.provenance.firstSeenAt && e101.provenance.importId === s.importId && /transactions/.test(e101.provenance.source) && e101.provenance.window && /^acct-[0-9a-f]{16}$/.test(e101.provenance.accountRef) && e101.provenance.archiveRecordKey && e101.provenance.archiveResponseKey, e101.provenance);
  check('provenance never holds the account hash itself', !JSON.stringify(e101.provenance).includes('HASHVALUE'));

  // ---- M11: the archive, and that archiving did not touch the ledger -------
  const firstArchiveRecord = events.findIndex(ev => ev.startsWith('archive-put broker-ledger-archive/v1/records/'));
  const ledgerWritesAfterArchiveStarted = events.slice(firstArchiveRecord).filter(ev => ev.startsWith('redis-set'));
  check('M11 once archiving starts, not one ledger entry is written or changed', firstArchiveRecord > 0 && ledgerWritesAfterArchiveStarted.length === 0, ledgerWritesAfterArchiveStarted);
  const archivedRecords = [...bucket.keys()].filter(k => k.includes('/records/'));
  check('M11 the archive holds one file per ledger record', archivedRecords.length === DISTINCT, archivedRecords.length);
  const a101 = JSON.parse(bucket.get(e101.provenance.archiveRecordKey));
  check('M11 ...holding the same raw record and fingerprint', JSON.stringify(a101.raw) === JSON.stringify(e101.raw) && a101.fingerprint === e101.fingerprint);
  const resp = bucket.get(e101.provenance.archiveResponseKey);
  check('M11 ...and Schwab\'s answer byte for byte, spacing and all', typeof resp === 'string' && sentBytes.includes(resp) && resp.includes('\n') && JSON.parse(resp).some(t => t.activityId === 101), resp && resp.slice(0, 60));
  check('M11 ...and a manifest of the import', bucket.has(s.archive.manifestKey), s.archive);
  const v = await L.verifyLedger();
  check('verify: every entry\'s raw record still produces its fingerprint, and each is archived',
    v.checked === DISTINCT && v.fingerprintMatches === DISTINCT && !v.fingerprintMismatches.length && !v.identityMismatches.length && !v.missingFromArchive.length, v);

  // ---- M2 + M12: re-running changes nothing that should not change --------
  const ledgerBefore = snapshot(L.PREFIX + 'rec:');
  const archiveRecordsBefore = JSON.stringify(archivedRecords.map(k => [k, bucket.get(k)]));
  s = await run();
  check('M2 an identical duplicate is not a second record', s.records.inserted === 0 && s.records.identical === DISTINCT && ledgerKeys(L.PREFIX + 'rec:').length === DISTINCT, s.records);
  check('M12 re-running leaves every ledger entry byte-identical', snapshot(L.PREFIX + 'rec:') === ledgerBefore);
  check('M12 ...creates no revision', ledgerKeys(L.PREFIX + 'rev:').length === 0);
  const archivedNow = [...bucket.keys()].filter(k => k.includes('/records/'));
  check('M12 ...and no new or changed archive record file', JSON.stringify(archivedNow.map(k => [k, bucket.get(k)])) === archiveRecordsBefore && s.archive.recordsAlreadyPresent === DISTINCT);
  check('M12 ...the only additions are this import\'s own log entry and evidence files', JSON.parse(db.get(L.IMPORTS)).length >= 2 && bucket.has(s.archive.manifestKey));

  // ---- M3: same activityId, changed content -> a revision, never an overwrite
  data.find(t => t.activityId === 102).netAmount = 121.00;
  s = await run();
  const e102 = JSON.parse(db.get(L.REC('102')));
  const revs = ledgerKeys(L.PREFIX + 'rev:102:');
  check('M3 changed content creates a revision', s.records.revisions === 1 && revs.length === 1, s.records);
  check('M3 ...the original is untouched', e102.raw.netAmount === 121.34, e102.raw.netAmount);
  const rv = JSON.parse(db.get(revs[0]));
  check('M3 ...the revision keeps the new version and points at the original', rv.raw.netAmount === 121 && rv.revisionOf.originalFingerprint === e102.fingerprint && rv.provenance.firstSeenAt, rv.revisionOf);
  s = await run();
  check('M3 ...seeing the same revision again adds nothing', s.records.revisionsAlreadyKnown === 1 && ledgerKeys(L.PREFIX + 'rev:').length === 1, s.records);
  resetData();

  // ---- M8: two imports at the same moment -----------------------------------
  for (const k of ledgerKeys(L.PREFIX)) db.delete(k);
  bucket.clear();
  const [x, y] = await Promise.all([run(), run()]);
  check('M8 two simultaneous imports: every record exists exactly once', ledgerKeys(L.PREFIX + 'rec:').length === DISTINCT, ledgerKeys(L.PREFIX + 'rec:').length);
  check('M8 ...between them each record was created once (the database decided, not memory)', x.records.inserted + y.records.inserted === DISTINCT && x.records.revisions + y.records.revisions === 0, [x.records, y.records]);
  check('M8 ...and the archive holds one file per record', [...bucket.keys()].filter(k => k.includes('/records/')).length === DISTINCT);

  // ---- M9: a failure part-way leaves only whole records ---------------------
  for (const k of ledgerKeys(L.PREFIX)) db.delete(k);
  bucket.clear();
  failAfterSets = setsDone + 4;
  s = await run();
  failAfterSets = null;
  const partial = ledgerKeys(L.PREFIX + 'rec:');
  check('M9 a storage failure part-way stops the import and says so', s.status === 'failed' && /stopped after 4 of 10/.test(s.reason) && /carries on safely/.test(s.reason), s.reason);
  check('M9 ...every entry left behind is whole and verifiable', partial.length === 4 && partial.every(k => { const e = JSON.parse(db.get(k)); return e.raw && require('../brokerInspect').fingerprint(e.raw) === e.fingerprint; }), partial);
  s = await run();
  check('M9 ...and the next import completes it without duplicating anything', s.status === 'complete' && s.records.inserted === 6 && s.records.identical === 4 && ledgerKeys(L.PREFIX + 'rec:').length === DISTINCT, s.records);

  // ---- M10: the journal was never touched -------------------------------
  const journalAfter = JSON.stringify(Object.keys(JOURNAL_KEYS).map(k => db.get(k)));
  check('M10 the journal\'s state, his settings and his sign-in are byte-identical', journalAfter === journalBefore);
  const foreignWrites = events.filter(ev => /^redis-(set|lpush|UNEXPECTED)/.test(ev) && !ev.includes(' ' + L.PREFIX));
  check('M10 ...and nothing was ever written outside the ledger\'s own keys', foreignWrites.length === 0, foreignWrites);
  const nonArchiveFiles = [...bucket.keys()].filter(k => !k.startsWith('broker-ledger-archive/v1/'));
  check('the archive writes only inside its own folder', nonArchiveFiles.length === 0, nonArchiveFiles);
  check('no Schwab sign-in renewal happened at any point', posts === 0, posts);

  // ---- Status reads only --------------------------------------------------
  const before = snapshot('');
  const st = await L.ledgerStatus();
  check('status reports the counts', st.ledgerRecords === DISTINCT && st.archiveRecordFiles === DISTINCT && st.recentImports.length > 0, st);
  check('status and verify write nothing', snapshot('') === before);

  // ---- Through the routes, behind the key --------------------------------
  const { buildApp } = require('../server');
  const app = buildApp();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const a = await fetch(base + '/api/ledger/import', { method: 'POST' });
  const b = await fetch(base + '/api/ledger/status');
  const c = await fetch(base + '/api/ledger/verify');
  check('the ledger routes refuse a caller without the key', a.status === 403 && b.status === 403 && c.status === 403, [a.status, b.status, c.status]);
  const st2 = await (await fetch(base + '/api/ledger/status', { headers: { Authorization: 'Bearer right-key' } })).json();
  check('with the key, status answers', st2.readOnly === true && st2.ledgerRecords === DISTINCT, st2);
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
