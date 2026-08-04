function computeFtfcConfirmation(perTimeframe) {
  const sequence = TIMEFRAMES.map(tf => perTimeframe[tf]);
  let bestRun = 0, bestDirection = null, bestStartIdx = -1, bestEndIdx = -1;
  let currentRun = 0, currentDirection = null, currentStartIdx = -1;
  sequence.forEach((value, idx) => {
    if (value && value === currentDirection) {
      currentRun++;
    } else {
      currentRun = value ? 1 : 0;
      currentDirection = value || null;
      currentStartIdx = idx;
    }
    if (currentRun > bestRun) {
      bestRun = currentRun;
      bestDirection = currentDirection;
      bestStartIdx = currentStartIdx;
      bestEndIdx = idx;
    }
  });
  // The run can start at ANY timeframe in the sequence, not just the
  // largest — e.g. 1M/1W/1D/4H bullish in a row confirms FTFC just as
  // much as 30m/15m/5m/3m would. timeframesInRun records exactly which
  // ones formed the confirmed run, largest to smallest, so the app can
  // show e.g. "FTFC: 1M → 4H" as a guide for how long to hold.
  const timeframesInRun = bestRun >= 4 ? TIMEFRAMES.slice(bestStartIdx, bestEndIdx + 1) : [];
  return {
    confirmed: bestRun >= 4,
    runLength: bestRun,
    direction: bestRun >= 4 ? bestDirection : null,
    timeframesInRun,
  };
}
