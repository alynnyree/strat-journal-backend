// Step 1B: purchase records and his answers, against a REAL Redis server
// (plan v4, B1-B5, B7-B10, B17-B24b, D3). An in-memory stand-in runs one
// call at a time and could not prove the answer script atomic; two real
// connections can interleave.
const { realRedis, connect } = require('./lib/realRedis');
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
const P = require('../purchases');

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS:', l); } else { fail++; console.log('FAIL:', l, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

const SENTINEL = 'SENTINEL-QUEUE';
const T = Date.UTC(2026, 10, 16, 16, 8, 34);
const leg = (f, extra) => ({ openFillId: f, occ: 'IWM   261120P00269000', ticker: 'IWM', dir: 'Short', openTimestamp: T, ...extra });
const ans = (f, id, play = 'FTFC Direction Play', tf = '5m', extra) => ({ fillId: f, answerId: id, play, timeframe: tf, ...extra });

(async () => {
  let server;
  try { server = await realRedis(); } catch (e) { console.log('FAIL: a real Redis server is required:', e.message); process.exit(1); }
  if (server.skipped) { console.log('SKIPPED: ' + server.skipped); process.exit(0); }
  const r = await connect(server.url);
  const r2 = await connect(server.url);
  await r.flushdb();
  await r.set('trades:state', SENTINEL);
  P.useStore(r);
  const sent = [];
  let failMode = null;
  P.useSender(async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    if (failMode === 500) { const e = new Error('push service down'); e.statusCode = 500; throw e; }
    if (failMode === 410) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  });
  await r.hset('push:subs', { phoneDev0001: JSON.stringify({ subscription: { endpoint: 'https://push.example/phone', keys: {} } }),
                              laptopDev001: JSON.stringify({ subscription: { endpoint: 'https://push.example/laptop', keys: {} } }) });

  // ===== B1 record, confirm, one pop-up per device =======================
  {
    const c = await P.createPurchase(leg('1000000001'));
    const rec = await P.getPurchase('1000000001');
    check('B1 a purchase gets a record (P0), not yet confirmed', c.created && rec && rec.confirmedAt === null && rec.occ === 'IWM   261120P00269000');
    await P.afterSave([leg('1000000001')]);
    check('B1 confirmed after the save (P1)', !!(await P.getPurchase('1000000001')).confirmedAt);
    check('B1 one pop-up per device', sent.length === 2 && sent.every(s => s.payload.fill === '1000000001') && /IWM 269 Put/.test(sent[0].payload.title), sent);
    check('B1 the pop-up opens the answer page on that purchase', sent[0].payload.url === './?fill=1000000001');
  }
  // ===== B3 duplicates ===================================================
  {
    sent.length = 0;
    for (let i = 0; i < 3; i++) { await P.createPurchase(leg('1000000001')); await P.afterSave([leg('1000000001')]); }
    check('B3 the same purchase seen three more times: still one record, no further pop-ups', sent.length === 0, sent.length);
  }
  // ===== B2 no fill id ===================================================
  {
    sent.length = 0;
    const before = P.stats().noFillId;
    const c = await P.createPurchase(leg(null));
    const c2 = await P.createPurchase(leg('not-a-fill'));
    check('B2 no usable fill id: no record, no pop-up, and the reason is recorded', !c.created && !c2.created && sent.length === 0 && P.stats().noFillId === before + 2
      && /no usable fill id/.test(P.stats().recentProblems[0].reason));
  }
  // ===== B4 pop-up failures ==============================================
  {
    sent.length = 0; failMode = 500;
    await P.createPurchase(leg('1000000002')); await P.afterSave([leg('1000000002')]);
    check('B4 a failing push service: at most 3 tries per device', sent.length === 6, sent.length);
    const rec = await P.getPurchase('1000000002');
    check('B4 and the record is unchanged (confirmed, nothing else)', rec && rec.confirmedAt && rec.fillId === '1000000002');
    sent.length = 0; failMode = 410;
    await P.createPurchase(leg('1000000003')); await P.afterSave([leg('1000000003')]);
    const subs = await r.hgetall('push:subs');
    check('B4 a device the push service calls gone is removed, after one try', sent.length === 2 && !subs, subs);
    failMode = null;
    await r.hset('push:subs', { phoneDev0001: JSON.stringify({ subscription: { endpoint: 'https://push.example/phone', keys: {} } }) });
  }
  // ===== answers: B7, B8/B23, B23b, B10, validation =====================
  {
    const f = '1000000001';
    let out = await P.submitAnswer(ans(f, 'answerK0001'));
    check('an answer is ACCEPTED and stored', out.code === 200 && out.body.verdict === 'ACCEPTED' && out.body.entry.answerId === 'answerK0001');
    const again = await P.submitAnswer(ans(f, 'answerK0001'));
    check('B7/B8/B23 the same answer id again: ALREADY, answered with the stored entry', again.code === 200 && again.body.verdict === 'ALREADY' && again.body.entry.answerId === 'answerK0001' && again.body.entry.at === out.body.entry.at);
    check('B7 still exactly one entry', (await P.answerHistory(f)).length === 1);
    const reused = await P.submitAnswer(ans(f, 'answerK0001', '2s Turning Into 3s'));
    check('B23b the same id with another play: REUSED, refused', reused.code === 409 && reused.body.verdict === 'REUSED');
    const other = await P.submitAnswer(ans(f, 'answerL0002', 'None of these', '30m'));
    check('B10 a different answer without "replaces": REFUSED, and the current one handed back', other.code === 409 && other.body.verdict === 'REFUSED' && other.body.entry.answerId === 'answerK0001');
    check('B10 history unchanged', (await P.answerHistory(f)).length === 1);
    const rep = await P.submitAnswer(ans(f, 'answerM0003', 'None of these', '30m', { replaces: 'answerK0001' }));
    check('replacing the current answer, by name: ACCEPTED, history keeps both', rep.body.verdict === 'ACCEPTED' && (await P.answerHistory(f)).length === 2 && (await P.currentAnswer(f)).answerId === 'answerM0003');
    check('validation: a play that is not one of the four', (await P.submitAnswer(ans(f, 'answerN0004', 'PMG'))).code === 400);
    check('validation: a timeframe that is not one of the fourteen', (await P.submitAnswer(ans(f, 'answerN0004', 'FTFC Direction Play', '7m'))).code === 400);
    check('validation: a Broadening Formation Scalp needs a LARGER formation timeframe',
      (await P.submitAnswer(ans(f, 'answerN0004', 'Broadening Formation Scalp', '1H', { formationTimeframe: '15m' }))).code === 400
      && (await P.submitAnswer(ans(f, 'answerN0004', 'Broadening Formation Scalp', '1H'))).code === 400);
    check('validation: an unknown purchase is UNKNOWN (404)', (await P.submitAnswer(ans('1999999999', 'answerN0004'))).code === 404);
  }
  // ===== B5 the right trade =============================================
  {
    await P.createPurchase(leg('2000000001')); await P.createPurchase(leg('2000000002'));
    await P.submitAnswer(ans('2000000001', 'answerX0001', 'FTFC Direction Play', '5m'));
    await P.submitAnswer(ans('2000000002', 'answerY0001', '2s Turning Into 3s', '15m'));
    // X closed in two pieces: both trades carry X's opening fill.
    const tradesOfX = [{ fills: ['2000000001', '2000000011'] }, { fills: ['2000000001', '2000000012'] }];
    const got = await Promise.all(tradesOfX.map(t => P.currentAnswer(t.fills[0])));
    const y = await P.currentAnswer('2000000002');
    check('B5 each partial close of X gets X\'s answer, and Y gets its own', got.every(a => a.play === 'FTFC Direction Play') && y.play === '2s Turning Into 3s');
  }
  // ===== B17 / B22 the queue is deleted before the answer ===============
  {
    await r.set('trades:state', JSON.stringify({ pending: [{ id: 'x', fills: ['3000000001', '3000000009'] }] }));
    await P.createPurchase(leg('3000000001'));                     // P0, before the save
    await r.del('trades:state');                                  // another journal copy collects and deletes the trade
    const a = await P.submitAnswer(ans('3000000001', 'answerQ0001'));
    check('B17/B22 the queued trade deleted first: the record is intact and the answer accepted', a.body.verdict === 'ACCEPTED' && !!(await P.getPurchase('3000000001')));
    await P.afterSave([leg('3000000001')]);                       // P1 then
    check('B22 P1 confirms it afterwards; history has exactly one entry', !!(await P.getPurchase('3000000001')).confirmedAt && (await P.answerHistory('3000000001')).length === 1);
    await r.set('trades:state', SENTINEL);
  }
  // ===== B18 / B19 another copy, a restart ================================
  {
    P.useStore(r2);    // a second journal copy / a restarted service: a new connection
    const a = await P.currentAnswer('3000000001');
    check('B18/B19 a new connection reads back the record and the answer by fill id', a && a.answerId === 'answerQ0001' && !!(await P.getPurchase('3000000001')));
    P.useStore(r);
  }
  // ===== B20 the record could not be made ================================
  {
    const broken = { ...r, set: async () => { throw new Error('store refused'); } };
    P.useStore(broken);
    const b = await P.beforeSave([leg('4000000001')], { switchOnAt: 0 });
    P.useStore(r);
    check('B20 a refused P0 write is counted, never thrown at the import', b.failed === 1 && b.created === 0);
    sent.length = 0;
    const s = await P.sweep({ openLegs: [leg('4000000001')], pending: [] }, { switchOnAt: 0 });
    check('B20 the next tick\'s sweep (P3) creates and confirms it, then sends the pop-up', s.fixed === 1 && !!(await P.getPurchase('4000000001')).confirmedAt && sent.length === 1);
    const s2 = await P.sweep({ openLegs: [leg('4000000001')], pending: [] }, { switchOnAt: 0 });
    check('B20 and a second sweep does nothing more', s2.fixed === 0 && sent.length === 1);
    const c = await P.submitAnswer(ans('4000000002', 'answerC0001', 'FTFC Direction Play', '5m', { createFrom: { occ: 'IWM   261120P00269000', ticker: 'IWM', dir: 'Short', entryTimestamp: T } }));
    const rec = await P.getPurchase('4000000002');
    check('B20/P7 a trade already collected: the card\'s answer creates the record', c.body.verdict === 'ACCEPTED' && rec && rec.source === 'card' && !!rec.confirmedAt);
    const old = await P.beforeSave([leg('4000000003', { openTimestamp: 1000 })], { switchOnAt: 5000 });
    check('a purchase from before the switch-on gets no record', old.created === 0 && !(await P.getPurchase('4000000003')));
  }
  // ===== waiting, skip ===================================================
  {
    await P.createPurchase(leg('5000000001')); await P.afterSave([leg('5000000001')]);
    await P.createPurchase(leg('5000000002')); await P.afterSave([leg('5000000002')]);
    await P.skipPurchase('5000000002');
    const w = (await P.waitingPurchases()).map(x => x.fillId);
    check('waiting: an unanswered purchase is listed ("Not now" asks again)', w.includes('5000000001'));
    check('waiting: answered and skipped ones are not', !w.includes('5000000002') && !w.includes('1000000001'));
  }
  // ===== B24 two devices at the same moment (200 runs) ===================
  {
    let both = 0, exactlyOne = 0, refusedCarries = 0, historyOk = 0;
    for (let i = 0; i < 200; i++) {
      const f = String(6000000000 + i);
      await P.createPurchase(leg(f));
      const k = P.K(f);
      const run = (client, id, play) => client.eval(P.ANSWER_SCRIPT, [k.record, k.current, k.history, k.sigs, k.entries],
        [id, '', JSON.stringify({ answerId: id, play }), [play, '5m', '', ''].join('|')]);
      const [a, b] = await Promise.all([run(r, 'phoneAns' + i, 'FTFC Direction Play'), run(r2, 'laptopAns' + i, 'None of these')]);
      const acc = [a, b].filter(x => x[0] === 'ACCEPTED');
      if (acc.length === 2) both++;
      if (acc.length === 1) exactlyOne++;
      const ref = [a, b].find(x => x[0] === 'REFUSED');
      if (ref && JSON.parse(ref[1]).answerId === JSON.parse(acc[0][1]).answerId) refusedCarries++;
      if ((await r.lrange(k.history, 0, -1)).length === 1) historyOk++;
    }
    check('B24 200 simultaneous pairs: never both accepted', both === 0, both);
    check('B24 exactly one accepted every time', exactlyOne === 200, exactlyOne);
    check('B24 the refused one is handed the accepted answer every time', refusedCarries === 200, refusedCarries);
    check('B24 history holds exactly the accepted entry every time', historyOk === 200, historyOk);
    // The control: the same thing done WITHOUT the script (read, then write).
    let controlBoth = 0;
    for (let i = 0; i < 200; i++) {
      const key = 'control:' + i;
      const naive = async (client, id) => { const cur = await client.get(key); if (cur) return false; await client.set(key, id); return true; };
      const [a, b] = await Promise.all([naive(r, 'a'), naive(r2, 'b')]);
      if (a && b) controlBoth++;
    }
    check(`B24 control: without the atomic script both are accepted (${controlBoth} of 200), so the check can fail`, controlBoth > 0, controlBoth);
  }
  // ===== B24b two replaces naming the same current answer ================
  {
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const f = String(7000000000 + i);
      await P.createPurchase(leg(f));
      await P.submitAnswer(ans(f, 'firstAns' + i));
      const k = P.K(f);
      const run = (client, id, play) => client.eval(P.ANSWER_SCRIPT, [k.record, k.current, k.history, k.sigs, k.entries],
        [id, 'firstAns' + i, JSON.stringify({ answerId: id, play }), [play, '5m', '', 'firstAns' + i].join('|')]);
      const [a, b] = await Promise.all([run(r, 'repA' + i, 'None of these'), run(r2, 'repB' + i, '2s Turning Into 3s')]);
      const acc = [a, b].filter(x => x[0] === 'ACCEPTED'), ref = [a, b].filter(x => x[0] === 'REFUSED');
      if (acc.length === 1 && ref.length === 1 && JSON.parse(ref[0][1]).answerId === JSON.parse(acc[0][1]).answerId) ok++;
    }
    check('B24b two replaces of the same answer: exactly one accepted, the other refused with the NEW current, 50 of 50', ok === 50, ok);
  }
  // ===== D3 the trade queue is never written =============================
  check('D3 the trade queue record was never written by purchase code', (await r.get('trades:state')) === SENTINEL);

  r.close(); r2.close(); server.stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASHED', e); process.exit(1); });
