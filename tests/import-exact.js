// Marked against his own Schwab export: 480 real fills pushed through the
// REAL matcher, and the money that comes out compared with what the broker
// actually charged and paid.
//
// Pairing is not the point here -- which buy meets which sell can differ
// without changing a single total, because every contract is paired either
// way. What IS the point is that nothing is lost, invented or rounded away
// on the journey from a fill to a trade.
const fs = require('fs');
const path = require('path');
const { processFills } = require('../matcher');

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log(`PASS: ${l}`); } else { fail++; console.log(`FAIL: ${l}`); } };

const EXPORTS = '/root/.claude/uploads/4bc092e0-d5e0-5924-af5c-c049e9563cea';
const FILES = fs.existsSync(EXPORTS)
  ? fs.readdirSync(EXPORTS).filter(f => /Schwab.*\.csv$/i.test(f)).map(f => path.join(EXPORTS, f))
  : [];

function splitCsvLine(line){
  const out = []; let cur = ''; let q = false;
  for(let i = 0; i < line.length; i++){
    const c = line[i];
    if(q){ if(c === '"' && line[i+1] === '"'){ cur += '"'; i++; } else if(c === '"') q = false; else cur += c; }
    else if(c === '"') q = true;
    else if(c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out.map(s => s.trim());
}
const money = s => { const t = String(s||'').replace(/[$,]/g,'').trim(); return t ? Number(t) : 0; };

// "SPY 06/22/2026 745.00 P" -> the OCC code the rest of the app speaks.
function occOf(sym){
  const m = sym.match(/^([A-Z.]{1,6}) (\d{2})\/(\d{2})\/(\d{4}) ([\d.]+) ([CP])$/);
  if(!m) return null;
  return m[1].padEnd(6,' ') + m[4].slice(2) + m[2] + m[3] + m[6] + String(Math.round(Number(m[5])*1000)).padStart(8,'0');
}

// The export carries no times. Fills are given times in file order, buys
// before sells within a day, which is the only ordering the file supports.
// It cannot change any total.
function fillsFromExport(file){
  const lines = fs.readFileSync(file,'utf8').split(/\r?\n/).filter(l => l.trim());
  const head = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const at = n => head.findIndex(h => h === n || h.startsWith(n));
  const iD = at('date'), iA = at('action'), iS = at('symbol'), iQ = at('quantity'),
        iP = at('price'), iF = at('fees'), iAmt = at('amount');
  const rows = [];
  for(let i = 1; i < lines.length; i++){
    const f = splitCsvLine(lines[i]);
    const action = f[iA];
    if(action !== 'Buy to Open' && action !== 'Sell to Close') continue;
    const m = f[iD].match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!m) continue;
    rows.push({ date: `${m[3]}-${m[1]}-${m[2]}`, isBuy: action === 'Buy to Open',
                symbol: f[iS], qty: Number(f[iQ]), price: money(f[iP]),
                fees: iF >= 0 ? money(f[iF]) : 0, amount: money(f[iAmt]) });
  }
  rows.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.isBuy === b.isBuy ? 0 : (a.isBuy ? -1 : 1)));
  let n = 0;
  return rows.map(r => {
    const ts = Date.parse(r.date + 'T14:30:00Z') + (n++) * 60000;
    return {
      occ: occOf(r.symbol), ticker: r.symbol.split(' ')[0],
      putCall: r.symbol.endsWith('P') ? 'PUT' : 'CALL',
      instruction: r.isBuy ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
      quantity: r.qty, price: r.price, fees: r.fees,
      date: r.date, time: new Date(ts).toISOString().slice(11,16), timestamp: ts,
      transactionId: 'csv' + n, _amount: r.amount,
    };
  });
}

const cents = n => Math.round(n * 100);

