// STEP 1A: fetch what setupBars.js measures, and referee it.
//
// Everything here is ONE question: what were the bars into his entry, up to
// the second he bought? It fetches from the market-data provider, checks the
// app's own grouped bars against the provider's own bars (the referee, so
// the app never marks its own homework), and hands it all to the pure
// readSetups(). It never writes anything.
//
//   readSetupFacts(trade, { alpaca, now })
//     -> { ok: true, facts, checks, fullTape }
//     -> { ok: false, outcome, reason }   (outcome: waiting-for-data | no-data)
//
// The full market tape is only served 15 minutes after the fact, so a trade
// younger than that is "waiting-for-data" -- not a failure, and not a try.
const { readSetups } = require('./setupBars');
const { buildFromMinutes, minutesOfDay, easternDateOf, SESSION_OPEN_MIN, SESSION_CLOSE_MIN } = require('./barAudit');

const HOLD_BACK_MS = 15 * 60 * 1000;
const DAY = 86400000;

// The app's bars against the provider's own: open, high, low and close
// within half a cent. The first and last of ours can be built from part of
// their period, so they are not marked either way.
function referee(ours, theirs) {
  if (!Array.isArray(ours) || !Array.isArray(theirs) || !theirs.length) return { agreed: false, checked: 0, disagreed: 0, why: 'no bars of theirs to compare' };
  const byTime = new Map(theirs.map(b => [b.datetime, b]));
  let checked = 0, disagreed = 0;
  for (const o of ours.slice(1, -1)) {
    const t = byTime.get(o.datetime);
    checked++;
    if (!t || ['open', 'high', 'low', 'close'].some(k => Math.abs(o[k] - t[k]) > 0.005)) disagreed++;
  }
  return { agreed: checked > 0 && disagreed === 0, checked, disagreed, why: checked ? null : 'too few bars to compare' };
}

// Call = bullish, put = bearish: he only ever buys to open.
function directionOf(trade) {
  const m = String(trade.occ || '').match(/\d{6}([CP])\d{8}$/);
  if (m) return m[1] === 'C' ? 'bullish' : 'bearish';
  if (trade.dir === 'Long') return 'bullish';
  if (trade.dir === 'Short') return 'bearish';
  return null;
}

const inSession = c => { const m = minutesOfDay(c.datetime); return m >= SESSION_OPEN_MIN && m < SESSION_CLOSE_MIN; };

async function readSetupFacts(trade, { alpaca = require('./alpacaClient'), now = Date.now() } = {}) {
  const entryMs = Number(trade && trade.entryTimestamp);
  if (!Number.isFinite(entryMs)) return { ok: false, outcome: 'no-data', reason: 'the trade has no entry moment' };
  if (now - entryMs < HOLD_BACK_MS) return { ok: false, outcome: 'waiting-for-data', reason: 'the full market prices for the entry are not out yet (15 minutes)' };
  const direction = directionOf(trade);
  if (!direction) return { ok: false, outcome: 'no-data', reason: 'the trade says neither call nor put' };
  const symbol = trade.ticker;
  if (!symbol) return { ok: false, outcome: 'no-data', reason: 'the trade has no ticker' };
  if (!(await alpaca.isReady())) return { ok: false, outcome: 'no-data', reason: 'no market-data key is saved, so there are no bars to measure' };

  const minuteStart = Math.floor(entryMs / 60000) * 60000;
  const feeds = [];
  const used = {};
  const minutes = await alpaca.fetchBars(symbol, { minutes: 1, startMs: minuteStart - 7 * DAY, endMs: minuteStart - 1, used });
  if (minutes == null) return { ok: false, outcome: 'no-data', reason: 'the minute bars could not be fetched' };
  if (!minutes.length) return { ok: false, outcome: 'no-data', reason: 'there were no minute bars before the entry' };
  feeds.push(used.feed);
  const before = minutes.filter(c => c.datetime < minuteStart);

  const entry = await alpaca.tradesBetween(symbol, minuteStart, entryMs);
  if (entry) feeds.push(entry.feed);

  const entryDate = easternDateOf(entryMs);
  const dUsed = {};
  const daily = await alpaca.fetchBars(symbol, { daily: true, startMs: entryMs - 4 * 366 * DAY, endMs: minuteStart - 1, used: dUsed });
  if (daily) feeds.push(dUsed.feed);
  const completedDaily = (daily || []).filter(d => easternDateOf(d.datetime + 12 * 3600000) < entryDate);

  // The referee: 3, 5, 15 and 30 minutes against the provider's own bars,
  // over the two days before the entry.
  const status = { '1m': 'input' };
  const checks = {};
  const recent = before.filter(c => c.datetime >= minuteStart - 2 * DAY && inSession(c));
  for (const size of [3, 5, 15, 30]) {
    const rUsed = {};
    const theirs = await alpaca.fetchBars(symbol, { minutes: size, startMs: minuteStart - 2 * DAY, endMs: minuteStart - 1, used: rUsed });
    const r = theirs ? referee(buildFromMinutes(recent, size), theirs.filter(inSession)) : { agreed: false, checked: 0, disagreed: 0, why: 'their bars could not be fetched' };
    checks[size + 'm'] = r;
    status[size + 'm'] = r.agreed ? 'confirmed' : 'unconfirmed';
  }
  for (const k of ['1H', '2H', '4H']) status[k] = status['30m'] === 'confirmed' ? 'derived' : 'unconfirmed';
  // Daily: the last whole session built from minutes against their daily bar.
  const lastDay = completedDaily[completedDaily.length - 1];
  if (lastDay) {
    const date = easternDateOf(lastDay.datetime + 12 * 3600000);
    const session = before.filter(c => easternDateOf(c.datetime) === date && inSession(c));
    const ours = session.length ? [{ datetime: lastDay.datetime, open: session[0].open, high: Math.max(...session.map(c => c.high)), low: Math.min(...session.map(c => c.low)), close: session[session.length - 1].close }] : [];
    const agreed = ours.length && ['open', 'high', 'low', 'close'].every(k => Math.abs(ours[0][k] - lastDay[k]) <= 0.005);
    checks.Daily = { agreed: !!agreed, checked: ours.length, disagreed: ours.length && !agreed ? 1 : 0, why: ours.length ? null : 'no minutes for the last whole session' };
    status.Daily = agreed ? 'confirmed' : 'unconfirmed';
  } else {
    checks.Daily = { agreed: false, checked: 0, disagreed: 0, why: 'no daily bars' };
    status.Daily = 'unconfirmed';
  }
  for (const k of ['Weekly', 'Monthly']) status[k] = status.Daily === 'confirmed' ? 'derived' : 'unconfirmed';
  for (const k of ['3 Month', '6 Month', 'Yearly']) status[k] = 'reconstruction';

  const fullTape = feeds.length > 0 && feeds.every(f => f === 'sip');
  const input = { entryMs, direction, minutesBefore: before, entryTrades: entry ? entry.trades : null, completedDaily, status, fullTape };
  let facts = readSetups(input);
  // A 1 Bar Rev Strat whose break and midpoint fell in one minute: that
  // minute's own trades settle the order (at most five minutes asked).
  if (facts.needsMinutes.length) {
    const minuteTrades = {};
    for (const m of facts.needsMinutes.slice(0, 5)) {
      const t = await alpaca.tradesBetween(symbol, m, Math.min(m + 59999, entryMs));
      if (t) minuteTrades[m] = t.trades;
    }
    facts = readSetups({ ...input, minuteTrades });
  }
  return { ok: true, facts, checks, fullTape };
}

module.exports = { readSetupFacts, referee, directionOf, HOLD_BACK_MS };
