const WebSocket = require('ws');
const axios = require('axios');
const { getValidAccessToken } = require('./auth');
const { runSyncCheck } = require('./cron');

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// Reconnect backoff: starts short, doubles on repeated failure, caps at 5
// minutes so it never hammers Schwab if something's persistently wrong.
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// Schwab access tokens last ~30 minutes. Rather than wait for one to
// silently go stale mid-connection, the whole streamer reconnects with a
// fresh token well before that — safer than hoping a live session tolerates
// an expired token gracefully.
const FORCED_RECONNECT_MS = 25 * 60 * 1000;

// A newly-matched trade sometimes arrives as several rapid ACCT_ACTIVITY
// messages in a row (e.g. a multi-leg fill). This collapses a burst of
// them into a single sync run instead of firing the REST pipeline once per
// message.
const SYNC_DEBOUNCE_MS = 2000;

let ws = null;
let backoffMs = BASE_BACKOFF_MS;
let forcedReconnectTimer = null;
let syncDebounceTimer = null;
let syncInFlight = false;
let reconnectAttempt = 0;

// In-memory only — resets on restart, which is fine, this is a live status
// view, not a durable record. runBackfill/runSyncCheck remain the source of
// truth for actual trade data.
const status = {
  connected: false,
  lastConnectedAt: null,
  lastMessageAt: null,
  lastActivityAt: null, // last time a real (non-heartbeat) message triggered a sync
  reconnectCount: 0,
  lastError: null,
};
function getStreamerStatus() { return { ...status }; }

function triggerSyncSoon() {
  status.lastActivityAt = new Date().toISOString();
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    if (syncInFlight) return; // a sync is already running — it'll pick up this activity anyway
    syncInFlight = true;
    try {
      console.log('Streamer: real activity detected — running sync now instead of waiting for the next 5-minute tick.');
      await runSyncCheck();
    } catch (err) {
      console.log('Streamer-triggered sync failed:', err.message);
    } finally {
      syncInFlight = false;
    }
  }, SYNC_DEBOUNCE_MS);
}

function scheduleReconnect() {
  status.connected = false;
  reconnectAttempt++;
  status.reconnectCount = reconnectAttempt;
  const delay = Math.min(backoffMs, MAX_BACKOFF_MS);
  console.log(`Streamer: reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})...`);
  setTimeout(connectStreamer, delay);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function connectStreamer() {
  if (forcedReconnectTimer) clearTimeout(forcedReconnectTimer);

  let accessToken, streamerInfo;
  try {
    accessToken = await getValidAccessToken();
    const prefResp = await axios.get(`${TRADER_BASE}/userPreference`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    streamerInfo = prefResp.data?.streamerInfo?.[0];
    if (!streamerInfo) throw new Error('No streamerInfo returned from /userPreference');
  } catch (err) {
    status.lastError = err.message;
    console.log('Streamer: could not get token/streamerInfo —', err.message);
    scheduleReconnect();
    return;
  }

  ws = new WebSocket(streamerInfo.streamerSocketUrl);
  let loggedIn = false;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      requests: [{
        service: 'ADMIN',
        requestid: '0',
        command: 'LOGIN',
        SchwabClientCustomerId: streamerInfo.schwabClientCustomerId,
        SchwabClientCorrelId: streamerInfo.schwabClientCorrelId,
        parameters: {
          Authorization: accessToken,
          SchwabClientChannel: streamerInfo.schwabClientChannel,
          SchwabClientFunctionId: streamerInfo.schwabClientFunctionId,
        },
      }],
    }));
  });

  ws.on('message', (raw) => {
    status.lastMessageAt = new Date().toISOString();
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch (e) { return; }

    const loginResp = parsed?.response?.find?.(r => r.service === 'ADMIN' && r.command === 'LOGIN');
    if (loginResp && !loggedIn) {
      if (loginResp.content?.code === 0) {
        loggedIn = true;
        status.connected = true;
        status.lastConnectedAt = new Date().toISOString();
        status.lastError = null;
        backoffMs = BASE_BACKOFF_MS; // reset backoff after a real successful connection
        reconnectAttempt = 0;
        status.reconnectCount = 0;
        console.log('Streamer: logged in. Subscribing to ACCT_ACTIVITY...');
        ws.send(JSON.stringify({
          requests: [{
            service: 'ACCT_ACTIVITY',
            requestid: '1',
            command: 'SUBS',
            SchwabClientCustomerId: streamerInfo.schwabClientCustomerId,
            SchwabClientCorrelId: streamerInfo.schwabClientCorrelId,
            parameters: { keys: 'Account Activity', fields: '0,1,2,3' },
          }],
        }));
        // Rotate the connection well before the access token expires, so a
        // stale token is never the reason the stream silently stops.
        forcedReconnectTimer = setTimeout(() => {
          console.log('Streamer: scheduled reconnect (token rotation).');
          try { ws.close(); } catch (e) { /* already closing */ }
        }, FORCED_RECONNECT_MS);
      } else {
        status.lastError = 'LOGIN failed: ' + JSON.stringify(loginResp.content);
        console.log('Streamer:', status.lastError);
        try { ws.close(); } catch (e) { /* already closing */ }
      }
      return;
    }

    if (parsed?.notify) return; // heartbeat — not real activity, ignore for sync purposes

    const acctSubAck = parsed?.response?.find?.(r => r.service === 'ACCT_ACTIVITY');
    if (acctSubAck) {
      console.log('Streamer: ACCT_ACTIVITY subscribe response:', JSON.stringify(acctSubAck.content));
      return;
    }

    // Anything else on the ACCT_ACTIVITY data channel is real account
    // activity — a trade was placed, filled, changed, or cancelled. Rather
    // than parse Schwab's specific field shape here (unverified — the only
    // example seen so far is a subscribe ack, not a live fill), just treat
    // it as a signal to run the same REST-based sync that already reliably
    // fetches and matches fills every 5 minutes — just immediately instead
    // of waiting for the next tick.
    const acctData = parsed?.data?.find?.(d => d.service === 'ACCT_ACTIVITY');
    if (acctData) {
      console.log('Streamer: ACCT_ACTIVITY data received:', JSON.stringify(parsed).slice(0, 500));
      triggerSyncSoon();
    }
  });

  ws.on('error', (err) => {
    status.lastError = err.message;
    console.log('Streamer: WebSocket error —', err.message);
  });

  ws.on('close', () => {
    console.log('Streamer: connection closed.');
    scheduleReconnect();
  });
}

function startStreamer() {
  console.log('Streamer: starting...');
  connectStreamer();
}

module.exports = { startStreamer, getStreamerStatus };
