const { extractOptionFills } = require('./schwabClient');
const { processFills } = require('./matcher');
const { getValidAccessToken } = require('./auth');

// A BLIND REPLAY OF ONE OF HIS REAL TRADES.
//
// The app picks a real trade at random, strips it back to the bare facts
// Schwab itself provides -- the contract, the two instants, the two fill
// prices, the size and the cash -- and sends only those. This rebuilds
// the Schwab transactions from them and pushes them through the REAL
// extraction, the REAL matcher and the REAL enrichment, knowing nothing
// else about the trade.
//
// Everything the journal then works out -- the dates and times in
// Eastern, the fees from the cash, the profit, the stock price at each
// end, the thirteen timeframes, the replay candles, the setup -- is
// derived from scratch. The app holds the answers and does the marking.
//
// What is NOT sent, and must never be: the setup, the play, the notation,
// the underlying prices, the timeframe alignment, the stop, the fees, the
// profit. Those are the answers. The one thing that IS sent and looks
// like an answer is CALL vs PUT -- but a real Schwab fill genuinely
// carries that, and Long/Short is derived from it, so withholding it
// would make the replay less faithful, not more honest.

// Rebuilds the two Schwab transactions -- one opening buy, one closing
// sell -- in the exact shape Schwab sends them, so the real extraction
// has real work to do.
//
// The cash is what makes the fee test genuine: a buy pays the contracts'
// value PLUS fees, a sell brings in that value MINUS fees. The extraction
// works the fee back out of that gap, and the app checks the number it
// arrives at against the one on file.
function buildTransactions(input) {
  const { occ, ticker, putCall, contracts,
          entryTimestamp, exitTimestamp, entryPrice, exitPrice,
          entryFees, exitFees } = input;

  const gross = price => Math.abs(price) * 100 * Math.abs(contracts);
  const leg = (price, positionEffect, paying) => ({
    instrument: { assetType: 'OPTION', symbol: occ, underlyingSymbol: ticker, putCall },
    amount: paying ? contracts : -contracts,
    price,
    // Negative cash means money left the account (a buy); positive means
    // it came in (a sell). This is what the extraction reads to decide
    // buy-to-open versus sell-to-close.
    cost: paying ? -gross(price) : gross(price),
    positionEffect,
  });

  return [
    {
      activityId: 'replay-open',
      tradeDate: new Date(entryTimestamp).toISOString(),
      netAmount: -(gross(entryPrice) + (entryFees || 0)),
      transferItems: [leg(entryPrice, 'OPENING', true)],
    },
    {
      activityId: 'replay-close',
      tradeDate: new Date(exitTimestamp).toISOString(),
      netAmount: gross(exitPrice) - (exitFees || 0),
      transferItems: [leg(exitPrice, 'CLOSING', false)],
    },
  ];
}

// Everything the app must send for a replay to be possible at all.
function missingFields(input) {
  const needed = ['occ', 'ticker', 'putCall', 'contracts',
                  'entryTimestamp', 'exitTimestamp', 'entryPrice', 'exitPrice'];
  return needed.filter(k => input == null || input[k] == null || input[k] === '');
}

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

