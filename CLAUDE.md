# Strat Trading Journal — Project Context

## FREEZE IN EFFECT (since 30 September 2026) -- read this before anything else

An independent audit is running. The owner makes every decision; the
auditor (ChatGPT) reviews; Claude implements only what the owner has
authorized IN WORDS, naming the step. The same note is at the top of both
projects (app and service).

**The auditor's sequence, which nothing may skip or reorder:**
Blocker 1 (freeze/protect the codebase) -> Blocker 2 (immutable
broker-fill storage) -> Blocker 3 (lock the trade identity, pairing and
user-data rules) -> Phase 0 safety -> Phase 1A security -> Phase 1B broker
ledger -> trade engine -> synchronization -> reconciliation -> backtesting
-> analytics -> frontend migration.

Status on 30 Sept 2026:
- Blocker 1: COMPLETE (30 Sept 2026). Automatic checks in both projects,
  and `main` locked by a GitHub ruleset in both (app 24242244, service
  24242754): no deletion, no force-push, changes only through a pull
  request, its check green (app: `app-checks`, service: `guard-check`),
  0 approvals. The auditor approved this arrangement (C1).
- Blocker 2: AUTHORIZED by the owner on 30 Sept 2026, after the auditor
  closed the read-only inspection (Blocker 2A), and COMPLETED the same
  day. Built in the service (pull requests #79 and #80): the immutable
  broker ledger (`brokerLedger.js`, entries under `ledger:schwab:`) and
  its independent archive in Cloudflare storage (`ledgerArchive.js`,
  folder `broker-ledger-archive/v1/`). Verified live: 691 Schwab records,
  0 revisions, 691 archive record files, a second import added nothing,
  every fingerprint matches, nothing pre-existing changed. Report:
  "Blocker2_Completion_Report_2026-09-30".
  The auditor's ruling on it: CONDITIONAL PASS, on two conditions --
  (1) choose the Schwab account by an explicit, deterministic rule instead
  of the first one Schwab lists (`ledgerAccount.js`: the ledger is tied to
  one account, a server setting `SCHWAB_LEDGER_ACCOUNT` may name one, and
  otherwise only a single returned account is used; anything else is
  refused), and (2) this note. Final closure is the auditor's to give.
  Not part of Blocker 2, and NOT authorized: automatic recurring ledger
  imports, a restore-from-archive tool, anything that pairs trades or
  rebuilds positions from the ledger, matcher changes, journal migration.
- **Blocker 3: NOT STARTED and NOT AUTHORIZED.** Its rules are locked by
  the auditor (below); building them in needs the auditor's separate
  review of Blocker 2 and the owner's authorization in words.
- Phase 0 and Phase 1A were carried out and are live, before this
  sequence was set. See "Auditor_Review_Pack_Phase1".
- The 7 known failures stay as baseline until the phase that owns them
  (auditor, C2). No new known failure without the owner's authorization.

**Rules locked by the auditor (30 Sept 2026). No code may contradict
them once built. The broker ledger follows R1 and keeps the original fee
untouched; the journal's sync and pairing do NOT yet follow R1 or R12:**
- **R1** Schwab `activityId` is authoritative. `orderId` is NOT an
  acceptable fill/execution identity fallback (the service currently
  uses `activityId || orderId` -- to be removed). A missing activityId
  gets a deterministic composite identity explicitly marked uncertain.
  Normalized fills get their own deterministic ids that tell apart
  several legs of one broker transaction.
- **R12** Schwab's transaction-level fee is kept as an immutable broker
  fact. Known fees are allocated proportionally and deterministically
  across legs, rounding reconciled exactly to the original fee; the
  allocation never replaces the original. Unknown stays null, never 0.
- **R19** Automatic processes may not silently downgrade established
  evidence, confidence or authoritative values. Missing later information
  cannot erase earlier information. Contradictions need an auditable
  conflict/correction record.
- **Archive (Blocker 2)** Redis/Upstash may be the operational broker
  ledger but never the only copy. An independent archive holds the
  original Schwab records, metadata, identities, fingerprints/checksums
  and import information. It is evidence and recovery, not a second
  pairing engine.

**Until the owner authorizes otherwise, never:**
- modify his production journal data (the phone's `strat_trades`, or the
  service's stored trades) -- read-only copies and dry runs only;
- run the old reconciliation repair ("Put this right");
- delete the 50 duplicate trades that came back on 30 Sept;
- begin any live migration;
- start Blocker 3, or build the trade engine;
- extend the broker ledger beyond what Blocker 2 authorized (no automatic
  imports, no restore tool, nothing that pairs or rebuilds from it);
- merge ANY change to `main` without: his written authorization for that
  step, the automatic checks green, and the auditor having seen the plan.

**How the protection works (Blocker 1, option a):**
- Every proposed change runs the automatic checks on GitHub -- the app's
  syntax check and every browser check (`tests/ci/run-all.js`), and every
  service check (`tests/run-all.js`). A check that fails blocks the change.
- `main` is protected on GitHub by a ruleset (see above): changes arrive
  only through a proposed change (pull request) whose checks are green;
  no direct pushes, no force-pushes, no deleting it.
- Required REVIEWS are deliberately NOT switched on: every change is filed
  under his one GitHub account and GitHub forbids approving your own
  change, so a required review would block everything, including urgent
  fixes. His written approval in the conversation is the review (his
  choice, option a, 30 Sept 2026).
- Known failures that predate the audit are listed in
  `tests/ci/known-failures.json` (app only). Any failure not on it fails
  the run; a listed one that starts passing also fails the run until it is
  taken off. Adding to that list needs his written approval.

**Recovery points** (exact copies that can be restored):
- `recovery-2026-09-29-before-audit-repairs` -- app 7d04b32, service de6a520
- `recovery-2026-09-30-after-phase1` -- app 29952e2, service 20275b3

**Every data migration** first runs as a dry run that writes a log of
exactly what it WOULD change; the owner and the auditor inspect that log
before anything live changes, and a backup is taken immediately before.

**Every step ends with a report file for the auditor** (owner's standing
instruction).

## Who you're working with

The owner is a discretionary options trader, **not a developer**. Assume no
coding background. Explain things in plain language and avoid jargon unless
you define it. He does not want to read code to understand what changed —
tell him what it does and what to check.

He primarily uses the app on an **iPhone in Safari**. He has a MacBook Pro
(16-inch 2019, Intel i7, 16GB, macOS Tahoe) available for development, but
the app itself is used on the phone. Anything that only works on desktop is
not a fix.

## Working rules (these matter — they came from real failures)

1. **Verify before reporting.** Do not say something works until you have
   actually checked it. Run the code, run tests, check syntax. "It should
   work" is not acceptable. If you cannot verify something (visual
   appearance on a phone, real Schwab data), say so explicitly.

2. **Full review over one-at-a-time patching.** When debugging, read all
   relevant code first and report every problem found together. Do not
   fix one error, ship it, wait for a bug report, fix the next. That
   pattern has burned a lot of time on this project.

3. **Change one thing at a time when the cause is unclear.** Several
   past sessions shipped multiple simultaneous changes and made it
   impossible to tell which one broke things.

4. **Diagnose from evidence, not inference.** Browser console output and
   actual data beat guessing from screenshots. Ask for real error output
   before theorising.

5. **Say when you're wrong.** If a previous fix was aimed at the wrong
   cause, name that plainly rather than quietly moving on.

6. **The entire response must be understandable with zero coding or
   computer background — not just a trailing section.** Owner confirmed
   (2026-08-17) he has no technical or computer terminology knowledge at
   all, so this applies throughout a response, not only below a divider.
   When a technical detail genuinely has to come up, explain what it means
   in plain terms in that same sentence rather than assuming familiarity.
   Avoid the words commit, repo, function, variable, parameter, syntax,
   console, deploy, or any filename ending in .js/.html without explaining
   it in plain terms right there.

   Still end every response with an "In plain English" section containing:
   what was done (1-2 sentences), what he should do next (numbered steps),
   and anything he needs to click, tap, or check — but the rest of the
   response should already meet the same bar, not require translating.

## Architecture

**Frontend** — repo `alynnyree/strat-journal-app`, hosted on GitHub Pages at
`https://alynnyree.github.io/strat-journal-app/` (note the repo name in the
path; the bare domain 404s). A single `index.html`: vanilla JS, no build
step, no framework, dark theme, PWA-installable. Trades are stored in the
browser's localStorage under `strat_trades`.

**Backend** — repo `alynnyree/strat-journal-backend`, hosted on Render at
`strat-journal-backend.onrender.com`. Node/Express with Upstash Redis for
storage.

Backend files and what they do:
- `server.js` — Express app entry
- `auth.js` — Schwab OAuth, token refresh
- `api.js` — trade/pending/backfill/enrich routes
- `cron.js` — 5-minute auto-sync, historical backfill, runs all enrichment
- `schwabClient.js` — Schwab API calls
- `schwabStreamer.js` — persistent WebSocket to Schwab's real-time streamer
  (ACCT_ACTIVITY), auto-reconnect with backoff, rotates every 25 min before
  token expiry
- `matcher.js` — pairs opening/closing option fills into completed trades
- `tokenStore.js` / `tradeStore.js` — Redis persistence
- `ftfcCheck.js` — Full Time Frame Continuity across 13 timeframes,
  underlying price lookup, shared `fetchCandles`
- `replayData.js` — pulls the 1-minute candle window for Bar Replay
- `media.js` — screenshot upload/pending/delete (multipart, multer)
- `aiClient.js` / `aiRoutes.js` — Gemini API calls, `/ai/analyze` and
  `/ai/classify` routes

**Environment variables on Render:** `SCHWAB_CLIENT_ID`, `SCHWAB_SECRET`,
`SCHWAB_REDIRECT_URI`, `FRONTEND_ORIGIN`, `APP_SECRET`, `SYNC_CRON`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`PUSHCUT_NOTIFICATION_NAME`, `PUSHCUT_API_KEY`, `GEMINI_API_KEY`.

AI features use **Google Gemini's free tier** (gemini-2.5-flash, schema-
enforced JSON), not Anthropic's API — chosen to avoid ongoing API cost.
Browsers cannot call these APIs directly (CORS), so all AI calls are
server-side.

