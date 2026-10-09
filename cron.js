const cron = require('node-cron');
const { getValidAccessToken } = require('./auth');
const { getOptionFills } = require('./schwabClient');
const alpaca = require('./alpacaClient');
const { processFills } = require('./matcher');
const tradeStore = require('./tradeStore');
const { getTokens, setLastCheck } = require('./tokenStore');
const { getUnderlyingPriceAt, getFtfcForTrade } = require('./ftfcCheck');
const { getReplayCandles } = require('./replayData');
const { computeStopForTrade, loadSettings: loadStopSettings } = require('./stopRule');
const { classifyStrategy } = require('./aiClient');
const { notifyTradeClosed, notifyTradeOpened, notifyTradeStillOpen } = require('./pushcut');
const { queueBrowserEvent } = require('./browserEvents');
const { checkSignInAndNotify } = require('./signInWatch');

const SHORT_TRADE_SAFETY_NET_MS = 15 * 60 * 1000; // matches pushcut.js's SHORT_TRADE_MS

// Runs once, 15 minutes after a leg opens: if it's STILL sitting unmatched
// in openLegs at that point, the trade has run past the video-vs-screenshot
// cutoff, so it's time to bail out of recording. If it already closed (and
// so is no longer in openLegs), this is a silent no-op — notifyTradeClosed
// already handled that trade via the normal close path.
// In-memory only (a plain setTimeout, not a durable job) — if the server
// restarts in the middle of this 15-minute window, the check is lost and
// that one trade's recording (if the owner is still mid-trade) won't get
// the automatic "still open" nudge. Acceptable for a personal app at this
// scale; worth revisiting only if it turns out to happen often in practice.
function scheduleStillOpenCheck(leg) {
  setTimeout(async () => {
    try {
      const state = await tradeStore.getState();
      const stillOpen = (state.openLegs || []).some(
        l => l.occ === leg.occ && l.openTimestamp === leg.openTimestamp
      );
      if (stillOpen) {
        await notifyTradeStillOpen(leg);
        // The 15-minute mark, NOT the entry time. Stamped with the entry
        // it would be matched as the ENTRY picture and would replace the
        // real one with a picture taken fifteen minutes later -- a photo
        // labelled "entry" showing something else entirely.
        queueBrowserEvent('stillOpen', {
          ticker: leg.ticker, dir: leg.dir,
          timestamp: leg.openTimestamp + SHORT_TRADE_SAFETY_NET_MS,
        }).catch(() => {});
      }
    } catch (err) {
      console.log('Still-open safety-net check failed:', err.message);
    }
  }, SHORT_TRADE_SAFETY_NET_MS);
}

// Runs the Full Time Frame Continuity check for each newly-matched trade,
// same logic used everywhere else in the app — now run automatically at
// match time instead of waiting for the trade to be manually tagged, since
// the Journal no longer has a separate tagging step.
// 1 = the original rule, which read a bar's FINAL close (hindsight) and
//     built the larger timeframes by grouping candles by position.
// 2 = the price at entry against the open of the bar forming then, with
//     intraday bars anchored to the session and quarters to the calendar.
const FTFC_RULE_VERSION = 2;

async function enrichWithFtfc(token, trades) {
  for (const trade of trades) {
    try {
      if (trade.entryTimestamp) {
        // The underlying price is worked out just above this step, so it
        // is available here. Handed over ONLY when it is a real print at
        // the fill second (Alpaca); a reconstructed one is the close of
        // the candle containing the entry, which is hindsight.
        const exactEntryPrice = trade.undEntryExact === true ? trade.undEntry : null;
        const result = await getFtfcForTrade(token, trade.ticker, trade.entryTimestamp, exactEntryPrice);
        trade.ftfc = result.timeframes;
        trade.ftfcRun = result.runLength;
        trade.ftfcConfirmed = result.confirmed;
        trade.ftfcDirection = result.direction;
        trade.ftfcTimeframesInRun = result.timeframesInRun;
        // Which version of the rule produced this reading. Without it,
        // the app has no way to know that a trade measured under the old
        // (hindsight) rule needs measuring again — it has an answer on
        // file, so every "is anything missing?" test says it is finished.
        // That is the same trap that stopped the plays and the exact
        // stock prices ever reaching old trades. Bump this whenever the
        // way a timeframe is read changes.
        trade.ftfcVersion = FTFC_RULE_VERSION;
        trade.ftfcPriceAtEntry = result.priceAtEntry ?? null;
      }
    } catch (err) {
      console.log(`FTFC enrichment failed for ${trade.ticker}:`, err.message);
    }
  }
  return trades;
}

