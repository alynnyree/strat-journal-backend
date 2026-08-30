const express = require('express');
const { wrap } = require('./asyncRoute');
const axios = require('axios');
const { saveTokens, getTokens, saveTokenFields } = require('./tokenStore');

const router = express.Router();

// Read-only check for whether Schwab is actually linked — no secrets in
// the response, just booleans. Sync and backfill both swallow a missing
// Schwab connection as a silent no-op (by design, so a routine 5-minute
// check doesn't spam errors when the token simply hasn't been set up
// yet), which means "up to date, no new trades" can print even when
// Schwab was never connected at all. This gives a direct way to tell
// those two situations apart without digging through server logs.
router.get('/status', wrap(async (req, res) => {
  try {
    const store = await getTokens();
    // "Connected" has meant two different things: the app can reach this
    // server, and this server can reach Schwab. They are not the same, and
    // the app showed a green light on the first while the second had been
    // dead for weeks. This answers the second one specifically.
    const neverConnected = !store.refresh_token;
    const refreshBroken = store.last_refresh_ok === false;
    // Schwab's refresh token lives SEVEN DAYS from the sign-in that
    // created it. Renewing gives a new access token but does not restart
    // that clock, so the countdown runs from connected_at, not from the
    // last renewal. Knowing this in advance is the difference between
    // signing in when it suits him and finding out because a day of
    // trades failed to arrive.
    const SIGN_IN_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
    const connectedMs = store.connected_at ? Date.parse(store.connected_at) : null;
    const expiresMs = connectedMs ? connectedMs + SIGN_IN_LIFE_MS : null;
    const msLeft = expiresMs == null ? null : expiresMs - Date.now();
    const hoursLeft = msLeft == null ? null : Math.floor(msLeft / (60 * 60 * 1000));
    res.json({
      hasRefreshToken: !!store.refresh_token,
      hasAccessToken: !!store.access_token,
      accessTokenExpired: store.expires_at ? Date.now() > store.expires_at : null,
      lastTransactionCheck: store.last_transaction_check || null,
      schwabConnected: !neverConnected && !refreshBroken,
      needsReconnect: neverConnected || refreshBroken,
      lastRefreshAt: store.last_refresh_at || null,
      lastRefreshError: store.last_refresh_error || null,
      connectedAt: store.connected_at || null,
      signInExpiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
      signInHoursLeft: hoursLeft,
      // Null when we cannot tell (an older sign-in that predates this
      // being recorded) -- the app must not invent a countdown it does
      // not have.
      signInExpiringSoon: hoursLeft == null ? null : hoursLeft <= 48,
      signInLifeDays: 7,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not read token status: ' + err.message });
  }
}));

// Schwab's OAuth endpoints, per developer.schwab.com. Verify these against
// current Schwab docs before going live — API paths have shifted before.
const AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';

// Step 1: send the user to Schwab to approve access.
// Visit this route once in a browser logged into your Schwab account.
router.get('/schwab/login', (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SCHWAB_CLIENT_ID,
    redirect_uri: process.env.SCHWAB_REDIRECT_URI,
  });
  res.redirect(`${AUTH_BASE}/authorize?${params.toString()}`);
});

// Step 2: Schwab redirects back here with a one-time code.
router.get('/schwab/callback', wrap(async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const basicAuth = Buffer.from(
      `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`
    ).toString('base64');

    const resp = await axios.post(
      `${AUTH_BASE}/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SCHWAB_REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    await saveTokens(resp.data);
    // A fresh login clears any recorded failure, so the app stops telling
    // him to reconnect the moment he actually has.
    await saveTokenFields({
      connected_at: new Date().toISOString(),
      last_refresh_ok: true,
      last_refresh_at: new Date().toISOString(),
      last_refresh_error: null,
    });
    res.send('Schwab connected. You can close this tab and return to the Strat Journal app.');
  } catch (err) {
    console.error('OAuth callback failed:', err.response?.data || err.message);
    res.status(500).send('OAuth exchange failed — check server logs.');
  }
}));

// Refreshes the access token using the stored refresh token.
// Schwab refresh tokens are long-lived but do expire — if this starts
// failing, you'll need to repeat the /schwab/login flow manually.
// Schwab refresh tokens last SEVEN DAYS and cannot be extended -- the
// login flow has to be repeated by hand every week. When that lapses,
// every sync, backfill and stream fails from this one point, and until
// now the only trace was a thrown error nobody surfaced. So the outcome
// is recorded: a failure here is the difference between "you have no
// trades" and "nothing has been able to reach Schwab for a month".
async function refreshAccessToken() {
  const store = await getTokens();
  if (!store.refresh_token) {
    await noteRefreshOutcome(false, 'No Schwab login on file.');
    throw new Error('No refresh token on file — run /auth/schwab/login first.');
  }

  const basicAuth = Buffer.from(
    `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`
  ).toString('base64');

  let resp;
  try {
    resp = await axios.post(
      `${AUTH_BASE}/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: store.refresh_token,
      }),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
  } catch (err) {
    const why = err.response?.data
      ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
      : err.message;
    await noteRefreshOutcome(false, String(why).slice(0, 300));
    throw err;
  }
  const saved = await saveTokens(resp.data);
  await noteRefreshOutcome(true, null);
  return saved;
}

// Records whether the last attempt to renew the Schwab connection worked.
// Never allowed to break the renewal itself.
async function noteRefreshOutcome(ok, why) {
  try {
    const store = await getTokens();
    await saveTokenFields({
      last_refresh_ok: ok,
      last_refresh_at: new Date().toISOString(),
      last_refresh_error: ok ? null : why,
    });
  } catch (err) {
    console.log('Could not record Schwab connection state:', err.message);
  }
}

async function getValidAccessToken() {
  const store = await getTokens();
  if (!store.access_token) throw new Error('Not connected — run /auth/schwab/login first.');
  if (Date.now() > (store.expires_at || 0)) {
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }
  return store.access_token;
}

module.exports = { router, getValidAccessToken };
