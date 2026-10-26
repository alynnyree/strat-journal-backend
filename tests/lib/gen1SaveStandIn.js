// Stand-in for the generation-1 save (tradeStore's GEN1_SAVE_SCRIPT; queue
// plan v14.1 revision 2, 5.8.2), for checks whose storage is a plain object.
//
// Since Deploy 1, "trades:state" is saved by ONE script run inside the
// database, not by SET. A stand-in storage object has no script engine, so
// this does in JavaScript exactly what the script does, through the
// stand-in's OWN get and set -- so a check that makes its set fail (to
// rehearse a refused save) still rehearses it, and each check keeps storing
// values its own way.
//
// It answers ONLY the generation-1 save, by its exact text and keys. Any
// other script is an error here, never a silent "OK".
//
// What this is NOT: evidence that the real script is right, or that the
// check and the save cannot be separated. That is tests/writer-fence.js
// (the real script on a real Redis, where one is installed) and the
// real-store gate (plan 6.0).
const path = require('path');

// `buildDir` is the folder of the generation-1 build (tests/lib/olderBuild.js):
// since Deploy 2 the generation-1 save lives only in history, at eb3880b.
function gen1SaveVia(fake, buildDir) {
  return async (script, keys, args) => {
    const ts = require(path.join(buildDir, 'tradeStore'));
    if (script !== ts.GEN1_SAVE_SCRIPT
        || !Array.isArray(keys) || keys.length !== 2 || keys[0] !== ts.KEY || keys[1] !== ts.FENCE_KEY
        || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error('stand-in storage: not the generation-1 save, so it is not answered');
    }
    const fence = await fake.get(keys[1]);
    if (fence != null) {
      if (!/^\d+$/.test(String(fence))) return 'FENCED';
      const d = String(fence).replace(/^0+/, '');          // as the script: digits, no tonumber
      if (d !== '' && d !== '1') return 'FENCED';
    }
    await fake.set(keys[0], JSON.parse(args[0]));
    return 'SAVED';
  };
}

module.exports = { gen1SaveVia };
