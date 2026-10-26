'use strict';
// UPSTASH'S REST INTERFACE, JUDGED STRICTLY (Deploy 2 real-store run plan
// v3.2, accepted as final by the owner on 26 Oct 2026; test code only).
//
// Everything a real-store run says to Upstash, and everything it accepts
// back, goes through this file:
//   - classify(): every answer is judged by ONE order of steps, the first
//     step that applies deciding (plan v3.2 A2): no usable HTTP answer;
//     401; 429; the envelope; identity by text; limit by text; an EXACT
//     accepted command error; a result (strict base64, A1); everything else.
//   - send(): one request, redirects NEVER followed (plan D-R), a 10-second
//     limit, no retry ever (P-6).
//   - directClient(): the tests' own inspection client in a real-store run.
//     A Redis error comes back as {error}; ANY other failure THROWS (D-4).
//   - storeFromEnv(): store mode starts only from the runner-built
//     environment, with its binding checked (I-2, I-3). It never falls back.
// Nothing here is used by the service's own code.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- The closed lists (plan v3.1 A2 / v3.2). Never widened during a run.
// E-1, E-2: the only Redis errors the suite provokes on purpose (Q-T20 (b);
// writer-fence.js B4), their texts checked on Redis 7.0.15. E-1 is accepted
// with or without the "ERR " prefix (real-store run 2: Upstash's text was not
// "ERR wrong-type"; the older Redis form has no prefix), and with the same
// optional script suffix as E-2. Nothing else (C-5, owner's words, 26 Oct).
const SCRIPT_SUFFIX = '(?: script: [0-9a-f]{40}, on @user_script:\\d+\\.)?';
const ACCEPTED_ERRORS = [
  t => new RegExp('^(?:ERR )?wrong-type' + SCRIPT_SUFFIX + '$').test(t),
  t => /^WRONGTYPE Operation against a key holding the wrong kind of value(?: script: [0-9a-f]{40}, on @user_script:\d+\.)?$/.test(t),
];
// L-1 to L-7: Upstash's documented limit messages (its troubleshooting pages).
const LIMIT_MARKERS = [
  'ERR max daily request limit exceeded', 'ERR max requests limit exceeded', 'ERR max request size exceeded',
  'ERR max single record size exceeded', 'ERR max key size exceeded', 'ERR DB capacity quota exceeded',
  'ERR max concurrent connections exceeded',
];
const IDENTITY_MARKERS = ['WRONGPASS', 'NOAUTH'];
// Every top-level command the suite and the builds under test send. A
// request naming anything else is malformed and is never forwarded.
// The second line is what the service itself calls, at 82f7cb4 and at both
// older builds alike (the same set in all three); the full-suite self-test
// (S-3) found HGETALL, sent by an older build's start-up, missing.
const COMMANDS = new Set(['GET', 'SET', 'DEL', 'EXISTS', 'EVAL', 'LPUSH', 'RPUSH', 'LRANGE', 'LLEN', 'LTRIM', 'TYPE', 'SCAN', 'DBSIZE', 'FLUSHALL',
  'HGETALL', 'HSET', 'LREM', 'MGET', 'PERSIST', 'RPOP', 'SMEMBERS', 'TTL', 'ZRANGE']);