## The trading methodology (needed to reason about features correctly)

Uses **The Strat**. Key concepts the code implements:

- **FTFC (Full Time Frame Continuity)** — timeframes aligned in the same
  direction. Implemented across 13 timeframes (6M, 3M, 1M, 1W, 1D, 4H, 2H,
  1H, 30m, 15m, 5m, 3m, 1m). Confirmed when **any 4+ consecutive**
  timeframes agree — the run can start anywhere in the sequence, not just
  at the largest timeframe.
- **Setups traded:** 2→3 Reversal, FTFC Continuation, Broadening Formation
  Reversal.
- **Instruments:** SPY and IWM options, 0DTE–3DTE. Occasionally others.
- **Always buys to open** (calls or puts), never sells to open. This is why
  P&L needs no sign flip: a rising option price is always profit,
  regardless of whether the underlying bet is Long or Short. Long/Short is
  derived from CALL vs PUT, not from buy/sell instruction.
- **Stops** are drawn on the **underlying's chart** (a price level on
  SPY/IWM), not on the option premium. Realized R:R is therefore computed
  from the underlying's move, not the option's:
  `(undExit − undEntry) / |undEntry − stop|`, sign-flipped for Short.

## Feature status

**Working:**
- Schwab OAuth and auto-sync of trades directly into the Journal
- Real-time Schwab streaming (verified live)
- FTFC calculation, underlying price at entry/exit
- Bar Replay (candle-by-candle playback via TradingView Lightweight Charts)
- Realized R:R calculation
- AI Analyst (server-side, Gemini)
- PWA install
- **AI strategy auto-classification (server-side, Gemini)** — corrected
  2026-08-18: this was already built (since 2026-08-09) and runs
  automatically on newly-synced trades via `cron.js`'s
  `enrichWithStrategy`; the "not built" note below was stale. What was
  actually missing — and was added 2026-08-18 — was a way to run it
  against trades logged *before* that existed: a "Classify Trades" button
  on the Dashboard (shows only when trades are untagged) sends each one
  to a new `POST /ai/classify` backend route, one trade per request so no
  single phone request runs long. Deliberately conservative: only tags a
  trade when the model itself reports high confidence, so some trades
  will keep showing "Needs Setup" — that's expected, not a bug. Not yet
  confirmed against real trade data or on a real phone.