async function runReplayCheck(deps, input) {
  const {
    enrichWithUnderlyingPrices, enrichWithFtfc, enrichWithReplayData,
    enrichWithStopRule, classifyForTest, applyClassification,
    getToken = getValidAccessToken,
  } = deps;

  const missing = missingFields(input);
  if (missing.length) {
    return { ok: false, error: 'That trade is missing something the replay needs, so it cannot be tested.', steps: [], trade: null };
  }

  const steps = [];
  let token = null;
  await runStep(steps, 'Reach Schwab', async () => {
    token = await getToken();
    return 'Signed in and reachable.';
  });

  // The REAL extraction, over transactions shaped exactly as Schwab sends
  // them. This is where the Eastern dates and times, and the fee worked
  // back out of the cash, actually come from.
  let fills = [];
  await runStep(steps, 'Read the fills as Schwab sends them', async () => {
    const txs = buildTransactions(input);
    fills = txs.flatMap(t => extractOptionFills(t));
    if (fills.length !== 2) throw new Error(`Expected a buy and a sell, got ${fills.length}.`);
    return `${fills[0].instruction} then ${fills[1].instruction}, on ${fills[0].date}.`;
  });

  let trade = null;
  await runStep(steps, 'Pair the buy with the sell', async () => {
    const { newPending } = processFills(fills, { openLegs: [], pending: [], lastProcessedIds: [] });
    if (!newPending.length) throw new Error('The two fills did not pair into a trade.');
    trade = newPending[0];
    trade.isTest = true;
    trade.source = 'replay-check';
    return `${trade.ticker} ${trade.dir}, ${trade.contracts} contract${trade.contracts === 1 ? '' : 's'}, in at ${trade.entryTime} and out at ${trade.exitTime}.`;
  });
  if (!trade) return { ok: false, steps, trade: null };

  await runStep(steps, 'Work out the money', async () => {
    if (trade.pnlDollar == null) throw new Error('No profit or loss was worked out.');
    return `${trade.pnlDollar >= 0 ? '+' : '-'}$${Math.abs(trade.pnlDollar).toFixed(2)} before fees`
      + (trade.fees == null ? ', fees unknown.' : `, $${trade.fees.toFixed(2)} of fees.`);
  });

  await runStep(steps, 'Price the stock at both ends', async () => {
    await enrichWithUnderlyingPrices(token, [trade]);
    if (trade.undEntry == null) throw new Error('No stock price was found for the entry.');
    const how = trade.undPricedWithAlpaca ? 'from Alpaca, exact' : `from Schwab candles (${trade.undEntrySource || 'unknown'})`;
    return `In at $${trade.undEntry.toFixed(2)}, out at ${trade.undExit != null ? '$' + trade.undExit.toFixed(2) : 'no price'} — ${how}.`;
  });

  await runStep(steps, 'Measure the 13 timeframes', async () => {
    await enrichWithFtfc(token, [trade]);
    if (!trade.ftfcRun) return { soft: true, summary: 'Measured — no run of four agreed.' };
    const dir = trade.ftfcDirection === 'bull' ? 'bullish' : trade.ftfcDirection === 'bear' ? 'bearish' : 'unclear';
    return `${(trade.ftfcTimeframesInRun || []).length} timeframes agreed, ${dir}.`;
  });

  await runStep(steps, 'Load the replay candles', async () => {
    await enrichWithReplayData(token, [trade]);
    const n = ((trade.replayData && trade.replayData.candles) || []).length;
    if (!n) throw new Error('No candles came back, so Bar Replay would have nothing to show.');
    return `${n} one-minute candles ready for Bar Replay.`;
  });

  await runStep(steps, 'Read the setup with AI', async () => {
    const { tagged, result } = await classifyForTest(trade);
    applyClassification(trade, result);
    if (tagged) {
      const bits = [];
      if (trade.stratNotation) bits.push(`${trade.stratNotation}${trade.stratNotationDirection ? ' · ' + trade.stratNotationDirection : ''}`);
      if (trade.strat) bits.push(trade.strat);
      if (trade.play) bits.push(`play: ${trade.play}`);
      return bits.join(' — ');
    }
    return { soft: true, summary: 'The chart was read and answered, but no setup was clear enough to name.' };
  });

  await runStep(steps, 'Work out the stop', async () => {
    await enrichWithStopRule(token, [trade]);
    if (trade.stop == null) return { soft: true, summary: 'No stop rule is set, so none was worked out.' };
    return `Stop at $${Number(trade.stop).toFixed(2)}`
      + (trade.rrRealized != null ? `, giving ${Number(trade.rrRealized).toFixed(2)}R.` : '.');
  });

  return { ok: steps.every(s => s.ok), steps, trade };
}

module.exports = { runReplayCheck, buildTransactions, missingFields };
