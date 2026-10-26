// Stand-in for the generation-2 scripts (tradeStore's SCRIPTS; queue plan
// v14.1 revision 3.2, Deploy 2), for checks whose storage is a plain object.
//
// Since Deploy 2, "trades:state" is read and saved ONLY by scripts run inside
// the database (THE RESOLUTION READ, THE COMMIT), the fence is raised by THE
// RAISE, and failures are logged by THE LOG. A stand-in storage object has no
// script engine, so this does in JavaScript what each script does, through
// the stand-in's OWN get and set -- so a check that makes its set fail still
// rehearses that failure. Scripts are recognised by their pinned SHA-1, and
// any other script is an error here, never a silent "OK".
//
// What this is NOT: evidence that the real scripts are right. That is
// tests/gen2-store.js (the real scripts on a real Redis) and the real-store
// run (plan 6.0).
const crypto = require('crypto');
const path = require('path');

const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const PIN_NAMES = {
  '8bab7b6be6738459a7decfa3bcdc489b759e974e': 'RAISE',
  '2ed6d703b781a328059b4f2eb515a9fb61a6b248': 'COMMIT',
  'a25e8b7ba49778dacf7f34b9a47ae10cb7dcc4b6': 'RESOLUTION_READ',
  'e2585315c7a488bcdd8ce65a51838f3e529bd3d4': 'LOG',
};

// hooks.beforeCommit(text) may throw to rehearse a failed save; hooks.log
// receives every script call.
function gen2Via(fake, hooks = {}) {
  const textOf = async k => { const v = await fake.get(k); return v == null ? null : JSON.stringify(v); };
  return async (script, keys, args) => {
    const name = PIN_NAMES[sha1(String(script))];
    if (hooks.log) hooks.log.push({ name, keys, args });
    if (name === 'RESOLUTION_READ') {
      const t = await textOf(keys[0]);
      if (t === null) return ['absent'];
      return ['present', sha1(t), t];
    }
    if (name === 'COMMIT') {
      const f = await fake.get(keys[1]);
      if (f == null || !/^\d+$/.test(String(f)) || Number(String(f)) !== Number(args[2])) return 'FENCED';
      const cur = await textOf(keys[0]);
      if (args[0] === 'none' ? cur !== null : (cur === null || sha1(cur) !== args[0])) return 'CONFLICT';
      if (hooks.beforeCommit) await hooks.beforeCommit(args[1]);
      await fake.set(keys[0], JSON.parse(args[1]));
      return 'COMMITTED';
    }
    if (name === 'RAISE') {
      const f = await fake.get(keys[0]);
      if (f != null) {
        if (!/^\d+$/.test(String(f))) return 'FENCE-INVALID';
        const d = String(f).replace(/^0+/, '');
        if (d === '2') return 'ALREADY';
        if (d !== '' && d !== '1') return 'FENCED';
      }
      await fake.set(keys[0], '2');
      return 'RAISED';
    }
    if (name === 'LOG') {
      const cur = await fake.get(keys[0]);
      if (cur != null && !Array.isArray(cur)) throw new Error('wrong-type');
      const list = [args[0], ...(cur || [])].slice(0, 100);
      await fake.set(keys[0], list);
      return list.length;
    }
    throw new Error('stand-in storage: not a generation-2 script, so it is not answered');
  };
}

// An older-shape record as generation 2 would leave it after its expansion,
// for checks that set up a starting record. Uses the real expansion.
function expanded(doc, at = Date.now()) {
  const Q = require(path.join(__dirname, '..', '..', 'queueOps'));
  if (doc && doc.schemaVersion === 2) return doc;
  const fixed = { opId: crypto.randomBytes(16).toString('hex'), at, candidateEpoch: crypto.randomBytes(16).toString('hex') };
  const out = Q.expandUpdate(doc, fixed);
  if (out.refuse) throw new Error('expanded(): ' + out.why);
  return Q.finalize(doc, out.next, out.result, 'expand', fixed).final;
}

// A record DAMAGED after its expansion: the generation-2 fields are added
// without the expansion's checks, so a check can store a deliberately bad
// field and see how generation 2 treats it (it refuses: "state-invalid").
function expandedAnyway(doc, at = Date.now()) {
  try { return expanded(doc, at); } catch (e) {
    const ok = expanded({ openLegs: [], pending: [], lastProcessedIds: [] }, at);
    return Object.assign({}, doc, Object.fromEntries(Object.entries(ok).filter(([k]) => GEN2_FIELDS.includes(k))));
  }
}

// Removes what generation 2 adds, so a check written before it can compare a
// record's older fields as it always did.
const GEN2_FIELDS = ['schemaVersion', 'stateVersion', 'queueEpoch', 'queueSeq', 'queueEvents', 'opRecords',
  'prunedThroughVersion', 'pendingStaged', 'removalEnabled', 'resetCounter', 'prunedResetThrough'];
function olderFields(doc) {
  if (!doc) return doc;
  const o = { ...doc };
  for (const k of GEN2_FIELDS) delete o[k];
  return o;
}
const withoutQid = e => { const o = { ...e }; delete o.qid; return o; };

// The two test writers the older checks used, through THE COMMIT now
// (saveState, addPendingTrade and removePendingTrade are gone: every write of
// the record goes through it). Removal is the real older-app form (4.3);
// adding is a test writer that lands one entry with its qid, as the sync does.
function removePending(tradeStore, id) {
  const Q = require(path.join(__dirname, '..', '..', 'queueOps'));
  return tradeStore.protect('legacy-removal', Q.legacyRemovalById, { payload: { id } });
}
function addPending(tradeStore, entry) {
  const Q = require(path.join(__dirname, '..', '..', 'queueOps'));
  return tradeStore.protect('sync-landing', (doc, fx) => {
    const ids = Q.issueQids(doc, 1, fx.candidateEpoch, fx.at);
    if (!ids.ok) return { refuse: ids.reason };
    const e = { ...entry, qid: ids.qids[0] };
    return { next: { ...doc, ...ids.fields, pending: [e, ...(doc.pending || [])] },
      result: { landed: [{ id: String(e.id), qid: e.qid }], fillsProcessed: 0 } };
  });
}

module.exports = { gen2Via, expanded, expandedAnyway, olderFields, withoutQid, removePending, addPending, GEN2_FIELDS, PIN_NAMES };