// ---- A1: strict, canonical base64; decoded bytes must be valid UTF-8.
// Checked character by character, never with one pattern over the whole text:
// a repeated group in a regular expression overflows the stack on a reply of
// a few megabytes (found by the full-suite self-test, S-3).
const B64_CHAR = /^[A-Za-z0-9+/]$/;
function b64Shape(s) {
  if (s.length % 4 !== 0) return false;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  for (let i = 0; i < s.length - pad; i++) if (!B64_CHAR.test(s[i])) return false;
  return true;
}
function strictBase64(s) {
  if (typeof s !== 'string' || !b64Shape(s)) return { ok: false };
  const bytes = Buffer.from(s, 'base64');
  if (bytes.toString('base64') !== s) return { ok: false };          // canonical: the round trip is exact
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch (e) { return { ok: false }; }
}
// A reply value: null, a safe integer, a string, or an array of them. Under
// base64 every string must be "OK" or strict base64 (A1); in plain JSON a
// string holding U+FFFD is refused (the suite never writes one; Upstash
// documents that character as its replacement for invalid UTF-8).
function replyValueOk(v, base64) {
  if (v === null) return true;
  if (typeof v === 'number') return Number.isSafeInteger(v);
  if (typeof v === 'string') return base64 ? (v === 'OK' || strictBase64(v).ok) : !v.includes('�');
  if (Array.isArray(v)) return v.every(x => replyValueOk(x, base64));
  return false;
}
// The client's own decoding rule (@upstash/redis 1.38.2: raw === "OK" ? "OK"
// : base64decode(raw)), applied only after replyValueOk passed.
function decodeValue(v) {
  if (typeof v === 'string') return v === 'OK' ? 'OK' : strictBase64(v).text;
  if (Array.isArray(v)) return v.map(decodeValue);
  return v;
}
function encodeValue(v) {
  if (typeof v === 'string') return v === 'OK' ? 'OK' : Buffer.from(v, 'utf8').toString('base64');
  if (Array.isArray(v)) return v.map(encodeValue);
  return v;
}

// A command as the shim and the direct client accept it: a non-empty array
// of strings and safe integers, naming a known command.
function commandOk(c) {
  return Array.isArray(c) && c.length > 0 && c.every(x => typeof x === 'string' || Number.isSafeInteger(x))
    && typeof c[0] === 'string' && COMMANDS.has(c[0].toUpperCase());
}
// Why a command is not forwarded, in words: the command's NAME only, never
// its arguments (those carry the test's data).
function commandWhy(c) {
  if (!Array.isArray(c) || !c.length) return 'a command that is not a non-empty list';
  if (typeof c[0] !== 'string') return 'a command whose name is not text';
  const name = /^[A-Za-z.-]{1,32}$/.test(c[0]) ? c[0].toUpperCase() : '(an unreadable name)';
  if (!COMMANDS.has(c[0].toUpperCase())) return `a command this harness does not forward: ${name}`;
  return `an argument of ${name} that is neither text nor a whole number`;
}
const exactlyOneKey = (o, k) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 1 && k in o;
const errorEnvelope = o => exactlyOneKey(o, 'error') && typeof o.error === 'string';
const resultEnvelope = o => exactlyOneKey(o, 'result');
// C-4: an error text that decides nothing else is QUOTED in the reason, at
// most 200 characters (the runner's redactor still scrubs every credential):
// a stop names exactly what Upstash said (real-store run 2 could not).
const quoted = t => JSON.stringify(String(t).length > 200 ? String(t).slice(0, 200) + '...' : String(t));
const textMarker = (t, list) => typeof t === 'string' && list.find(m => t.startsWith(m)) || null;

