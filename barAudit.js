// THE APP MUST NOT MARK ITS OWN HOMEWORK.
//
// His question, after the 5 and 15 minute bars turned out to be wrong
// (2026-09-25): "This app needs to be built off of facts... How do we make
// sure that this is correct now and moving forward?"
//
// He is right, and the reason those bars stayed wrong is precise: every
// check the app had compared the app against ITSELF. Nothing ever asked
// anyone outside whether a 5-minute bar was a 5-minute bar. The money was
// the one number with a real referee -- his broker's own export -- and the
// money is the one number that has never been wrong since.
//
// This is that referee, for bars. Alpaca serves 5, 15 and 30-minute and
// 1-hour bars ITSELF. The app builds its own out of 1-minute bars. Those
// two answers must match, and if they do not, one of them is wrong and it
// is not a matter of opinion which questions to ask.
//
// It compares the OPEN of each bar, which is the number that matters: the
// whole thirteen-timeframe reading is "was the price at entry above or
// below the open of the bar forming then". A wrong open is a wrong
// BULLISH or BEARISH, and four of those in a row is FTFC.
const alpaca = require('./alpacaClient');

const EASTERN_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
});
function minutesOfDay(ms) {
  const p = Object.fromEntries(EASTERN_CLOCK.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  let hour = Number(p.hour); if (hour === 24) hour = 0;
  return hour * 60 + Number(p.minute);
}
const SESSION_OPEN_MIN = 9 * 60 + 30;
const SESSION_CLOSE_MIN = 16 * 60;

// The app's own arithmetic: 1-minute bars grouped into larger ones,
// anchored to the session open and stamped with when they START. This is
// deliberately the SAME rule ftfcCheck and the replay screen use -- if it
// drifts from either, that is itself worth finding.
function buildFromMinutes(oneMin, minutes) {
  const out = [];
  let cur = null, curBucket = null;
  for (const c of oneMin) {
    const m = minutesOfDay(c.datetime);
    if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;
    const bucket = Math.floor((m - SESSION_OPEN_MIN) / minutes);
    if (bucket !== curBucket) {
      cur = { datetime: c.datetime - ((m - SESSION_OPEN_MIN) % minutes) * 60000,
              open: c.open, high: c.high, low: c.low, close: c.close };
      out.push(cur); curBucket = bucket; continue;
    }
    cur.high = Math.max(cur.high, c.high);
    cur.low = Math.min(cur.low, c.low);
    cur.close = c.close;
  }
  return out;
}

// EVERY WAY OUT SAYS WHY. "Could not reach it", "it answered with nothing"
// and "they disagree" are three different things and must never share one
// answer -- that rule is on this project's record more than any other.
async function auditBars(symbol, startMs, endMs, sizes = [5, 15, 30, 60]) {
  if (!(await alpaca.isReady())) {
    return { ran: false, reason: 'There is no market-data key saved, so there was nothing to check against.', rows: [] };
  }
  let oneMin;
  try {
    oneMin = await alpaca.fetchBars(symbol, { minutes: 1, startMs, endMs });
  } catch (err) {
    return { ran: false, reason: `Could not reach the market data service for the minute bars: ${err.message}`, rows: [] };
  }
  if (!oneMin || !oneMin.length) {
    return { ran: false, reason: 'The market data service answered, but had no minute bars for that day.', rows: [] };
  }

  const rows = [];
  for (const size of sizes) {
    let theirs;
    try {
      theirs = await alpaca.fetchBars(symbol, { minutes: size, startMs, endMs });
    } catch (err) {
      rows.push({ size, checked: 0, disagreed: null,
        reason: `Could not reach the market data service for its own ${size}-minute bars: ${err.message}` });
      continue;
    }
    if (!theirs || !theirs.length) {
      rows.push({ size, checked: 0, disagreed: null,
        reason: `The market data service had no ${size}-minute bars of its own for that day, so there was nothing to compare.` });
      continue;
    }
    const ours = buildFromMinutes(oneMin, size);
    // A BAR BUILT FROM A PART OF ITS OWN PERIOD IS NOT A WRONG BAR, AND
    // NOT A RIGHT ONE EITHER.
    //
    // Found by this very check: a recording that begins at 10:17 builds a
    // "10:15 bar" holding only 10:17 onwards, so its open is the 10:17
    // price and the provider's is the 10:15 price. Measured at 100.15
    // against 100.09. The bar is INCOMPLETE, not mismatched, and calling
    // it a disagreement would cry wolf on every single trade -- which is
    // how a warning becomes something he learns to ignore.
    // Counted on its own, like "could not reach it" versus "it answered
    // with nothing".
    const firstMin = minutesOfDay(oneMin[0].datetime);
    const lastMin = minutesOfDay(oneMin[oneMin.length - 1].datetime);
    const partialStart = ours.length && minutesOfDay(ours[0].datetime) < firstMin
      ? ours[0].datetime : null;
    const lastOurs = ours.length ? ours[ours.length - 1] : null;
    const partialEnd = lastOurs && (minutesOfDay(lastOurs.datetime) + size) > lastMin + 1
      ? lastOurs.datetime : null;
    // Matched by the moment each bar STARTS. Matching by position would
    // hide exactly the fault this exists to catch -- two lists can line up
    // one-for-one and still describe different minutes.
    const theirsByTime = new Map();
    for (const b of theirs) {
      const m = minutesOfDay(b.datetime);
      if (m < SESSION_OPEN_MIN || m >= SESSION_CLOSE_MIN) continue;   // they send extended hours too
      theirsByTime.set(b.datetime, b);
    }
    let checked = 0, disagreed = 0, incomplete = 0;
    const examples = [];
    for (const o of ours) {
      if (o.datetime === partialStart || o.datetime === partialEnd) { incomplete++; continue; }
      const t = theirsByTime.get(o.datetime);
      if (!t) {
        // A bar we built that they have no bar for AT THAT MOMENT is the
        // loudest possible signal: our bars are not on their clock.
        disagreed++;
        if (examples.length < 3) examples.push({ at: new Date(o.datetime).toISOString(), ours: o.open, theirs: null });
        continue;
      }
      checked++;
      if (Math.abs(o.open - t.open) > 0.005) {
        disagreed++;
        if (examples.length < 3) examples.push({ at: new Date(o.datetime).toISOString(), ours: o.open, theirs: t.open });
      }
    }
    rows.push({ size, checked, disagreed, incomplete, examples, reason: null });
  }
  const bad = rows.filter(r => r.disagreed > 0);
  return {
    ran: true,
    agreed: bad.length === 0,
    reason: bad.length === 0
      ? null
      : `The bars this app builds do not match the market data service's own bars on ${bad.map(r => r.size + '-minute').join(', ')}.`,
    rows,
  };
}

module.exports = { auditBars, buildFromMinutes, minutesOfDay, SESSION_OPEN_MIN, SESSION_CLOSE_MIN };
