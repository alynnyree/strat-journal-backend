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

// Picks which open leg a closing fill should be matched against.
//
// THE OLDEST ELIGIBLE PURCHASE FIRST (fifo-v1). The owner chose this rule on
// 7 October 2026 ("Option 1", audit Step E, B3-5), replacing "newest
// same-day purchase first". The journal is rebuilt from the broker ledger
// under the same rule, so trades that arrive from now on pair the way the
// rebuilt history does. Equal purchase moments are ordered by the broker's
// own fill id, compared as a number (the ledger's tie-break), so the choice
// never depends on the order the fills happened to arrive in.
//
// Eligibility is unchanged: a dead leg (past its expiry, or older than
// MAX_LEG_AGE_DAYS) is never eligible, and a close can't precede its open.
// Known difference from the ledger's fifo-v1, kept deliberately and listed in
// the Step E plan: this expiry test is 23:59:59 UTC on the expiry day and
// there is a 45-day age limit; fifo-v1 uses the New York expiry date and has
// no age limit.
function compareFillIds(a, b) {
  const x = a == null ? '' : String(a), y = b == null ? '' : String(b);
  const dx = /^\d+$/.test(x), dy = /^\d+$/.test(y);
  if (dx && dy) return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  if (dx !== dy) return dx ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}
function pickLegForClose(openLegs, fill) {
  const eligible = openLegs
    .map((leg, idx) => ({ leg, idx }))
    .filter(({ leg }) =>
      leg.occ === fill.occ &&
      leg.remaining > 0 &&
      // M-1: the same account, both sides known. Never inferred.
      !!leg.accountRef && !!fill.accountRef && leg.accountRef === fill.accountRef &&
      leg.openTimestamp <= fill.timestamp && // a close can't precede its own open
      !isLegDead(leg, fill.timestamp)
    );
  if (!eligible.length) return -1;
  eligible.sort((a, b) => (a.leg.openTimestamp - b.leg.openTimestamp)
    || compareFillIds(a.leg.openFillId, b.leg.openFillId)
    || (a.idx - b.idx));
  return eligible[0].idx;
}

// WHAT COULD NOT BE PAIRED IS WRITTEN DOWN, NEVER DROPPED (audit H-2;
// authorized by the owner 9 Oct 2026: "I authorize H-2 implementation").
//
// Two paths used to lose broker fills without a word: a sale with no
// eligible purchase on file was discarded (all of it, or the part larger than
// what was open), and a purchase past its expiry or older than 45 days was
// purged. Both are now returned as `exceptions`. Pairing itself is unchanged:
// the same trades come out, in the same order, with the same fees.
//
// An exception is keyed by its kind and the broker fill id, so the same fill
// seen again (a retry, a backfill, a re-run after a reset) names the same
// record. A leg saved before fill references existed has no id: it is keyed by
// what it is made of and marked identityUncertain -- that key only stops the
// record being written twice; it never pairs, merges or resolves anything.
//
// `fullyPaired` is the matcher's own evidence that a fill WAS paired after
// all (H-2 correction, auditor item 1): a sale every contract of which was
// paired in this call, and a purchase whose last contract was paired in this
// call. Only a fill with a broker id is listed, with its broker facts, so a
// record can be matched to it by id AND facts. A fill part of which is left
// unpaired is never listed -- part paired is not paired.
const legShapeKey = l => `S:${l.occ}|${l.openTimestamp}|${l.openPrice}|${l.totalQuantity}`;
const closeShapeKey = f => `S:${f.occ}|${f.timestamp}|${f.price}|${f.quantity}`;
// The kinds a sale's unpaired remainder can be recorded as (H-2, M-1).
const CLOSE_KINDS = ['close-without-open', 'account-mismatch', 'account-unknown'];
function exceptionKey(kind, fillId, shapeKey) {
  return fillId != null ? `${kind}:${fillId}` : `${kind}:${shapeKey}`;
}
// Why a sale found nothing to pair with -- said from what is on file, never
// guessed. Asked of the legs as they stood when the sale arrived.
function whyUnpaired(openLegs, fill, partial) {
  if (partial) return 'more contracts were sold than were open on file for this contract';
  const same = openLegs.filter(l => l.occ === fill.occ && l.remaining > 0);
  if (!same.length) return 'no purchase of this contract is on file';
  if (same.every(l => l.openTimestamp > fill.timestamp)) return 'the only purchase on file is dated after this sale';
  return 'the purchase on file is past its expiry or older than 45 days';
}