// ---- A2 (plan v3.2): ONE ORDER, FIRST APPLICABLE STEP DECIDES.
// answer: {transport: null | kind, status, contentType, body (text)}
// req: {kind: 'single'|'pipeline', n, base64}
// Returns {decision, step, position?, evidence?, entries?}: decision is one of
// RESULT, COMMAND_ERROR, IDENTITY, LIMIT, AMBIGUOUS. For a pipeline, RESULT
// means every entry is a result or an accepted command error.
function classify(answer, req) {
  const out = (decision, step, extra = {}) => ({ decision, step, ...extra });
  // STEP 1: no usable HTTP answer (the body is not examined).
  if (answer.transport) return out('AMBIGUOUS', 1, { why: answer.transport });
  const st = answer.status;
  if (st >= 300 && st < 400) return out('AMBIGUOUS', 1, { why: 'a redirect (never followed)' });
  // Parsed only for evidence in steps 2-3, and for the envelope in step 4.
  let body; let parsed = false;
  try { body = JSON.parse(answer.body); parsed = true; } catch (e) { /* judged below */ }
  const evidenceOf = () => {
    if (!parsed) return null;
    const texts = Array.isArray(body) ? body.map(e => (e && typeof e.error === 'string' ? e.error : null)) : [body && typeof body.error === 'string' ? body.error : null];
    for (let i = 0; i < texts.length; i++) {
      const m = textMarker(texts[i], IDENTITY_MARKERS) || textMarker(texts[i], LIMIT_MARKERS);
      if (m) return { marker: m, position: Array.isArray(body) ? i + 1 : null };
    }
    return null;
  };
  // STEP 2 and STEP 3: decided by the status alone, whatever the body.
  if (st === 401) return out('IDENTITY', 2, { evidence: evidenceOf() });
  if (st === 429) return out('LIMIT', 3, { evidence: evidenceOf() });
  if (st !== 200 && st !== 400) return out('AMBIGUOUS', 9, { why: 'status ' + st });
  // STEP 4: the envelope -- only what is needed to READ the answer.
  const jsonType = /^application\/json(\s*;|$)/i.test(answer.contentType || '');
  if (!jsonType || !parsed) return out('AMBIGUOUS', 4, { why: 'not a JSON answer', evidence: evidenceOf() });
  let entries;
  if (req.kind === 'single') {
    if (!(resultEnvelope(body) || errorEnvelope(body))) return out('AMBIGUOUS', 4, { why: 'not exactly one "result" or "error"', evidence: evidenceOf() });
    entries = [body];
  } else if (Array.isArray(body)) {
    if (body.length !== req.n) return out('AMBIGUOUS', 4, { why: `pipeline answer has ${body.length} entries for ${req.n} commands`, evidence: evidenceOf() });
    const bad = body.findIndex(e => !(resultEnvelope(e) || errorEnvelope(e)));
    if (bad >= 0) return out('AMBIGUOUS', 4, { why: 'malformed pipeline entry', position: bad + 1, evidence: evidenceOf() });
    entries = body;
  } else {
    // A whole-batch refusal: readable for steps 5 and 6 only.
    if (!errorEnvelope(body)) return out('AMBIGUOUS', 4, { why: 'pipeline answer is neither a list nor an error', evidence: evidenceOf() });
    const t = body.error;
    if (textMarker(t, IDENTITY_MARKERS)) return out('IDENTITY', 5);
    if (textMarker(t, LIMIT_MARKERS)) return out('LIMIT', 6, { marker: textMarker(t, LIMIT_MARKERS) });
    return out('AMBIGUOUS', 9, { why: 'whole-batch error not identity or limit: ' + quoted(t) });
  }
  // STEPS 5-9, entry by entry in command order; the first decisive entry decides.
  const judged = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]; const pos = req.kind === 'pipeline' ? i + 1 : null;
    if ('error' in e) {
      if (textMarker(e.error, IDENTITY_MARKERS)) return out('IDENTITY', 5, { position: pos });
      const lm = textMarker(e.error, LIMIT_MARKERS);
      if (lm) return out('LIMIT', 6, { position: pos, marker: lm });
      const statusOk = req.kind === 'single' ? st === 400 : st === 200;
      if (statusOk && req.wellFormed !== false && ACCEPTED_ERRORS.some(f => f(e.error))) { judged.push({ error: e.error }); continue; }
      return out('AMBIGUOUS', 9, { position: pos, why: `an error not on the accepted list${statusOk ? '' : ' (under status ' + st + ')'}: ${quoted(e.error)}` });
    }
    // 'result'
    if (st !== 200) return out('AMBIGUOUS', 9, { position: pos, why: 'a result under status ' + st });
    if (!replyValueOk(e.result, req.base64)) return out('AMBIGUOUS', 8, { position: pos, why: 'a result value that is not a valid reply value' });
    judged.push({ result: e.result });
  }
  if (req.kind === 'single') return out('error' in judged[0] ? 'COMMAND_ERROR' : 'RESULT', 'error' in judged[0] ? 7 : 8, { entries: judged });
  return out('RESULT', 8, { entries: judged });
}

// ---- Transport: ONE request, redirects never followed, 10-second limit.
const REQUEST_LIMIT_MS = 10000;
const MAX_ANSWER = 16 * 1024 * 1024;
async function send(url, { method = 'POST', headers = {}, body, timeoutMs = REQUEST_LIMIT_MS, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { transport: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'no complete answer within the time limit' : 'the connection failed or was interrupted' };
  }
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ANSWER) return { transport: 'an answer larger than 16 MB' };
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: buf.toString('utf8'), bytes: buf };
  } catch (e) {
    return { transport: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'no complete answer within the time limit' : 'the answer was cut off' };
  }
}