// Looks up the underlying stock's actual price at entry and exit for each
// newly-matched trade, since Schwab's option data never includes it. Runs
// one at a time (not in parallel) to stay comfortably within Schwab's rate
// limits during a large backfill.
// Where the underlying stock was when the fill went through.
//
// Alpaca first, because it can answer with an actual print at the actual
// second and its minute data goes back years. Schwab second, because it
// is always available but only keeps minute data ~35 days and otherwise
// falls back to a 30-minute or daily close.
//
// Each price is stored with HOW it was obtained, so a reconstruction is
// never displayed as though it were a record. Alpaca failing costs
// accuracy, never correctness -- the Schwab path is unchanged beneath it.
async function priceWithProvenance(token, ticker, timestampMs) {
  // isReady(), never isConfigured(). isConfigured() reads only what is in
  // memory, and memory is empty after every restart, so this gate was
  // closing on a server that had his Alpaca keys in storage the whole
  // time -- silently falling through to a Schwab candle and marking every
  // price "approximate". That is the bug he reported on 30 August.
  const alpacaOn = await alpaca.isReady();
  if (alpacaOn) {
    try {
      const hit = await alpaca.underlyingPriceAt(ticker, timestampMs);
      if (hit) return { ...hit, alpacaChecked: true };
    } catch (err) {
      console.log(`Alpaca lookup failed for ${ticker}, falling back to Schwab:`, err.message);
    }
  }
  const price = await getUnderlyingPriceAt(token, ticker, timestampMs);
  // Records whether Alpaca was actually available when this price was
  // worked out. Without it there is no way to tell a price that Alpaca
  // could not improve from one it was never asked about -- and the app
  // needs that to know which trades are worth looking up again.
  // A Schwab candle close is never improvable by waiting: Schwab has no
  // better record of that second and never will.
  return price == null ? null
    : { price, source: 'schwab-candle', exact: false, feed: null, upgradable: false, alpacaChecked: alpacaOn };
}

async function enrichWithUnderlyingPrices(token, trades) {
  for (const trade of trades) {
    try {
      if (trade.entryTimestamp) {
        const hit = await priceWithProvenance(token, trade.ticker, trade.entryTimestamp);
        trade.undEntry = hit ? hit.price : null;
        trade.undEntrySource = hit ? hit.source : null;
        trade.undEntryExact = hit ? hit.exact : null;
        // Taken from the real-time single-exchange feed while the
        // consolidated tape was still inside its 15-minute delay. Worth
        // asking again once, later, for the all-venues price.
        trade.undEntryUpgradable = hit ? !!hit.upgradable : false;
        trade.undPricedWithAlpaca = hit ? !!hit.alpacaChecked : false;
      }
      if (trade.exitTimestamp) {
        const hit = await priceWithProvenance(token, trade.ticker, trade.exitTimestamp);
        trade.undExit = hit ? hit.price : null;
        trade.undExitSource = hit ? hit.source : null;
        trade.undExitExact = hit ? hit.exact : null;
        trade.undExitUpgradable = hit ? !!hit.upgradable : false;
        trade.undPricedWithAlpaca = trade.undPricedWithAlpaca && (hit ? !!hit.alpacaChecked : false);
      }
    } catch (err) {
      console.log(`Underlying price enrichment failed for ${trade.ticker}:`, err.message);
    }
  }
  return trades;
}

// Pulls the 1-minute candle window around each newly-matched trade for the
// bar-replay feature (a candle-by-candle playback of the trade, used as a
// substitute for video screen recording — see replayData.js). Same
// one-at-a-time approach as the underlying-price enrichment, for the same
// rate-limit reason. Stores null on trades too old for Schwab's minute-data
// retention rather than leaving the field missing, so the frontend can
// tell "no replay available" apart from "not checked yet".
async function enrichWithReplayData(token, trades) {
  for (const trade of trades) {
    try {
      const built = await getReplayCandles(token, trade.ticker, trade.entryTimestamp, trade.exitTimestamp);
      // The bars themselves only get stored when there ARE some, so every
      // "does this trade have a replay?" test in the app keeps working.
      // The reason it is empty is stored beside them either way, so the
      // app can say which part refused instead of guessing at a cause.
      trade.replayData = built.candles.length ? built : null;
      trade.replayNote = built.candles.length ? null : (built.reason || null);
    } catch (err) {
      console.log(`Replay data enrichment failed for ${trade.ticker}:`, err.message);
      trade.replayData = null;
      trade.replayNote = 'Building the replay did not finish.';
    }
  }
  return trades;
}

