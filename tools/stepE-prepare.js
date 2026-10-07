// AUDIT STEP E, part E1: the OFFLINE preparation of the rebuilt journal.
// Authorized by the owner on 7 October 2026 ("I authorize Step E
// implementation"), after his B3-5 choice ("Option 1": fifo-v1, the oldest
// purchase first, is the production pairing rule). Plan: Step E v7, accepted
// by the auditor.
//
// THIS IS NOT PART OF THE RUNNING SERVER. Nothing requires it; it has no
// route and no timer. It is a pure calculation:
//
//   his journal export + the read-only backup copy (ledger entries)
//     -> a dry-run log, and (only if nothing stops it) a prepared journal and
//        a restore file
//
// It loads only `crypto` and tradeRebuild.js (unchanged, frozen at 09e4671),
// reads no clock, no network and no storage. Reading and writing files is
// done by tools/stepE-cli.js, which opens both inputs read-only.
//
// The rules it follows, in the plan's words, are in the comments below. The
// one that matters most: NOTHING of his is ever discarded, guessed at, or
// moved by anything but FILL IDENTITY. When a rule cannot be met it STOPS and
// writes no prepared journal.
const crypto = require('crypto');
const R = require('../tradeRebuild');

const RULE = 'fifo-v1';
const OWNER_DECISION = 'B3-5 decided by the owner on 7 Oct 2026: "Option 1" (fifo-v1, oldest purchase first)';
const KIND_PREPARED = 'strat-journal-stepE-prepared-v1';
const KIND_RESTORE = 'strat-journal-stepE-restore-v1';
const LEDGER_PREFIX = 'ledger:schwab:rec:';
const DAY_MS = 86400000;
const PICTURES = ['shotEntry', 'shotMid', 'shotExit'];

// ---- Field classes (the plan's OWNER DATA and MACHINE LIST) ------------------
// Broker facts: replaced from the ledger on a kept trade, set from it on an
// added one.
const BROKER = ['id', 'ticker', 'occ', 'dir', 'contracts', 'contractsOpened', 'closeQuantity', 'fillStatus',
  'entryDate', 'entryTime', 'entryTimestamp', 'exitDate', 'exitTime', 'exitTimestamp', 'optEntry', 'optExit',
  'pnlDollar', 'pnlPercent', 'entryFees', 'exitFees', 'fees', 'pnlNet', 'winLoss', 'suspectPairing', 'heldMs',
  'source', 'fills'];
// Machine facts measured at the moment of the PURCHASE: carried to an added
// trade only from a journal trade citing the same opening fill.
const ENTRY_FACTS = ['ftfc', 'ftfcRun', 'ftfcConfirmed', 'ftfcDirection', 'ftfcTimeframesInRun', 'ftfcVersion', 'ftfcPriceAtEntry',
  'undEntry', 'undEntrySource', 'undEntryExact', 'undEntryUpgradable',
  'strat', 'stratConfidence', 'stratNotation', 'stratNotationDirection', 'stratReasoning', 'stratSawCandles',
  'play', 'playConfidence', 'playReasoning', 'broadeningDetected', 'broadeningReasoning',
  'stop', 'stopAuto', 'stopReason', 'stopBasis', 'stopSizeRatio', 'stopTimeframe'];
// Machine facts measured at the moment of the SALE: only from a journal trade
// citing the same closing fill.
const EXIT_FACTS = ['undExit', 'undExitSource', 'undExitExact', 'undExitUpgradable'];
// Only from the exact same pair (never carried to an added trade).
const PAIR_ONLY = ['replayData', 'replayNote', 'undPricedWithAlpaca'];
// Worked out from other fields, or catch-up bookkeeping.
const DERIVED = ['realizedRR', 'needsTagging', 'settled', 'fillAttempts', 'moneyDisagreement', 'classifyTries', 'stepE'];
// Owner fields that exist whatever userSet says.
const OWNER_KNOWN = ['userSet', 'notes', ...PICTURES, 'chartDrawings', 'offBroadeningFormation', 'rrPlanned'];
const FTFC_GROUP = ['ftfc', 'ftfcRun', 'ftfcConfirmed', 'ftfcDirection', 'ftfcTimeframesInRun'];
const MACHINE = new Set([...BROKER, ...ENTRY_FACTS, ...EXIT_FACTS, ...PAIR_ONLY, ...DERIVED]);
const KNOWN = new Set([...MACHINE, ...OWNER_KNOWN]);
const BROKER_SET = new Set(BROKER);

