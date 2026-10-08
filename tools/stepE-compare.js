// AUDIT STEP E: stepE-compare, the check that runs between his fresh journal
// export and any apply. Plan "STEP E - stepE-compare" (7 Oct 2026), approved by
// the auditor; implementation authorized by the owner ("I authorize step
// E-compare implementation"). It implements dry-run plan v2's rules C1-C9.
//
// It is OFFLINE and PURE: it loads only crypto and ./stepE-prepare (E1, which
// loads tradeRebuild.js). No clock, network or file access; the command-line
// tool (stepE-compare-cli.js) reads the files and writes the one report.
//
// It never writes a journal, never repairs, never chooses. It re-derives both
// sides itself with E1 (it trusts no handed-over result) and answers PASS or
// STOP with every difference listed.
//
// compare({ approval, approvalBytes, x0Bytes, b0Bytes, xnBytes, pnBytes, codeHashes })
//   -> { result: 'PASS' | 'STOP', stops: [{ rule, trade, text }], report }
const crypto = require('crypto');
const E = require('./stepE-prepare');

const KIND_APPROVAL = 'strat-journal-stepE-approval-v1';
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A stable text form of a value (keys sorted), for comparing values only.
function stable(v) {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const same = (a, b) => stable(a) === stable(b);
const short = v => { const s = stable(v); return s.length <= 80 ? s : `${s.slice(0, 60)}... (${s.length} chars, sha256 ${sha256(s).slice(0, 12)})`; };
const asBuffer = b => (b == null ? null : Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'));
const parseJson = b => { try { return { ok: true, value: JSON.parse(asBuffer(b).toString('utf8')) }; } catch (e) { return { ok: false, error: e.message }; } };

// ---- Reading E1's own log (the classes and lines come from E1, never from a
// second copy here) ----------------------------------------------------------------
function section(log, header) {
  const lines = log.split('\n');
  const i = lines.indexOf(header);
  if (i < 0) return null;
  const out = [];
  for (let k = i + 1; k < lines.length && lines[k] !== ''; k++) out.push(lines[k]);
  return out;
}
const lineStarting = (log, prefix) => log.split('\n').find(l => l.startsWith(prefix)) || null;
const movedLines = log => log.split('\n').filter(l => l.startsWith('MOVED his data from removed ')).sort();
function parseMoved(line) {
  const m = /^MOVED his data from removed (.+?) to (.+?) by opening fill (\S+): (.+)$/.exec(line);
  return m ? { from: m[1], to: m[2], fill: m[3], fields: m[4] } : null;
}
// The text E1 logs after a removed trade's own description: its reason, and
// "; his data: ..." when it carried any.
function removalReason(log, t) {
  const prefix = `REMOVED ${t.id} ${t.ticker || '?'} ${t.entryDate || '?'} ${t.entryTime || ''}->${t.exitTime || ''} x${t.contracts} ${t.source}: `;
  const l = log.split('\n').find(x => x.startsWith(prefix));
  return l ? l.slice(prefix.length) : null;
}
// E1's class for every field name: a probe run of E1 itself, with one trade
// typed by hand that carries every name, so its log lists the class of each.
function classesFromE1(names, backup, rangeStart) {
  const probe = { id: 'stepE-compare-class-probe', source: 'class-probe' };
  for (const n of names) if (!(n in probe)) probe[n] = null;
  const r = E.prepare({ journal: [probe], backup, rangeStart });
  const lines = section(r.log, 'FIELD CLASSES (every field name found in the journal):');
  const cls = new Map();
  for (const l of lines || []) {
    const m = /^ {2}([^:]+): (.+)$/.exec(l);
    if (!m) continue;
    const c = m[2];
    cls.set(m[1], c.startsWith('broker fact') ? 'broker' : (c.startsWith('machine fact') || c.startsWith('worked out')) ? 'machine' : c.startsWith('HIS') ? 'owner' : 'broker');
  }
  // A name E1 did not answer for is held to the strictest rule.
  for (const n of names) if (!cls.has(n)) cls.set(n, 'broker');
  return cls;
}

// ---- The rules ----------------------------------------------------------------------
// Each rule adds its STOPs to ctx; a rule never changes anything. Exported so a
// test can switch one off and show its STOP disappears.
const RULES = {
  // C1: the same ledger records, code, rule, range and reference, proved by
  // reproducing the approved P0 and L0 exactly.
  C1(ctx) {
    const { a, stop } = ctx;
    if (!a || a.kind !== KIND_APPROVAL) { stop('C1', '-', `The approval record is not a ${KIND_APPROVAL} record.`); return; }
    if (!ctx.x0) stop('C1', '-', 'X0 is unreadable.');
    if (!ctx.b0) stop('C1', '-', 'B0 is unreadable.');
    if (ctx.x0 && ctx.x0Fingerprint !== a.x0Fingerprint) stop('C1', '-', `X0 is not the approved journal: fingerprint ${ctx.x0Fingerprint}, approved ${a.x0Fingerprint}.`);
    if (ctx.b0Sha256 !== a.b0Sha256) stop('C1', '-', `B0 is not the approved ledger copy: sha256 ${ctx.b0Sha256}, approved ${a.b0Sha256}.`);
    for (const f of ['stepE-prepare.js', 'tradeRebuild.js']) {
      const got = ctx.codeHashes && ctx.codeHashes[f], want = a.code && a.code[f];
      if (!got || got !== want) stop('C1', '-', `${f} is not the approved code: sha256 ${got || 'not given'}, approved ${want || 'not given'}.`);
    }
    if (!ctx.r0) return;
    if (ctx.r0.stopped) { stop('C1', '-', `E1 stopped on X0 + B0, so the approved result cannot be reproduced: ${ctx.r0.stops.map(s => s.code).join(', ')}.`); return; }
    if (ctx.r0.prepared.fingerprint !== a.p0Fingerprint) stop('C1', '-', `E1 on X0 + B0 gives prepared fingerprint ${ctx.r0.prepared.fingerprint}, approved P0 is ${a.p0Fingerprint}.`);
    if (sha256(ctx.r0.log) !== a.l0Sha256) stop('C1', '-', `E1 on X0 + B0 gives a log with sha256 ${sha256(ctx.r0.log)}, approved L0 is ${a.l0Sha256} (the range, the reference, the ledger or the code differ).`);
    if (ctx.r0.prepared.range.from !== a.rangeStart) stop('C1', '-', `The approved run's range starts ${ctx.r0.prepared.range.from}, the approval record says ${a.rangeStart}.`);
    if (ctx.rn && !ctx.rn.stopped && ctx.rn.prepared.range.from !== a.rangeStart) stop('C1', '-', `P_n's range starts ${ctx.rn.prepared.range.from}, approved ${a.rangeStart}.`);
  },
  // The file that would be applied is the file that was compared.
  FILE(ctx) {
    const { stop } = ctx;
    if (!ctx.pnBytes) { stop('FILE', '-', 'No P_n file was given.'); return; }
    if (!ctx.rn || ctx.rn.stopped) return;
    const derived = Buffer.from(JSON.stringify(ctx.rn.prepared), 'utf8');
    if (Buffer.compare(derived, ctx.pnBytes) !== 0) stop('FILE', '-', `The P_n file (sha256 ${sha256(ctx.pnBytes)}) is not byte-identical to E1's result on X_n + B0 (sha256 ${sha256(derived)}).`);
  },
  // C9: E1's own stops stand.
  C9(ctx) {
    if (ctx.rn && ctx.rn.stopped) for (const s of ctx.rn.stops) ctx.stop('C9', '-', `E1 stopped on X_n: [${s.code}] ${s.text}`);
  },
  // C2: the same rebuilt trades (by ledger trade id, with their fills), the same
  // exceptions record by record, the same ledger, range, reconciliation and money.
  C2(ctx) {
    const { stop, r0, rn } = ctx;
    if (!ctx.both) return;
    for (const id of ctx.ledgerIds) {
      const t0 = ctx.p0ByLedger.get(id), tn = ctx.pnByLedger.get(id);
      if (!t0) stop('C2', id, 'A rebuilt trade in P_n that is not in P0.');
      else if (!tn) stop('C2', id, 'A rebuilt trade in P0 that is not in P_n.');
      else if (!same(t0.stepE, tn.stepE)) stop('C2', id, `Its provenance differs: ${short(t0.stepE)} -> ${short(tn.stepE)}.`);
    }
    const exc0 = section(r0.log, 'EXCEPTIONS IN RANGE (listed, never turned into trades; tradeDate stays authoritative):') || [];
    const excN = section(rn.log, 'EXCEPTIONS IN RANGE (listed, never turned into trades; tradeDate stays authoritative):') || [];
    for (const l of exc0) if (!excN.includes(l)) stop('C2', '-', `An approved exception is missing or different in L_n:${l}`);
    for (const l of excN) if (!exc0.includes(l)) stop('C2', '-', `An exception in L_n that is not in L0:${l}`);
    for (const p of ['Backup copy taken ', 'Reconciliation: ']) {
      const l0 = lineStarting(r0.log, p), ln = lineStarting(rn.log, p);
      if (l0 !== ln) stop('C2', '-', `The line "${p.trim()}" differs: L0 "${l0}" / L_n "${ln}".`);
    }
    const rng = l => { const m = /^Range: rebuilt trades closing on or after (\S+) .*: (\d+)\.$/.exec(l || ''); return m ? `${m[1]} ${m[2]}` : null; };
    const g0 = rng(lineStarting(r0.log, 'Range: ')), gn = rng(lineStarting(rn.log, 'Range: '));
    if (!g0 || g0 !== gn) stop('C2', '-', `The range or the number of rebuilt trades differs: L0 ${g0} / L_n ${gn}.`);
    if (!same(r0.prepared.totals, rn.prepared.totals)) stop('C2', '-', `The prepared totals differ: ${short(r0.prepared.totals)} -> ${short(rn.prepared.totals)}.`);
  },
  // C3 and C8, field by field: broker facts never differ; other machine facts
  // are listed; owner data is C7's.
  C3(ctx) {
    if (!ctx.both) return;
    for (const [key, t0, tn] of ctx.pairs) {
      for (const f of ctx.fieldsOf(t0, tn)) {
        const c = ctx.cls.get(f);
        if (c !== 'broker') continue;
        if (f === 'id' && ctx.c5Kept.has(String(tn.id)) && String(t0.id) === key) continue;   // a new genuine trade kept under its own id
        if (!same(t0[f], tn[f])) ctx.stop('C3', ctx.label(tn), `Broker fact ${f} differs: ${short(t0[f])} -> ${short(tn[f])}.`);
      }
    }
  },
  // C4: every X0 trade keeps its disposition.
  C4(ctx) {
    if (!ctx.both) return;
    for (const x of ctx.x0) {
      const id = String(x.id), xn = ctx.xnById.get(id);
      if (!xn) continue;   // C6
      const k0 = ctx.p0ById.get(id), kn = ctx.pnById.get(id);
      const where = t => (t.stepE ? t.stepE.ledgerTradeId : 'untouched');
      if (k0 && kn) { if (where(k0) !== where(kn)) ctx.stop('C4', id, `Kept to ${where(k0)} in P0, to ${where(kn)} in P_n.`); continue; }
      if (k0 && !kn) { ctx.stop('C4', id, `Kept to ${where(k0)} in P0, removed in P_n (${removalReason(ctx.rn.log, xn) || 'no reason found in L_n'}).`); continue; }
      if (!k0 && kn) { ctx.stop('C4', id, `Removed in P0 (${removalReason(ctx.r0.log, x) || 'no reason found in L0'}), kept to ${where(kn)} in P_n.`); continue; }
      const w0 = removalReason(ctx.r0.log, x), wn = removalReason(ctx.rn.log, xn);
      if (w0 == null || wn == null || w0 !== wn) ctx.stop('C4', id, `Removed for a different reason: L0 "${w0}" / L_n "${wn}".`);
    }
  },
  // C5: a trade that appeared after X0.
  C5(ctx) {
    if (!ctx.both) return;
    for (const id of ctx.newIds) {
      const xn = ctx.xnById.get(id), tn = ctx.pnById.get(id);
      if (tn) {
        if (!tn.stepE) { ctx.stop('C5', id, 'A new trade that E1 leaves untouched (typed by hand or before the range): not one of the two allowed outcomes.'); continue; }
        const t0 = ctx.p0ByLedger.get(tn.stepE.ledgerTradeId);
        if (!same(tn.fills, xn.fills)) ctx.stop('C5', id, `Kept, but not on its own fills: ${short(xn.fills)} -> ${short(tn.fills)}.`);
        if (!t0 || String(t0.id) !== tn.stepE.ledgerTradeId) ctx.stop('C5', id, `It is kept in place of ${t0 ? t0.id : 'nothing'}, which P0 held under that ledger trade.`);
        const own = E.ownerFields(xn), kept = E.ownerFields(tn);
        if (!same(own, kept) || own.some(f => !same(xn[f], tn[f]))) ctx.stop('C5', id, `Its own data does not stay on it unchanged: ${own.join(', ') || 'none'} -> ${kept.join(', ') || 'none'}.`);
        ctx.c5Lines.push(`${id}: KEPT on its own fills ${(tn.fills || []).join('+')} (ledger trade ${tn.stepE.ledgerTradeId})${own.length ? '; its own data stays: ' + own.join(', ') : ''}`);
        continue;
      }
      const why = removalReason(ctx.rn.log, xn) || '';
      const own = E.ownerFields(xn);
      if (!why.startsWith('the same broker pair saved again')) { ctx.stop('C5', id, `Removed as "${why || 'no reason found'}": not one of the two allowed outcomes.`); continue; }
      if (own.length) { ctx.stop('C5', id, `Removed as the same broker pair saved again, but it carries his data (${own.join(', ')}). Nothing is discarded, merged or moved.`); continue; }
      ctx.c5Lines.push(`${id}: REMOVED, ${why}; it carries no data of his`);
    }
  },
  // C6: no X0 trade may be missing.
  C6(ctx) {
    if (!ctx.x0 || !ctx.xn) return;
    for (const x of ctx.x0) if (!ctx.xnById.has(String(x.id))) ctx.stop('C6', String(x.id), 'It is in X0 and missing from X_n. A deletion is never assumed to be intended.');
  },
  // C7: owner data and transfers.
  C7(ctx) {
    if (!ctx.both) return;
    const { stop } = ctx;
    for (const x of ctx.x0) {
      const xn = ctx.xnById.get(String(x.id));
      if (!xn) continue;
      const f0 = E.ownerFields(x), fn = E.ownerFields(xn);
      if (!same(f0, fn)) stop('C7', String(x.id), `The fields that are his changed between X0 and X_n: ${f0.join(', ') || 'none'} -> ${fn.join(', ') || 'none'}.`);
      for (const f of [...new Set([...f0, ...fn])].sort()) if (!same(x[f], xn[f])) stop('C7', String(x.id), `His ${f} changed between X0 and X_n: ${short(x[f])} -> ${short(xn[f])}.`);
    }
    for (const [, t0, tn] of ctx.pairs) {
      const f0 = E.ownerFields(t0), fn = E.ownerFields(tn);
      if (ctx.c5Kept.has(String(tn.id))) {
        if (f0.length) stop('C7', ctx.label(tn), `P0 carried his data here (${f0.join(', ')}); the new trade ${tn.id} now sits in its place.`);
        continue;
      }
      if (!same(f0, fn)) stop('C7', ctx.label(tn), `The fields that are his differ between P0 and P_n: ${f0.join(', ') || 'none'} -> ${fn.join(', ') || 'none'}.`);
      for (const f of [...new Set([...f0, ...fn])].sort()) if (!same(t0[f], tn[f])) stop('C7', ctx.label(tn), `His ${f} differs between P0 and P_n: ${short(t0[f])} -> ${short(tn[f])}.`);
    }
    const m0 = movedLines(ctx.r0.log), mn = movedLines(ctx.rn.log);
    for (const l of m0) if (!mn.includes(l)) stop('C7', '-', `An approved transfer is missing or different in L_n: ${l}`);
    for (const l of mn) {
      const p = parseMoved(l);
      if (p && (ctx.newIdSet.has(p.to) || ctx.c5Kept.has(p.to))) stop('C7', p.to, `A new trade would RECEIVE his data from ${p.from}: ${l}`);
      if (p && ctx.newIdSet.has(p.from)) stop('C7', p.from, `A new trade would GIVE his data to ${p.to}: ${l}`);
      if (!m0.includes(l)) stop('C7', '-', `A transfer in L_n that L0 did not approve: ${l}`);
    }
  },
  // C8: machine facts that differ are listed and never block.
  C8(ctx) {
    if (!ctx.both) return;
    for (const [, t0, tn] of ctx.pairs) for (const f of ctx.fieldsOf(t0, tn)) {
      if (ctx.cls.get(f) !== 'machine' || same(t0[f], tn[f])) continue;
      ctx.c8Lines.push(`${ctx.label(tn)} ${f}: ${short(t0[f])} -> ${short(tn[f])}`);
    }
  },
};
const ORDER = ['C1', 'FILE', 'C9', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

function compare({ approval, approvalBytes, x0Bytes, b0Bytes, xnBytes, pnBytes, codeHashes } = {}) {
  const stops = [];
  const stop = (rule, trade, text) => stops.push({ rule, trade: String(trade), text });
  const ctx = { stop, a: approval, codeHashes, c5Lines: [], c8Lines: [] };
  const X0 = parseJson(x0Bytes), XN = parseJson(xnBytes), B0 = parseJson(b0Bytes);
  ctx.x0 = X0.ok && Array.isArray(X0.value) ? X0.value : null;
  ctx.xn = XN.ok && Array.isArray(XN.value) ? XN.value : null;
  ctx.b0 = B0.ok && B0.value && typeof B0.value === 'object' ? B0.value : null;
  ctx.pnBytes = asBuffer(pnBytes);
  ctx.b0Sha256 = b0Bytes == null ? null : sha256(asBuffer(b0Bytes));
  ctx.x0Fingerprint = ctx.x0 ? E.journalFingerprint(ctx.x0) : null;
  ctx.xnFingerprint = ctx.xn ? E.journalFingerprint(ctx.xn) : null;
  ctx.xnById = new Map((ctx.xn || []).map(t => [String(t.id), t]));
  const a = approval || {};
  // The approved run is reproduced exactly as it was made (its range from the
  // journal); X_n is run with the approved range GIVEN, never re-derived.
  if (ctx.x0 && ctx.b0) ctx.r0 = E.prepare({ journal: ctx.x0, backup: ctx.b0, reference: a.reference });
  if (ctx.xn && ctx.b0) ctx.rn = E.prepare({ journal: ctx.xn, backup: ctx.b0, reference: a.reference, rangeStart: a.rangeStart });
  if (!ctx.xn) stop('C9', '-', 'X_n is unreadable.');

  RULES.C1(ctx);
  if (!stops.some(s => s.rule === 'C1')) {
    ctx.both = !!(ctx.r0 && !ctx.r0.stopped && ctx.rn && !ctx.rn.stopped);
    if (ctx.both) {
      const P0 = ctx.r0.prepared.trades, PN = ctx.rn.prepared.trades;
      ctx.p0ById = new Map(P0.map(t => [String(t.id), t]));
      ctx.pnById = new Map(PN.map(t => [String(t.id), t]));
      const byLedger = list => new Map(list.filter(t => t.stepE).map(t => [t.stepE.ledgerTradeId, t]));
      ctx.p0ByLedger = byLedger(P0); ctx.pnByLedger = byLedger(PN);
      ctx.ledgerIds = [...new Set([...ctx.p0ByLedger.keys(), ...ctx.pnByLedger.keys()])].sort();
      const x0Ids = new Set(ctx.x0.map(t => String(t.id)));
      ctx.newIds = ctx.xn.map(t => String(t.id)).filter(id => !x0Ids.has(id)).sort();
      ctx.newIdSet = new Set(ctx.newIds);
      ctx.c5Kept = new Set(ctx.newIds.filter(id => ctx.pnById.has(id) && ctx.pnById.get(id).stepE));
      // Pairs: rebuilt trades by ledger trade id; untouched trades by their id.
      ctx.pairs = [];
      for (const id of ctx.ledgerIds) if (ctx.p0ByLedger.has(id) && ctx.pnByLedger.has(id)) ctx.pairs.push([id, ctx.p0ByLedger.get(id), ctx.pnByLedger.get(id)]);
      const untouched0 = P0.filter(t => !t.stepE), untouchedN = new Map(PN.filter(t => !t.stepE).map(t => [String(t.id), t]));
      for (const t of untouched0.sort((p, q) => cmpStr(String(p.id), String(q.id)))) if (untouchedN.has(String(t.id))) ctx.pairs.push([String(t.id), t, untouchedN.get(String(t.id))]);
      const names = [...new Set([...P0, ...PN, ...ctx.x0, ...ctx.xn].flatMap(t => Object.keys(t)))].sort();
      ctx.cls = classesFromE1(names, ctx.b0, a.rangeStart);
      ctx.fieldsOf = (p, q) => [...new Set([...Object.keys(p), ...Object.keys(q)])].sort();
      ctx.label = t => `${t.id}${t.stepE && String(t.id) !== t.stepE.ledgerTradeId ? ' (' + t.stepE.ledgerTradeId + ')' : ''}`;
    }
    for (const r of ORDER.slice(1)) RULES[r](ctx);
  }
  stops.sort((p, q) => cmpStr(ORDER.indexOf(p.rule), ORDER.indexOf(q.rule)) || cmpStr(p.trade, q.trade) || cmpStr(p.text, q.text));
  const result = stops.length ? 'STOP' : 'PASS';
  return { result, stops, report: reportOf(ctx, result, stops, approvalBytes) };
}

function reportOf(ctx, result, stops, approvalBytes) {
  const L = [];
  const a = ctx.a || {};
  const money = c => (c == null ? 'unknown' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2));
  const tot = t => (t ? `${t.trades} trades, ${t.contracts} contracts, ${money(t.grossCents)} gross, ${money(t.feeCents)} fees, ${money(t.netCents)} net` : 'none');
  L.push('STEP E COMPARISON REPORT (tools/stepE-compare.js). Read-only: nothing was written but this report.');
  L.push(`RESULT: ${result}${stops.length ? ` (${stops.length} reason${stops.length === 1 ? '' : 's'})` : ''}`);
  L.push('');
  L.push('INPUTS');
  L.push(`  approval record sha256 ${approvalBytes == null ? 'not given' : sha256(asBuffer(approvalBytes))}`);
  L.push(`  X0 journal fingerprint ${ctx.x0Fingerprint || 'unreadable'} (approved ${a.x0Fingerprint || '?'})`);
  L.push(`  X_n journal fingerprint ${ctx.xnFingerprint || 'unreadable'}`);
  L.push(`  B0 sha256 ${ctx.b0Sha256 || 'not given'} (approved ${a.b0Sha256 || '?'})`);
  L.push(`  P_n file sha256 ${ctx.pnBytes ? sha256(ctx.pnBytes) : 'not given'}`);
  for (const f of ['stepE-prepare.js', 'tradeRebuild.js']) L.push(`  ${f} sha256 ${(ctx.codeHashes || {})[f] || 'not given'} (approved ${(a.code || {})[f] || '?'})`);
  L.push(`  approved: P0 fingerprint ${a.p0Fingerprint || '?'}, L0 sha256 ${a.l0Sha256 || '?'}, range from ${a.rangeStart || '?'}, reference ${a.reference ? a.reference.name : '?'}`);
  L.push('');
  L.push('RESULTS RE-DERIVED WITH E1');
  if (ctx.r0) L.push(`  X0 + B0: ${ctx.r0.stopped ? 'STOPPED' : `prepared fingerprint ${ctx.r0.prepared.fingerprint}; log sha256 ${sha256(ctx.r0.log)}; ${tot(ctx.r0.prepared.totals)}`}`);
  if (ctx.rn) L.push(`  X_n + B0: ${ctx.rn.stopped ? 'STOPPED' : `prepared fingerprint ${ctx.rn.prepared.fingerprint}; checksum ${ctx.rn.prepared.checksum}; basedOn ${ctx.rn.prepared.basedOn}; ${tot(ctx.rn.prepared.totals)}`}`);
  L.push(`  trades: X0 ${ctx.x0 ? ctx.x0.length : '?'}, X_n ${ctx.xn ? ctx.xn.length : '?'}, P0 ${ctx.r0 && !ctx.r0.stopped ? ctx.r0.prepared.trades.length : '?'}, P_n ${ctx.rn && !ctx.rn.stopped ? ctx.rn.prepared.trades.length : '?'}`);
  for (const [n, r] of [['L0', ctx.r0], ['L_n', ctx.rn]]) if (r) {
    for (const p of ['Outcome: ', 'Reconciliation: ']) { const l = lineStarting(r.log, p); if (l) L.push(`  ${n} ${l}`); }
  }
  if (ctx.rn && !ctx.rn.stopped) for (const l of movedLines(ctx.rn.log)) L.push(`  L_n ${l}`);
  L.push('');
  L.push(`STOPS (${stops.length})`);
  for (const s of stops) L.push(`  [${s.rule}] ${s.trade}: ${s.text}`);
  if (!stops.length) L.push('  none');
  L.push('');
  L.push(`NEW TRADES SINCE X0 (C5) (${ctx.c5Lines.length})`);
  for (const l of ctx.c5Lines.slice().sort()) L.push('  ' + l);
  if (!ctx.c5Lines.length) L.push('  none');
  L.push('');
  L.push(`MACHINE FACTS THAT DIFFER (C8, listed, never blocking) (${ctx.c8Lines.length})`);
  for (const l of ctx.c8Lines.slice().sort()) L.push('  ' + l);
  if (!ctx.c8Lines.length) L.push('  none');
  return L.join('\n') + '\n';
}

module.exports = { compare, RULES, KIND_APPROVAL };
