# Strat Journal — Schwab Sync Backend

This is the small always-on program that checks your Schwab account every
few minutes and hands completed trades to the Strat Journal app, ready to
tag. See the main chat conversation for a full plain-language walkthrough
of setting this up entirely from an iPhone (GitHub → Render → Schwab
developer portal → connect).

## Files in this folder

Every file sits at the top level on purpose — no subfolders — so it's easy
to upload from a phone. Nothing in here needs editing before upload; all
the account-specific values (Schwab keys, URLs) are set as **environment
variables** on Render, not in these files.

- `server.js` — starts everything
- `auth.js` — the Schwab login/token handling
- `api.js` — the endpoints the Strat Journal app talks to
- `cron.js` — the background job that checks Schwab on a timer
- `matcher.js` — pairs opening/closing fills into completed trades
- `schwabClient.js` — talks to Schwab's API
- `tokenStore.js` / `tradeStore.js` — simple on-disk storage
- `package.json` — the list of other people's code this depends on
- `.env.example` — a template showing which settings you'll need (don't
  upload this one with real values in it — Render's dashboard is where
  real values go)

## Quick reference once deployed

- One-time Schwab connect: visit
  `https://YOUR-RENDER-URL/auth/schwab/login?key=YOUR_APP_SECRET` in Safari
  while logged into Schwab.
- One-time historical import: in the Strat Journal app's Sync tab, tap
  "Import Trade History."
- Ongoing: nothing to do — the background job checks every 5 minutes on
  its own. Open the app whenever; anything found is waiting in "Ready to Tag."

## What auto-sync can't fill in

Schwab's transaction feed only has option contract prices, not the
underlying's price at that instant — pending trades come through with
underlying entry/exit left blank. Strat setup, FTFC, stop loss, and
screenshots are always yours to add.

## Notes on accuracy

Schwab's exact API paths (`/trader/v1/...`) are reproduced here from their
published developer docs. Schwab has changed field names and paths
before — if a call fails, check developer.schwab.com's current reference
for that endpoint.
