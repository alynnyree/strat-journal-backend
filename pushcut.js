const axios = require('axios');
const { Redis } = require('@upstash/redis');

// ---- What happened to the last phone alert ----
//
// Every one of these alerts returned instantly and silently for months,
// because no key was set and the very first line below simply gave up. The
// owner had no way to learn that the whole phone path was inert, and I had
// no way either -- the only failure report was a log line nobody reads.
//
// So each attempt now writes down what it asked for and what came back, in
// plain words, and /health hands it over. Four outcomes that must never
// share one answer: never asked (nothing set up), asked and accepted,
// asked and REFUSED by Pushcut (the name does not exist on his phone), and
// could not reach Pushcut at all.
//
// Best-effort on every side: storing this may never delay or block an
// alert, and an alert may never fail because storing it did.
const ALERT_KEY = 'pushcut:lastAlert';
let redis = null;
function store() {
  if (redis) return redis;
  try { redis = Redis.fromEnv(); } catch (e) { redis = null; }
  return redis;
}

async function noteAlert(record) {
  const r = store();
  if (!r) return;
  try { await r.set(ALERT_KEY, JSON.stringify(record)); } catch (e) { /* never block an alert */ }
}

async function lastPhoneAlert() {
  const r = store();
  if (!r) return null;
  try {
    const raw = await r.get(ALERT_KEY);
    if (raw == null) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
}

// Three distinct signals for the "photo for long trades, video for short
// trades" capture pipeline. Each maps to its own notification name/Shortcut
// on the phone, except notifyTradeClosed which reuses the original single
// "trade closed" notification and instead tells the Shortcut which mode to
// run via the input payload — see the `mode` field below.
//
//   1. notifyTradeOpened      — fires the instant a position opens. Shortcut: start screen recording.
//   2. notifyTradeStillOpen   — fires once, 15 minutes after open, only if still open. Shortcut: stop + discard the recording, fall back to screenshot mode.
//   3. notifyTradeClosed      — fires on close (unchanged trigger point). mode:'video' (held <15min, recording still running) → stop + upload video. mode:'screenshot' (held >=15min, or the 15-min safety net already stopped it) → take/upload a screenshot, same as before.
//
// All three silently do nothing if their required env vars aren't set,
// rather than erroring — this is a nice-to-have layered on top of the trade
// already being safely in the Journal, never something that should block or
// fail the sync it's called from.
async function sendPushcut(notificationName, apiKey, payload, moment) {
  const at = Date.now();
  const what = moment || 'a trade';
  if (!notificationName || !apiKey) {
    // Not a failure to reach anything -- nothing was ever asked. Said
    // plainly, because "it was never asked" and "it refused" are different
    // faults with different fixes.
    await noteAlert({
      at, moment: what, name: notificationName || null, ok: false, asked: false,
      reason: !notificationName && !apiKey
        ? 'No alert name and no key are set, so nothing was sent to your phone.'
        : !notificationName
          ? 'No alert name is set for this moment, so nothing was sent to your phone.'
          : 'No key is set, so nothing was sent to your phone.',
    });
    return;
  }
  try {
    await axios.post(
      `https://api.pushcut.io/v1/notifications/${encodeURIComponent(notificationName)}`,
      payload,
      { headers: { 'API-Key': apiKey } }
    );
    await noteAlert({ at, moment: what, name: notificationName, ok: true, asked: true, reason: null });
  } catch (err) {
    // A name Pushcut has never heard of and a phone that could not be
    // reached look identical from here unless they are told apart. Pushcut
    // answering at all -- even to refuse -- means the key worked and the
    // NAME is what is wrong, which is the one thing he can fix himself.
    const status = err.response?.status ?? null;
    const reason = status === 404
      ? `Your phone alert list has nothing called "${notificationName}", so the alert had nowhere to go.`
      : status === 401 || status === 403
        ? 'Your phone alert key was not accepted.'
        : status
          ? `The phone alert was turned down (${status}).`
          : 'The phone alert service could not be reached at all.';
    await noteAlert({ at, moment: what, name: notificationName, ok: false, asked: true, status, reason });
    console.log(`Pushcut notification (${notificationName}) failed:`, err.response?.data || err.message);
  }
}

const SHORT_TRADE_MS = 15 * 60 * 1000; // matches the 15-minute cutoff the owner set for video vs screenshot

function legKey(leg) {
  return `${leg.occ}-${leg.openTimestamp}`;
}

async function notifyTradeOpened(leg) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME_OPENED;
  const apiKey = process.env.PUSHCUT_API_KEY;
  await sendPushcut(notificationName, apiKey, {
    title: `${leg.ticker} ${leg.dir} opened`,
    text: 'Tap to start recording',
    // The moment the trade actually happened, sent so the picture can be
    // stamped with THAT rather than with whenever he gets to his phone.
    // Same rule the laptop side already follows: a picture filed against
    // the wrong trade looks entirely genuine, and a late stamp is how that
    // happens.
    input: JSON.stringify({ legKey: legKey(leg), occ: leg.occ, openTimestamp: leg.openTimestamp, timestamp: leg.openTimestamp }),
  }, 'a trade opening');
}

