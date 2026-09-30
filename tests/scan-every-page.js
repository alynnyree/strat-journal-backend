// Listing stored entries must read EVERY page, whatever the page marker
// looks like. On 30 Sept 2026 the backup came back with 200 entries out of
// about 900 -- one page -- the first time the service held more than one
// page. Both listers turned the database's page marker into a number, and
// Upstash's markers can be larger than a number holds exactly. This check
// uses markers of that size.
const Module = require('module');
process.env.UPSTASH_REDIS_REST_URL = 'https://fake';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
setTimeout(() => { console.log('FAIL: this check stalled'); process.exit(1); }, 60000).unref();

const keys = [];
for (let i = 0; i < 1450; i++) keys.push('ledger:schwab:rec:' + (124000000000 + i));
keys.push('trades:state', 'stopRule:settings', 'schwab:tokens');
// Page markers beyond what a number holds exactly (> 2^53).
const marker = n => (BigInt('18446744073709551000') + BigInt(n)).toString();
const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
class FakeRedis {
  constructor() {}
  async scan(cursor, o) {
    const page = o.count || 10;
    let start = 0;
    if (String(cursor) !== '0') {
      const n = BigInt(String(cursor)) - BigInt('18446744073709551000');
      if (n < 0n || n > BigInt(keys.length) || marker(Number(n)) !== String(cursor)) return ['0', []]; // an unknown marker: the listing just ends
      start = Number(n);
    }
    const slice = keys.slice(start, start + page);
    const re = globToRe(o.match || '*');
    const next = start + page >= keys.length ? '0' : marker(start + page);
    return [next, slice.filter(k => re.test(k))];
  }
  async type() { return 'string'; }
  async get() { return { x: 1 }; }
  async lrange() { return []; }
}
FakeRedis.fromEnv = () => new FakeRedis();
const orig = Module._load;
Module._load = function (req) { if (req === '@upstash/redis') return { Redis: FakeRedis }; return orig.apply(this, arguments); };

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d)); } };

(async () => {
  const { exportState } = require('../backupExport');
  const copy = await exportState(new FakeRedis());
  check('the backup reads every page (1453 entries, secrets left out and named)', copy.totals.copied + copy.totals.excluded === 1453 && copy.keys['trades:state'], copy.totals);
  process.env.R2_ACCOUNT_ID = ''; // archive not needed for a count
  const L = require('../brokerLedger');
  const st = await L.ledgerStatus({ redis: new FakeRedis() });
  check('the ledger status counts every entry across pages', st.ledgerRecords === 1450, st.ledgerRecords);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
