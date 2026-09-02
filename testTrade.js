const { processFills } = require('./matcher');
const { getValidAccessToken } = require('./auth');

// A REHEARSED TRADE, run through the real machinery.
//
// Two synthetic fills -- a buy to open and a sell to close on a recent
// real trading session -- are pushed through the SAME matcher and the
// SAME enrichment steps a genuine Schwab fill goes through: the stock
// price at each end, the thirteen timeframes, the replay candles, the AI
// reading the setup, and the stop rule. Every step reports whether it
// worked and what it produced.
//
// Two rules this is built around:
//
//   1. It calls the REAL steps, never a copy. A rehearsal that runs a
//      copy of the pipeline proves only that the copy works.
//   2. It cannot reach his journal. Nothing here writes to the trade
//      store, touches lastProcessedIds, or goes near the pending list --
//      the finished trade is handed straight back in the answer, marked
//      as a rehearsal, and the app keeps it somewhere else entirely.
//      His journal has been polluted once already, with 161 contracts he
//      never bought.

const ENTRY_HOUR_ET = 10, ENTRY_MIN_ET = 30;
const HOLD_MINUTES = 22;        // past the fifteen-minute mark on purpose, so the middle of a trade is exercised too
const CONTRACTS = 2;
const OPEN_PRICE = 1.24;
const CLOSE_PRICE = 1.61;
// Fees are derived from the cash, so the cash has to be right: a buy pays
// the contracts' value PLUS fees, a sell brings in that value MINUS fees.
const FEE_PER_SIDE = 1.32;

// Eastern time, without pulling in a date library. The offset flips on the
// US changeover dates; Intl knows them, so ask it rather than guessing.
function easternOffsetMinutes(date) {
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(date).find(p => p.type === 'timeZoneName');
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(tz ? tz.value : '');
  if (!m) return -300;
  return Number(m[1]) * 60 + (m[1].startsWith('-') ? -1 : 1) * Number(m[2] || 0);
}

// The most recent weekday that is not today -- today's candles may not
// exist yet, and a session still in progress is a moving target. Weekends
// step back to Friday. Not a holiday calendar: if the day picked turns
// out to have no market data, the steps below say so plainly rather than
// pretending.
function pickSession(now = new Date()) {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < 6; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = t => parts.find(p => p.type === t).value;
    const weekday = get('weekday');
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      return { year: get('year'), month: get('month'), day: get('day') };
    }
    d.setTime(d.getTime() - 24 * 60 * 60 * 1000);
  }
  return null;
}

// A moment on that session, given as Eastern wall-clock, turned into a
// real instant. Done in two passes because the offset itself depends on
// the date.
function easternMoment(session, hour, minute) {
  const naive = Date.UTC(Number(session.year), Number(session.month) - 1, Number(session.day), hour, minute, 0);
  const offset = easternOffsetMinutes(new Date(naive));
  return naive - offset * 60 * 1000;
}

function two(n) { return String(n).padStart(2, '0'); }

// Schwab's contract symbols: six characters of ticker, then the expiry as
// YYMMDD, then C or P, then the strike in thousandths padded to eight.
function buildOcc(ticker, session, strike, putCall) {
  const yy = String(session.year).slice(2);
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker.padEnd(6, ' ')}${yy}${session.month}${session.day}${putCall === 'PUT' ? 'P' : 'C'}${strikePart}`;
}

function buildFills(session, strike, entryMs, exitMs) {
  const occ = buildOcc('SPY', session, strike, 'CALL');
  const gross = (price) => price * 100 * CONTRACTS;
  const at = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const get = t => parts.find(p => p.type === t).value;
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${hour}:${get('minute')}`;
  };
  const dateStr = `${session.year}-${session.month}-${session.day}`;
  return [
    {
      transactionId: 'rehearsal-open', occ, ticker: 'SPY',
      instruction: 'BUY_TO_OPEN', putCall: 'CALL',
      price: OPEN_PRICE, quantity: CONTRACTS, fees: FEE_PER_SIDE,
      netAmount: -(gross(OPEN_PRICE) + FEE_PER_SIDE),
      date: dateStr, time: at(entryMs), timestamp: entryMs,
    },
    {
      transactionId: 'rehearsal-close', occ, ticker: 'SPY',
      instruction: 'SELL_TO_CLOSE', putCall: 'CALL',
      price: CLOSE_PRICE, quantity: CONTRACTS, fees: FEE_PER_SIDE,
      netAmount: gross(CLOSE_PRICE) - FEE_PER_SIDE,
      date: dateStr, time: at(exitMs), timestamp: exitMs,
    },
  ];
}

// Each step runs on its own and reports for itself. One failing step must
// not stop the ones after it -- the whole value of this is finding out
// which parts work, not stopping at the first that does not.
async function runStep(steps, name, fn) {
  const startedAt = Date.now();
  try {
    const summary = await fn();
    steps.push({ name, ok: true, summary: summary || 'Done.', ms: Date.now() - startedAt });
    return true;
  } catch (err) {
    steps.push({
      name, ok: false,
      summary: (err && err.message) ? String(err.message).slice(0, 200) : 'It did not work.',
      ms: Date.now() - startedAt,
    });
    return false;
  }
}

