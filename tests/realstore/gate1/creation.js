'use strict';
// THE UPSTASH CREATION STEP (Gate 1 plan v12), written to the format
// Upstash documents (upstash.com/docs/devops/developer-api/start-redis/create)
// and to the auditor's five conditions:
//   1. STRICT VALIDATION: every required labelled line exactly once, each
//      value in its exact form; missing, duplicated, malformed or
//      contradictory answers are refused; nothing is accepted half-parsed.
//   2. SECRETS: the database id is OUR OWN UUIDv4, made before the request
//      (the caller registers it as a secret first); nothing in this file
//      ever puts any part of the answer into an error or a reason.
//   3. UNCERTAIN OUTCOMES: a timeout, a dropped connection or a server error
//      is retried with the SAME Idempotency-Key ("sending the same UUID again
//      returns the same database instead of creating a duplicate"), never a
//      new one.
//   4. TRANSPORT: redirects are never followed; only status 200 with a
//      text/markdown body of at most 64 KB, decoded once as strict UTF-8,
//      is read; every failure is reported by KIND only.
//   5. An answer that cannot be used never proves that no database exists:
//      the caller reports it as possibly existing (gate1.js, finish()).
const START_URL = 'https://upstash.com/start-redis';
const MAX_BYTES = 65536;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.upstash\.io$/;
// The token's exact alphabet is not documented ("<token>" in the example):
// this accepts the URL-safe and standard base64 alphabets, 20 to 512 long.
const TOKEN = /^[A-Za-z0-9_\-+=/]{20,512}$/;
const DAY = 86400000;

