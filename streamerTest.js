const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const { getValidAccessToken } = require('./auth');

const router = express.Router();
const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';

// One-time diagnostic: confirms whether Schwab's ACCT_ACTIVITY streaming
// service actually works for this account, before any real-time capture
// pipeline gets built on top of it. There are conflicting reports online —
// Schwab's own docs list this service, but at least one other real
// integration has reported "Feature not supported" when actually
// subscribing. This route settles it definitively for THIS account.
//
// Visit once in a browser: /debug/streamer-test?key=YOUR_APP_SECRET
// Collects everything the streamer sends back for ~8 seconds, then
// returns it all as plain JSON — the raw truth, not a guess.
router.get('/streamer-test', async (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const log = [];
  const addLog = (msg) => { log.push(`${new Date().toISOString()} — ${msg}`); };

  try {
    const accessToken = await getValidAccessToken();
    addLog('Got access token.');

    const prefResp = await axios.get(`${TRADER_BASE}/userPreference`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const streamerInfo = prefResp.data?.streamerInfo?.[0];
    if (!streamerInfo) {
      addLog('No streamerInfo returned from /userPreference — cannot proceed.');
      return res.json({ ok: false, log, raw: prefResp.data });
    }
    addLog(`Got streamerInfo. Socket URL: ${streamerInfo.streamerSocketUrl}`);

    const result = await new Promise((resolve) => {
      const messages = [];
      let loggedIn = false;
      let settled = false;
      const ws = new WebSocket(streamerInfo.streamerSocketUrl);

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws.close(); } catch (e) { /* already closing */ }
        resolve({ ok, messages });
      };

      const timeout = setTimeout(() => {
        addLog('Timed out after 8s waiting for messages — closing connection.');
        finish(loggedIn); // logged in but no ACCT_ACTIVITY response yet still counts as partial info
      }, 8000);

      ws.on('open', () => {
        addLog('WebSocket opened. Sending LOGIN request...');
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

      ws.on('message', (data) => {
        let parsed;
        try { parsed = JSON.parse(data.toString()); } catch (e) { parsed = data.toString(); }
        messages.push(parsed);
        addLog('Received: ' + JSON.stringify(parsed).slice(0, 400));

        const loginResp = parsed?.response?.find?.(r => r.service === 'ADMIN' && r.command === 'LOGIN');
        if (loginResp && !loggedIn) {
          if (loginResp.content?.code === 0) {
            loggedIn = true;
            addLog('LOGIN succeeded. Subscribing to ACCT_ACTIVITY...');
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
          } else {
            addLog('LOGIN failed: ' + JSON.stringify(loginResp.content));
            finish(false);
          }
        }

        const acctResp = parsed?.response?.find?.(r => r.service === 'ACCT_ACTIVITY');
        if (acctResp) {
          addLog('ACCT_ACTIVITY subscribe response: ' + JSON.stringify(acctResp.content));
          // Give it one more second in case a real data message follows the
          // subscribe ack, then wrap up either way.
          setTimeout(() => finish(true), 1000);
        }
      });

      ws.on('error', (err) => {
        addLog('WebSocket error: ' + err.message);
        finish(false);
      });

      ws.on('close', () => {
        addLog('WebSocket closed.');
      });
    });

    res.json({ ok: result.ok, log, messages: result.messages });
  } catch (err) {
    addLog('Fatal error: ' + (err.response?.data ? JSON.stringify(err.response.data) : err.message));
    res.status(500).json({ ok: false, log });
  }
});

module.exports = router;