**Not working / not built:**
- **Screenshot capture pipeline** — Pushcut → iOS Shortcut → backend →
  auto-attach by timestamp. Owner confirmed this is NOT complete. Note it
  is inherently one-tap-per-trade, not zero-tap.
- **Backtesting** — never started.
- **Native iOS app** for zero-tap session recording — fully scoped, not
  started. Needs Xcode + free Apple ID (Personal Team signing avoids the
  $99/yr fee but requires re-signing roughly every 7 days). Design: one tap
  to start a session via Control Center tile, one-time ReplayKit consent,
  records through multiple trades, backend auto-clips each trade from the
  session recording using the same timestamp-matching approach as
  screenshots.

## Known traps (hard-won — do not re-learn these)

- **Lightweight Charts positions by candle SLOT, not by real time.** Adding
  a drawing as a data series with a far-future timestamp does NOT stretch
  it across the chart — it collapses into one slot, and inserting a
  non-candle timestamp physically shifts every candle. User-drawn lines are
  therefore painted on a **separate transparent canvas overlaid on the
  chart**, never added as chart series.
- **Forcing `barSpacing`/`minBarSpacing` while removing `fitContent()`
  blanked the chart entirely** (no candles, no gridlines, no price scale,
  and no console error). Candle size is fixed by limiting how much data is
  loaded, not by fighting the chart's layout.
