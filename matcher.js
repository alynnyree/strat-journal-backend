// Pairs up opening and closing option fills (FIFO, per OCC symbol) into
// completed trades ready for Strat tagging. Schwab's transaction feed only
// tells you WHAT filled and WHEN — not which Strat setup it was, whether
// FTFC held, or where your stop was. Those stay manual on purpose.
//
// Direction (Long/Short) is based on CALL vs PUT, not buy vs sell — since
// this trader only ever buys to open (never sells to open), a bought call
// is a Long bet and a bought put is a Short bet, regardless of the specific
// buy/sell instruction text Schwab reports.
function dirFromPutCall(putCall) {
  if (putCall === 'CALL') return 'Long';
  if (putCall === 'PUT') return 'Short';
  return null;
}
function isOpen(instruction) {
  return instruction === 'BUY_TO_OPEN' || instruction === 'SELL_TO_OPEN';
}
function isClose(instruction) {
  return instruction === 'BUY_TO_CLOSE' || instruction === 'SELL_TO_CLOSE';
}
// state: { openLegs: [...], pending: [...] }
// fills: array of normalized fills, already sorted by time, not yet processed
// (caller is responsible for not re-feeding already-processed transactionIds)
function processFills(fills, state) {
  const openLegs = [...state.openLegs];
  const newPending = [];
  for (const fill of fills) {
    if (isOpen(fill.instruction)) {
      openLegs.push({
        occ: fill.occ,
        ticker: fill.ticker,
        dir: dirFromPutCall(fill.putCall),
        openPrice: fill.price,
        openDate: fill.date,
        openTime: fill.time,
        remaining: fill.quantity,
      });
      continue;
    }
    if (isClose(fill.instruction)) {
      let qtyToClose = fill.quantity;
      while (qtyToClose > 0) {
        const legIdx = openLegs.findIndex(l => l.occ === fill.occ && l.remaining > 0);
        if (legIdx === -1) break; // close with no matching open on file — skip, can't reconcile
        const leg = openLegs[legIdx];
        const qtyMatched = Math.min(qtyToClose, leg.remaining);
        // P&L is always (exit - entry) per contract — Long or Short, since
        // this trader only buys options, a rising option price is always
        // the winning direction regardless of which underlying direction
        // the position itself is betting on.
        const perContractDiff = (fill.price - leg.openPrice);
        const pnlDollar = perContractDiff * 100 * qtyMatched;
        const pnlPercent = leg.openPrice ? (perContractDiff / leg.openPrice) * 100 : 0;
        newPending.push({
          id: `${fill.occ}-${leg.openTime}-${fill.time}-${Math.random().toString(36).slice(2, 7)}`,
          ticker: leg.ticker,
          occ: leg.occ,
          dir: leg.dir,
          contracts: qtyMatched,
          entryDate: leg.openDate,
          entryTime: leg.openTime,
          exitDate: fill.date,
          exitTime: fill.time,
          optEntry: leg.openPrice,
          optExit: fill.price,
          pnlDollar: Math.round(pnlDollar * 100) / 100,
          pnlPercent: Math.round(pnlPercent * 10) / 10,
          winLoss: pnlDollar >= 0 ? 'Win' : 'Loss',
          source: 'schwab-auto',
          needsTagging: true,
        });
        leg.remaining -= qtyMatched;
        qtyToClose -= qtyMatched;
      }
    }
  }
  const remainingOpenLegs = openLegs.filter(l => l.remaining > 0);
  return {
    updatedState: {
      openLegs: remainingOpenLegs,
      pending: [...newPending, ...state.pending],
    },
    newPending,
  };
}
module.exports = { processFills };