function describeAlignment(trade) {
  if (!trade.ftfcRun) return 'Measured — no run of four agreed.';
  const dir = trade.ftfcDirection === 'bull' ? 'bullish'
    : trade.ftfcDirection === 'bear' ? 'bearish' : 'unclear';
  const n = (trade.ftfcTimeframesInRun || []).length;
  return `${n} timeframes agreed, ${dir}.`;
}

async function runTestTrade(deps) {
  const {
    getUnderlyingPriceAt, enrichWithUnderlyingPrices, enrichWithFtfc,
    enrichWithReplayData, enrichWithStopRule, enrichWithStrategy,
    getToken = getValidAccessToken,
  } = deps;

  const steps = [];
  const session = pickSession();
  if (!session) {
    return { ok: false, steps: [{ name: 'Pick a trading day', ok: false, summary: 'Could not work out a recent trading day.', ms: 0 }], trade: null };
  }
  const entryMs = easternMoment(session, ENTRY_HOUR_ET, ENTRY_MIN_ET);
  const exitMs = entryMs + HOLD_MINUTES * 60 * 1000;

  let token = null;
  await runStep(steps, 'Reach Schwab', async () => {
    token = await getToken();
    return 'Signed in and reachable.';
  });

  // The strike is chosen around where the stock actually was, so the
  // rehearsed contract is one that could really have existed.
  let strike = 600;
  await runStep(steps, 'Find where SPY was', async () => {
    const price = await getUnderlyingPriceAt(token, 'SPY', entryMs);
    if (price == null) throw new Error('No price came back for that day. Schwab keeps only about a month of minute data.');
    strike = Math.round(price);
    return `SPY was around $${price.toFixed(2)} at 10:30.`;
  });

  const fills = buildFills(session, strike, entryMs, exitMs);

  // A FRESH, EMPTY state. Never his. Nothing read, nothing written.
  let trade = null;
  await runStep(steps, 'Pair the buy with the sell', async () => {
    // A FRESH, EMPTY state carrying every field the real matcher reads.
    // Nothing of his is read and nothing is written back.
    const { newPending } = processFills(fills, { openLegs: [], pending: [], lastProcessedIds: [] });
    if (!newPending.length) throw new Error('The two fills did not pair into a trade.');
    trade = newPending[0];
    trade.isTest = true;
    return `${trade.ticker} ${trade.dir}, ${trade.contracts} contracts, in at ${trade.entryTime} and out at ${trade.exitTime}.`;
  });

  if (!trade) return { ok: false, steps, trade: null };

  await runStep(steps, 'Work out the money', async () => {
    if (trade.pnlDollar == null) throw new Error('No profit or loss was worked out.');
    const fees = trade.fees == null ? 'no fees' : `$${trade.fees.toFixed(2)} of fees`;
    return `${trade.pnlDollar >= 0 ? '+' : '-'}$${Math.abs(trade.pnlDollar).toFixed(2)} before fees, ${fees}.`;
  });

  await runStep(steps, 'Price the stock at both ends', async () => {
    await enrichWithUnderlyingPrices(token, [trade]);
    if (trade.undEntry == null) throw new Error('No stock price was found for the entry.');
    const how = trade.undPricedWithAlpaca ? 'from Alpaca, exact' : `from Schwab candles (${trade.undEntrySource || 'unknown'})`;
    return `In at $${trade.undEntry.toFixed(2)}, out at ${trade.undExit != null ? '$' + trade.undExit.toFixed(2) : 'no price'} — ${how}.`;
  });

  await runStep(steps, 'Measure the 13 timeframes', async () => {
    await enrichWithFtfc(token, [trade]);
    return describeAlignment(trade);
  });

  await runStep(steps, 'Load the replay candles', async () => {
    await enrichWithReplayData(token, [trade]);
    const n = (trade.replayData && trade.replayData.candles || []).length;
    if (!n) throw new Error('No candles came back, so Bar Replay would have nothing to show.');
    return `${n} one-minute candles ready for Bar Replay.`;
  });

  await runStep(steps, 'Read the setup with AI', async () => {
    await enrichWithStrategy([trade]);
    if (!trade.strat && !trade.play) {
      throw new Error('The AI did not name a setup or a play it was confident about.');
    }
    const bits = [];
    if (trade.stratNotation) bits.push(`${trade.stratNotation}${trade.stratNotationDirection ? ' · ' + trade.stratNotationDirection : ''}`);
    if (trade.strat) bits.push(trade.strat);
    if (trade.play) bits.push(`play: ${trade.play}`);
    if (trade.broadeningDetected) bits.push(`broadening: ${trade.broadeningDetected}`);
    return bits.join(' — ') || 'Read, but nothing confident.';
  });

  await runStep(steps, 'Work out the stop', async () => {
    await enrichWithStopRule(token, [trade]);
    if (trade.stop == null) return 'No stop rule is set, so none was worked out. Nothing wrong.';
    return `Stop at $${Number(trade.stop).toFixed(2)}${trade.rrRealized != null ? `, giving ${Number(trade.rrRealized).toFixed(2)}R` : ''}.`;
  });

  trade.isTest = true;
  trade.source = 'rehearsal';
  return { ok: steps.every(s => s.ok), steps, trade };
}

module.exports = {
  runTestTrade, pickSession, easternMoment, buildOcc, buildFills,
  easternOffsetMinutes, HOLD_MINUTES, CONTRACTS, OPEN_PRICE, CLOSE_PRICE, FEE_PER_SIDE,
};