// Fills in the stop from the trader's own rule, which Schwab cannot supply
// — a Strat stop is a line drawn on the underlying's chart, never an order
// sent to the broker, so an auto-imported trade has always arrived with the
// stop blank and therefore no realized R:R at all.
//
// Runs AFTER enrichWithStrategy, because the timeframe can depend on which
// setup it was, and never overwrites a stop the trader entered himself.
async function enrichWithStopRule(token, trades) {
  let settings;
  try {
    settings = await loadStopSettings();
  } catch (err) {
    console.log('Could not load stop-rule settings; skipping stop enrichment:', err.message);
    return trades;
  }
  if (!settings.enabled) return trades;

  for (const trade of trades) {
    if (trade.stop != null) continue; // his own number always wins
    try {
      const result = await computeStopForTrade(token, trade, settings);
      // Stored even when no level could be worked out, so the app can say
      // WHY a trade has no stop instead of just showing a blank.
      trade.stop = result.stop;
      trade.stopBasis = result.basis || null;
      trade.stopReason = result.reason || null;
      trade.stopTimeframe = result.timeframe || trade.stopTimeframe || null;
      trade.stopSizeRatio = result.sizeRatio ?? null;
      trade.stopAuto = result.stop != null;
    } catch (err) {
      console.log(`Stop-rule enrichment failed for ${trade.ticker}:`, err.message);
      trade.stopReason = `Could not work out a stop: ${err.message}`;
      trade.stopAuto = false;
    }
  }
  return trades;
}

// Auto-tags each newly-matched trade with one of the trader's own defined
// Strat setups, using the FTFC/price data and replay candles gathered by
// the enrichment steps above — must run after those, not before. Left null
// (same as before — shows the "Needs Setup" badge) whenever the model
// isn't confident, rather than force a guess onto a trade the trader will
// see in their Journal.
// Writes a classification onto a trade. Extracted so the live sync and
// the full-test rehearsal set the exact same fields the exact same way --
// a second copy would drift. The result handed in has already cleared the
// confidence bar, so each field is written only when it survived.
function applyClassificationToTrade(trade, result) {
  if (!result) return;
  // Written whether or not anything was confident enough to tag, because
  // the question "was this read with a chart in front of it?" has to be
  // answerable for every trade the reading has touched -- not only the
  // ones it managed to name.
  if (result.sawCandles != null) trade.stratSawCandles = result.sawCandles;
  // The combo (WHAT he saw) and the play (HOW he chose it) are two
  // separate answers. Either can be confident while the other is not.
  if (result.strategy) {
    trade.strat = result.strategy;
    trade.stratConfidence = result.confidence;
    trade.stratReasoning = result.reasoning;
  }
  if (result.play) {
    trade.play = result.play;
    trade.playConfidence = result.playConfidence;
    trade.playReasoning = result.playReasoning;
  }
  // His own notation for the combo -- what he actually reads.
  if (result.notation && result.notation !== 'unclear') {
    trade.stratNotation = result.notation;
    trade.stratNotationDirection = result.notationDirection || null;
  }
  // What the AI made of the Broadening Formation. Recorded BESIDE his own
  // toggle (offBroadeningFormation), never over it -- his answer is the
  // truth, this is only what the model saw.
  if (result.broadeningFormation && result.broadeningFormation !== 'unclear') {
    trade.broadeningDetected = result.broadeningFormation === 'yes';
    trade.broadeningReasoning = result.broadeningReasoning || null;
  }
}

async function enrichWithStrategy(trades) {
  for (const trade of trades) {
    try {
      const result = await classifyStrategy(trade);
      applyClassificationToTrade(trade, result);
    } catch (err) {
      console.log(`Strategy classification failed for ${trade.ticker}:`, err.message);
    }
  }
  return trades;
}

// ---- One sync job at a time; save changes, not copies ---------------------
// (audit Step B: F3, F4, H-3, H-7; authorized by the owner 6 Oct 2026)
//
// The five-minute tick, the streamer, "sync now", a backfill and the reset
// all change the same record. Run side by side, each could save the copy it
// read before the others had finished. Only one runs at a time now: a tick
// that finds another job running is skipped and does NOT move the
// checkpoint, so the next tick simply looks again. A backfill waits for a
// running sync; a second backfill is not started while one is running.
let currentJob = null;
async function runExclusive(kind, fn, { wait = false } = {}) {
  while (currentJob) {
    if (!wait || currentJob.kind === kind) return { ran: false, busyWith: currentJob.kind };
    await currentJob.done;
  }
  let finish;
  const done = new Promise(r => { finish = r; });
  currentJob = { kind, done };
  try {
    return { ran: true, value: await fn() };
  } finally {
    currentJob = null;
    finish();
  }
}
function jobRunning() { return currentJob ? currentJob.kind : null; }

