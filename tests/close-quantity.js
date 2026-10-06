// STEP D of the audit's remediation (F2), service half, authorized by the
// owner on 6 October 2026: "I authorize Step D implementation."
//
// The app recognises a trade by its pair of broker fills, and refuses a NEW
// pair only if it would make one of those fills cover more contracts than the
// fill holds. It knows how many contracts the purchase held (contractsOpened)
// but not how many the sale held. Each trade now also carries closeQuantity:
// the contracts in its closing fill. Data only -- pairing, money and ids are
// exactly as before, which import-exact checks to the cent.
const path = require('path');
const { processFills } = require(path.join(__dirname, '..', 'matcher.js'));

let pass = 0, fail = 0;
const check = (label, ok) => { if (ok) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } };

const OCC = 'SPY   261231C00600000';
const T0 = Date.now() - 3 * 3600e3;
function fill(id, kind, minute, qty){
  const ts = T0 + minute * 60000; const d = new Date(ts);
  return { transactionId: id, occ: OCC, ticker: 'SPY', putCall: 'CALL',
    instruction: kind === 'open' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
    price: 1, quantity: qty, fees: 0.66,
    date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), timestamp: ts };
}
const run = fills => processFills(fills, { openLegs: [], pending: [] }).newPending;
const view = ts => ts.map(t => `${t.fills.join('+')} x${t.contracts} of ${t.contractsOpened}/${t.closeQuantity}`).sort();

console.log('--- one purchase of 2, sold in two pieces of 1 ---');
{
  const ts = run([fill('o1', 'open', 0, 2), fill('c1', 'close', 1, 1), fill('c2', 'close', 2, 1)]);
  check(`two trades (${ts.length})`, ts.length === 2);
  check(`each sale's closeQuantity is 1 (${JSON.stringify(view(ts))})`, ts.every(t => t.closeQuantity === 1));
  check('pairing unchanged: o1+c1 and o1+c2, 1 contract each, purchase of 2',
    JSON.stringify(view(ts)) === JSON.stringify(['o1+c1 x1 of 2/1', 'o1+c2 x1 of 2/1']));
}

console.log('\n--- two purchases of 1, closed by one sale of 2 ---');
{
  const ts = run([fill('a', 'open', 0, 1), fill('b', 'open', 1, 1), fill('s', 'close', 2, 2)]);
  check(`two trades (${ts.length})`, ts.length === 2);
  check(`both carry the sale's closeQuantity of 2 (${JSON.stringify(view(ts))})`, ts.every(t => t.closeQuantity === 2));
  check('pairing unchanged: a+s and b+s, 1 contract each',
    JSON.stringify(view(ts)) === JSON.stringify(['a+s x1 of 1/2', 'b+s x1 of 1/2']));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