// ---- Small helpers ------------------------------------------------------------
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const canonical = R.canonical;
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const isEmpty = v => v == null || v === '' || v === false
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const same = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
const differs = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) >= 0.005 : !same(a, b);
const cents = x => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100));
const money = c => (c == null ? 'unknown' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ridOf = fillId => String(fillId).split(':')[1];          // "F:<record id>:<n>" -> record id
const nOf = fillId => Number(String(fillId).split(':')[2]);

// THE JOURNAL FINGERPRINT, used by this tool and by the app alike: sha256 of
// the canonical form of the trades sorted by id, with the three picture
// fields replaced by present/absent (the export embeds the pictures; storage
// holds only a mark).
function journalFingerprint(trades) {
  const norm = trades.map(t => {
    const o = Object.assign({}, t);
    for (const f of PICTURES) if (f in o) o[f] = !!o[f];
    return o;
  }).sort((a, b) => cmpStr(String(a.id), String(b.id)));
  return sha256(canonical(norm));
}

// Everything of his on a trade (the plan's OWNER DATA, (a) to (c)).
function ownerFields(t) {
  const out = new Set();
  const us = t.userSet && typeof t.userSet === 'object' ? t.userSet : {};
  for (const k of Object.keys(us)) {
    if (!us[k]) continue;
    if (k === 'ftfc') FTFC_GROUP.forEach(g => out.add(g)); else out.add(k);
  }
  if (typeof t.notes === 'string' && t.notes.trim()) out.add('notes');
  for (const f of PICTURES) if (t[f]) out.add(f);
  if (Array.isArray(t.chartDrawings) && t.chartDrawings.length) out.add('chartDrawings');
  if (t.offBroadeningFormation === true) out.add('offBroadeningFormation');
  if (t.rrPlanned != null && t.rrPlanned !== '') out.add('rrPlanned');
  if (!isEmpty(t.strat) && t.stratConfidence == null) out.add('strat');
  if (!isEmpty(t.play) && t.playConfidence == null) out.add('play');
  for (const k of Object.keys(t)) if (!KNOWN.has(k) && !isEmpty(t[k])) out.add(k);
  return [...out].sort();
}
const fromBroker = t => !!t && (t.source === 'schwab-auto' || t.source === 'schwab-csv');
const invented = t => Array.isArray(t.fills) && t.fills.length > 0 && t.fills.every(f => String(f).startsWith('csv|'));
const nyDate = s => String(s || '').slice(0, 10);

// ---- The preparation --------------------------------------------------------------
// prepare({ journal, backup, rangeStart?, reference? }) -> { stopped, stops, log,
//   prepared?, restore? }. Never throws for a data problem: a problem is a STOP
// with its reason.
function prepare({ journal, backup, rangeStart, reference } = {}) {
  const stops = [];
  const lines = [];
  const say = s => lines.push(s);
  const stop = (code, text) => stops.push({ code, text });

  // -- Inputs --
  if (!Array.isArray(journal)) {
    stop('journal-unreadable', 'The journal export is not a list of trades.');
    return finish();
  }
  const ids = new Map();
  for (const t of journal) {
    if (!t || t.id == null) { stop('trade-without-id', 'A trade in the journal has no id.'); continue; }
    const k = String(t.id);
    if (ids.has(k)) stop('duplicate-id', `Two trades in the journal share the id ${k}.`);
    ids.set(k, t);
  }
  const keys = backup && backup.keys && typeof backup.keys === 'object' ? backup.keys : null;
  if (!keys) { stop('backup-unreadable', 'The backup copy holds no stored entries.'); return finish(); }
  const ledgerItems = Object.keys(keys).filter(k => k.startsWith(LEDGER_PREFIX)).sort().map(k => keys[k]);
  if (!ledgerItems.length) { stop('no-ledger', 'The backup copy holds no broker ledger entries.'); return finish(); }
  if (stops.length) return finish();

  const R_FP = journalFingerprint(journal);
  const exportedAt = backup.exportedAt || 'not stated';

  // -- The rebuild (tradeRebuild.js, unchanged) --
  const rb = R.rebuild(ledgerItems, { rule: RULE });
  const rc = rb.reconstruction;
  const st = rb.input;
  if (st.unreadable || st.fingerprintMismatches || st.conflictingIdentities || rc.exceptions.inputProblems.length) {
    stop('ledger-input-problem', `The ledger has unreadable entries (${st.unreadable}), fingerprint mismatches (${st.fingerprintMismatches}) or conflicting records (${st.conflictingIdentities}).`);
  }
  const cons = rc.conservation;
  if (!cons.openingBalances || !cons.closingBalances || !cons.feesBalance) {
    stop('ledger-conservation', `The ledger's own checks fail: purchases balance ${cons.openingBalances}, sales balance ${cons.closingBalances}, fees balance ${cons.feesBalance}.`);
  }
  if (stops.length) return finish();
  const fills = new Map(rc.fills.map(f => [f.fillId, f]));
  const recordIds = new Set(rc.fills.map(f => f.recordId));
  const multiLine = new Set(rc.fills.filter(f => f.n > 1).map(f => f.recordId));
  const latestLedgerDate = rc.asOf ? rc.asOf.slice(0, 10) : null;

  // -- Range --
  const brokerTrades = journal.filter(fromBroker);
  const earliest = brokerTrades.map(t => t.exitDate).filter(Boolean).sort()[0] || null;
  const start = rangeStart || earliest;
  if (!start) { stop('no-range', 'The journal holds no broker trade with a closing date, so there is no range to rebuild.'); return finish(); }
  const inRange = t => nyDate(t.exitNy) >= start;
  const rebuilt = rc.trades.filter(inRange);
  for (const t of rebuilt) {
    if (multiLine.has(ridOf(t.openFillId)) || multiLine.has(ridOf(t.closeFillId)) || nOf(t.openFillId) !== 1 || nOf(t.closeFillId) !== 1) {
      stop('multi-line-record', `Ledger record ${ridOf(t.openFillId)} or ${ridOf(t.closeFillId)} has more than one option line, so a fill pair of record ids would be ambiguous.`);
    }
  }
  const pairOf = t => `${ridOf(t.openFillId)}|${ridOf(t.closeFillId)}`;
  const rebuiltByPair = new Map(rebuilt.map(t => [pairOf(t), t]));
  const rebuiltByOpen = new Map();
  for (const t of rebuilt) { const k = ridOf(t.openFillId); if (!rebuiltByOpen.has(k)) rebuiltByOpen.set(k, []); rebuiltByOpen.get(k).push(t); }

  // -- The journal, classified --
  const handTyped = journal.filter(t => !fromBroker(t));
  const before = brokerTrades.filter(t => t.exitDate && t.exitDate < start);
  const inScope = brokerTrades.filter(t => !(t.exitDate && t.exitDate < start));
  const genuinePair = t => Array.isArray(t.fills) && t.fills.length === 2 && !invented(t)
    && recordIds.has(String(t.fills[0])) && recordIds.has(String(t.fills[1]));
  const genuineOpen = t => Array.isArray(t.fills) && t.fills.length >= 1 && !String(t.fills[0]).startsWith('csv|')
    && recordIds.has(String(t.fills[0]));
  for (const t of inScope) {
    // A live trade citing broker fills the ledger does not hold: the ledger
    // does not cover it, and removing it would lose a real trade.
    const cites = (Array.isArray(t.fills) ? t.fills : []).map(String).filter(f => !f.startsWith('csv|'));
    const missing = cites.filter(f => !recordIds.has(f));
    if (missing.length) stop('ledger-does-not-cover', `Trade ${t.id} (${t.ticker} closed ${t.exitDate}) cites broker fills the ledger does not hold (${missing.join(', ')}). Import the ledger first.`);
    if (latestLedgerDate && t.exitDate && t.exitDate > latestLedgerDate) stop('ledger-does-not-cover', `Trade ${t.id} closed ${t.exitDate}, after the ledger's latest record (${latestLedgerDate}).`);
  }
  if (stops.length) return finish();

  // Journal trades by their genuine pair; same pair saved more than once.
  const journalByPair = new Map();
  for (const t of inScope) if (genuinePair(t)) {
    const k = `${t.fills[0]}|${t.fills[1]}`;
    if (!journalByPair.has(k)) journalByPair.set(k, []);
    journalByPair.get(k).push(t);
  }

  const kept = new Map();        // rebuilt tradeId -> { from: journal trade, out }
  const keptJournalIds = new Set();
  const removed = [];            // { t, reason }
  for (const [k, list] of journalByPair) {
    const rt = rebuiltByPair.get(k);
    if (!rt) continue;
    const sorted = list.slice().sort((a, b) => cmpStr(String(a.id), String(b.id)));
    const withOwner = sorted.filter(t => ownerFields(t).length);
    if (withOwner.length > 1) {
      stop('destination-collision', `Trades ${withOwner.map(t => t.id).join(' and ')} are the same broker pair saved more than once, and more than one carries his data (${withOwner.map(t => `${t.id}: ${ownerFields(t).join(', ')}`).join('; ')}). Nothing is merged.`);
      continue;
    }
    const keep = withOwner[0] || sorted[0];
    kept.set(rt.tradeId, { from: keep });
    keptJournalIds.add(String(keep.id));
    for (const t of sorted) if (t !== keep) removed.push({ t, reason: `the same broker pair saved again (kept as ${keep.id})` });
  }
  for (const t of inScope) {
    if (keptJournalIds.has(String(t.id)) || removed.some(r => r.t === t)) continue;
    let reason;
    if (invented(t)) reason = 'a copy read from the broker file (its references are invented): its fills are in the rebuilt trades';
    else if (!Array.isArray(t.fills) || !t.fills.length) reason = 'no broker fill references';
    else if (!genuinePair(t)) reason = 'its fill references are not one purchase and one sale in the ledger';
    else {
      const holders = rebuilt.filter(r => ridOf(r.openFillId) === String(t.fills[0]) || ridOf(r.closeFillId) === String(t.fills[1])).map(r => r.tradeId);
      reason = `paired differently under fifo-v1: its fills are now in ${holders.join(', ') || 'no rebuilt trade in range'}`;
    }
    removed.push({ t, reason });
  }

  // -- Item 4: owner data on removed trades, by FILL IDENTITY only --
  const transfers = new Map();   // destination tradeId -> [{ t, fields }]
  for (const { t } of removed) {
    const fields = ownerFields(t);
    if (!fields.length) continue;
    const label = `Trade ${t.id} (${t.ticker || '?'} closed ${t.exitDate || '?'}), his fields: ${fields.join(', ')}`;
    if (!genuineOpen(t)) {
      stop('owner-data-no-genuine-fill', `${label}. It has no genuine broker opening fill (${invented(t) ? 'its references were invented by the file reader' : 'no fill reference the ledger holds'}), so there is no valid fill-identity destination. Nothing is discarded, guessed or moved.`);
      continue;
    }
    if (PICTURES.some(f => t[f])) { stop('owner-data-picture', `${label}. It has pictures, which never move.`); continue; }
    const brokerCorrections = fields.filter(f => BROKER_SET.has(f));
    if (brokerCorrections.length) { stop('owner-data-broker-correction', `${label}. He corrected broker facts by hand (${brokerCorrections.join(', ')}) on a trade being removed; they cannot be carried over the ledger's facts.`); continue; }
    const dests = rebuiltByOpen.get(String(t.fills[0])) || [];
    if (dests.length !== 1) {
      stop('owner-data-no-single-destination', `${label}. ${dests.length} rebuilt trades cite its opening fill ${t.fills[0]} (${dests.map(d => d.tradeId).join(', ') || 'none'}); exactly one is required.`);
      continue;
    }
    const d = dests[0].tradeId;
    if (!transfers.has(d)) transfers.set(d, []);
    transfers.get(d).push({ t, fields });
  }
  // (iv) DESTINATION COLLISION: at most one source, and none of its own.
  for (const [d, srcs] of transfers) {
    const k = kept.get(d);
    const own = k ? ownerFields(k.from) : [];
    if (srcs.length > 1) {
      stop('destination-collision', `Rebuilt trade ${d} would receive his data from ${srcs.length} removed trades: ${srcs.map(s => `${s.t.id} (${s.fields.join(', ')})`).join('; ')}. Stopped whatever the values; nothing is merged.`);
    } else if (own.length) {
      stop('destination-collision', `Rebuilt trade ${d} is kept journal trade ${k.from.id}, which already carries his data (${own.join(', ')}); removed trade ${srcs[0].t.id} would add ${srcs[0].fields.join(', ')}. Nothing is merged.`);
    }
  }

  // -- Build the prepared trades --
  const allJournalBroker = inScope;   // sources for carried machine facts
  const brokerFactsOf = rt => {
    const open = fills.get(rt.openFillId), close = fills.get(rt.closeFillId);
    const consumed = rc.trades.filter(x => x.openFillId === rt.openFillId)
      .sort((a, b) => cmpStr(a.exitInstant, b.exitInstant) || cmpStr(a.tradeId, b.tradeId));
    let cum = 0;
    for (const x of consumed) { cum += x.contracts; if (x.tradeId === rt.tradeId) break; }
    const heldMs = Date.parse(rt.exitInstant) - Date.parse(rt.entryInstant);
    const pnlDollar = rt.grossCents / 100;
    return {
      ticker: rt.underlying, occ: rt.symbol, dir: rt.direction,
      contracts: rt.contracts, contractsOpened: open.quantity, closeQuantity: close.quantity,
      fillStatus: cum >= open.quantity ? 'Closed' : 'Partial Fill',
      entryDate: rt.entryNy.slice(0, 10), entryTime: rt.entryNy.slice(11, 16), entryTimestamp: Date.parse(rt.entryInstant),
      exitDate: rt.exitNy.slice(0, 10), exitTime: rt.exitNy.slice(11, 16), exitTimestamp: Date.parse(rt.exitInstant),
      optEntry: rt.entryPrice, optExit: rt.exitPrice,
      pnlDollar, pnlPercent: rt.entryPrice ? Math.round(((rt.exitPrice - rt.entryPrice) / rt.entryPrice) * 1000) / 10 : 0,
      entryFees: rt.entryFeeCents == null ? null : rt.entryFeeCents / 100,
      exitFees: rt.exitFeeCents == null ? null : rt.exitFeeCents / 100,
      fees: rt.feeCents == null ? null : rt.feeCents / 100,
      pnlNet: rt.netCents == null ? null : rt.netCents / 100,
      winLoss: pnlDollar >= 0 ? 'Win' : 'Loss',
      suspectPairing: heldMs > DAY_MS, heldMs,
      fills: [ridOf(rt.openFillId), ridOf(rt.closeFillId)],
    };
  };
  const provenance = rt => ({ rule: RULE, ledgerTradeId: rt.tradeId, openFillId: rt.openFillId, closeFillId: rt.closeFillId });

  const out = [];
  const keptLog = [], addedLog = [], transferLog = [];
  for (const rt of rebuilt) {
    const facts = brokerFactsOf(rt);
    const k = kept.get(rt.tradeId);
    if (k) {
      const t = clone(k.from);
      const us = t.userSet || {};
      const changes = [];
      for (const [f, v] of Object.entries(facts)) {
        if (differs(t[f], v)) {
          if (us[f]) stop('hand-correction-conflict', `Kept trade ${t.id}: he corrected ${f} by hand to ${JSON.stringify(t[f])}; the ledger says ${JSON.stringify(v)}. His correction is never overwritten silently.`);
          changes.push(`${f}: ${JSON.stringify(t[f])} -> ${JSON.stringify(v)}`);
        }
        t[f] = v;
      }
      t.stepE = provenance(rt);
      out.push(t);
      keptLog.push(`KEPT ${t.id} = ${rt.tradeId} ${facts.ticker} ${facts.exitDate}${changes.length ? '; changed ' + changes.join('; ') : '; unchanged'}`);
      continue;
    }
    // ADDED: machine facts only by FILL.
    const t = Object.assign({ id: rt.tradeId }, facts, { source: 'schwab-auto', settled: false, fillAttempts: 0 });
    const carried = [], blank = [];
    const carry = (fieldsList, sources, why) => {
      for (const f of fieldsList) {
        const vals = [];
        let his = null;
        for (const s of sources) {
          const own = s.userSet && (s.userSet[f] || (FTFC_GROUP.includes(f) && s.userSet.ftfc));
          if (own) { his = s.id; continue; }
          // A machine fact is present unless it is missing or blank; false
          // and 0 are real answers here.
          if (s[f] != null && s[f] !== '') vals.push(s[f]);
        }
        // A field left out is unknown (the app reads a missing field as not
        // known); nothing is ever filled with 0 or a guess.
        if (his != null) { blank.push(`${f} (his correction on ${his} is not copied)`); continue; }
        const distinct = [...new Set(vals.map(v => canonical(v)))];
        if (distinct.length === 1) { t[f] = clone(vals[0]); carried.push(f); }
        else if (distinct.length > 1) blank.push(`${f} (sources disagree)`);
      }
    };
    const openSrc = allJournalBroker.filter(s => genuineOpen(s) && String(s.fills[0]) === ridOf(rt.openFillId));
    const closeSrc = allJournalBroker.filter(s => genuinePair(s) && String(s.fills[1]) === ridOf(rt.closeFillId));
    carry(ENTRY_FACTS, openSrc, 'same purchase');
    carry(EXIT_FACTS, closeSrc, 'same sale');
    if (!openSrc.length) blank.push('no journal trade shares its purchase, so the purchase-moment facts are unknown');
    if (!closeSrc.length) blank.push('no journal trade shares its sale, so the sale-moment facts are unknown');
    blank.push('replay: never carried to a new pair');
    t.realizedRR = (t.undEntry && t.undExit && t.stop && Math.abs(t.undEntry - t.stop) !== 0)
      ? (t.dir === 'Short' ? (t.undEntry - t.undExit) : (t.undExit - t.undEntry)) / Math.abs(t.undEntry - t.stop) : null;
    t.needsTagging = isEmpty(t.strat);
    t.stepE = provenance(rt);
    for (const f of PICTURES) t[f] = null;
    out.push(t);
    addedLog.push(`ADDED ${rt.tradeId} ${facts.ticker} ${facts.occ.trim()} ${facts.entryDate} ${facts.entryTime}->${facts.exitTime} x${facts.contracts} ${money(rt.grossCents)} gross; carried by fill: ${carried.join(', ') || 'nothing'} (from ${openSrc.map(x => x.id).join(', ') || 'no trade'} / ${closeSrc.map(x => x.id).join(', ') || 'no trade'}); unknown: ${blank.join('; ')}`);
  }
  // Owner-data transfers (only when no stop applies).
  const byTradeId = new Map(out.map(t => [String(t.id), t]));
  for (const [d, srcs] of transfers) {
    if (srcs.length !== 1) continue;
    const dest = kept.get(d) ? byTradeId.get(String(kept.get(d).from.id)) : byTradeId.get(d);
    if (!dest) continue;
    const { t: src, fields } = srcs[0];
    for (const f of fields) dest[f] = clone(src[f]);
    const us = Object.assign({}, dest.userSet || {});
    for (const [kk, v] of Object.entries(src.userSet || {})) if (v) us[kk] = true;
    if (Object.keys(us).length) dest.userSet = us;
    transferLog.push(`MOVED his data from removed ${src.id} to ${dest.id} by opening fill ${src.fills[0]}: ${fields.join(', ')}`);
  }
  for (const t of before) out.push(t);
  for (const t of handTyped) out.push(t);
  const outIds = new Set();
  for (const t of out) { const k = String(t.id); if (outIds.has(k)) stop('id-collision', `Two trades in the prepared journal would share id ${k}.`); outIds.add(k); }
  // Pictures: stored as marks; the app keeps each trade's stored value by id.
  for (const t of out) for (const f of PICTURES) if (f in t) t[f] = t[f] ? 'kept' : null;
  out.sort((a, b) => (Number(b.exitTimestamp) || 0) - (Number(a.exitTimestamp) || 0) || cmpStr(String(a.id), String(b.id)));

  // -- Exceptions in range, and the reconciliation against Schwab's file --
  const exc = rc.exceptions;
  const excInRange = [
    ...exc.closeWithoutOpen.filter(c => nyOf(c.instant) >= start).map(c => `close without open: ${c.symbol} ${c.instant} x${c.contractsUnmatched} -- ${c.reason}`),
    ...exc.excessClose.filter(c => nyOf(c.instant) >= start).map(c => `excess close: ${c.symbol} ${c.instant} x${c.contractsUnmatched} -- ${c.reason}`),
    ...exc.pastExpiryOpen.filter(l => nyOf(l.openedInstant) >= start).map(l => `open past expiry: ${l.symbol} opened ${l.openedInstant} x${l.contractsRemaining} -- ${l.reason}`),
    ...exc.stillOpen.filter(l => nyOf(l.openedInstant) >= start).map(l => `still open: ${l.symbol} opened ${l.openedInstant} x${l.contractsRemaining}`),
  ];
  const recon = window => {
    const inW = d => d >= window.from && d <= window.to;
    const tr = rc.trades.filter(t => inW(nyDate(t.exitNy)));
    const left = [...exc.closeWithoutOpen, ...exc.excessClose].filter(c => inW(nyOf(c.instant)));
    const lots = [...exc.pastExpiryOpen, ...exc.stillOpen].filter(l => inW(nyOf(l.openedInstant)));
    const px = (fillId, q) => { const f = fills.get(fillId); return Math.round(f.price * f.multiplier * q * 100); };
    const contracts = tr.reduce((s, t) => s + t.contracts, 0) + left.reduce((s, c) => s + c.contractsUnmatched, 0);
    const grossCents = tr.reduce((s, t) => s + t.grossCents, 0) + left.reduce((s, c) => s + px(c.fillId, c.contractsUnmatched), 0) - lots.reduce((s, l) => s + px(l.fillId, l.contractsRemaining), 0);
    const feeCents = tr.reduce((s, t) => s + (t.feeCents || 0), 0) + left.reduce((s, c) => s + (c.feeShareCents || 0), 0) + lots.reduce((s, l) => s + (l.feeShareCents || 0), 0);
    return { contracts, grossCents, feeCents, netCents: grossCents - feeCents, trades: tr.length, exceptions: left.length + lots.length };
  };
  let reconLine = 'no outside reference given';
  if (reference) {
    const got = recon(reference.window);
    const want = reference.expect;
    const ok = got.contracts === want.contracts && got.grossCents === want.grossCents && got.feeCents === want.feeCents && got.netCents === want.netCents;
    reconLine = `${reference.name} (${reference.window.from} to ${reference.window.to}): rebuilt trades ${got.trades} + exceptions ${got.exceptions} = ${got.contracts} contracts, ${money(got.grossCents)} gross, ${money(got.feeCents)} fees, ${money(got.netCents)} net; Schwab: ${want.contracts}, ${money(want.grossCents)}, ${money(want.feeCents)}, ${money(want.netCents)} -> ${ok ? 'EQUAL' : 'DIFFERENT'}`;
    if (!ok) stop('reference-mismatch', `The rebuild does not reconcile with ${reference.name}: ${reconLine}`);
  }

  const totals = totalsOf(out);
  const P_FP = journalFingerprint(out);

  // -- The log --
  say('STEP E DRY-RUN LOG (tools/stepE-prepare.js). Nothing was written anywhere but this file' + (stops.length ? '.' : ', the prepared journal and the restore file.'));
  say(OWNER_DECISION + '; tradeRebuild.js ' + R.ENGINE + ', rule ' + RULE + '.');
  say(`Backup copy taken ${exportedAt}; ${ledgerItems.length} ledger entries; ${rc.fills.length} fills; ${rc.trades.length} rebuilt trades in all; latest ledger date ${latestLedgerDate}.`);
  say(`Journal: ${journal.length} trades (${brokerTrades.length} from the broker, ${handTyped.length} typed by hand); fingerprint ${R_FP}.`);
  say(`Range: rebuilt trades closing on or after ${start}${rangeStart ? ' (given)' : ' (the earliest close in the journal)'}: ${rebuilt.length}.`);
  say(`Journal broker trades in range: ${inScope.length}; before the range, untouched: ${before.length}; typed by hand, untouched: ${handTyped.length}.`);
  say(`Outcome: KEPT ${kept.size}, ADDED ${rebuilt.length - kept.size}, REMOVED ${removed.length}, his data moved ${transferLog.length}.`);
  say(`Reconciliation: ${reconLine}.`);
  const st0 = keys['trades:state'] && keys['trades:state'].value;
  const stObj = typeof st0 === 'string' ? safeParse(st0) : st0;
  say(`Server queue (trades:state): ${stObj && Array.isArray(stObj.pending) ? stObj.pending.length + ' trades waiting' : 'not in the backup'}.`);
  say(`Pictures on trades: ${journal.filter(t => PICTURES.some(f => t[f])).length} trades. Journal size as stored (approx.): ${Buffer.byteLength(JSON.stringify(journal.map(t => { const o = Object.assign({}, t); for (const f of PICTURES) if (o[f]) o[f] = 'kept'; return o; })))} bytes.`);
  say(`Prepared journal: ${out.length} trades, ${totals.contracts} contracts, ${money(totals.grossCents)} gross, ${money(totals.feeCents)} fees, ${money(totals.netCents)} net (known fees only); fingerprint ${P_FP}.`);
  say('');
  if (stops.length) {
    say(`STOPPED: ${stops.length} reason(s). NO prepared journal was written. The inputs were not modified.`);
    for (const s of stops) say(`STOP [${s.code}] ${s.text}`);
    say('');
  }
  say('FIELD CLASSES (every field name found in the journal):');
  const fieldNames = [...new Set(journal.flatMap(t => Object.keys(t || {})))].sort();
  for (const f of fieldNames) say(`  ${f}: ${classOf(f)}`);
  say('');
  say('EXCEPTIONS IN RANGE (listed, never turned into trades; tradeDate stays authoritative):');
  for (const e of excInRange) say('  ' + e);
  if (!excInRange.length) say('  none');
  say('');
  for (const l of keptLog) say(l);
  for (const l of addedLog) say(l);
  for (const { t, reason } of removed) say(`REMOVED ${t.id} ${t.ticker || '?'} ${t.entryDate || '?'} ${t.entryTime || ''}->${t.exitTime || ''} x${t.contracts} ${t.source}: ${reason}${ownerFields(t).length ? '; his data: ' + ownerFields(t).join(', ') : ''}`);
  for (const l of transferLog) say(l);
  for (const t of before) say(`UNTOUCHED (before range) ${t.id} ${t.ticker} ${t.exitDate}`);
  for (const t of handTyped) say(`UNTOUCHED (typed by hand) ${t.id} ${t.ticker} ${t.exitDate}`);
  return finish(out, totals, P_FP, R_FP, start);

  function finish(outTrades, tot, pfp, rfp, startDate) {
    const stopped = stops.length > 0;
    if (!lines.length) { for (const s of stops) lines.push(`STOP [${s.code}] ${s.text}`); lines.unshift('STEP E DRY-RUN LOG: STOPPED before the rebuild. NO prepared journal was written. The inputs were not modified.'); }
    const result = { stopped, stops, log: lines.join('\n') + '\n' };
    if (stopped) return result;
    const body = {
      kind: KIND_PREPARED, rule: RULE, ownerDecision: OWNER_DECISION, engine: R.ENGINE,
      basedOn: rfp, fingerprint: pfp, range: { from: startDate }, totals: tot, trades: outTrades,
    };
    result.prepared = Object.assign({}, body, { checksum: sha256(canonical(body)) });
    const rbody = { kind: KIND_RESTORE, fingerprint: rfp, totals: totalsOf(journal), trades: journal };
    result.restore = Object.assign({}, rbody, { checksum: sha256(canonical(rbody)) });
    return result;
  }
}

function nyOf(instant) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function classOf(f) {
  if (BROKER_SET.has(f)) return 'broker fact (from the ledger)';
  if (ENTRY_FACTS.includes(f)) return 'machine fact at the purchase (carried by the same opening fill only)';
  if (EXIT_FACTS.includes(f)) return 'machine fact at the sale (carried by the same closing fill only)';
  if (PAIR_ONLY.includes(f)) return 'machine fact, same pair only';
  if (DERIVED.includes(f)) return 'worked out / catch-up bookkeeping';
  if (OWNER_KNOWN.includes(f)) return 'HIS (owner data)';
  return 'HIS (unknown field, so treated as his)';
}
// Totals the app recomputes from the trades, in cents.
function totalsOf(trades) {
  let contracts = 0, grossCents = 0, feeCents = 0, netCents = 0;
  for (const t of trades) {
    contracts += Number(t.contracts) || 0;
    if (cents(t.pnlDollar) != null) grossCents += cents(t.pnlDollar);
    if (cents(t.fees) != null) feeCents += cents(t.fees);
    if (cents(t.pnlNet) != null) netCents += cents(t.pnlNet);
  }
  return { trades: trades.length, contracts, grossCents, feeCents, netCents };
}

// Schwab's own file (B), the outside referee recorded in Blocker 3B.
const REFERENCE_B = {
  name: "Schwab's file (B)", window: { from: '2026-05-04', to: '2026-07-23' },
  expect: { contracts: 151, grossCents: -54100, feeCents: 19994, netCents: -74094 },
};

module.exports = { prepare, journalFingerprint, ownerFields, totalsOf, REFERENCE_B, KIND_PREPARED, KIND_RESTORE, RULE };
