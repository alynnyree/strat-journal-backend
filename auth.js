const express = require('express');
const axios = require('axios');
const { saveTokens, getTokens } = require('./tokenStore');

const router = express.Router();

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
router.get('/schwab/callback', async (req, res) => {
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
    res.send('Schwab connected. You can close this tab and return to the Strat Journal app.');
  } catch (err) {
    console.error('OAuth callback failed:', err.response?.data || err.message);
    res.status(500).send('OAuth exchange failed — check server logs.');
  }
});

// Refreshes the access token using the stored refresh token.
// Schwab refresh tokens are long-lived but do expire — if this starts
// failing, you'll need to repeat the /schwab/login flow manually.
async function refreshAccessToken() {
  const store = await getTokens();
  if (!store.refresh_token) throw new Error('No refresh token on file — run /auth/schwab/login first.');

  const basicAuth = Buffer.from(
    `${process.env.SCHWAB_CLIENT_ID}:${process.env.SCHWAB_CLIENT_SECRET}`
  ).toString('base64');

  const resp = await axios.post(
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
  return await saveTokens(resp.data);
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
