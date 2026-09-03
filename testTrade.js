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

// Schwab keeps minute-by-minute data for only about thirty to
// thirty-five days. Past that the timeframes and the replay have nothing
// to work from -- not a fault, just gone. Said up front rather than
// letting him watch two steps fail for a reason that is nobody's doing.
const MINUTE_DATA_DAYS = 30;

function isTooOldForMinuteData(session, now = Date.now()) {
  const dayMs = easternMoment(session, 12, 0);
  return (now - dayMs) > MINUTE_DATA_DAYS * 24 * 60 * 60 * 1000;
}

// Weekday in Eastern terms, so a Saturday evening in London is still
// Saturday here.
function weekdayOf(session) {
  const ms = easternMoment(session, 12, 0);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    .format(new Date(ms));
}

const REGULAR_OPEN_MINUTES = 9 * 60 + 30;   // 09:30 Eastern
const REGULAR_CLOSE_MINUTES = 16 * 60;      // 16:00 Eastern

// Everything he can choose, checked before anything is fetched. Returns
// either what to run or a plain reason it cannot be run -- never a
// half-valid set of choices that fails confusingly later.
function readChoices(raw = {}) {
  const out = {
    ticker: 'SPY', dir: 'Long',
    holdMinutes: HOLD_MINUTES,
    hour: ENTRY_HOUR_ET, minute: ENTRY_MIN_ET,
    session: null, warnings: [],
  };

  if (raw.ticker != null && String(raw.ticker).trim() !== '') {
    const t = String(raw.ticker).trim().toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(t)) return { error: 'That does not look like a ticker. Use something like SPY or IWM.' };
    out.ticker = t;
  }

  if (raw.dir != null && String(raw.dir).trim() !== '') {
    const d = String(raw.dir).trim().toLowerCase();
    if (d !== 'long' && d !== 'short') return { error: 'Choose Long or Short.' };
    out.dir = d === 'long' ? 'Long' : 'Short';
  }

  if (raw.holdMinutes != null && String(raw.holdMinutes).trim() !== '') {
    const h = Number(raw.holdMinutes);
    if (!Number.isFinite(h) || h < 1 || h > 390) {
      return { error: 'How long the trade ran must be between 1 minute and 390 (a whole trading day).' };
    }
    out.holdMinutes = Math.round(h);
  }

  if (raw.time != null && String(raw.time).trim() !== '') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time).trim());
    if (!m) return { error: 'The time should look like 10:30.' };
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) return { error: 'That is not a real time of day.' };
    out.hour = hh; out.minute = mm;
    out.timeGiven = true;
  }

  if (raw.date != null && String(raw.date).trim() !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.date).trim());
    if (!m) return { error: 'The date should look like 2026-08-28.' };
    const [ , year, month, day ] = m;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) {
      return { error: 'That is not a real date.' };
    }
    out.session = { year, month, day };
    out.dateGiven = true;
  } else {
    out.session = pickSession();
    if (!out.session) return { error: 'Could not work out a recent trading day.' };
  }

  // Warnings, not refusals. Only about the parts he actually pinned: when
  // he does not pin a time, the rehearsal finds a real setup and uses ITS
  // moment, so a warning about the placeholder 10:30 would be nonsense.
  if (out.dateGiven) {
    const weekday = weekdayOf(out.session);
    if (weekday === 'Sat' || weekday === 'Sun') {
      out.warnings.push('That day is a weekend, so the market was shut and there will be no chart data.');
    }
    if (isTooOldForMinuteData(out.session) && !awaitingAlpacaNote(out)) {
      out.warnings.push(`That day is more than ${MINUTE_DATA_DAYS} days ago. Without Alpaca connected, Schwab throws away minute-by-minute data after about a month, so the timeframes and Bar Replay may come back empty. That is not a fault.`);
    }
  }
  if (out.timeGiven) {
    const startMin = out.hour * 60 + out.minute;
    if (startMin < REGULAR_OPEN_MINUTES || startMin >= REGULAR_CLOSE_MINUTES) {
      out.warnings.push('That time is outside 9:30 to 4:00, so there may be little or no chart data.');
    } else if (startMin + out.holdMinutes > REGULAR_CLOSE_MINUTES) {
      out.warnings.push('The trade runs past the 4:00 close, so the exit falls after the market shut.');
    }
  }
  return out;
}