const clone = v => JSON.parse(JSON.stringify(v));
// An open leg is named by the broker fill it came from; a leg saved before
// those references existed falls back to what it is made of.
const legKey = l => (l.openFillId
  ? 'F:' + l.openFillId
  : `S:${l.occ}|${l.openTimestamp}|${l.openPrice}|${l.totalQuantity}`);
// The same trade out of two runs of the matcher over the same fills.
const tradeKey = t => `${(t.fills || []).join('+')}|${t.contracts}|${t.entryTimestamp}|${t.exitTimestamp}`;
// THE EXCEPTION LEDGER (audit H-2; authorized 9 Oct 2026). What the matcher
// could not pair is kept in `exceptions` on this same record, keyed by
// kind + broker fill id, and written in the SAME change that marks those
// fills processed -- so "processed" and "recorded" are saved together or not
// at all, through the one queue every writer of this record uses (Step B).
// A record is added only when its key is absent: a retry, a backfill or a
// re-run after a reset adds nothing. Nothing is ever deleted or overwritten;
// a record whose fill is later paired by fill id becomes "resolved".
function withExceptions(latest, found, pairedTrades, at) {
  const had = latest.exceptions || {};
  const next = { ...had };
  let changed = false;
  for (const e of found || []) {
    if (next[e.key]) continue;
    next[e.key] = { ...e, status: 'open', firstSeenAt: at };
    changed = true;
  }
  for (const t of pairedTrades || []) {
    const [open, close] = t.fills || [];
    for (const key of [open && `open-retired:${open}`, close && `close-without-open:${close}`]) {
      const rec = key && next[key];
      if (!rec || rec.status !== 'open') continue;
      next[key] = { ...rec, status: 'resolved', resolvedAt: at, resolvedBy: t.fills };
      changed = true;
    }
  }
  return changed ? next : had;
}
// ONE RULE for the list of fills already handled (H-3): kept whole, each id
// once, in every path. It used to be cut to the last 500 by the sync and kept
// whole by the backfill, so a backfill after the cut re-queued old history.
function unionIds(a, b) {
  const seen = new Set();
  const out = [];
  for (const id of [...(a || []), ...(b || [])]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
// A broker fill is handled once. Asked against the record as it is at the
// moment of saving, so a fill another operation handled meanwhile is skipped
// while the rest of the same batch still goes through.
//
// THE CHANGEOVER (audit Step C). Fills with no activityId used to be recorded
// by their ORDER number; they are recorded by their own "U-..." id now. A
// recorded order number is NOT taken as proof that every execution of that
// order was handled -- that is the very loss Step C removes. It is used only
// to recognise the one fill it can positively be:
//   a. a fill dated at or after `cutoverMs` (the new code's first run) can
//      never have been seen by the old code: only its own id counts;
//   b. a fill dated before it is taken as the old fill only when it is the
//      ONLY record carrying that order number in the data fetched;
//   c. otherwise which execution the old code handled cannot be known, so
//      none is processed and none is guessed at: each goes into `ambiguous`,
//      to be listed with its reason and settled by the rebuild from the
//      ledger, which never uses order numbers.
function notYetProcessed(fills, record, { cutoverMs = Infinity, ambiguous = null } = {}) {
  const seen = new Set(record.lastProcessedIds || []);
  const recordsPerOrder = new Map();
  for (const f of fills) {
    if (!f.identityUncertain || f.legacyId == null || f.timestamp >= cutoverMs) continue;
    if (!recordsPerOrder.has(f.legacyId)) recordsPerOrder.set(f.legacyId, new Set());
    recordsPerOrder.get(f.legacyId).add(f.transactionId);
  }
  return fills.filter(f => {
    if (seen.has(f.transactionId)) return false;
    if (!f.identityUncertain || f.legacyId == null || !seen.has(f.legacyId)) return true;
    if (f.timestamp >= cutoverMs) return true;                                          // a
    if ((recordsPerOrder.get(f.legacyId) || new Set()).size <= 1) return false;         // b
    if (ambiguous && !ambiguous.some(a => a.id === f.transactionId)) {                  // c
      ambiguous.push({
        id: f.transactionId, orderId: f.legacyId, date: f.date, time: f.time,
        reason: 'An older version recorded this order by its order number; which executions it processed cannot be established.',
      });
    }
    return false;
  });
}
const cutoverOf = record => (record.identityCutoverAt ? Date.parse(record.identityCutoverAt) : Infinity);
// What the sync could not use, said in its own words (H-5, Step C).
function syncProblems(report, ambiguous) {
  const out = {};
  if (report.unusable && report.unusable.count) out.unusable = report.unusable;
  if (ambiguous.length) out.legacyAmbiguous = { count: ambiguous.length, examples: ambiguous.slice(0, 5) };
  return out;
}

async function runSyncCheck() {
  const out = await runExclusive('sync', syncOnce);
  if (!out.ran) {
    console.log(`Auto-sync skipped: a ${out.busyWith} is still running; the next tick will look again.`);
    return { skipped: out.busyWith };
  }
  return out.value;
}

async function syncOnce() {
  try {
    const token = await getValidAccessToken();
    const store = await getTokens();
    const since = store.last_transaction_check
      ? new Date(store.last_transaction_check)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();

    // H-7: a window Schwab refused used to look exactly like a quiet one, and
    // the checkpoint moved past it, so those days were never asked for again.
    // Refused, empty and answered are three different results now.
    const report = {};
    const fills = await getOptionFills(
      token,
      since.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
      report
    );
    const refused = (report.windowsFailed || 0) > 0 || report.accountFound === false;
    const syncNote = !refused ? null : {
      at: now.toISOString(),
      windowsAsked: report.windowsAsked ?? null,
      windowsOk: report.windowsOk ?? null,
      windowsFailed: report.windowsFailed ?? null,
      failures: report.failures || [],
      error: report.error || null,
      checkpointKeptAt: store.last_transaction_check || null,
    };

    const state = await tradeStore.getState();
    // The changeover moment is set once, by the first run of this code, and
    // never moved (Step C).
    const cutoverIso = state.identityCutoverAt || now.toISOString();
    const cutoverMs = Date.parse(cutoverIso);
    const freshFills = notYetProcessed(fills, state, { cutoverMs });

    // The slow part -- prices, timeframes, chart, setup, stop -- is done on a
    // private trial match, and nothing is written while it runs.
    const enriched = new Map();
    if (freshFills.length) {
      const trial = processFills(freshFills, { openLegs: clone(state.openLegs || []), pending: [] });
      if (trial.newPending.length) {
        await enrichWithUnderlyingPrices(token, trial.newPending);
        await enrichWithFtfc(token, trial.newPending);
        await enrichWithReplayData(token, trial.newPending);
        await enrichWithStrategy(trial.newPending);
        await enrichWithStopRule(token, trial.newPending);
      }
      for (const t of trial.newPending) enriched.set(tradeKey(t), t);
    }

    // Then the match is made again ON THE RECORD AS IT IS NOW and only the
    // changes are saved: fills already handled meanwhile are skipped, the
    // rest are matched against the open legs as they now stand, and an
    // acknowledgement from the phone made meanwhile stays made. When nothing
    // got in the way this is the same match as the trial, so every trade
    // keeps its details; a trade the trial did not produce is queued without
    // them and the app's catch-up fills them in.
    let landed = [];
    let opened = [];
    await tradeStore.updateState(latest => {
      const ambiguous = [];
      const latestCutover = latest.identityCutoverAt ? cutoverOf(latest) : cutoverMs;
      const take = notYetProcessed(fills, latest, { cutoverMs: latestCutover, ambiguous });
      const problems = syncProblems(report, ambiguous);
      const hasProblems = Object.keys(problems).length > 0;
      const prev = latest.lastSync || {};
      const hadProblems = !!(prev.windowsFailed || prev.unusable || prev.legacyAmbiguous);
      if (!take.length && !syncNote && !hasProblems && !hadProblems && latest.identityCutoverAt) return null;
      const next = { ...latest };
      if (!next.identityCutoverAt) next.identityCutoverAt = cutoverIso;
      if (take.length) {
        const m = processFills(take, { openLegs: clone(latest.openLegs || []), pending: [] });
        landed = m.newPending.map(t => enriched.get(tradeKey(t)) || t);
        opened = m.newlyOpenedLegs;
        next.openLegs = m.updatedState.openLegs;
        next.pending = [...landed, ...(latest.pending || [])];
        next.lastProcessedIds = unionIds(latest.lastProcessedIds, take.map(f => f.transactionId));
        // H-2: in the same change as "processed" (see withExceptions).
        const ex = withExceptions(latest, m.exceptions, m.newPending, now.toISOString());
        if (ex !== latest.exceptions) next.exceptions = ex;
      }
      if (syncNote) next.lastSync = { ...syncNote, ...problems };
      else if (hasProblems || hadProblems) {
        next.lastSync = { at: now.toISOString(), windowsFailed: 0, ...problems,
          ...(prev.windowsFailed ? { recoveredFrom: prev.at || null } : {}) };
      }
      return next;
    });

    // Only here, in the live 5-minute/streamer-triggered check — never
    // from runBackfill() below, which can surface a hundred-plus
    // historical trades/legs at once and would spam notifications.
    if (opened.length) {
      console.log(`Auto-sync: ${opened.length} newly-opened position(s).`);
      for (const leg of opened) {
        notifyTradeOpened(leg).catch(() => {});
        queueBrowserEvent('opened', { ticker: leg.ticker, dir: leg.dir, timestamp: leg.openTimestamp }).catch(() => {});
        scheduleStillOpenCheck(leg);
      }
    }
    if (landed.length) {
      console.log(`Auto-sync: ${landed.length} closed trade(s) ready for tagging.`);
      for (const trade of landed) {
        notifyTradeClosed(trade).catch(() => {}); // notifyTradeClosed already logs its own failures
        queueBrowserEvent('closed', { ticker: trade.ticker, dir: trade.dir, timestamp: trade.exitTimestamp }).catch(() => {});
      }
    }

    if (refused) {
      console.log(`Auto-sync: Schwab refused ${syncNote.windowsFailed ?? 'the'} window(s); the checkpoint stays at ${syncNote.checkpointKeptAt} so the next tick asks again.`);
    } else {
      await setLastCheck(now.toISOString());
    }
  } catch (err) {
    // Most common cause: not connected yet (no refresh token on file).
    // Read defensively: a rejection carrying something that is not an
    // error would throw again right here, out of the very catch meant to
    // contain it, and end the process.
    console.log('Auto-sync check skipped:', (err && err.message) || err);
  }
}

// Empties the record of what is waiting (see the reset route). Waits for a
// running job, so a sync cannot save its results over the emptied record
// half-way through.
async function resetSyncState() {
  const out = await runExclusive('reset',
    // The exception ledger (H-2) survives a reset: it records broker fills,
    // not the queue, and nothing may delete it.
    () => tradeStore.updateState(latest => ({ openLegs: [], pending: [], lastProcessedIds: [],
      ...(latest && latest.exceptions ? { exceptions: latest.exceptions } : {}) })),
    { wait: true });
  return out.ran;
}

// One-time (or on-demand) wide-range pull for historical backfill.
// Defaults to 90 days (3 months) — enough to study recent trades without
// pulling a full year; increase if you want to look further back.
// 90 days was the old default, and it is why the owner's journal began in
// mid-May while his trading began on 2 January — four months of real
// trades were never fetched, and nothing said so. A year is the sensible
// default for a history import; the caller can ask for more.
// Records where the backfill has got to, so the app can say something
// true while it runs instead of guessing. A year of history takes minutes
// -- fetching a dozen windows from Schwab, then working out the FTFC,
// underlying prices, replay data, setup and stop for every trade found.
// Before this existed the app waited seven seconds and then announced
// "Schwab had nothing new", which was not something it could know.
async function noteBackfillProgress(patch) {
  try {
    await tradeStore.updateState(latest => ({
      ...latest,
      lastBackfill: { ...(latest.lastBackfill || {}), ...patch },
    }));
  } catch (err) {
    // Progress reporting must never be the thing that breaks an import.
    console.log('Could not record backfill progress:', err.message);
  }
}

// How many trades are enriched before the work so far is saved. Small
// enough that a restart loses little, large enough not to rewrite the
// whole journal on every trade.
const ENRICH_BATCH = 25;

// Saves the enriched copies of a backfill's own trades -- but only those
// still waiting. One the phone has already taken stays taken.
async function refreshWaiting(trades) {
  const byId = new Map(trades.map(t => [t.id, t]));
  await tradeStore.updateState(latest => {
    let changed = false;
    const pending = (latest.pending || []).map(p => {
      if (!byId.has(p.id)) return p;
      changed = true;
      return byId.get(p.id);
    });
    return changed ? { ...latest, pending } : null;
  });
}

async function runBackfill(daysBack = 365) {
  const out = await runExclusive('backfill', () => backfillOnce(daysBack), { wait: true });
  if (!out.ran) {
    console.log('A backfill is already running; not starting a second one.');
    return [];
  }
  return out.value;
}

async function backfillOnce(daysBack) {
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const now = new Date();
  const requestedFrom = start.toISOString().slice(0, 10);

  // Keep the attempt count across a resume; a run that reaches 'done'
  // clears it, so a later manual import starts from a clean slate.
  const prior = (await tradeStore.getState()).lastBackfill || {};
  await noteBackfillProgress({
    status: 'running', phase: 'asking-schwab',
    startedAt: now.toISOString(), finishedAt: null,
    daysBack, requestedFrom,
    fillsFound: null, tradesMatched: null, error: null,
    windowsAsked: null, windowsOk: null, windowsFailed: null,
    failures: [], oldestWindowWithData: null,
    attempts: prior.attempts || 0,
  });

  try {
    const token = await getValidAccessToken();
    const report = {};
    const fills = await getOptionFills(
      token,
      requestedFrom,
      now.toISOString().slice(0, 10),
      report
    );

    await noteBackfillProgress({
      phase: 'matching',
      fillsFound: fills.length,
      windowsAsked: report.windowsAsked ?? null,
      windowsOk: report.windowsOk ?? null,
      windowsFailed: report.windowsFailed ?? null,
      failures: report.failures || [],
      oldestWindowWithData: report.oldestWindowWithData || null,
      unusable: report.unusable || null,
    });

    // Matched on its own, from no open legs, as before -- but SAVED as a
    // change to the record as it is now (F3). The live open legs are kept
    // and this run's still-open legs are added beside them: it used to save
    // its own empty list over them, so a position open at the time lost its
    // purchase and its sale was later thrown away as unmatched. Fills
    // handled meanwhile are skipped; the rest still go through.
    //
    // Queued BEFORE enriching. Enrichment is the slow part -- thirteen
    // timeframes of candles per trade -- and there is no reason to make him
    // stare at an empty journal through all of it.
    let newPending = [];
    await tradeStore.updateState(latest => {
      const cutoverIso = latest.identityCutoverAt || new Date().toISOString();
      const ambiguous = [];
      const take = notYetProcessed(fills, latest, { cutoverMs: Date.parse(cutoverIso), ambiguous });
      const m = processFills(take, { openLegs: [], pending: [] });
      newPending = m.newPending;
      const have = new Set((latest.openLegs || []).map(legKey));
      // H-2: what this run could not pair, in the same change (withExceptions).
      const ex = withExceptions(latest, m.exceptions, m.newPending, new Date().toISOString());
      return {
        ...latest,
        ...(ex !== latest.exceptions ? { exceptions: ex } : {}),
        identityCutoverAt: cutoverIso,
        openLegs: [...(latest.openLegs || []), ...m.updatedState.openLegs.filter(l => !have.has(legKey(l)))],
        pending: [...newPending, ...(latest.pending || [])],
        lastProcessedIds: unionIds(latest.lastProcessedIds, take.map(f => f.transactionId)),
        lastBackfill: {
          ...(latest.lastBackfill || {}),
          phase: 'enriching',
          tradesMatched: newPending.length,
          freshFills: take.length,
          legacyAmbiguous: ambiguous.length ? { count: ambiguous.length, examples: ambiguous.slice(0, 5) } : null,
        },
      };
    });

    if (newPending.length) {
      // Worked through in batches, saving after each one.
      //
      // It used to enrich all three hundred trades and save once at the
      // end, so a restart part-way through threw away every minute of it
      // -- and the server has been restarting, both from the crash and
      // from running out of memory. Saving as it goes means a restart
      // costs one batch, not the whole run. It also gives him a journal
      // that fills in steadily rather than all at once at the end.
      for (let i = 0; i < newPending.length; i += ENRICH_BATCH) {
        const batch = newPending.slice(i, i + ENRICH_BATCH);
        await enrichWithUnderlyingPrices(token, batch);
        await enrichWithFtfc(token, batch);
        await enrichWithReplayData(token, batch);
        await enrichWithStrategy(batch);
        await enrichWithStopRule(token, batch);
        // Saved as it goes, onto the record as it is now: only this run's
        // own trades that are still waiting are updated.
        await refreshWaiting(batch);
        await noteBackfillProgress({
          phase: 'enriching',
          tradesMatched: newPending.length,
          tradesEnriched: Math.min(i + ENRICH_BATCH, newPending.length),
        });
      }
      // Once more for the whole run, as before; it changes only this run's
      // own trades that are still waiting.
      await refreshWaiting(newPending);
    }

    await noteBackfillProgress({
      status: 'done', phase: 'done',
      finishedAt: new Date().toISOString(),
      attempts: 0, resumedAutomatically: false,
    });
    return newPending;
  } catch (err) {
    await noteBackfillProgress({
      status: 'failed', phase: 'done',
      finishedAt: new Date().toISOString(),
      error: String(err.response?.data ? JSON.stringify(err.response.data) : err.message).slice(0, 300),
    });
    throw err;
  }
}

// Carries an unfinished history import on by itself.
//
// The owner should not have to keep tapping a button, and until now he
// did: a backfill that Schwab blocked, or that died when the server
// restarted, simply stopped and waited for a human. Schwab turns requests
// away when too many arrive at once -- which a year-long import can
// trigger -- and that block lifts by itself after a few minutes. There is
// no reason a person needs to be involved in waiting for it.
//
// A backfill still marked "running" long after it started is not running;
// nothing survives a restart mid-job. Both that and an outright failure
// are treated the same way: wait, then carry on.
const RETRY_WAIT_MS = 16 * 60 * 1000;   // Schwab's block lifts in about 15
const STALE_RUN_MS = 25 * 60 * 1000;    // beyond this, a "running" job is dead
const MAX_RETRIES = 8;
let resumeInFlight = false;

async function resumeBackfillIfNeeded() {
  if (resumeInFlight) return;
  const state = await tradeStore.getState();
  const b = state.lastBackfill;
  if (!b || b.status === 'done') return;

  const startedMs = b.startedAt ? Date.parse(b.startedAt) : 0;
  const stalled = b.status === 'running' && Date.now() - startedMs > STALE_RUN_MS;
  if (b.status !== 'failed' && !stalled) return;   // genuinely still working

  const attempts = b.attempts || 0;
  if (attempts >= MAX_RETRIES) return;             // stop pestering Schwab

  const lastTry = Date.parse(b.finishedAt || b.startedAt || 0) || 0;
  if (Date.now() - lastTry < RETRY_WAIT_MS) return;

  resumeInFlight = true;
  console.log(`Resuming unfinished backfill by itself (attempt ${attempts + 1} of ${MAX_RETRIES}).`);
  try {
    await noteBackfillProgress({ attempts: attempts + 1, resumedAutomatically: true });
    await runBackfill(b.daysBack || 365);
  } catch (err) {
    console.log('Automatic resume failed, will try again later:', err.message);
  } finally {
    resumeInFlight = false;
  }
}

// Runs every 5 minutes by default. Change the cron expression to taste —
// Schwab rate limits are generous enough for personal use at this interval.
// One tick of the five-minute job. A named function rather than an inline
// one so it can actually be run in a test, instead of a test reading this
// file and pattern-matching the text of it.
//
// Nothing holds the promise this returns, so nothing here may be allowed
// to escape: an unhandled failure ends the entire server, which is what
// Render's "Exited with status 1" alert means. Each half is wrapped
// separately so a failure in one still lets the other run.
async function runScheduledTick() {
  try {
    await runSyncCheck();
  } catch (err) {
    console.log('Auto-sync tick failed:', (err && err.message) || err);
  }
  // Picking up where an interrupted import left off is part of keeping
  // the journal current, not a separate thing he has to ask for.
  try {
    await resumeBackfillIfNeeded();
  } catch (err) {
    console.log('Backfill resume check failed:', (err && err.message) || err);
  }
  // Anything left waiting to be read -- after a restart, say -- starts
  // moving again without being asked.
  try {
    await require('./classifyQueue').drain();
  } catch (err) {
    console.log('Setup reading tick failed:', (err && err.message) || err);
  }
  // Its own attempt and its own catch: a warning about the sign-in
  // running out must not be skipped because collecting trades failed --
  // least of all when the reason collecting trades failed IS the sign-in
  // having run out.
  try {
    await checkSignInAndNotify();
  } catch (err) {
    console.log('Sign-in reminder tick failed:', (err && err.message) || err);
  }
}

function startAutoSync(intervalCron = '*/5 * * * *') {
  cron.schedule(intervalCron, runScheduledTick);
  console.log(`Auto-sync scheduled: ${intervalCron}`);
}

// enrichWithUnderlyingPrices and priceWithProvenance are exported so a test
// can run them for real, rather than a test reading this file and guessing.
// Every enrichment step is exported so the full rehearsal can run the
// REAL ones. A rehearsal that calls a copy of the pipeline proves only
// that the copy works.
module.exports = { FTFC_RULE_VERSION, startAutoSync, runScheduledTick, runSyncCheck, runBackfill, resumeBackfillIfNeeded,
                   resetSyncState, jobRunning, withExceptions,
                   enrichWithUnderlyingPrices, priceWithProvenance,
                   enrichWithFtfc, enrichWithReplayData, enrichWithStopRule, enrichWithStrategy,
                   applyClassificationToTrade };