// Pure. Returns {ok: true, ...fields} or {ok: false, why}. "why" is built
// from fixed words and counts ONLY, never from the answer's text.
function parseCreationAnswer(text, id, nowMs) {
  const no = why => ({ ok: false, why });
  if (typeof text !== 'string') return no('the answer is not text');
  if (typeof id !== 'string' || !UUID4.test(id)) return no('the request id is not a UUIDv4');
  const lines = text.split(/\r?\n/);
  const one = name => {
    const prefix = `**${name}:**`;
    const found = lines.filter(l => l.startsWith(prefix));
    if (found.length !== 1) return { why: `the "${name}" line appears ${found.length} times (exactly 1 required)` };
    return { v: found[0].slice(prefix.length).trim() };
  };
  const dbid = one('Database ID'); if (dbid.why) return no(dbid.why);
  if (!UUID4.test(dbid.v)) return no('the database id is not a UUIDv4');
  if (dbid.v !== id) return no('the database id is not the id this run sent');
  const ep = one('Endpoint'); if (ep.why) return no(ep.why);
  const em = /^https:\/\/([^/\s:?#]+)$/.exec(ep.v);
  if (!em || !HOST.test(em[1])) return no('the endpoint is not https://<name>.upstash.io exactly');
  const host = em[1], endpoint = 'https://' + host;
  const tk = one('Token'); if (tk.why) return no(tk.why);
  if (!TOKEN.test(tk.v)) return no('the token is not in the accepted form');
  const token = tk.v;
  const mt = one('Metrics'); if (mt.why) return no(mt.why);
  const metricsUrl = mt.v.split(/\s+/)[0];
  if (metricsUrl !== `${START_URL}/metrics/${id}`) return no('the metrics address does not name this database id');
  const ex = one('Expires'); if (ex.why) return no(ex.why);
  const dm = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(ex.v);
  if (!dm) return no('the expiry is not a date');
  const expMs = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
  // v12.1: Date.UTC turns an impossible date (31 February) into a real one
  // (early March). The date must read back as exactly the same year, month
  // and day, or it does not exist and is refused.
  const back = new Date(expMs);
  if (back.getUTCFullYear() !== Number(dm[1]) || back.getUTCMonth() !== Number(dm[2]) - 1 || back.getUTCDate() !== Number(dm[3])) return no('the expiry is not a real calendar date');
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  if (!(expMs >= today && expMs <= today + 4 * DAY)) return no('the expiry is not within 4 days from today');
  const consoleUrls = lines.map(l => l.trim()).filter(l => l.includes('start-redis/console/'));
  if (consoleUrls.length !== 1) return no(`the console address appears ${consoleUrls.length} times (exactly 1 required)`);
  const consoleUrl = `${START_URL}/console/${id}`;
  if (consoleUrls[0] !== consoleUrl) return no('the console address does not name this database id');
  // CONTRADICTIONS anywhere in the answer (for example in the quickstart).
  const hosts = new Set((text.match(/[a-z0-9-]+\.upstash\.io/g) || []));
  if (hosts.size !== 1 || !hosts.has(host)) return no(`the answer names ${hosts.size} different database hosts (exactly 1 required)`);
  // v12.1: EVERY "Bearer" and EVERY "Authorization", in any letter case and
  // anywhere in the answer, must be written exactly "Authorization: Bearer "
  // followed by this token, and the token must then END: a quote, white
  // space or the end of the text (v12.2: a backslash no longer counts as an
  // end, so "<token>\extra" is refused). Any other form -- quoted,
  // with punctuation, lower case, a different value, another scheme -- is
  // unrecognised and refuses the whole answer (fail closed).
  const FORM = 'Authorization: Bearer ';
  const endsCleanly = i => i >= text.length || /["'\s]/.test(text.charAt(i));
  for (const m of text.matchAll(/authorization/gi)) {
    if (text.slice(m.index, m.index + FORM.length) !== FORM || text.slice(m.index + FORM.length, m.index + FORM.length + token.length) !== token || !endsCleanly(m.index + FORM.length + token.length))
      return no('an "Authorization" in the answer is not exactly "Authorization: Bearer <this token>"');
  }
  for (const m of text.matchAll(/bearer/gi)) {
    const start = m.index - 'Authorization: '.length;
    if (start < 0 || text.slice(start, m.index + 'Bearer '.length) !== FORM)
      return no('a "Bearer" in the answer is not part of "Authorization: Bearer <this token>"');
  }
  const ids = new Set((text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []));
  if (ids.size !== 1) return no(`the answer names ${ids.size} different database ids (exactly 1 required)`);
  return { ok: true, id, endpoint, host, token, metricsUrl, consoleUrl, expires: `${dm[1]}-${dm[2]}-${dm[3]}` };
}

// Every value in the answer that COULD be a credential, found without
// trusting the answer's structure. The caller registers them as secrets
// BEFORE parsing, so even a refused answer cannot leak through any output.
function credentialCandidates(text) {
  if (typeof text !== 'string') return [];
  const out = new Set();
  for (const m of text.match(/https?:\/\/[^\s"'()<>]+/g) || []) out.add(m);
  for (const m of text.match(/[a-z0-9-]+\.upstash\.io/g) || []) out.add(m);
  for (const m of text.match(/Bearer\s+[^\s"'()]+/g) || []) out.add(m.replace(/^Bearer\s+/, ''));
  for (const l of text.split(/\r?\n/)) {
    const m = /^\*\*[^*]{1,40}:\*\*\s*(\S+)/.exec(l);
    if (m && !/^(\d{4}-\d{2}-\d{2})$/.test(m[1])) out.add(m[1]);
  }
  for (const m of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []) out.add(m);
  return [...out].filter(v => v.length >= 8 && !/[\r\n]/.test(v));
}

// The request, with up to "attempts" tries, all with the SAME id. Resolves
// {text, tries: [...]} or rejects with code CREATE and a reason of KIND only.
// "tries" lists each attempt's outcome kind, for the log.
async function requestCreation({ url = START_URL, id, attempts = 3, timeoutMs = 30000, backoffMs = [2000, 4000], fetchImpl = fetch } = {}) {
  if (typeof id !== 'string' || !UUID4.test(id)) throw Object.assign(new Error('refused: the request id is not a UUIDv4; nothing was sent'), { code: 'CREATE', sent: false });
  const tries = [];
  const fail = (why, retryable) => ({ fail: why, retryable });
  for (let n = 1; n <= attempts; n++) {
    let r;
    try {
      const res = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Idempotency-Key': id, 'User-Agent': 'claude-code' } });
      if (res.status >= 300 && res.status < 400) r = fail(`a redirect (status ${res.status}) was not followed`, false);
      else if (res.status >= 500) r = fail(`the service answered status ${res.status}`, true);
      else if (res.status !== 200) r = fail(`the service answered status ${res.status}`, false);
      else if (!/^text\/markdown(\s*;|$)/i.test(res.headers.get('content-type') || '')) r = fail('the answer is not text/markdown', false);
      else {
        const reader = res.body.getReader(); const parts = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) { try { await reader.cancel(); } catch (e) {} break; }
          parts.push(value);
        }
        if (size > MAX_BYTES) r = fail('the answer is larger than 64 KB', false);
        else {
          let text = null;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)); } catch (e) { r = fail('the answer is not valid UTF-8', false); }
          if (text !== null) { tries.push('answered'); return { text, tries }; }
        }
      }
    } catch (e) {
      const kind = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'no complete answer within the time limit' : 'the connection failed or was interrupted';
      r = fail(kind, true);
    }
    tries.push(r.fail);
    if (!r.retryable || n === attempts) {
      const err = new Error(`creation answer not usable after ${n} attempt(s), all with the same request id: ${tries.join('; ')}`);
      err.code = 'CREATE'; err.sent = true; err.tries = tries; throw err;
    }
    await new Promise(res => setTimeout(res, backoffMs[Math.min(n - 1, backoffMs.length - 1)]));
  }
}

module.exports = { parseCreationAnswer, credentialCandidates, requestCreation, START_URL, MAX_BYTES, UUID4 };
