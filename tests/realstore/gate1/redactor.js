'use strict';
// THE OUTPUT FILTER (Gate 1 plan v8, the credential-filter correction).
// v7 blanked each piece of output on its own and passed it straight on, so a
// credential arriving in two pieces passed as two unrecognised halves. Now
// output is HELD until a whole line has arrived; the whole line is blanked
// against every credential known at that moment, and only then written.
// A credential may never contain a line break (addSecretTo refuses one), so
// every occurrence of a credential lies inside one line, and no line reaches
// the screen or the log before it has been blanked.
// The only text ever written without its line break is an unfinished last
// line at exit (flush): it is blanked, and any ending that could be the
// START of a credential is blanked as well.
const { StringDecoder } = require('string_decoder');

const MARK = '[redacted]';
function scrubWith(secrets, s) {
  let t = String(s);
  for (const x of secrets) t = t.split(x).join(MARK);
  return t;
}
// Adds a credential to the list. Empty or missing values are skipped (there
// is nothing to blank). A value that is not text, or that contains a line
// break, is REFUSED with an error: the caller treats that as a failure.
// Its JSON-escaped form is added too, so a credential printed inside
// JSON.stringify output is blanked as well.
function addSecretTo(secrets, x) {
  if (x === undefined || x === null || x === '') return;
  if (typeof x !== 'string') { const e = new Error('a credential is not text: refused'); e.code = 'SECRET_TYPE'; throw e; }
  if (/[\r\n]/.test(x)) { const e = new Error('a credential contains a line break: refused'); e.code = 'SECRET_LINEBREAK'; throw e; }
  for (const v of [x, JSON.stringify(x).slice(1, -1)]) if (!secrets.includes(v)) secrets.push(v);
}
// emit(text) receives only blanked text. One filter per output stream; the
// list of credentials is shared.
function makeLineRedactor(secrets, emit) {
  const decoder = new StringDecoder('utf8');
  let held = '';
  return {
    write(chunk) {
      held += typeof chunk === 'string' ? decoder.end() + chunk : decoder.write(Buffer.from(chunk));
      const i = held.lastIndexOf('\n');
      if (i < 0) return;
      const lines = held.slice(0, i + 1);
      held = held.slice(i + 1);
      emit(scrubWith(secrets, lines));
    },
    // Only at exit. The unfinished line is blanked; then, if it ENDS with the
    // beginning of any credential (one character or more), that ending is
    // blanked too, because the rest of the credential never arrived.
    flush() {
      held += decoder.end();
      if (!held) return;
      let t = scrubWith(secrets, held);
      held = '';
      for (const x of secrets) {
        for (let k = x.length - 1; k >= 1; k--) {
          if (t.endsWith(x.slice(0, k))) { t = t.slice(0, t.length - k) + MARK; break; }
        }
      }
      emit(t);
    },
  };
}
module.exports = { makeLineRedactor, addSecretTo, scrubWith, MARK };
