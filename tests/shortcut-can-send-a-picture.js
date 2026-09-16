// The iPhone Shortcut that sends a screenshot into the journal is the one
// part of this whole pipeline he builds BY HAND, in the Shortcuts app,
// from written instructions. So the far end is marked here against exactly
// what that Shortcut produces -- and against the mistakes he is most
// likely to make building it, each of which must come back naming what is
// wrong rather than failing blankly.
//
// Written before he was given the instructions, not after. It found one
// real fault: a field named anything other than "image" threw, so the
// helpful message sitting right there was unreachable by the single most
// likely mistake.
const Module = require('module');
const realLoad = Module._load;
const store = new Map();
Module._load = function (request) {
  if (request === '@upstash/redis') {
    class FakeRedis {
      static fromEnv() { return new FakeRedis(); }
      async set(k, v) { store.set(k, v); }
      async get(k) { return store.get(k) ?? null; }
      async lpush(k, v) { const l = store.get(k) || []; l.unshift(v); store.set(k, l); }
      async ltrim(k, a, b) { store.set(k, (store.get(k) || []).slice(a, b + 1)); }
      async lrange(k, a, b) { return (store.get(k) || []).slice(a, b < 0 ? undefined : b + 1); }
      async del(k) { store.delete(k); }
    }
    return { Redis: FakeRedis };
  }
  return realLoad.apply(this, arguments);
};

process.env.APP_SECRET = 'testkey';
process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

const express = require('express');
const mediaRouter = require('../media.js');
const app = express();
app.use('/media', mediaRouter);
const srv = app.listen(38499, run);

// A tiny real JPEG, so this is a genuine image upload and not a blob of bytes.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

async function post(qs, filename = 'shot.jpg', field = 'image') {
  const fd = new FormData();
  fd.append(field, new Blob([JPEG], { type: 'image/jpeg' }), filename);
  const r = await fetch(`http://127.0.0.1:38499/media/upload${qs}`, { method: 'POST', body: fd });
  const raw = await r.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: r.status, body };
}

const assert = require('assert');
let n = 0; const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)})`); };
const ok = (c, m) => { n++; assert.ok(c, m); };

async function run() {
  // 1. Exactly what the Shortcut sends: an ISO 8601 time, form field "image".
  let r = await post('?key=testkey&timestamp=2026-09-16T13%3A49%3A00Z');
  eq(r.status, 200, 'an ISO time is accepted');
  eq(r.body.ok, true, 'and answers ok:true, which is what he will see in Shortcuts');
  ok(r.body.id, 'with an id');

  // 2. Unencoded colons, which is what Shortcuts actually produces when the
  //    formatted date is dropped straight into a text field.
  r = await post('?key=testkey&timestamp=2026-09-16T13:49:00Z');
  eq(r.status, 200, 'unencoded colons are accepted too');

  // 2b. What Shortcuts' ISO 8601 actually produces: LOCAL time with the
  //     timezone on the end. In New York that offset is a minus, which
  //     travels fine. East of London it is a PLUS -- and a plus means "a
  //     space" inside a web address, so it arrives broken. He is in New
  //     York and this would never have bitten him, which is exactly why it
  //     would have sat there unnoticed.
  for (const t of ['2026-09-16T09:49:00-04:00', '2026-09-16T15:49:00 02:00', '2026-09-16T15:49:00 0200']) {
    const rr = await post('?key=testkey&timestamp=' + t.replace(/ /g, '%20'));
    eq(rr.status, 200, 'accepted: ' + t);
  }
  {
    // All four spellings must land on the SAME instant, or a picture goes
    // on the wrong trade -- which looks entirely genuine.
    const ids = [];
    for (const t of ['2026-09-16T13:49:00Z', '2026-09-16T09:49:00-04:00', '2026-09-16T15:49:00%2002:00']) {
      const rr = await post('?key=testkey&timestamp=' + t);
      ids.push(rr.body.id);
    }
    const times = ids.map(id => JSON.parse(store.get('screenshot:' + id)).timestamp);
    n++; assert.ok(times.every(t => t === times[0]),
      'every way of writing that instant lands on the same instant: ' + JSON.stringify(times));
  }

  // 2c. A DATE IS NOT A MOMENT. Shortcuts' ISO 8601 has a separate
  //     "Include ISO 8601 Time" switch, and with it off the answer is just
  //     `2026-09-16`. Date.parse reads that as midnight UTC -- eight in the
  //     EVENING THE DAY BEFORE in New York -- so the picture was accepted,
  //     answered ok:true, stamped hours from its trade, and left waiting for
  //     ever with nothing saying why. Seen on his own screen with that
  //     switch off.
  {
    const rr = await post('?key=testkey&timestamp=2026-09-16');
    eq(rr.status, 400, 'a date with no time of day is refused, not quietly filed at midnight');
    ok(/time of day/i.test(rr.body.error), 'and says what is wrong: ' + rr.body.error);
    ok(/Include ISO 8601 Time/.test(rr.body.error), 'and names the switch that fixes it');
    ok(/2026-09-16/.test(rr.body.error), 'and quotes back what it was sent');
  }
  {
    // A WHOLE time that happens to read midnight is a different thing and
    // must still go through -- refusing it would be the opposite mistake.
    const rr = await post('?key=testkey&timestamp=2026-09-16T00:00:00Z');
    eq(rr.status, 200, 'a real time that reads midnight is still accepted');
  }

  // 3. Unix seconds, the other format the route documents.
  r = await post('?key=testkey&timestamp=1758030540');
  eq(r.status, 200, 'unix seconds accepted');

  // 4. Wrong key -- he must be able to tell this apart from everything else.
  r = await post('?key=wrong&timestamp=1758030540');
  eq(r.status, 403, 'a wrong key is refused');

  // 5. No time at all.
  r = await post('?key=testkey');
  eq(r.status, 400, 'a missing time is refused');
  ok(/timestamp/.test(r.body.error), 'and says which part was missing');

  // 6. The field named something other than "image" -- the single most
  //    likely mistake when building this by hand.
  r = await post('?key=testkey&timestamp=1758030540', 'shot.jpg', 'photo');
  eq(r.status, 400, 'a wrongly-named field is refused');
  ok(/named "image"/.test(r.body.error), 'and names the field it wanted: ' + r.body.error);
  ok(/"photo"/.test(r.body.error), 'and names what he actually called it');
  ok(!/Unexpected field|MulterError/i.test(r.body.error), 'never raw text from somewhere else');

  // 6b. Nothing attached at all is a DIFFERENT fault with a different fix.
  {
    const rr = await fetch('http://127.0.0.1:38499/media/upload?key=testkey&timestamp=1758030540',
      { method: 'POST', body: new FormData() });
    const b = await rr.json();
    eq(rr.status, 400, 'nothing attached is refused');
    ok(/No picture was attached/.test(b.error), 'and says so, not "wrong name": ' + b.error);
  }

  // 7. It really is waiting to be collected afterwards.
  const p = await fetch('http://127.0.0.1:38499/media/pending?key=testkey&slim=1');
  const pj = await p.json();
  ok(Array.isArray(pj.screenshots) && pj.screenshots.length >= 3, 'the pictures are queued for the journal');
  ok(pj.screenshots.every(s => 'image' in s), 'every one keeps the image key present, even when slimmed');

  console.log(`upload route: ${n} checks passed`);
  srv.close();
}