// ---- The ledger and fault records (plan v2 Q-2; v3 P-4a). Sequence numbers,
// verbs, outcome kinds and positions ONLY: never a value, never a credential.
function recorder(dir) {
  if (!dir) return { start: () => 0, end: () => {}, fault: () => {} };
  const file = path.join(dir, `${process.pid}.ledger`);
  let seq = 0;
  const line = s => fs.appendFileSync(file, s + '\n');
  return {
    start(verbs) { seq++; line(`start ${seq} ${verbs.join(',')}`); return seq; },
    end(n, decision, step, position) { line(`end ${n} ${decision} ${step}${position ? ' ' + position : ''}`); },
    fault(decision, step, position, why) {
      fs.appendFileSync(path.join(dir, `${process.pid}.faults`), `fault ${decision} step ${step}${position ? ' position ' + position : ''}${why ? ' (' + String(why).replace(/[\r\n]/g, ' ').slice(0, 120) + ')' : ''}\n`);
    },
  };
}

// ---- The tests' direct client (plan v2 PATH D).
class TransportError extends Error {
  constructor(decision, step, why) { super(`real-store request not usable: ${decision} at step ${step}${why ? ' (' + why + ')' : ''}`); this.code = 'TRANSPORT'; this.decision = decision; this.step = step; }
}
function directClient(store, { ledgerDir = store.ledgerDir, fetchImpl } = {}) {
  const rec = recorder(ledgerDir);
  return {
    store: true,
    async call(...args) {
      const cmd = args.map(a => (typeof a === 'number' ? a : String(a)));
      if (!commandOk(cmd)) throw new TransportError('REFUSED', 0, commandWhy(cmd));
      const n = rec.start([cmd[0]]);
      const a = await send(store.endpoint + '/', { headers: { Authorization: 'Bearer ' + store.token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), fetchImpl });
      const c = classify(a, { kind: 'single', n: 1, base64: false, wellFormed: true });
      rec.end(n, c.decision, c.step);
      if (c.decision === 'RESULT') return c.entries[0].result;
      if (c.decision === 'COMMAND_ERROR') return { error: c.entries[0].error };
      rec.fault(c.decision, c.step, c.position, c.why);
      throw new TransportError(c.decision, c.step, c.why);
    },
    close() {},
  };
}

// ---- Store mode from the runner-built environment (plan v2 I-3).
const ENDPOINT_REAL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io$/;
const ENDPOINT_SELFTEST = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const bindingOf = (id, endpoint, token) => crypto.createHash('sha256').update(`${id}\n${endpoint}\n${token}`).digest('hex');
function storeFromEnv(env = process.env) {
  if (env.QUEUE_REALSTORE_RUN === undefined) return null;                         // ordinary local runs and CI
  const refuse = why => { const e = new Error('real-store mode refused: ' + why + ' (it never falls back to a local Redis)'); e.code = 'STORE_REFUSED'; throw e; };
  if (env.QUEUE_REALSTORE_RUN !== 'authorised') refuse('QUEUE_REALSTORE_RUN is not "authorised"');
  const id = env.QUEUE_REALSTORE_ID, endpoint = env.QUEUE_REALSTORE_ENDPOINT, token = env.QUEUE_REALSTORE_TOKEN, binding = env.QUEUE_REALSTORE_BINDING;
  if (!id || !endpoint || !token || !binding) refuse('a run value is missing');
  const selftest = env.QUEUE_REALSTORE_SELFTEST === '1';
  if (!(ENDPOINT_REAL.test(endpoint) || (selftest && ENDPOINT_SELFTEST.test(endpoint)))) refuse('the endpoint is not of the allowed form');
  if (bindingOf(id, endpoint, token) !== binding) refuse('the binding does not match the run values');
  return Object.freeze({ id, endpoint, token, ledgerDir: env.QUEUE_REALSTORE_LEDGER || null, selftest });
}

module.exports = {
  quoted,
  ACCEPTED_ERRORS, LIMIT_MARKERS, IDENTITY_MARKERS, COMMANDS,
  strictBase64, replyValueOk, decodeValue, encodeValue, commandOk, commandWhy, classify, send, recorder,
  directClient, TransportError, storeFromEnv, bindingOf, ENDPOINT_REAL, REQUEST_LIMIT_MS,
};