// Called ~15 minutes after notifyTradeOpened, only if that same leg is still
// unmatched (see cron.js) — a trade that closed already never reaches this.
async function notifyTradeStillOpen(leg) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME_STILL_OPEN;
  const apiKey = process.env.PUSHCUT_API_KEY;
  await sendPushcut(notificationName, apiKey, {
    title: `${leg.ticker} ${leg.dir} still open after 15 min`,
    text: 'Tap to stop recording (switching to screenshot mode)',
    // Fifteen minutes past the open -- which is the moment this picture is
    // of, and the moment the journal will try to match it to.
    input: JSON.stringify({ legKey: legKey(leg), occ: leg.occ, openTimestamp: leg.openTimestamp, timestamp: leg.openTimestamp + SHORT_TRADE_MS }),
  }, 'a trade passing fifteen minutes');
}

async function notifyTradeClosed(trade) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME;
  const apiKey = process.env.PUSHCUT_API_KEY;

  const pnl = trade.pnlDollar != null
    ? (trade.pnlDollar >= 0 ? '+$' : '-$') + Math.abs(trade.pnlDollar).toFixed(2)
    : '';
  // Under 15 minutes and the recording is presumably still running (the
  // 15-min safety net only fires for trades that are STILL open at that
  // mark, so anything that closed before then never triggered it) — keep
  // the video. Otherwise the safety net already stopped/discarded it (or
  // this trade ran long enough that it would have), so fall back to a
  // plain screenshot exactly like the pipeline already does today.
  const mode = trade.heldMs != null && trade.heldMs < SHORT_TRADE_MS ? 'video' : 'screenshot';

  await sendPushcut(notificationName, apiKey, {
    title: `${trade.ticker} ${trade.dir} closed`,
    text: mode === 'video'
      ? `${pnl} — tap to stop recording & upload video`.trim()
      : `${pnl} — tap to screenshot`.trim(),
    // Passed through to whatever Shortcut action runs off this
    // notification's tap. JSON so one Shortcut can branch on `mode`
    // (video vs screenshot) instead of needing two separate notifications
    // for the same close event.
    input: JSON.stringify({ tradeId: trade.id, mode, timestamp: trade.exitTimestamp ?? null }),
  }, 'a trade closing');
}

// The seven-day Schwab sign-in, sent to his phone rather than waiting to
// be discovered. Falls back to the existing trade-closed notification name
// when no dedicated one is set, so this works with the Pushcut setup he
// already has -- a reminder that needs him to add a setting first is a
// reminder that never arrives.
async function notifySignInExpiring(stageKey, hoursLeft) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME_SIGNIN
    || process.env.PUSHCUT_NOTIFICATION_NAME;
  const apiKey = process.env.PUSHCUT_API_KEY;
  // Required here rather than at the top: signInWatch requires this file,
  // so importing it back at load time would be circular.
  const { messageFor } = require('./signInWatch');
  const { title, text } = messageFor(stageKey, hoursLeft);
  await sendPushcut(notificationName, apiKey, {
    title,
    text,
    input: JSON.stringify({ kind: 'schwabSignIn', stage: stageKey, hoursLeft }),
  }, 'the weekly sign-in running out');
}

module.exports = { notifyTradeOpened, notifyTradeStillOpen, notifyTradeClosed, notifySignInExpiring, lastPhoneAlert };
