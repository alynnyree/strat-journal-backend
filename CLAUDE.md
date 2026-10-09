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
- Blocker 2: CLOSED by the auditor (30 Sept 2026). Authorized by the
  owner after the read-only inspection (Blocker 2A) and built in the
  service (pull requests #79, #80): the immutable broker ledger
  (`brokerLedger.js`, entries under `ledger:schwab:`) and its independent
  archive in Cloudflare storage (`ledgerArchive.js`, folder
  `broker-ledger-archive/v1/`). Verified live: 691 Schwab records, 0
  revisions, 691 archive record files, a second import added nothing,
  every fingerprint matches. The auditor's two closing conditions were met
  in #81: the Schwab account is chosen by an explicit rule
  (`ledgerAccount.js`; the ledger is tied to one account, a server setting
  `SCHWAB_LEDGER_ACCOUNT` may name one, otherwise only a single returned
  account is used, anything else is refused), and this note.
  NOT authorized: automatic recurring ledger imports, a restore tool.
- Blocker 3A: CLOSED by the auditor (30 Sept 2026). PR #82 MERGED to the
  service's main as 00341fb (content identical to the approved head
  09e4671). It added exactly two files: `tradeRebuild.js`, a PURE
  reconstruction (ledger records in -> fills, positions, trades,
  exceptions out; loads only `crypto`, no storage, network, files, clock,
  matcher or journal) and `tests/trade-rebuild.js` (82 checks, 10
  deliberate faults caught). NOTHING in the service calls it, and nothing
  may, until a later phase is authorized. Rules B3-1..B3-11 are locked
  (the authoritative wording is the header of `tradeRebuild.js`); **B3-5,
  the pairing rule, is OPEN**: `fifo-v1` is a candidate and
  `current-rule-v1` is only a comparison model of `matcher.js` -- neither
  may be chosen or used as the production rule. Reports:
  "Blocker3A_Report", "Blocker3A_Corrections_Report",
  "Blocker3A_Merge_Report".
- Blocker 3B: CLOSED AS A READ-ONLY DRY RUN by the auditor (30 Sept
  2026). Authorized by the owner with a fresh journal export; nothing was
  written anywhere. Report: "Blocker3B_Report" and "Blocker3B_Details".
  Proven: the ledger rebuilt under either rule reconciles to BOTH Schwab
  files to the cent (4 May-23 Jul: 151 contracts, -$541.00 gross, $199.94
  fees, -$740.94 net; 2 Jan-23 Jul: 306 contracts, $404.73, -$1,100.73),
  once the two midnight-dated sales (D3) are counted. The journal does
  not, for these proven reasons -- none of them may be repaired without a
  separately authorized phase:
  - D1 38 file-read trades double-count fills already in live trades
    (journal 219 contracts vs Schwab 151 in that window).
  - D2 the old shape-based duplicate check threw away 8 real 1-contract
    trades that had identical-shape twins. Shape/price/time/size alone is
    NEVER an identity; use durable fill ids.
  - D3 3 option records have tradeDate at New York midnight while Schwab's
    `time` holds the real moment; two are sales dated before their own
    purchase. tradeDate stays authoritative (B3-2/B3-3); they stay
    explicit exceptions until a later authorized rule change.
  - D4 the old "Put this right" plan removed 6 genuine trades and kept
    mispaired file copies: that is the historical $49 gap, reproduced
    exactly. It is historical evidence only, never a repair algorithm.
  - D5 the journal splits fee cents differently from R12's largest
    remainder; fill totals agree. No fee rewrite now; R12 applies to any
    future canonical data.
  B3-5 remained OPEN at 3B: fifo-v1 and current-rule-v1 differ on 10
  sales, with identical money on every contract-day. **DECIDED 7 Oct 2026
  by the owner: "Option 1", fifo-v1 (oldest purchase first) is the
  production pairing rule** (Step E); current-rule-v1 stays a comparison
  model only. tradeRebuild.js is still frozen, so its RULE_STATUS text
  still says "candidate"; this note and the Step E files record the
  decision. The two NIO trades carrying his
  chart drawings must be migrated non-destructively, never mapped by
  contract count.
  **Nothing further is authorized.** Any next implementation phase must
  first be presented to the auditor with its exact scope, tests, dry-run
  output and rollback plan, and needs the owner's authorization in words.
- Phase 0 and Phase 1A were carried out and are live, before this
  sequence was set. See "Auditor_Review_Pack_Phase1".
