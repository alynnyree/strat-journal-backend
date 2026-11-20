// STEP 1B: HIS POP-UP ANSWERS, KEPT APART FROM THE TRADE QUEUE.
//
// Authorised 15 Nov 2026 ("I authorize Step 1 implementation"; plan v4,
// review closed "B1 yes, B2 yes, B3 yes").
//
// When he buys, a PURCHASE RECORD is made for the opening fill, and his
// phone and laptop get a pop-up asking the play and the timeframe he
// entered on. His answer is stored under that fill id. The trade queue
// (kept by tradeStore.js) is never written here: collecting a trade, or deleting a
// queued one, never touches a purchase record or an answer, and no code that
// collects or deletes a queued trade ever touches this. The journal joins
// his answer to the trade later by the trade's opening fill id.
//
// The order, inside the five-minute sync (cron.js):
//   P0 before the save that makes the purchase collectible: the record is
//      created (SET NX), from the trial match's newly opened legs;
//   P1 after that save: the record is confirmed, then
//   P2 one pop-up per device (claimed with SET NX, up to 3 tries; a device
//      the push service says is gone is removed);
//   P3 every tick: a purchase still open or queued with no record, or with
//      an unconfirmed one, is created/confirmed then (read-only on the queue);
//   P7 an answer asked on the trade card creates its record if none exists.
//
// An answer is saved by ONE atomic script, so two devices answering at once
// can never both win (B24): ACCEPTED, ALREADY (the same answer again: a
// retry after a lost reply), REUSED (that answer id with other contents),
// REFUSED (another answer is current; it is handed back), UNKNOWN (no such
// purchase).
const express = require('express');
const { wrap } = require('./asyncRoute');
const { requireAppKey } = require('./appKey');
const { validFillId } = require('./matcher');
const { TIMEFRAME_KEYS } = require('./setupBars');

const PLAY_CHOICES = ['Broadening Formation Scalp', 'FTFC Direction Play', '2s Turning Into 3s', 'None of these'];
const BF = 'Broadening Formation Scalp';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const RECENT = 'purchases:recent';
const SUBS = 'push:subs';
const K = f => ({
  record: `purchase:${f}`, current: `purchase:${f}:current`, history: `purchase:${f}:history`,
  sigs: `purchase:${f}:sigs`, entries: `purchase:${f}:entries`, skipped: `purchase:${f}:skipped`,
  push: d => `purchase:${f}:push:${d}`,
});

// ---- the store and the sender (swappable for the checks) ----------------
let store = null;
function redis() {
  if (store) return store;
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  const { Redis } = require('@upstash/redis');
  // Strings in, strings out: the answer script compares exact text.
  store = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, automaticDeserialization: false });
  return store;
}
function useStore(r) { store = r; }
let sender = null;
function useSender(fn) { sender = fn; }
function vapid() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  return { pub, priv, subject: process.env.VAPID_SUBJECT || 'mailto:owner@example.invalid' };
}
function defaultSender() {
  const v = vapid();
  if (!v) return null;
  const webpush = require('web-push');
  return (subscription, payload) => webpush.sendNotification(subscription, payload,
    { TTL: 3600, vapidDetails: { subject: v.subject, publicKey: v.pub, privateKey: v.priv } });
}

// What happened, for the Details line -- never on his screen.
const counts = { created: 0, confirmed: 0, noFillId: 0, failed: 0, pushSent: 0, pushFailed: 0, pushGone: 0, pushNotSetUp: 0 };
const problems = [];
function note(reason) { problems.unshift({ at: new Date().toISOString(), reason }); problems.length = Math.min(problems.length, 5); }
function stats() { return { ...counts, notificationsSetUp: !!vapid(), recentProblems: problems.slice() }; }

const parse = v => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return null; } };
const asObject = h => {
  if (!h) return {};
  if (Array.isArray(h)) { const o = {}; for (let i = 0; i + 1 < h.length; i += 2) o[h[i]] = h[i + 1]; return o; }
  return h;
};

// ---- records ------------------------------------------------------------
function recordFromLeg(leg, source) {
  return { fillId: String(leg.openFillId), occ: leg.occ || null, ticker: leg.ticker || null, dir: leg.dir || null,
           openTimestamp: Number.isFinite(Number(leg.openTimestamp)) ? Number(leg.openTimestamp) : null,
           createdAt: new Date().toISOString(), confirmedAt: null, source };
}

