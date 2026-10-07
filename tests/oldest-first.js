// AUDIT STEP E, part E3, authorized by the owner on 7 October 2026 ("I
// authorize Step E implementation"), after his B3-5 choice ("Option 1"):
// fifo-v1, the oldest purchase first, is the production pairing rule.
//
// The live matcher used to pick the NEWEST purchase of the same day. The
// journal is rebuilt from the broker ledger under fifo-v1, so trades arriving
// from now on must pair the same way, or the journal would mix two rules.
const { processFills } = require('../matcher');
const R = require('../tradeRebuild');
const { record, entry, fillOf } = require('./lib/ledgerFixture');

let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : '-> ' + JSON.stringify(d).slice(0, 400)); } };
const run = fills => processFills(fills, { openLegs: [], pending: [] }).newPending;
const pairsOf = ts => ts.map(t => `${t.fills.join('+')} x${t.contracts}`).sort();

console.log('--- 1. purchases layered in one session close oldest first ---');
{
  const b1 = record({ id: 1001, at: '2026-06-01T13:31:00+0000', buy: true, price: 1.00 });
  const b2 = record({ id: 1002, at: '2026-06-01T13:33:00+0000', buy: true, price: 1.20 });
  const s1 = record({ id: 1003, at: '2026-06-01T13:40:00+0000', buy: false, price: 1.30 });
  const ts = run([b1, b2, s1].map(fillOf));
  check(`the sale closes the 13:31 purchase, not the newer 13:33 one (${JSON.stringify(pairsOf(ts))})`,
    JSON.stringify(pairsOf(ts)) === JSON.stringify(['1001+1003 x1']));
}

console.log('\n--- 2. purchases at the same moment: the lower broker id first ---');
{
  const at = '2026-06-01T14:00:00+0000';
  const hi = record({ id: 10, at, buy: true, price: 1.00 });   // "10" sorts before "9" as text
  const lo = record({ id: 9, at, buy: true, price: 1.00 });
  const s = record({ id: 11, at: '2026-06-01T14:05:00+0000', buy: false, price: 1.10 });
  const ts = run([hi, lo, s].map(fillOf));                       // the higher id arrives first
  check(`the sale closes purchase 9, whatever the arrival order (${JSON.stringify(pairsOf(ts))})`,
    JSON.stringify(pairsOf(ts)) === JSON.stringify(['9+11 x1']));
}

console.log('\n--- 3. the live matcher pairs exactly as tradeRebuild fifo-v1 ---');
{
  // Random sessions on three contracts: purchases (some at the same second),
  // then sales that never sell more than is open. Everything is the same day,
  // well before expiry, so both rules' eligibility agrees.
  let seed = 12345;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  let rounds = 0, mismatches = [];
  for (let round = 0; round < 60; round++) {
    const raws = [];
    let id = 300000 + round * 1000;
    for (const und of ['SPY', 'IWM', 'QQQ']) {
      let t = Date.UTC(2026, 5, 1, 13, 30, 0) + Math.floor(rnd() * 600) * 1000;
      let open = 0;
      const steps = 4 + Math.floor(rnd() * 6);
      for (let k = 0; k < steps; k++) {
        const sell = open > 0 && rnd() < 0.45;
        if (!sell || k === 0) {
          if (rnd() < 0.7) t += 1000 * (1 + Math.floor(rnd() * 90));     // otherwise the same second as the last purchase
          const qty = 1 + Math.floor(rnd() * 3);
          raws.push(record({ id: id++, at: new Date(t).toISOString().replace('.000Z', '+0000'), buy: true, qty, price: Math.round((0.5 + rnd() * 2) * 100) / 100, und }));
          open += qty;
        } else {
          t += 1000 * (1 + Math.floor(rnd() * 90));
          const qty = 1 + Math.floor(rnd() * open);
          raws.push(record({ id: id++, at: new Date(t).toISOString().replace('.000Z', '+0000'), buy: false, qty, price: Math.round((0.5 + rnd() * 2) * 100) / 100, und }));
          open -= qty;
        }
      }
    }
    const fills = raws.map(fillOf).sort((a, b) => a.timestamp - b.timestamp || (a.transactionId.length - b.transactionId.length) || (a.transactionId < b.transactionId ? -1 : 1));
    const live = pairsOf(run(fills));
    const rebuilt = R.rebuild(raws.map(r => entry(r)), { rule: 'fifo-v1' }).reconstruction.trades
      .map(t => `${t.openFillId.split(':')[1]}+${t.closeFillId.split(':')[1]} x${t.contracts}`).sort();
    rounds++;
    if (JSON.stringify(live) !== JSON.stringify(rebuilt)) mismatches.push({ round, live, rebuilt });
  }
  check(`${rounds} random sessions: every pairing identical (${mismatches.length} differ)`, mismatches.length === 0, mismatches[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