- **6 Oct 2026, the owner changed the process to end revision loops.**
  - The Level 2 read-only code audit is COMPLETE for existing code. Its
    blockers are F1 to F6.
  - The Trade Engine design (v21, A-4, A-5, A-6, C-7, C-8, OD-1 to OD-9b)
    is PARKED as written.
  - Remaining work, in a fixed order:
    - A: gate F5 (app; done, PR #169);
    - B: F3 + F4 + H-3 + H-7 (this service);
    - C: F1 + H-5;
    - D: F2;
    - E: rebuild the journal from the ledger, after the owner picks
      B3-5.
  - Each step: one-page plan, ONE auditor review round, the owner's
    authorization in words, a PR with green checks, then a separate
    merge authorization.
  - **Step B (implemented here)** changes how "trades:state" is written:
    - every write goes through `tradeStore.updateState(change)`, one at a
      time, onto the record as it is at that moment;
    - only one sync job (sync, backfill, reset) runs at a time;
    - a backfill keeps the live open legs;
    - lastProcessedIds is kept whole and de-duplicated in every path;
    - a window Schwab refused leaves the checkpoint where it was, with
      the reason in `lastSync`.
    Checked by `tests/sync-state-safety.js`. Never write a copy of this
    record that was read earlier.
  - **Step C (implemented here)** changes the live fill identity:
    - extractOptionFills names a record by its activityId, unchanged;
    - without one, it uses "U-" + 32 hex of the record's fingerprint,
      identical to brokerLedger.identityOf, marked identityUncertain, with
      the orderId kept only as legacyId;
    - no tradeDate means no fill, reported in report.unusable and lastSync,
      and never replaced by `time`;
    - notYetProcessed uses a recorded orderId only to recognise the one
      fill it can positively be (identityCutoverAt, written once, and a
      single record per order); anything else is listed in
      lastSync.legacyAmbiguous, never guessed at.
    Checked by `tests/fill-identity.js`.
  - **Step D (service half)**: each trade from the matcher also carries
    closeQuantity, the contracts in its closing fill. It is data only, and
    pairing is unchanged. The app uses it with contractsOpened to refuse
    only a pair that would over-use a fill (tests/close-quantity.js).
  - **Step E (plan v7, accepted by the auditor; implementation authorized
    7 Oct 2026: "I authorize Step E implementation")**:
    - E3: `matcher.js` pickLegForClose picks the OLDEST eligible purchase
      (ties by fill id as a number), replacing "newest same-day first", so
      new trades pair as fifo-v1 does (tests/oldest-first.js). Eligibility
      (expiry 23:59:59 UTC, 45 days) is unchanged and is a known,
      listed difference from fifo-v1.
    - E1: `tools/stepE-prepare.js` (pure; crypto + tradeRebuild only) and
      `tools/stepE-cli.js` (reads the journal export and the backup copy
      read-only) produce the dry-run log, the prepared journal and the
      restore file OFFLINE. Not part of the running server; nothing
      requires it. Owner data moves only by fill identity and the tool
      STOPS rather than discard, guess or merge (tests/stepE-prepare.js).
      Its outputs are owner data: never commit them.
    - Correction (authorized 7 Oct 2026: "I authorize the Step E
      correction"; plan accepted by the auditor after the first dry run's
      L0 was BLOCKED): `replayMissingReason` is the app's own note about
      a failed chart-bar fetch, so it is PAIR_ONLY machine state, never
      owner data, and never moved to a new pair (tests/stepE-prepare.js
      case 13). A field on no list still falls to "his" as a fail-safe.
    - stepE-compare (plan approved by the auditor; implementation
      authorized 7 Oct 2026: "I authorize step E-compare implementation"):
      `tools/stepE-compare.js` (pure; crypto + stepE-prepare only) and
      `tools/stepE-compare-cli.js` (inputs read-only, writes only the
      report, never over an existing file). It re-runs E1 itself on X0 +
      B0 (must reproduce the approved P0 fingerprint AND L0 byte for byte)
      and on X_n + B0 with the approved range GIVEN, requires the P_n file
      to be byte-identical to that result, and applies C1-C9. Field
      classes are asked of E1 (a probe run's FIELD CLASSES), never copied;
      a name E1 does not answer for is held to the broker rule. Trades are
      matched by stepE.ledgerTradeId, never by shape. PASS or STOP with
      every difference listed (tests/stepE-compare.js). It writes no
      journal and repairs nothing; the apply still needs "Step E apply".
    - The dry run and the APPLY on his phone are separate gates: the log
      goes to the auditor, and the apply needs the owner's words naming
      "Step E apply".
- **H-2 (Phase 1; revised plan reviewed by the auditor; implementation
  authorized 9 Oct 2026: "I authorize H-2 implementation")**: the live
  matcher no longer drops a sale it cannot pair, or a purchase past expiry
  / older than 45 days, without a record. `processFills` returns
  `exceptions` (close-without-open, open-retired) and pairing is unchanged
  (5,000 random streams identical to the old matcher). They are saved in
  `trades:state.exceptions`, keyed by kind + broker fill id, in the SAME
  updateState change that marks the fills processed; never duplicated,
  never deleted; a reset keeps them. A retired purchase is never called
  "expired worthless". Read-only `GET /api/trades/exceptions` (app key),
  one line behind Details in the app (tests/unpaired-fills.js).
  **Corrected after the auditor's implementation review (9 Oct 2026):**
  - A record is resolved ONLY by the matcher's own `fullyPaired` evidence:
    the same broker fill id AND the same contract, date, time, price and
    size, with EVERY contract paired. Part paired is not paired (the first
    version resolved a partly paired sale by its own trade, in the same
    change). Never resolved: identityUncertain records, conflicted records,
    or a key the same run reports unpaired.
  - Original facts never change. Resolution adds only status, resolvedAt
    and `resolution`. The same key with different facts (one id on two
    fills -- the live sync gives every option leg of one Schwab transaction
    the same id, R1 is not applied there) or after resolution is kept as an
    `observation` and sets `conflicted`; never applied, never dropped.
  - An `exceptions` field of the wrong shape, or a record of the wrong
    shape at the very key a fill must be recorded under, makes the WHOLE
    change refuse (auditor, second review): nothing in it is saved, the
    sync checkpoint does not move, the bad value is never overwritten, and
    the route counts it. Only a repair outside the service clears it.
  - The route's per-kind summary has three fixed labels
    (close-without-open, open-retired, other).
  - The route sends at most 100 records, named fields only, strings cut at
    200 characters, counts over all records, and counts malformed ones.
  - ROLLBACK RULE: main's code before H-2 erases `exceptions` on a reset
    (measured; every other writer keeps it). So H-2 is never rolled back by
    a plain revert: a rollback keeps the reset line that preserves
    `exceptions`, and a backup export is taken first.
- **M-1 (Phase 1; plan v4 approved by the auditor; implementation
  authorized 9 Oct 2026: "I authorize M-1 implementation")**: a trade's id
  comes from its broker fills.
  - id = contract-openTime-closeTime-"p" + the first 32 hex of the
    SHA-256 of "m1v1|" + len(acct) + ":" + acct + "|" + len(open) + ":" +
    open + "|" + len(close) + ":" + close (matcher.js canonicalPair /
    tradeIdFor). The random suffix is gone. Existing ids, including Step
    E's "T:" ids, are never renamed.
  - A fill id is valid only as decimal digits (Schwab's activityId) or
    "U-" + 32 lowercase hex; anything else is MISSING (never trimmed). A
    pairing with a missing id is not queued: "pair-unidentified", keyed by
    the leg, always uncertain. A "U-" side gives idBasis
    "uncertain-fill-id"; otherwise "fill-pair".
  - getOptionFills stamps every fill with accountRef =
    ledgerAccount.refOf(hashValue). A sale pairs only with a leg of the SAME
    account, both known: otherwise "account-mismatch" / "account-unknown".
    Nothing is inferred. Trades carry accountRef.
  - Two different pairs under one id (forced in tests only): neither is
    queued, one "id-collision" incident per key, with detections (every
    detection, the first included) and detectedBy ("matcher", "queue").
  - DELETE /api/trades/pending/:id?fills=open,close removes only that
    pair; a different pair under the id is kept and answered 409. Without
    "fills", the old behaviour.
  - The rehearsals (testTrade.js, replayCheck.js) give their pretend fills
    "U-" ids and accountRef "rehearsal"; they never reach his journal.
  - Tests: tests/trade-ids.js; the old fixtures now use decimal ids and an
    account (tests/lib/ledgerFixture.js fillOf stamps one).
    tests/live-fill-account.js runs Schwab-shaped transactions through the
    REAL getOptionFills and sync (the stamp is in getOptionFills, just
    before each fill is collected -- extractOptionFills cannot know the
    account, and brokerInspect reads it alone), and proves itself by
    failing with the stamping line removed.
- **H-4 owner decisions (9 Oct 2026), POLICY ONLY:** Q1 "Option A" -- a
  broker-confirmed worthless expiry becomes a trade closed at $0.00 on the
  verified expiry date, marked "expired", only with full broker evidence,
  otherwise an exception. Q2: "I approve the Schwab activity rule" (V-1 to
  V-7). The live fetch stays `types: 'TRADE'` until a separate H-4
  implementation plan is reviewed and authorized.
- The 7 known failures stay as baseline until the phase that owns them
  (auditor, C2). No new known failure without the owner's authorization.

**Rules locked by the auditor (30 Sept 2026). No code may contradict
them once built. The broker ledger and `tradeRebuild.js` follow R1 and
R12; the LIVE journal sync and pairing (`schwabClient.js`, `matcher.js`)
still do NOT:**
- **R1** Schwab `activityId` is authoritative. `orderId` is NOT an
  acceptable fill/execution identity fallback (the service currently
  used `activityId || orderId`; REMOVED in Step C, see below). A missing activityId
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
- choose a pairing rule (B3-5), build the trade engine, or start any
  phase after Blocker 3B without the auditor seeing its plan first;
- substitute Schwab's `time` field for `tradeDate`, or identify a trade by
  its shape (contract, minutes, prices, size) alone;
- call `tradeRebuild.js` from anything live, or change it outside an
  authorized step;
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
