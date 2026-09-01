const { getTokens, saveTokenFields } = require('./tokenStore');
const { notifySignInExpiring } = require('./pushcut');

// Schwab's sign-in dies exactly seven days after it was made and cannot be
// extended. When it dies, trades simply stop arriving and nothing else
// goes wrong -- which is the worst kind of failure, because it looks like
// a quiet week. The app now shows a countdown on its first screen, but
// that still needs him to open the app. This buzzes his phone instead, so
// the first he hears of it is not a week of missing trades.
const SIGN_IN_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

// Most urgent first. Each one is sent at most ONCE per sign-in: the record
// of what has been sent is stored against the sign-in it belongs to, so a
// fresh sign-in starts with a clean slate and no marker to clear by hand.
//
// Three and only three. A reminder that arrives every hour is a reminder
// he learns to swipe away, and the whole point is that this one gets read.
const STAGES = [
  { key: 'gone', atHoursLeft: 0 },
  { key: 'lastHours', atHoursLeft: 6 },
  { key: 'daySix', atHoursLeft: 24 },
];

function hoursLeftFrom(connectedAtIso, now) {
  if (!connectedAtIso) return null;
  const started = Date.parse(connectedAtIso);
  if (!Number.isFinite(started)) return null;
  // Rounded DOWN, the same as the app's own countdown. Overstating the
  // time left costs him a day of trades; understating costs one early
  // sign-in.
  return Math.floor((started + SIGN_IN_LIFE_MS - now) / (60 * 60 * 1000));
}

// Which single reminder is due right now, given how long is left and what
// has already gone out for this sign-in. Returns null when nothing is due.
// Kept free of storage and network so it can be tested directly.
function stageDue(hoursLeft, alreadySent) {
  if (hoursLeft == null) return null;          // no countdown on file: say nothing
  const sent = new Set(alreadySent || []);
  for (const stage of STAGES) {                // most urgent first
    if (hoursLeft <= stage.atHoursLeft && !sent.has(stage.key)) return stage.key;
  }
  return null;
}

// Passing a later stage means the earlier, gentler ones are moot -- if he
// is inside six hours there is no point ever sending "you have a day
// left". Marking them as sent stops that arriving out of order.
function stagesToMark(dueKey) {
  const idx = STAGES.findIndex(s => s.key === dueKey);
  if (idx === -1) return [];
  return STAGES.slice(idx).map(s => s.key);
}

function messageFor(stageKey, hoursLeft) {
  if (stageKey === 'gone') {
    return {
      title: 'Schwab has signed you out',
      text: 'No new trades can come in until you sign in again. Open your journal and tap Sign In to Schwab.',
    };
  }
  if (stageKey === 'lastHours') {
    return {
      title: 'Schwab sign-in runs out today',
      text: `About ${Math.max(hoursLeft, 0)} hour${hoursLeft === 1 ? '' : 's'} left. Open your journal and tap Sign In to Schwab.`,
    };
  }
  return {
    title: 'Schwab sign-in runs out tomorrow',
    text: 'Trades keep arriving until then. Open your journal and tap Sign In to Schwab whenever it suits you.',
  };
}

// Called from the scheduled tick. Never throws: this is a nice-to-have
// sitting on top of a journal that is already safe, and it must never be
// able to take the trade sync down with it.
async function checkSignInAndNotify(now = Date.now()) {
  try {
    const store = await getTokens();
    // Never connected at all: there is no sign-in to warn about, and
    // buzzing his phone about one would be nonsense.
    if (!store || !store.refresh_token) return { sent: null, reason: 'never connected' };

    const hoursLeft = hoursLeftFrom(store.connected_at, now);
    if (hoursLeft == null) return { sent: null, reason: 'no sign-in date on file' };

    // The record is stored against the sign-in it belongs to. A fresh
    // sign-in changes connected_at, so the old record stops applying on
    // its own -- nothing has to remember to clear it.
    const record = store.signin_alerts || {};
    const sent = record.connectedAt === store.connected_at ? (record.sent || []) : [];

    const due = stageDue(hoursLeft, sent);
    if (!due) return { sent: null, reason: 'nothing due', hoursLeft };

    await notifySignInExpiring(due, hoursLeft);
    await saveTokenFields({
      signin_alerts: {
        connectedAt: store.connected_at,
        sent: Array.from(new Set([...sent, ...stagesToMark(due)])),
        lastSentAt: new Date(now).toISOString(),
      },
    });
    return { sent: due, hoursLeft };
  } catch (err) {
    console.log('Sign-in reminder check failed:', (err && err.message) || err);
    return { sent: null, reason: 'check failed' };
  }
}

module.exports = {
  checkSignInAndNotify,
  hoursLeftFrom,
  stageDue,
  stagesToMark,
  messageFor,
  SIGN_IN_LIFE_MS,
  STAGES,
};
