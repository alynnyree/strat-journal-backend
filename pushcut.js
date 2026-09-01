const axios = require('axios');

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
async function sendPushcut(notificationName, apiKey, payload) {
  if (!notificationName || !apiKey) return;
  try {
    await axios.post(
      `https://api.pushcut.io/v1/notifications/${encodeURIComponent(notificationName)}`,
      payload,
      { headers: { 'API-Key': apiKey } }
    );
  } catch (err) {
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
    input: JSON.stringify({ legKey: legKey(leg), occ: leg.occ, openTimestamp: leg.openTimestamp }),
  });
}

// Called ~15 minutes after notifyTradeOpened, only if that same leg is still
// unmatched (see cron.js) — a trade that closed already never reaches this.
async function notifyTradeStillOpen(leg) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME_STILL_OPEN;
  const apiKey = process.env.PUSHCUT_API_KEY;
  await sendPushcut(notificationName, apiKey, {
    title: `${leg.ticker} ${leg.dir} still open after 15 min`,
    text: 'Tap to stop recording (switching to screenshot mode)',
    input: JSON.stringify({ legKey: legKey(leg), occ: leg.occ, openTimestamp: leg.openTimestamp }),
  });
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
    input: JSON.stringify({ tradeId: trade.id, mode }),
  });
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
  });
}

module.exports = { notifyTradeOpened, notifyTradeStillOpen, notifyTradeClosed, notifySignInExpiring };