- **Schwab retains 1-minute candle data for only ~30–35 days.** Older
  trades legitimately have no replay data. `ftfcCheck.js` cascades
  1m → 5m → 30m → daily so older trades still get an underlying price.
- **Expired options never produce a closing fill.** Their open legs used to
  sit in the matcher forever, so re-trading the same contract weeks later
  paired the new close against the ancient open — producing "trades"
  spanning a month and replays with thousands of candles. `matcher.js` now
  purges dead legs and prefers same-day matches.
- **iOS Safari measures container size before a fullscreen modal finishes
  laying out.** Chart sizing needs a short delayed re-measure.
- **The `/media` and `/ai` routes require the app key.** The frontend has an
  "App Key" field on the Journal tab that must match the backend's
  `APP_SECRET`. A 403 on `/media/pending` means these don't match.

## Testing expectations

There is no test suite. Before claiming a change works:
- Run a real JavaScript syntax check on `index.html`'s script block
  (extract it and parse it — brace counting is not sufficient).
- For backend logic changes (matching, date/window math), write a throwaway
  Node script that exercises the actual edge cases and print the results.
  Past bugs would have been caught this way.
- State plainly what you could NOT verify — anything about how the app
  looks or behaves on a physical iPhone is unverifiable from here.

## Deployment

Both repos deploy on commit to `main`:
- Frontend → GitHub Pages (takes a minute or two; verify via the Actions
  tab, not the Settings→Pages "last deployed" text, which caches badly)
- Backend → Render (auto-redeploys)

After backend matching/enrichment changes, the owner needs to tap
**"Reset & Re-import Trades"** on the Journal tab to rebuild existing
trades — old trades keep their stale data otherwise.