// A TRADE'S ID COMES FROM ITS BROKER FILLS (audit M-1, plan v4; authorized
// by the owner 9 Oct 2026: "I authorize M-1 implementation").
//
// It used to end in five random characters, so the same two fills paired
// again got a different id every time. Now it is the contract, both times
// (readable only -- they carry no identity) and "p" plus the first 32 hex
// characters of the SHA-256 of one canonical string built from the ONE
// account both fills belong to and the two broker fill ids, each with its
// length in front and in a fixed order:
//   "m1v1|" + len(acct) + ":" + acct + "|" + len(open) + ":" + open + "|" + len(close) + ":" + close
// "m1v1" is a version: any later change gives different ids, never
// silently equal ones.
//
// A fill id is valid only as Schwab's activityId (decimal digits, after
// String(), nothing else) or "U-" + exactly 32 lowercase hex characters
// (schwabClient's deterministic id for a record with no activityId).
// Anything else counts as MISSING: nothing is trimmed, padded, case-folded
// or replaced. A pairing with a missing id is never queued as a trade (no
// random fallback): it is recorded as "pair-unidentified" instead.
//
// Pairing requires both fills to carry the SAME account reference
// (schwabClient stamps it, from the ledger's own refOf). A sale whose only
// purchase on file is in another account is recorded "account-mismatch";
// one where either side has no reference, "account-unknown". Nothing is
// inferred: a leg with no reference is never assumed to be the only account.
//
// Two DIFFERENT fill pairs under one id (a hash collision, which a 128-bit
// hash makes practically impossible -- detected, never trusted away) queue
// neither trade: one "id-collision" incident holds both pairs.
const crypto = require('crypto');
const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
function validFillId(id) {
  if (id == null) return null;
  const s = String(id);
  return /^[0-9]+$/.test(s) || /^U-[0-9a-f]{32}$/.test(s) ? s : null;
}
function canonicalPair(acct, open, close) {
  const part = v => `${String(v).length}:${v}`;
  return `m1v1|${part(acct)}|${part(open)}|${part(close)}`;
}
function tradeIdFor(occ, openTime, closeTime, acct, open, close, idHash = sha256hex) {
  return `${occ}-${openTime}-${closeTime}-p${idHash(canonicalPair(acct, open, close)).slice(0, 32)}`;
}
// One incident record for two (or more) different pairs under one id. The
// key is the same however often, and by whichever layer, it is seen again.
function collisionIncident(id, trades, layer) {
  const canon = trades.map(t => canonicalPair(t.accountRef, t.fills[0], t.fills[1]));
  return {
    kind: 'id-collision',
    key: collisionKey(id, canon),
    id,
    pairs: trades.map(t => ({ fills: t.fills, accountRef: t.accountRef, occ: t.occ, contracts: t.contracts,
      entryTimestamp: t.entryTimestamp, exitTimestamp: t.exitTimestamp,
      entryFeeCents: t.entryFees == null ? null : Math.round(t.entryFees * 100),
      exitFeeCents: t.exitFees == null ? null : Math.round(t.exitFees * 100) })),
    detectedBy: [layer],
    reason: 'two different broker fill pairs produced the same trade id; neither was queued',
  };
}
function collisionKey(id, canonicals) {
  return `id-collision:${id}:${sha256hex([...new Set(canonicals)].sort().join('\n'))}`;
}
// The same naming of a leg the sync uses (cron.js legKey).
const legKeyOf = l => (l.openFillId ? 'F:' + l.openFillId
  : `S:${l.occ}|${l.openTimestamp}|${l.openPrice}|${l.totalQuantity}`);
// Why a sale's remainder found no purchase in ITS account (M-1). null when
// the account is not the reason, and the H-2 reasons apply.
function accountReason(openLegs, fill) {
  if (!fill.accountRef) return { kind: 'account-unknown', reason: 'the sale carries no account reference' };
  const otherwise = openLegs.filter(l => l.occ === fill.occ && l.remaining > 0
    && l.openTimestamp <= fill.timestamp && !isLegDead(l, fill.timestamp));
  if (otherwise.some(l => !l.accountRef)) return { kind: 'account-unknown', reason: 'a purchase of this contract on file carries no account reference' };
  if (otherwise.some(l => l.accountRef !== fill.accountRef)) return { kind: 'account-mismatch', reason: 'the purchase of this contract on file is in another account' };
  return null;
}

