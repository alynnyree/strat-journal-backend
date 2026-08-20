const axios = require('axios');

// Fires the Pushcut notification that's the missing link in the screenshot
// pipeline: a trade closing → a phone notification → tapping it runs the
// iOS Shortcut that grabs the just-taken screenshot and uploads it via
// /media/upload. This only sends the notification; the notification's own
// tap action (which Shortcut it runs) is configured once inside the
// Pushcut app itself, not here — this just has to trigger it by name with
// useful content.
//
// Silently does nothing if PUSHCUT_NOTIFICATION_NAME/PUSHCUT_API_KEY
// aren't set, rather than erroring — this is a nice-to-have on top of the
// trade already being safely in the Journal, not something that should
// ever block or fail the sync it's called from.
async function notifyTradeClosed(trade) {
  const notificationName = process.env.PUSHCUT_NOTIFICATION_NAME;
  const apiKey = process.env.PUSHCUT_API_KEY;
  if (!notificationName || !apiKey) return;

  const pnl = trade.pnlDollar != null
    ? (trade.pnlDollar >= 0 ? '+$' : '-$') + Math.abs(trade.pnlDollar).toFixed(2)
    : '';

  try {
    await axios.post(
      `https://api.pushcut.io/v1/notifications/${encodeURIComponent(notificationName)}`,
      {
        title: `${trade.ticker} ${trade.dir} closed`,
        text: `${pnl} — tap to screenshot`.trim(),
        // Passed through to whatever Shortcut action runs off this
        // notification's tap, so the Shortcut can tag the upload with
        // which trade prompted it if it wants to.
        input: String(trade.id),
      },
      { headers: { 'API-Key': apiKey } }
    );
  } catch (err) {
    console.log('Pushcut notification failed:', err.response?.data || err.message);
  }
}

module.exports = { notifyTradeClosed };
