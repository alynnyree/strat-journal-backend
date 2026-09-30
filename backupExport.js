// A READ-ONLY copy of everything this server stores, for backup.
//
// Phase 0 found the server had no way to hand over a complete copy of its
// own data: the positions still open, the list of Schwab fills it has already
// handled, his stop settings, his feedback on the AI's readings. The only
// complete copy was the database's own website. Phase 2 changes how that data
// is stored, so a copy must be taken first -- and before every later phase.
//
// It reads and never writes. It walks every key the database holds rather
// than a hand-written list, so something added later is not silently left
// out -- and it says by NAME what it left out, and why, so nothing is left
// out silently either.
//
// Never included: his Schwab sign-in and his Alpaca keys. Anything else whose
// name looks like a credential is left out too and named in the answer, so a
// secret added later is refused by default rather than copied by default.
const NEVER = new Set(['schwab:tokens', 'alpaca:keys']);
const LOOKS_SECRET = /(token|secret|password|passwd|credential|api[_-]?key|:keys$)/i;
const SKIP_PREFIX = ['oauth:state:']; // one-time sign-in checks, meaningless in a backup

// A backup must not be the thing that runs the free server out of memory.
const MAX_VALUE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

function whyExcluded(key) {
  if (NEVER.has(key)) return 'secret (sign-in or keys)';
  if (LOOKS_SECRET.test(key)) return 'name looks like a credential';
  if (SKIP_PREFIX.some(p => key.startsWith(p))) return 'one-time sign-in check';
  return null;
}

async function allKeys(redis) {
  const keys = [];
  let cursor = 0;
  let rounds = 0;
  do {
    const [next, batch] = await redis.scan(cursor, { count: 200 });
    for (const k of batch || []) keys.push(k);
    cursor = Number(next);
    if (++rounds > 1000) throw new Error('Stopped listing keys after 1000 rounds -- the database did not finish answering.');
  } while (cursor !== 0);
  return [...new Set(keys)].sort();
}

async function readValue(redis, key, type) {
  switch (type) {
    case 'string': return redis.get(key);
    case 'list':   return redis.lrange(key, 0, -1);
    case 'hash':   return redis.hgetall(key);
    case 'set':    return redis.smembers(key);
    case 'zset':   return redis.zrange(key, 0, -1, { withScores: true });
    default:       return undefined;
  }
}

async function exportState(redis) {
  const out = {
    exportedAt: new Date().toISOString(),
    readOnly: true,
    keys: {},
    excluded: [],     // { key, why }  -- left out on purpose
    notCopied: [],    // { key, why }  -- could not be copied
    totals: { copied: 0, excluded: 0, notCopied: 0, bytes: 0 },
  };
  const keys = await allKeys(redis);
  for (const key of keys) {
    const why = whyExcluded(key);
    if (why) { out.excluded.push({ key, why }); continue; }
    try {
      const type = await redis.type(key);
      const value = await readValue(redis, key, type);
      if (value === undefined) { out.notCopied.push({ key, why: `unfamiliar kind of entry (${type})` }); continue; }
      const bytes = Buffer.byteLength(JSON.stringify(value) || '');
      if (bytes > MAX_VALUE_BYTES) { out.notCopied.push({ key, why: `too large to include (${bytes} bytes)` }); continue; }
      if (out.totals.bytes + bytes > MAX_TOTAL_BYTES) { out.notCopied.push({ key, why: 'backup size limit reached' }); continue; }
      out.keys[key] = { type, value };
      out.totals.bytes += bytes;
    } catch (err) {
      out.notCopied.push({ key, why: 'could not be read: ' + ((err && err.message) || String(err)) });
    }
  }
  out.totals.copied = Object.keys(out.keys).length;
  out.totals.excluded = out.excluded.length;
  out.totals.notCopied = out.notCopied.length;
  return out;
}

module.exports = { exportState, whyExcluded };