if(!FILES.length){
  console.log('His export files are not on this machine, so the real-data checks are skipped.');
} else {
  for(const file of FILES){
    const fills = fillsFromExport(file);
    const name = path.basename(file);
    // The broker's own arithmetic, from the file and nothing else.
    const brokerFees = fills.reduce((s,f) => s + cents(f.fees), 0);
    const brokerCash = fills.reduce((s,f) => s + cents(f._amount), 0);
    const brokerBought = fills.filter(f => f.instruction === 'BUY_TO_OPEN').reduce((s,f) => s + f.quantity, 0);

    // The app's own arithmetic, through the real matcher, fed in the
    // batches a real sync would use rather than all at once.
    let state = { openLegs: [], pending: [], lastProcessedIds: [] };
    const trades = [];
    for(let i = 0; i < fills.length; i += 37){
      const out = processFills(fills.slice(i, i + 37), state);
      trades.push(...out.newPending);
      // Carried forward exactly as the real sync carries it, so a position
      // opened in one batch and closed in another behaves as it really does.
      state = { openLegs: out.updatedState.openLegs, pending: [], lastProcessedIds: [] };
    }
    const ourFees = trades.reduce((s,t) => s + cents(t.fees || 0), 0);
    const ourGross = trades.reduce((s,t) => s + cents(t.pnlDollar || 0), 0);
    const ourNet = trades.reduce((s,t) => s + cents(t.pnlNet == null ? t.pnlDollar || 0 : t.pnlNet), 0);
    const ourContracts = trades.reduce((s,t) => s + t.contracts, 0);

    console.log(`\n--- ${name}: ${fills.length} fills -> ${trades.length} trades ---`);
    console.log(`    fees      broker $${(brokerFees/100).toFixed(2)}   journal $${(ourFees/100).toFixed(2)}`);
    console.log(`    after fees broker $${(brokerCash/100).toFixed(2)}   journal $${(ourNet/100).toFixed(2)}`);
    console.log(`    contracts broker ${brokerBought}   journal ${ourContracts}`);

    check(`${name}: every contract bought becomes a contract in the journal`, ourContracts === brokerBought);
    check(`${name}: the fees add up to the penny Schwab charged`, ourFees === brokerFees);
    check(`${name}: profit before fees matches to the penny`, ourGross === brokerCash + brokerFees);
    check(`${name}: profit after fees matches to the penny`, ourNet === brokerCash);
    check(`${name}: no trade was left without a fee`, trades.every(t => t.fees != null));
    check(`${name}: no trade was left without an after-fee figure`, trades.every(t => t.pnlNet != null));
    check(`${name}: nothing was left open at the end`,
      state.openLegs.filter(l => l.remaining > 0).length === 0);
    check(`${name}: every trade has both prices and a size`,
      trades.every(t => t.optEntry != null && t.optExit != null && t.contracts > 0));
    check(`${name}: no two trades share an identity`,
      new Set(trades.map(t => `${t.occ}|${t.entryTime}|${t.exitTime}|${t.optEntry}|${t.optExit}|${t.contracts}`)).size === trades.length);
  }
}

// ===== Fees allocated in pieces still add up ==========================
{
  const t = n => Date.parse('2026-03-02T15:00:00Z') + n * 60000;
  const mk = (instruction, qty, price, fees, n) => ({
    occ: 'SPY   260302C00700000', ticker: 'SPY', putCall: 'CALL', instruction,
    quantity: qty, price, fees, date: '2026-03-02',
    time: new Date(t(n)).toISOString().slice(11,16), timestamp: t(n),
    transactionId: 'p' + n + instruction + qty,
  });
  // The two that used to lose and invent a cent.
  const cases = [[1.00, 3, [1,1,1]], [2.00, 3, [1,1,1]], [4.62, 7, [3,4]], [3.97, 6, [1,2,3]], [0.01, 5, [1,1,1,1,1]]];
  let allOk = true;
  for(const [openFee, qty, closes] of cases){
    const fills = [mk('BUY_TO_OPEN', qty, 1.00, openFee, 0)];
    closes.forEach((c, i) => fills.push(mk('SELL_TO_CLOSE', c, 1.50, 0.66 * c, i + 1)));
    const { newPending } = processFills(fills, { openLegs: [], pending: [], lastProcessedIds: [] });
    const e = newPending.reduce((s,p) => s + cents(p.entryFees), 0);
    const x = newPending.reduce((s,p) => s + cents(p.exitFees), 0);
    if(e !== cents(openFee) || x !== closes.reduce((s,c) => s + cents(0.66 * c), 0)) allOk = false;
  }
  check('a fee split across several closes still adds to what was charged', allOk);
}

