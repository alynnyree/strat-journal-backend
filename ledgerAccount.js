// WHICH SCHWAB ACCOUNT the broker ledger is about. The auditor's condition
// for closing Blocker 2 (30 Sept 2026): "replace the first account returned
// behavior with an explicit, deterministic account-selection mechanism."
//
// Before this, the ledger import and the broker-history inspection both took
// whichever account Schwab happened to list FIRST. With one account that is
// harmless. The day a second one appears (an IRA, a new brokerage account),
// the order Schwab lists them in would have decided whose history went into
// his ledger, and nothing anywhere would have said so.
//
// The rule, in this order -- the same facts always give the same answer:
//
//  1. THE TIE. Once the ledger holds anything, it is about one account. The
//     tie is the entry "ledger:schwab:account", written once and never
//     rewritten (create-only). Until that entry exists, the accounts named
//     by the records ALREADY in the ledger are the tie -- the 691 records of
//     30 Sept were copied before this rule existed, and established evidence
//     is never overruled by a later answer (R19).
//  2. THE SETTING. SCHWAB_LEDGER_ACCOUNT on the server names an account
//     explicitly: its reference as the ledger shows it ("acct-" and 16
//     characters) or the last four (or more) digits of its number. It must
//     match exactly one account Schwab returns, and it must agree with the
//     tie. It cannot move the ledger to another account; that is a decision
//     for the owner, not a setting.
//  3. ONLY ONE. With no tie and no setting, an account is used only when
//     Schwab returns exactly one.
//
// Anything else is refused, before anything is fetched, and the refusal says
// which of those it was. It never falls back to "the first one".
//
// Nothing here pairs trades or touches the journal. The only thing it ever
// writes is the tie, and only when an import asks it to.
const crypto = require('crypto');

const TIE_KEY = 'ledger:schwab:account';
const REC_MATCH = 'ledger:schwab:rec:*';
const SETTING = 'SCHWAB_LEDGER_ACCOUNT';

const sha16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
// Same reference the ledger has written into every record since it began.
const refOf = hashValue => 'acct-' + sha16(hashValue);
// A second, independent reference from the account NUMBER, so that if Schwab
// ever changes its own reference for the same account, that can be told
// apart from "a different account".
const numberRefOf = n => (n == null || n === '' ? null : 'num-' + sha16('schwab-account-number:' + n));
const asObject = v => (typeof v === 'string' ? JSON.parse(v) : v);

// Every key matching a pattern, every page. The page marker is kept exactly
// as given: Upstash's can be larger than a JavaScript number holds exactly
// (see backupExport.js allKeys).
async function scanKeys(r, match) {
  const keys = []; let cursor = '0', rounds = 0;
  do {
    const [next, batch] = await r.scan(cursor, { match, count: 1000 });
    for (const k of batch || []) keys.push(k);
    cursor = String(next);
    if (++rounds > 2000) throw new Error('listing ledger keys did not finish');
  } while (cursor !== '0');
  return [...new Set(keys)];
}

// What Schwab returned, sorted by reference so nothing depends on its order.
// The hash itself is kept out of anything that is shown.
function candidatesFrom(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !a.hashValue) continue;
    const num = a.accountNumber == null ? '' : String(a.accountNumber);
    out.push({ ref: refOf(a.hashValue), numberRef: numberRefOf(num), ending: num ? num.slice(-4) : null, hashValue: a.hashValue, number: num });
  }
  return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
const shown = cs => cs.map(c => (c.ending ? `${c.ref} (ending ${c.ending})` : c.ref)).join(', ');

// The setting, matched against what Schwab returned.
function bySetting(setting, cs) {
  const s = String(setting).trim();
  if (/^acct-[0-9a-f]{16}$/.test(s)) return cs.filter(c => c.ref === s);
  if (/^\d{4,}$/.test(s)) return cs.filter(c => c.number && c.number.endsWith(s));
  return null; // not a form the setting accepts
}