// P0. Never overwrites: SET NX. -> { created, reason }
async function createPurchase(leg, { source = 'sync', confirmed = false } = {}) {
  const f = validFillId(leg && leg.openFillId);
  if (!f) { counts.noFillId++; note('a purchase arrived with no usable fill id, so it gets no record and no pop-up'); return { created: false, reason: 'no fill id' }; }
  const r = redis();
  if (!r) return { created: false, reason: 'no store' };
  const rec = recordFromLeg({ ...leg, openFillId: f }, source);
  if (confirmed) rec.confirmedAt = rec.createdAt;
  const ok = await r.set(K(f).record, JSON.stringify(rec), { nx: true });
  if (ok) { counts.created++; await r.lpush(RECENT, f); await r.ltrim(RECENT, 0, 499); }
  return { created: !!ok, reason: ok ? null : 'already recorded' };
}
async function getPurchase(f) {
  const r = redis();
  return r ? parse(await r.get(K(f).record)) : null;
}
// P1. Only confirmedAt is ever added to a record after it is made.
async function confirmPurchase(f) {
  const r = redis();
  const rec = await getPurchase(f);
  if (!r || !rec) return false;
  if (rec.confirmedAt) return true;
  rec.confirmedAt = new Date().toISOString();
  await r.set(K(f).record, JSON.stringify(rec));
  counts.confirmed++;
  return true;
}

// ---- answers ----------------------------------------------------------
const ANSWER_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'UNKNOWN', ''} end
local prev = redis.call('HGET', KEYS[4], ARGV[1])
if prev then local e = redis.call('HGET', KEYS[5], ARGV[1]) or ''
  if prev == ARGV[4] then return {'ALREADY', e} end return {'REUSED', e} end