// A day older than Schwab's window is only a problem when Alpaca cannot
// cover it. This cannot be known here (no token), so the note is left to
// the run itself when the price step comes up empty -- see runTestTrade.
function awaitingAlpacaNote() { return false; }

function two(n) { return String(n).padStart(2, '0'); }

// The Eastern calendar day an instant falls on, as a session object -- so
// a setup found on a different day than the default still stamps its
// contract and its fills with the right date.
function sessionFromMs(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Schwab's contract symbols: six characters of ticker, then the expiry as
// YYMMDD, then C or P, then the strike in thousandths padded to eight.
function buildOcc(ticker, session, strike, putCall) {
  const yy = String(session.year).slice(2);
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker.padEnd(6, ' ')}${yy}${session.month}${session.day}${putCall === 'PUT' ? 'P' : 'C'}${strikePart}`;
}

function buildFills(session, strike, entryMs, exitMs, choices = {}) {
  const ticker = choices.ticker || 'SPY';
  // Long is a call and Short is a put -- that is how his direction is
  // decided, not by buy or sell. He always buys to open either way, which
  // is why a rising option price is profit on both.
  const putCall = choices.dir === 'Short' ? 'PUT' : 'CALL';
  const occ = buildOcc(ticker, session, strike, putCall);
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
      transactionId: 'rehearsal-open', occ, ticker,
      instruction: 'BUY_TO_OPEN', putCall,
      price: OPEN_PRICE, quantity: CONTRACTS, fees: FEE_PER_SIDE,
      netAmount: -(gross(OPEN_PRICE) + FEE_PER_SIDE),
      date: dateStr, time: at(entryMs), timestamp: entryMs,
    },
    {
      transactionId: 'rehearsal-close', occ, ticker,
      instruction: 'SELL_TO_CLOSE', putCall,
      price: CLOSE_PRICE, quantity: CONTRACTS, fees: FEE_PER_SIDE,
      netAmount: gross(CLOSE_PRICE) - FEE_PER_SIDE,
      date: dateStr, time: at(exitMs), timestamp: exitMs,
    },
  ];
}

// Each step runs on its own and reports for itself. One failing step must
// not stop the ones after it -- the whole value of this is finding out
// which parts work, not stopping at the first that does not.
// A step can end three ways, not two. Returning a plain string is a pass.
// Returning { soft:true, summary } is "it worked, but there was nothing to
// show" -- the AI reached the chart and honestly found no setup at this
// minute, which is a real answer, not a fault. Throwing is a failure.
async function runStep(steps, name, fn) {
  const startedAt = Date.now();
  try {
    const out = await fn();
    const soft = out && typeof out === 'object' && out.soft === true;
    const summary = (out && typeof out === 'object' ? out.summary : out) || 'Done.';
    steps.push({ name, ok: true, soft: !!soft, summary, ms: Date.now() - startedAt });
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

async function runTestTrade(deps, rawChoices = {}) {
  const {
    getUnderlyingPriceAt, enrichWithUnderlyingPrices, enrichWithFtfc,
    enrichWithReplayData, enrichWithStopRule,
    // The setup reading is split for the rehearsal: classifyForTest tells
    // "could not reach the AI" apart from "reached it, no setup here", and
    // applyClassification writes the same fields the live sync writes.
    classifyForTest, applyClassification,
    // Scans recent real candles for an actual setup to anchor on.
    findRecentSetup,
    getToken = getValidAccessToken,
  } = deps;

  // Everything he chose is checked BEFORE anything is fetched, so a bad
  // choice is a sentence he can act on rather than two steps quietly
  // failing several seconds later.
  const choices = readChoices(rawChoices);
  if (choices.error) {
    return { ok: false, error: choices.error, steps: [], trade: null, warnings: [] };
  }
  const { holdMinutes, warnings } = choices;
  let { ticker, dir, session } = choices;

  const steps = [];

  let token = null;
  await runStep(steps, 'Reach Schwab', async () => {
    token = await getToken();
    return 'Signed in and reachable.';
  });

  // Unless he pinned an exact minute, the rehearsal SOURCES ITSELF FROM A
  // REAL SETUP: it scans recent candles for an actual occurrence of one of
  // his nine combos -- the same detectors the backtester uses, never a
  // made-up one -- and anchors the trade there, in the direction the setup
  // took. This is the whole point: the setup reading, the timeframes and
  // the replay then have real work to do. It tries his ticker first, then
  // the other of SPY/IWM, so it almost always lands on something.
  let entryMs = easternMoment(session, choices.hour, choices.minute);
  let foundSetup = null;
  if (!choices.timeGiven && findRecentSetup) {
    await runStep(steps, 'Find a real setup to test on', async () => {
      const onDate = choices.dateGiven
        ? `${session.year}-${session.month}-${session.day}` : null;
      const tries = ticker === 'IWM' ? ['IWM', 'SPY'] : [ticker, ticker === 'SPY' ? 'IWM' : 'SPY'];
      for (const t of tries) {
        const hit = await findRecentSetup(token, { ticker: t, days: 30, onDate });
        if (hit) { foundSetup = hit; break; }
      }
      if (!foundSetup) {
        throw new Error(onDate
          ? 'No clear setup was found on that day. Pick another day, or leave the day blank to search recent trading.'
          : 'No clear setup was found in recent trading. This is rare — try again shortly.');
      }
      ticker = foundSetup.ticker;
      dir = foundSetup.dir;
      entryMs = foundSetup.entryTimestampMs;
      session = sessionFromMs(entryMs);   // the contract and dates follow the setup's own day
      const d = new Date(entryMs);
      const timeStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
      return `Found a real ${foundSetup.setup} (${dir}) on ${ticker}, ${dayStr} at ${timeStr} on the ${foundSetup.timeframe} chart.`;
    });
  }
  const exitMs = entryMs + holdMinutes * 60 * 1000;

  // The strike is chosen around where the stock actually was, so the
  // rehearsed contract is one that could really have existed.
  let strike = 600;
  await runStep(steps, `Find where ${ticker} was`, async () => {
    const price = await getUnderlyingPriceAt(token, ticker, entryMs);
    if (price == null) throw new Error('No price came back for that moment. Without Alpaca connected, Schwab keeps only about a month of minute data.');
    strike = Math.round(price);
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entryMs));
    return `${ticker} was around $${price.toFixed(2)} at ${t}.`;
  });

  const fills = buildFills(session, strike, entryMs, exitMs, { ticker, dir, entryMs });

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
    // Throws only if the AI genuinely could not be reached -- which is the
    // one real failure of this step. runStep catches it and marks it so.
    const { tagged, result } = await classifyForTest(trade);
    applyClassification(trade, result);
    if (tagged) {
      const bits = [];
      if (trade.stratNotation) bits.push(`${trade.stratNotation}${trade.stratNotationDirection ? ' · ' + trade.stratNotationDirection : ''}`);
      if (trade.strat) bits.push(trade.strat);
      if (trade.play) bits.push(`play: ${trade.play}`);
      return bits.join(' — ');
    }
    // Reached, read the chart, answered -- just not a setup it was sure of
    // at this exact minute. That is the transfer working, not a fault, and
    // it is exactly what happens when the moment chosen had no setup on it.
    return {
      soft: true,
      summary: 'The chart was read and answered, but no setup was clear at this exact minute. That is a real answer, not a fault — pick a day and time you know had a setup to watch it name one.',
    };
  });

  await runStep(steps, 'Work out the stop', async () => {
    await enrichWithStopRule(token, [trade]);
    if (trade.stop == null) return 'No stop rule is set, so none was worked out. Nothing wrong.';
    return `Stop at $${Number(trade.stop).toFixed(2)}${trade.rrRealized != null ? `, giving ${Number(trade.rrRealized).toFixed(2)}R` : ''}.`;
  });

  trade.isTest = true;
  trade.source = 'rehearsal';
  return {
    ok: steps.every(s => s.ok),
    steps, trade, warnings,
    // Handed back so the app can show what was actually run, rather than
    // him having to remember what he typed.
    ran: {
      date: `${session.year}-${session.month}-${session.day}`,
      time: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entryMs)),
      holdMinutes, ticker, dir,
      // What real setup this landed on, when one was found -- so the card
      // can say "tested on a real 2-1-2 Continuation" rather than nothing.
      setup: foundSetup ? foundSetup.setup : null,
      setupTimeframe: foundSetup ? foundSetup.timeframe : null,
    },
  };
}

module.exports = {
  runTestTrade, pickSession, easternMoment, buildOcc, buildFills,
  readChoices, isTooOldForMinuteData, weekdayOf, MINUTE_DATA_DAYS,
  easternOffsetMinutes, HOLD_MINUTES, CONTRACTS, OPEN_PRICE, CLOSE_PRICE, FEE_PER_SIDE,
};