// state: { openLegs: [...], pending: [...] }
// fills: array of normalized fills, already sorted by time, not yet processed
// (caller is responsible for not re-feeding already-processed transactionIds)
// opts.idHash: tests only, to force a collision. Never passed by the service.
function processFills(fills, state, opts = {}) {
  const idHash = opts.idHash || sha256hex;
  const openLegs = [...state.openLegs];
  const newPending = [];
  const exceptions = [];
  const fullyPaired = [];
  const pairsOfLeg = new Map(); // leg -> what this call paired it with
  const newlyOpenedLegs = []; // legs opened THIS call only — for a one-time "trade opened" notification, not a repeat on every leg still sitting open from before
  let latestTimestamp = 0;

  for (const fill of fills) {
    if (fill.timestamp > latestTimestamp) latestTimestamp = fill.timestamp;

    if (isOpen(fill.instruction)) {
      const leg = {
        occ: fill.occ,
        ticker: fill.ticker,
        dir: dirFromPutCall(fill.putCall),
        openPrice: fill.price,
        openDate: fill.date,
        openTime: fill.time,
        openTimestamp: fill.timestamp,
        totalQuantity: fill.quantity, // how many contracts were opened in total
        remaining: fill.quantity,
        openFees: fill.fees,          // fees for the WHOLE opening, split below when it closes in pieces
        // The same fee in whole cents, drawn down as the position closes.
        // Kept separately because a PROPORTION of a fee, rounded, does not
        // add back up: $1.00 over three contracts closed one at a time
        // paid out as 33+33+33 = 99 cents, and $2.00 as 67+67+67 = $2.01.
        // A cent lost or invented on every position that closes in pieces.
        openFeeCents: fill.fees == null ? null : Math.round(fill.fees * 100),
        // Schwab's own reference for the purchase this leg came from. See
        // the note on `fills` below: this is what makes a trade traceable
        // back to the broker rather than identifiable only by its shape.
        openFillId: fill.transactionId == null ? null : String(fill.transactionId),
        // M-1: the account of the opening fill; a sale pairs only with its own.
        accountRef: fill.accountRef || null,
      };
      openLegs.push(leg);
      newlyOpenedLegs.push(leg);
      continue;
    }
    if (isClose(fill.instruction)) {
      let qtyToClose = fill.quantity;
      const pairedWith = []; // what this sale was paired with, in this call
      // What is left of THIS closing fill's fee, in whole cents, as it is
      // spread across however many open legs it closes.
      const closeFee = { cents: fill.fees == null ? null : Math.round(fill.fees * 100) };
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
        // Each side's fees, allocated in whole cents out of what is LEFT
        // of that fill's charge, with the final piece taking the exact
        // remainder. A fee belongs to a FILL, not to a contract, so the
        // pieces must add back to the penny Schwab charged -- rounding
        // each piece independently did not, and lost or invented a cent
        // on every position closed in more than one go.
        //
        // A leg saved before this existed carries only the dollar figure,
        // so it is converted here rather than being treated as unknown.
        if (leg.openFeeCents === undefined) {
          leg.openFeeCents = leg.openFees == null ? null : Math.round(leg.openFees * 100);
        }
        const drawDown = (holder, key, part, whole) => {
          if (holder[key] == null) return null;
          if (!whole || part >= whole) { const all = holder[key]; holder[key] = 0; return all; }
          const share = Math.round(holder[key] * (part / whole));
          holder[key] -= share;
          return share;
        };
        const entryFeeCents = drawDown(leg, 'openFeeCents', qtyMatched, leg.remaining);
        const exitFeeCents = drawDown(closeFee, 'cents', qtyMatched, qtyToClose);
        const entryFees = entryFeeCents == null ? null : entryFeeCents / 100;
        const exitFees = exitFeeCents == null ? null : exitFeeCents / 100;
        // Unknown on either side means the total is unknown. A missing fee
        // must not quietly become a fee of nothing.
        const fees = (entryFees == null || exitFees == null)
          ? null
          : Math.round((entryFees + exitFees) * 100) / 100;
        const pnlPercent = leg.openPrice ? (perContractDiff / leg.openPrice) * 100 : 0;
        const remainingAfterThis = leg.remaining - qtyMatched;
        const heldMs = fill.timestamp - leg.openTimestamp;
        // M-1: both ids valid, or this piece is not queued (see the header).
        const vOpen = validFillId(leg.openFillId), vClose = validFillId(fill.transactionId);
        const queued = !!(vOpen && vClose);
        const trade = {
          id: queued ? tradeIdFor(fill.occ, leg.openTime, fill.time, leg.accountRef, vOpen, vClose, idHash) : null,
          ticker: leg.ticker,
          occ: leg.occ,
          dir: leg.dir,
          contracts: qtyMatched,
          contractsOpened: leg.totalQuantity,
          // How many contracts the CLOSING fill held (audit Step D). With
          // contractsOpened it lets the app tell a genuine partial close from
          // the same fills paired up twice. Data only: pairing is unchanged.
          closeQuantity: fill.quantity,
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
          entryFees, exitFees, fees,
          // What actually reached the account. Null when the fees are not
          // known, so nothing downstream can mistake "no fee recorded" for
          // "this trade was free".
          pnlNet: fees == null ? null : Math.round((pnlDollar - fees) * 100) / 100,
          winLoss: pnlDollar >= 0 ? 'Win' : 'Loss',
          // Flags a pairing that spans more than a day. These are scalps, so
          // this should essentially never fire — if it does, the match is
          // worth a look rather than being trusted silently.
          suspectPairing: heldMs > DAY_MS,
          heldMs, // used to decide video-vs-screenshot for the trade-capture pipeline — see pushcut.js
          source: 'schwab-auto',
          needsTagging: true,
          // WHICH BROKER FILLS THIS TRADE IS MADE OF.
          //
          // Measured on his real journal (2026-09-09): four trades in it
          // do not exist. Two of them read
          //   09:31 -> 09:36  1 contract  1.11 -> 1.22  fee $1.33
          //   09:31 -> 09:36  2 contracts 1.11 -> 1.22  fee none
          // Same purchase, same sale, same two prices, different SIZE.
          // They are one real trade, paired twice: the fills went through
          // the matcher a second time and came out matched up differently.
          //
          // Nothing downstream could catch that, because a trade was
          // identified by its SHAPE -- contract, both minutes, both prices,
          // size -- and a different pairing has a different shape. So the
          // phantom looked like a brand new trade and was written down. It
          // arrives with no fee, because the fee had already been correctly
          // handed to the real trade, which is why he had four trades
          // "waiting for a fee" that could never get one.
          //
          // These references cannot be re-pairing-dependent: a purchase is
          // a purchase whichever sale it is matched to. Two trades sharing
          // a fill are two versions of the same thing, and the app refuses
          // the second one on sight.
          fills: [vOpen, vClose],
          // M-1: what the id rests on. "uncertain-fill-id" when either fill
          // is one Schwab sent without an activityId (a "U-" id).
          idBasis: /^U-/.test(vOpen || '') || /^U-/.test(vClose || '') ? 'uncertain-fill-id' : 'fill-pair',
          accountRef: leg.accountRef,
        };
        if (queued) newPending.push(trade);
        else {
          const rawClose = fill.transactionId == null ? null : String(fill.transactionId);
          exceptions.push({
            kind: 'pair-unidentified',
            key: `pair-unidentified:${legKeyOf(leg)}>${rawClose != null ? 'F:' + rawClose : closeShapeKey(fill)}`,
            identityUncertain: true,
            legKey: legKeyOf(leg),
            openFillId: leg.openFillId || null, closeFillId: rawClose,
            occ: fill.occ, ticker: leg.ticker,
            entryDate: leg.openDate, entryTime: leg.openTime, entryTimestamp: leg.openTimestamp,
            exitDate: fill.date, exitTime: fill.time, exitTimestamp: fill.timestamp,
            optEntry: leg.openPrice, optExit: fill.price,
            contracts: qtyMatched, entryFeeCents, exitFeeCents,
            reason: 'a broker fill id is missing or not in a recognised form, so no trade id can be made',
          });
        }
        leg.remaining = remainingAfterThis;
        qtyToClose -= qtyMatched;
        const closeId = fill.transactionId == null ? null : String(fill.transactionId);
        pairedWith.push({ fillId: leg.openFillId || null, contracts: qtyMatched, queued });
        if (!pairsOfLeg.has(leg)) pairsOfLeg.set(leg, []);
        pairsOfLeg.get(leg).push({ fillId: closeId, contracts: qtyMatched, queued });
        // Evidence only when every piece of this purchase in this call became
        // a queued trade (M-1: a piece with no id is not a trade).
        if (remainingAfterThis === 0 && leg.openFillId && pairsOfLeg.get(leg).every(x => x.queued)) {
          fullyPaired.push({
            resolves: ['open-retired'], fillId: leg.openFillId,
            occ: leg.occ, date: leg.openDate, time: leg.openTime, timestamp: leg.openTimestamp,
            price: leg.openPrice, quantity: leg.totalQuantity,
            pairedWith: pairsOfLeg.get(leg).slice(),
          });
        }
      }
      if (qtyToClose === 0 && fill.quantity > 0 && fill.transactionId != null && pairedWith.every(x => x.queued)) {
        fullyPaired.push({
          resolves: CLOSE_KINDS, fillId: String(fill.transactionId),
          occ: fill.occ, date: fill.date, time: fill.time, timestamp: fill.timestamp,
          price: fill.price, quantity: fill.quantity, pairedWith,
        });
      }
      // Whatever is left of the sale had nothing to pair with. It used to
      // vanish here. It is recorded with the rest of its fee, so the pieces
      // of this sale's fee still add up to the cent Schwab charged.
      if (qtyToClose > 0) {
        const fillId = fill.transactionId == null ? null : String(fill.transactionId);
        // M-1: when the account is why nothing was eligible, it says so.
        const acc = accountReason(openLegs, fill);
        const kind = acc ? acc.kind : 'close-without-open';
        exceptions.push({
          kind,
          key: exceptionKey(kind, fillId, closeShapeKey(fill)),
          fillId,
          ...(fillId == null ? { identityUncertain: true } : {}),
          occ: fill.occ, ticker: fill.ticker,
          date: fill.date, time: fill.time, timestamp: fill.timestamp,
          price: fill.price,
          contractsUnmatched: qtyToClose,
          contractsInSale: fill.quantity,
          feeCents: closeFee.cents,
          reason: acc ? acc.reason : whyUnpaired(openLegs, fill, qtyToClose < fill.quantity),
        });
      }
    }
  }

  // M-1: two DIFFERENT fill pairs under one id in this call. Neither is
  // queued and neither overwrites the other: one incident holds both pairs
  // (their contracts and fee cents included, so nothing goes missing), and
  // their fills are not offered as evidence that anything was paired.
  const pairOf = t => `${t.accountRef}|${t.fills.join('+')}`;
  const byId = new Map();
  for (const t of newPending) {
    if (!byId.has(t.id)) byId.set(t.id, new Map());
    byId.get(t.id).set(pairOf(t), t);
  }
  const collided = new Set();
  for (const [id, pairs] of byId) {
    if (pairs.size < 2) continue;
    const members = [...pairs.values()];
    exceptions.push(collisionIncident(id, members, 'matcher'));
    for (const t of members) collided.add(pairOf(t));
  }
  if (collided.size) {
    const gone = newPending.filter(t => collided.has(pairOf(t)));
    const goneFills = new Set(gone.flatMap(t => t.fills));
    newPending.splice(0, newPending.length, ...newPending.filter(t => !collided.has(pairOf(t))));
    fullyPaired.splice(0, fullyPaired.length, ...fullyPaired.filter(f => !goneFills.has(f.fillId)));
  }

  // Drop fully-closed legs, and also purge dead ones (expired contracts,
  // or legs old enough that no close is coming) so they can't poison a
  // future match the way the Jun/Jul NIO pairing did. A purged leg that
  // still held contracts is RECORDED (H-2): never assumed to have expired
  // worthless, which only Schwab's own record can say (H-4, V-2).
  const asOf = latestTimestamp || Date.now();
  for (const l of openLegs) {
    if (!(l.remaining > 0) || !isLegDead(l, asOf)) continue;
    // A leg saved before whole cents existed carries only the dollar figure.
    // Read here without writing back onto the leg (it belongs to the caller).
    const feeCents = l.openFeeCents !== undefined ? l.openFeeCents
      : (l.openFees == null ? null : Math.round(l.openFees * 100));
    const exp = expirationFromOcc(l.occ);
    exceptions.push({
      kind: 'open-retired',
      key: exceptionKey('open-retired', l.openFillId, legShapeKey(l)),
      fillId: l.openFillId || null,
      ...(l.openFillId ? {} : { identityUncertain: true }),
      occ: l.occ, ticker: l.ticker,
      date: l.openDate, time: l.openTime, timestamp: l.openTimestamp,
      price: l.openPrice,
      contractsRemaining: l.remaining,
      contractsOpened: l.totalQuantity,
      feeCents,
      reason: exp != null && asOf > exp
        ? 'past expiry (no sale on file)'
        : 'older than 45 days (no sale on file)',
    });
  }
  const remainingOpenLegs = openLegs.filter(l => l.remaining > 0 && !isLegDead(l, asOf));

  return {
    updatedState: {
      openLegs: remainingOpenLegs,
      pending: [...newPending, ...state.pending],
    },
    newPending,
    newlyOpenedLegs,
    exceptions,
    fullyPaired,
  };
}
module.exports = { processFills, expirationFromOcc, isLegDead,
  validFillId, canonicalPair, tradeIdFor, collisionKey, collisionIncident, CLOSE_KINDS };