local cur = redis.call('GET', KEYS[2]) or ''
if cur ~= ARGV[2] then local e = '' if cur ~= '' then e = redis.call('HGET', KEYS[5], cur) or '' end return {'REFUSED', e} end
redis.call('HSET', KEYS[4], ARGV[1], ARGV[4]) redis.call('HSET', KEYS[5], ARGV[1], ARGV[3])
redis.call('RPUSH', KEYS[3], ARGV[1]) redis.call('SET', KEYS[2], ARGV[1]) return {'ACCEPTED', ARGV[3]}
`;
const sigOf = a => [a.play, a.timeframe, a.formationTimeframe || '', a.replaces || ''].join('|');

function validateAnswer(a) {
  if (!a || typeof a !== 'object') return 'no answer was sent';
  if (!validFillId(a.fillId)) return 'that purchase reference is not valid';
  if (!ID_RE.test(String(a.answerId || ''))) return 'that answer reference is not valid';
  if (!PLAY_CHOICES.includes(a.play)) return 'that play is not one of the four choices';
  if (!TIMEFRAME_KEYS.includes(a.timeframe)) return 'that timeframe is not one of the fourteen';
  if (a.play === BF) {
    if (!TIMEFRAME_KEYS.includes(a.formationTimeframe)) return 'a Broadening Formation Scalp needs the formation\'s timeframe';
    if (TIMEFRAME_KEYS.indexOf(a.formationTimeframe) <= TIMEFRAME_KEYS.indexOf(a.timeframe)) return 'the formation\'s timeframe must be larger than the one you entered on';
  } else if (a.formationTimeframe) return 'a formation timeframe goes only with a Broadening Formation Scalp';
  if (a.replaces != null && !ID_RE.test(String(a.replaces))) return 'the answer it replaces is not valid';
  if (a.device != null && !ID_RE.test(String(a.device))) return 'that device reference is not valid';
  return null;
}

// -> { code, body }
async function submitAnswer(a) {
  const why = validateAnswer(a);
  if (why) return { code: 400, body: { verdict: 'INVALID', reason: why } };
  const r = redis();
  if (!r) return { code: 503, body: { verdict: 'NO-STORE', reason: 'the service has no storage set up' } };
  const f = String(a.fillId);
  // P7: asked on the trade card, for a purchase with no record yet.
  if (a.createFrom && !(await getPurchase(f))) {
    const c = a.createFrom;
    await createPurchase({ openFillId: f, occ: typeof c.occ === 'string' ? c.occ.slice(0, 40) : null, ticker: typeof c.ticker === 'string' ? c.ticker.slice(0, 10) : null,
      dir: c.dir === 'Long' || c.dir === 'Short' ? c.dir : null, openTimestamp: c.entryTimestamp }, { source: 'card', confirmed: true });
  }
  const entry = { answerId: String(a.answerId), fillId: f, play: a.play, timeframe: a.timeframe,
    formationTimeframe: a.play === BF ? a.formationTimeframe : null, replaces: a.replaces || null,
    device: a.device || null, deviceLabel: a.deviceLabel === 'phone' || a.deviceLabel === 'laptop' ? a.deviceLabel : null,
    at: new Date().toISOString() };
  const k = K(f);
  const out = await r.eval(ANSWER_SCRIPT, [k.record, k.current, k.history, k.sigs, k.entries],
    [entry.answerId, entry.replaces || '', JSON.stringify(entry), sigOf(entry)]);
  const [verdict, e] = Array.isArray(out) ? out : [null, null];
  const stored = parse(e) || null;
  if (verdict === 'ACCEPTED' || verdict === 'ALREADY') return { code: 200, body: { verdict, entry: stored } };
  if (verdict === 'REUSED') return { code: 409, body: { verdict, entry: stored, reason: 'answer id reused with other contents' } };
  if (verdict === 'REFUSED') return { code: 409, body: { verdict, entry: stored, reason: 'another answer is current' } };
  if (verdict === 'UNKNOWN') return { code: 404, body: { verdict, reason: 'no such purchase' } };
  return { code: 500, body: { verdict: 'UNEXPECTED', reason: 'the store gave an unexpected answer' } };
}

async function currentAnswer(f) {
  const r = redis();
  if (!r || !validFillId(f)) return null;
  const cur = await r.get(K(f).current);
  if (!cur) return null;
  return parse(await r.hget(K(f).entries, cur));
}
async function answerHistory(f) {
  const r = redis();
  if (!r || !validFillId(f)) return [];
  const ids = (await r.lrange(K(f).history, 0, -1)) || [];
  const all = asObject(await r.hgetall(K(f).entries));
  return ids.map(id => parse(all[id])).filter(Boolean);
}
async function recentAnswers(n = 10) {
  const r = redis();
  if (!r) return [];
  const fills = (await r.lrange(RECENT, 0, n * 3)) || [];
  const out = [];
  for (const f of fills) {
    const a = await currentAnswer(f);
    if (a) out.push(a);
    if (out.length >= n) break;
  }
  return out;
}
// Confirmed purchases with no answer and not skipped ("Not now" asks again).
async function waitingPurchases(limit = 30) {
  const r = redis();
  if (!r) return [];
  const fills = (await r.lrange(RECENT, 0, 199)) || [];
  const out = [];
  for (const f of [...new Set(fills)]) {
    const rec = await getPurchase(f);
    if (!rec || !rec.confirmedAt) continue;
    if (await r.get(K(f).current)) continue;
    if (await r.get(K(f).skipped)) continue;
    out.push({ fillId: f, occ: rec.occ, ticker: rec.ticker, dir: rec.dir, openTimestamp: rec.openTimestamp, confirmedAt: rec.confirmedAt });
    if (out.length >= limit) break;
  }
  return out;
}
async function skipPurchase(f) {
  const r = redis();
  if (!r || !validFillId(f) || !(await getPurchase(f))) return false;
  await r.set(K(f).skipped, new Date().toISOString());
  return true;
}

// ---- the pop-up (P2) ------------------------------------------------------
function labelOf(rec) {
  const m = String(rec.occ || '').match(/^(\S+)\s*(\d{6})([CP])(\d{8})$/);
  if (!m) return rec.ticker || 'a position';
  const strike = Number(m[4]) / 1000;
  return `${m[1]} ${strike % 1 ? strike.toFixed(1) : strike} ${m[3] === 'C' ? 'Call' : 'Put'}`;
}
async function notifyPurchase(f) {
  const r = redis();
  const send = sender || defaultSender();
  if (!send) { counts.pushNotSetUp++; note('pop-ups are not set up on the service yet (no notification keys)'); return { sent: 0, reason: 'not set up' }; }
  const rec = await getPurchase(f);
  if (!r || !rec || !rec.confirmedAt) return { sent: 0, reason: 'no confirmed record' };
  const subs = asObject(await r.hgetall(SUBS));
  const payload = JSON.stringify({ title: `You bought ${labelOf(rec)}`, body: 'Which play, and which timeframe did you enter on?',
    url: `./?fill=${encodeURIComponent(f)}`, fill: f });
  let sent = 0;
  for (const [device, raw] of Object.entries(subs)) {
    const saved = parse(raw);
    const subscription = saved && (saved.subscription || saved);
    if (!subscription || !subscription.endpoint) continue;
    // One pop-up per purchase per device, however many ticks see it.
    const claimed = await r.set(K(f).push(device), new Date().toISOString(), { nx: true, ex: 7 * 86400 });
    if (!claimed) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await send(subscription, payload); sent++; counts.pushSent++; break; }
      catch (err) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) { await r.hdel(SUBS, device); counts.pushGone++; note('a device no longer accepts pop-ups and was removed'); break; }
        if (attempt === 3) { counts.pushFailed++; note(`a pop-up could not be sent after 3 tries (${status || (err && err.message) || 'no reason given'})`); }
      }
    }
  }
  return { sent };
}

// ---- inside the sync ------------------------------------------------------
const after = (leg, switchOnAt) => Number.isFinite(switchOnAt) && Number(leg && leg.openTimestamp) >= switchOnAt;
async function beforeSave(legs, { switchOnAt } = {}) {
  let created = 0, failed = 0;
  for (const leg of legs || []) {
    if (!after(leg, switchOnAt)) continue;
    try { if ((await createPurchase(leg)).created) created++; }
    catch (err) { failed++; counts.failed++; note('a purchase record could not be made: ' + err.message); }
  }
  return { created, failed };
}
async function afterSave(legs) {
  for (const leg of legs || []) {
    const f = validFillId(leg && leg.openFillId);
    if (!f) continue;
    try { if (await confirmPurchase(f)) await notifyPurchase(f); }
    catch (err) { counts.failed++; note('a purchase could not be confirmed or announced: ' + err.message); }
  }
}
// P3: the queue as it is now, read only. A purchase with no record is
// given one; an unconfirmed record is confirmed; then its pop-up (claimed,
// so never twice).
async function sweep(state, { switchOnAt } = {}) {
  const legs = [...((state && state.openLegs) || []),
    ...((state && state.pending) || []).map(t => ({ openFillId: Array.isArray(t.fills) ? t.fills[0] : null, occ: t.occ, ticker: t.ticker, dir: t.dir, openTimestamp: t.entryTimestamp }))];
  let fixed = 0;
  for (const leg of legs) {
    if (!after(leg, switchOnAt)) continue;
    const f = validFillId(leg.openFillId);
    if (!f) continue;
    try {
      const rec = await getPurchase(f);
      if (rec && rec.confirmedAt) continue;
      if (!rec) await createPurchase(leg);
      await confirmPurchase(f);
      await notifyPurchase(f);
      fixed++;
    } catch (err) { counts.failed++; note('the repair sweep could not finish a purchase: ' + err.message); }
  }
  return { fixed };
}

// ---- routes (every one needs the app key) ------------------------------
const router = express.Router();
router.use(requireAppKey);

router.get('/waiting', wrap(async (req, res) => {
  res.json({ waiting: await waitingPurchases(30) });
}));
// Current answers by fill id (any journal copy may ask; reading changes nothing).
router.get('/', wrap(async (req, res) => {
  const fills = String(req.query.fills || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  const out = {};
  for (const f of fills) {
    if (!validFillId(f)) continue;
    const [answer, record] = await Promise.all([currentAnswer(f), getPurchase(f)]);
    out[f] = { answer, known: !!record };
  }
  res.json({ answers: out });
}));
router.post('/answer', wrap(async (req, res) => {
  const out = await submitAnswer(req.body || {});
  res.status(out.code).json(out.body);
}));
router.post('/skip', wrap(async (req, res) => {
  const ok = await skipPurchase(String((req.body || {}).fillId || ''));
  res.status(ok ? 200 : 404).json({ ok });
}));
router.get('/history', wrap(async (req, res) => {
  res.json({ history: await answerHistory(String(req.query.fill || '')) });
}));
router.get('/push/key', wrap(async (req, res) => {
  const v = vapid();
  res.json({ publicKey: v ? v.pub : null, reason: v ? null : 'notifications are not set up on the service yet' });
}));
router.post('/push/subscribe', wrap(async (req, res) => {
  const b = req.body || {};
  if (!ID_RE.test(String(b.device || '')) || !b.subscription || typeof b.subscription.endpoint !== 'string' || !/^https:\/\//.test(b.subscription.endpoint)) {
    return res.status(400).json({ ok: false, reason: 'that device or its pop-up address is not valid' });
  }
  const r = redis();
  if (!r) return res.status(503).json({ ok: false, reason: 'the service has no storage set up' });
  await r.hset(SUBS, { [b.device]: JSON.stringify({ subscription: { endpoint: b.subscription.endpoint, keys: b.subscription.keys || {} },
    deviceLabel: b.deviceLabel === 'phone' || b.deviceLabel === 'laptop' ? b.deviceLabel : null, at: new Date().toISOString() }) });
  res.json({ ok: true });
}));
router.post('/push/unsubscribe', wrap(async (req, res) => {
  const r = redis();
  if (r && ID_RE.test(String((req.body || {}).device || ''))) await r.hdel(SUBS, String(req.body.device));
  res.json({ ok: true });
}));
router.get('/stats', wrap(async (req, res) => { res.json(stats()); }));

module.exports = { router, createPurchase, confirmPurchase, getPurchase, submitAnswer, validateAnswer, currentAnswer, answerHistory,
  recentAnswers, waitingPurchases, skipPurchase, notifyPurchase, beforeSave, afterSave, sweep, stats, useStore, useSender,
  ANSWER_SCRIPT, PLAY_CHOICES, K };
