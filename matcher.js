// Pairs up opening and closing option fills (per OCC symbol) into
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

const DAY_MS = 24 * 60 * 60 * 1000;
// An open leg older than this is treated as dead and dropped rather than
// left waiting for a close that is never coming.
const MAX_LEG_AGE_DAYS = 45;

// Pulls the expiration date out of an OCC symbol.
// Format: 6-char padded ticker + YYMMDD + C/P + 8-digit strike.
// e.g. "NIO   260918C00005000" expires 2026-09-18.
// Returns null if the symbol doesn't parse, so callers fall back to the
// age-based check instead of guessing.
function expirationFromOcc(occ) {
  if (!occ || typeof occ !== 'string') return null;
  const m = occ.replace(/\s+/g, ' ').trim().match(/(\d{6})[CP]\d{8}$/);
  if (!m) return null;
  const s = m[1];
  const year = 2000 + parseInt(s.slice(0, 2), 10);
  const month = parseInt(s.slice(2, 4), 10) - 1;
  const day = parseInt(s.slice(4, 6), 10);
  const d = new Date(Date.UTC(year, month, day, 23, 59, 59));
  return isNaN(d.getTime()) ? null : d.getTime();
}

// True once a leg can no longer be legitimately closed: its contract has
// expired, or it's simply been sitting unmatched too long.
//
// This is what prevents the mis-pairing this function was rewritten to fix.
// An option that expires worthless never produces a closing fill, so its
// open leg used to sit in the queue forever. Trading that SAME contract
// again weeks later would then match the new close against the ancient
// open — producing a "trade" with an entry and exit a month apart, and a
// bar replay covering thousands of candles.
function isLegDead(leg, atTimestamp) {
  const exp = expirationFromOcc(leg.occ);
  if (exp != null && atTimestamp > exp) return true;
  if (leg.openTimestamp && atTimestamp - leg.openTimestamp > MAX_LEG_AGE_DAYS * DAY_MS) return true;
  return false;
}

function sameTradingDay(aMs, bMs) {
  if (!aMs || !bMs) return false;
  return new Date(aMs).toDateString() === new Date(bMs).toDateString();
}

// Picks which open leg a closing fill should be matched against.
//
// Plain FIFO (always the oldest) is what caused the mis-pairing. This
// trader scalps — opens and closes are almost always the same session — so
// a same-day open is overwhelmingly the right match. Only when there's no
// same-day candidate does it fall back to FIFO, and dead legs are never
// eligible at all.
function pickLegForClose(openLegs, fill) {
  const eligible = openLegs
    .map((leg, idx) => ({ leg, idx }))
    .filter(({ leg }) =>
      leg.occ === fill.occ &&
      leg.remaining > 0 &&
      leg.openTimestamp <= fill.timestamp && // a close can't precede its own open
      !isLegDead(leg, fill.timestamp)
    );
  if (!eligible.length) return -1;

  const sameDay = eligible.filter(({ leg }) => sameTradingDay(leg.openTimestamp, fill.timestamp));
  if (sameDay.length) {
    // Newest same-day open first — matches how a scalper actually layers in
    // and out within a session.
    sameDay.sort((a, b) => b.leg.openTimestamp - a.leg.openTimestamp);
    return sameDay[0].idx;
  }
  // No same-day open: fall back to oldest-first (standard FIFO).
  eligible.sort((a, b) => a.leg.openTimestamp - b.leg.openTimestamp);
  return eligible[0].idx;
}

// state: { openLegs: [...], pending: [...] }
// fills: array of normalized fills, already sorted by time, not yet processed
// (caller is responsible for not re-feeding already-processed transactionIds)
function processFills(fills, state) {
  const openLegs = [...state.openLegs];
  const newPending = [];
  let latestTimestamp = 0;

  for (const fill of fills) {
    if (fill.timestamp > latestTimestamp) latestTimestamp = fill.timestamp;

    if (isOpen(fill.instruction)) {
      openLegs.push({
        occ: fill.occ,
        ticker: fill.ticker,
        dir: dirFromPutCall(fill.putCall),
        openPrice: fill.price,
        openDate: fill.date,
        openTime: fill.time,
        openTimestamp: fill.timestamp,
        totalQuantity: fill.quantity, // how many contracts were opened in total
        remaining: fill.quantity,
      });
      continue;
    }
    if (isClose(fill.instruction)) {
      let qtyToClose = fill.quantity;
      while (qtyToClose > 0) {
        const legIdx = pickLegForClose(openLegs, fill);
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
        const remainingAfterThis = leg.remaining - qtyMatched;
        const heldMs = fill.timestamp - leg.openTimestamp;
        newPending.push({
          id: `${fill.occ}-${leg.openTime}-${fill.time}-${Math.random().toString(36).slice(2, 7)}`,
          ticker: leg.ticker,
          occ: leg.occ,
          dir: leg.dir,
          contracts: qtyMatched,
          contractsOpened: leg.totalQuantity,
          // 'Closed' once every contract from the original opening has been
          // matched to a close (possibly across several closing fills);
          // 'Partial Fill' if some of the original position is still open.
          fillStatus: remainingAfterThis === 0 ? 'Closed' : 'Partial Fill',
          entryDate: leg.openDate,
          entryTime: leg.openTime,
          entryTimestamp: leg.openTimestamp,
          exitDate: fill.date,
          exitTime: fill.time,
          exitTimestamp: fill.timestamp,
          optEntry: leg.openPrice,
          optExit: fill.price,
          undEntry: null, // filled in by cron.js after matching, via a separate underlying-price lookup
          undExit: null,
          pnlDollar: Math.round(pnlDollar * 100) / 100,
          pnlPercent: Math.round(pnlPercent * 10) / 10,
          winLoss: pnlDollar >= 0 ? 'Win' : 'Loss',
          // Flags a pairing that spans more than a day. These are scalps, so
          // this should essentially never fire — if it does, the match is
          // worth a look rather than being trusted silently.
          suspectPairing: heldMs > DAY_MS,
          source: 'schwab-auto',
          needsTagging: true,
        });
        leg.remaining = remainingAfterThis;
        qtyToClose -= qtyMatched;
      }
    }
  }

  // Drop fully-closed legs, and also purge dead ones (expired contracts,
  // or legs old enough that no close is coming) so they can't poison a
  // future match the way the Jun/Jul NIO pairing did.
  const asOf = latestTimestamp || Date.now();
  const remainingOpenLegs = openLegs.filter(l => l.remaining > 0 && !isLegDead(l, asOf));

  return {
    updatedState: {
      openLegs: remainingOpenLegs,
      pending: [...newPending, ...state.pending],
    },
    newPending,
  };
}
module.exports = { processFills, expirationFromOcc, isLegDead };