// ===== A leg saved before the cent-exact split still works ============
{
  const t = n => Date.parse('2026-03-02T15:00:00Z') + n * 60000;
  const oldLeg = { occ: 'SPY   260302C00700000', ticker: 'SPY', dir: 'Long', openPrice: 1.00,
    openDate: '2026-03-02', openTime: '10:00', openTimestamp: t(0),
    totalQuantity: 3, remaining: 3, openFees: 1.00 };   // no openFeeCents on it
  const close = { occ: 'SPY   260302C00700000', ticker: 'SPY', putCall: 'CALL',
    instruction: 'SELL_TO_CLOSE', quantity: 3, price: 1.50, fees: 1.98,
    date: '2026-03-02', time: '10:05', timestamp: t(5), transactionId: 'old1' };
  const { newPending } = processFills([close], { openLegs: [oldLeg], pending: [], lastProcessedIds: [] });
  check('a position opened before this change still closes correctly',
    newPending.length === 1 && cents(newPending[0].fees) === cents(2.98));
}

// ===== An unknown fee stays unknown, never becomes zero ===============
{
  const t = n => Date.parse('2026-03-02T15:00:00Z') + n * 60000;
  const mk = (instruction, qty, fees, n) => ({
    occ: 'SPY   260302C00700000', ticker: 'SPY', putCall: 'CALL', instruction,
    quantity: qty, price: instruction === 'BUY_TO_OPEN' ? 1.0 : 1.5, fees,
    date: '2026-03-02', time: new Date(t(n)).toISOString().slice(11,16),
    timestamp: t(n), transactionId: 'u' + n,
  });
  const { newPending } = processFills([mk('BUY_TO_OPEN', 2, null, 0), mk('SELL_TO_CLOSE', 2, 1.32, 1)],
    { openLegs: [], pending: [], lastProcessedIds: [] });
  check('a fee that is not known stays unknown', newPending[0].fees === null);
  check('  and the after-fee figure stays unknown with it', newPending[0].pnlNet === null);
  check('  while the before-fee figure is still worked out', newPending[0].pnlDollar === 100);
}

// ---- Every trade says which broker fills it was built from ------------
//
// This is what stops a second pairing of the same fills getting in. His real
// journal had four trades that do not exist, each sharing its purchase and
// its sale with a real one but carrying a different size, because the fills
// went through the matcher twice and came out matched up differently. A
// purchase is a purchase whichever sale it is paired to, so the references
// catch it where the trade's shape never could.
{
  const mk = (instruction, quantity, price, fees, n) => ({
    occ: 'SPY   260609C00745000', ticker: 'SPY', putCall: 'CALL',
    instruction, quantity, price, fees,
    date: '2026-06-09', time: '09:3' + n,
    timestamp: Date.parse('2026-06-09T13:3' + n + ':00Z'),
    transactionId: 'fill-' + n,
  });
  // His real 9 June: bought 1 then 2, sold 2 then 1.
  const fills = [mk('BUY_TO_OPEN',1,1.21,0.66,0), mk('BUY_TO_OPEN',2,1.11,1.32,1),
                 mk('SELL_TO_CLOSE',2,1.22,1.34,2), mk('SELL_TO_CLOSE',1,1.43,0.66,3)];
  const out = processFills(fills, { openLegs: [], pending: [], lastProcessedIds: [] });
  const trades = out.newPending;
  check('every trade says which fills it came from', trades.every(t => Array.isArray(t.fills) && t.fills.length));
  check('each names both a purchase and a sale', trades.every(t => t.fills.length === 2));
  check('every reference is one the broker actually gave',
    trades.every(t => t.fills.every(f => fills.some(x => x.transactionId === f))));

  // The same fills a second time, from a clean slate, is what produced his
  // phantoms. However they pair, they can only cite fills already spoken for.
  const again = processFills(fills, { openLegs: [], pending: [], lastProcessedIds: [] }).newPending;
  const claimed = new Set(trades.flatMap(t => t.fills));
  check(`a second pass can only cite fills already claimed (${again.length} trades)`,
    again.length > 0 && again.every(t => t.fills.some(f => claimed.has(f))));

  // And within one pass nothing is invented: every fill is accounted for.
  const cited = new Set(trades.flatMap(t => t.fills));
  check(`all ${fills.length} fills are accounted for, none invented`,
    cited.size === fills.length && [...cited].every(f => fills.some(x => x.transactionId === f)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