// Pure: the choice itself. tie = { ref, numberRef? } or null.
function chooseAccount(list, { setting, tie } = {}) {
  const cs = candidatesFrom(list);
  const refuse = reason => ({ ok: false, reason, accountsReturned: cs.length });
  const pick = (c, how) => ({ ok: true, hashValue: c.hashValue, ref: c.ref, numberRef: c.numberRef, how, accountsReturned: cs.length });
  if (!cs.length) return refuse('Schwab answered the account lookup with no account.');

  let fromSetting = null;
  if (setting != null && String(setting).trim() !== '') {
    const m = bySetting(setting, cs);
    if (m === null) return refuse(`The server setting ${SETTING} is not in a form it accepts (an "acct-" reference as the ledger shows it, or the last four or more digits of the account number). Nothing was fetched.`);
    if (m.length === 0) return refuse(`The server setting ${SETTING} names an account Schwab did not return. Schwab returned ${cs.length}: ${shown(cs)}. Nothing was fetched.`);
    if (m.length > 1) return refuse(`The server setting ${SETTING} matches ${m.length} of the accounts Schwab returned (${shown(m)}), so it does not say which one. Use more digits, or the "acct-" reference. Nothing was fetched.`);
    fromSetting = m[0];
  }

  if (tie && tie.ref) {
    const tied = cs.find(c => c.ref === tie.ref);
    if (!tied) {
      const sameNumber = tie.numberRef && cs.find(c => c.numberRef === tie.numberRef);
      if (sameNumber) return refuse(`The ledger is tied to account ${tie.ref}. Schwab returned the same account number under a different reference (${sameNumber.ref}), so Schwab has changed how it refers to the account. Nothing was fetched; carrying on under the new reference is a decision for the owner.`);
      return refuse(`The ledger is tied to account ${tie.ref}, and Schwab did not return it (it returned ${cs.length}: ${shown(cs)}). Nothing was fetched. Using a different account is a decision for the owner, never an automatic switch.`);
    }
    if (fromSetting && fromSetting.ref !== tied.ref) return refuse(`The server setting ${SETTING} names ${fromSetting.ref}, but the ledger is tied to ${tied.ref}. A setting cannot move the ledger to a different account. Nothing was fetched.`);
    return pick(tied, fromSetting ? 'tied, and the setting agrees' : 'tied');
  }

  if (fromSetting) return pick(fromSetting, 'named by the server setting');
  if (cs.length === 1) return pick(cs[0], 'the only account Schwab returned');
  return refuse(`Schwab returned ${cs.length} accounts (${shown(cs)}) and nothing says which one the ledger is for. Set ${SETTING} on the server to one of those references. Nothing was fetched.`);
}

// The tie as it stands: the written entry, or else the accounts named by the
// records already in the ledger. Reads only.
async function readTie(r) {
  const entry = asObject(await r.get(TIE_KEY));
  if (entry && entry.ref) return { tie: { ref: entry.ref, numberRef: entry.numberRef || null }, source: 'the ledger\'s account entry', written: true };
  const keys = (await scanKeys(r, REC_MATCH)).sort();
  if (!keys.length) return { tie: null, source: 'the ledger is empty', written: false };
  const refs = new Set();
  let unreadable = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const vals = await r.mget(...keys.slice(i, i + 100));
    for (const v of vals) {
      const e = asObject(v);
      const ref = e && e.provenance && e.provenance.accountRef;
      if (ref) refs.add(ref); else unreadable++;
    }
  }
  if (refs.size === 1 && !unreadable) return { tie: { ref: [...refs][0], numberRef: null }, source: `the ${keys.length} records already in the ledger`, written: false };
  const err = new Error(refs.size > 1
    ? `The records already in the ledger name ${refs.size} different accounts (${[...refs].sort().join(', ')}). That needs a person to look at it; nothing was fetched.`
    : `${unreadable} of the ${keys.length} records already in the ledger do not say which account they came from, so the ledger's account cannot be established. Nothing was fetched.`);
  err.plain = true;
  throw err;
}

// Write the tie, once. If someone else wrote it first it must agree.
async function writeTie(r, chosen, { importId, at, basis }) {
  const entry = { ref: chosen.ref, numberRef: chosen.numberRef || null, how: chosen.how, basis, tiedAt: at, importId };
  const created = await r.set(TIE_KEY, entry, { nx: true });
  if (created === 'OK') return 'written';
  const existing = asObject(await r.get(TIE_KEY));
  if (existing && existing.ref === chosen.ref) return 'already';
  const err = new Error(`The ledger's account entry names ${existing && existing.ref}, not ${chosen.ref}. Nothing was written.`);
  err.plain = true;
  throw err;
}

// Read the tie, then choose. Used by both the import and the inspection.
async function resolveAccount(r, list) {
  const t = await readTie(r);
  const choice = chooseAccount(list, { setting: process.env[SETTING], tie: t.tie });
  return Object.assign(choice, { tieSource: t.source, tieWritten: t.written });
}

module.exports = { scanKeys, chooseAccount, candidatesFrom, readTie, writeTie, resolveAccount, refOf, numberRefOf, TIE_KEY, SETTING };
