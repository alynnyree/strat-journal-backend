require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { router: authRouter } = require('./auth');
const apiRouter = require('./api');
const streamerTestRouter = require('./streamerTest');
const mediaRouter = require('./media');
const aiRoutes = require('./aiRoutes');
const { persistExistingFeedback } = require('./aiTestFeedback');
const { router: browserEventsRouter } = require('./browserEvents');
const { startAutoSync, FTFC_RULE_VERSION } = require('./cron');
const { startStreamer } = require('./schwabStreamer');
const { installCrashGuards, getCrashes, uptimeSeconds, startedAt, memoryMb, watchMemory } = require('./crashGuard');
const { lastPhoneAlert } = require('./pushcut');
const { wrap, errorHandler } = require('./asyncRoute');
const { keyOk, queryKeyUse } = require('./appKey');

// Installed before anything is started, so a failure while starting up is
// caught too. Without this, one unwrapped failure anywhere in a background
// job ends the whole process -- which is what "Exited with status 1" in
// Render's alert email means.
installCrashGuards();
watchMemory();

// Which web pages may read this server's answers.
//
// It was `origin: FRONTEND_ORIGIN || '*'`, and FRONTEND_ORIGIN turned out NOT
// to be set on the live server -- checked 30 September 2026: it answered
// "access-control-allow-origin: *" to the app, to an extension and to an
// unrelated website alike. The project notes said the setting existed; the
// server said otherwise, and the server is the evidence.
//
// Now: never "*". Allowed are the app's own address (built in, because it
// is public and fixed, and because failing closed with nothing allowed would
// have cut the owner's own app off the moment this went live), anything
// listed in FRONTEND_ORIGIN (comma-separated), and Chrome extensions -- his
// laptop add-on calls this server from one, has no permission of its own to
// skip this check, and its ID is not fixed in its manifest.
//
// This rule only governs what a BROWSER lets a page read. It is not the
// lock: the app key is. A request with no Origin (the iPhone Shortcut, a
// script) is unaffected by it either way.
const APP_ORIGIN = 'https://alynnyree.github.io';
function allowedOrigins() {
  const fromSettings = String(process.env.FRONTEND_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean).filter(s => s !== '*');
  return new Set([APP_ORIGIN, ...fromSettings]);
}
function originAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins().has(origin)) return true;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function buildApp() {
const app = express();

app.use(cors({
  origin: (origin, cb) => cb(null, originAllowed(origin)),
  // The app now sends its key in a header, which makes the browser ask
  // permission first. Remembered for ten minutes so it asks once, not before
  // every request.
  maxAge: 600,
}));
// Default Express JSON limit is 100KB — far too small for a base64-encoded
// screenshot. Raised to 16MB so the Test Classification tool can also take
// a short screen recording (encoding for transport inflates a file by
// about a third, so this clears a ~10MB clip). The /media/upload route
// itself still rejects anything over ~3MB as a sanity check independent
// of this ceiling, and the phone refuses an oversized clip before it ever
// gets sent, so this is a ceiling rather than an invitation.
app.use(express.json({ limit: '16mb' }));

// Answers "is the server actually up, and has it fallen over lately?".
// It used to answer only the first half, so a server that had crashed and
// been restarted looked exactly like one that had been running all week --
// and the only sign anything had happened was an email from the hosting
// company that the owner cannot act on.
//
// Public, but only "up" and the time. Everything else -- uptime, memory,
// recent failures, what happened to his last phone alert -- describes his
// private setup and is returned only with the app key (the app sends it).
app.get('/health', wrap(async (req, res) => {
  if (!keyOk(req)) return res.json({ ok: true, time: new Date().toISOString() });
  let crashes = [];
  try { crashes = await getCrashes(5); } catch (err) { /* never let this route fail */ }
  // What became of the last alert sent to his phone. Behind the Details
  // tap in the app, never on his screen -- but it exists at all because
  // every one of those alerts failed silently for months and nothing
  // anywhere said so.
  let phoneAlert = null;
  try { phoneAlert = await lastPhoneAlert(); } catch (err) { /* never let this route fail */ }
  const mem = memoryMb();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    startedAt,
    uptimeSeconds: uptimeSeconds(),
    // Which version of the timeframe rule THIS server measures with.
    // Without it there is no way to tell a server that has picked up a
    // correction from one still running the old code -- and the phone
    // would keep asking for a re-measure that can never satisfy it.
    ftfcRuleVersion: FTFC_RULE_VERSION,
    memoryMb: mem.nowMb,
    peakMemoryMb: mem.peakMb,
    recentFailures: crashes,
    lastPhoneAlert: phoneAlert,
    // Decision D: which callers still send the key in the web address, and
    // when they last did. The old way is switched off only once this has
    // stayed empty for the agreed period.
    keyInAddress: await queryKeyUse().catch(err => ({ _readError: err.message })),
  });
}));

app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/debug', streamerTestRouter);
app.use('/media', mediaRouter);
app.use('/ai', aiRoutes);
app.use('/browser', browserEventsRouter);

// Mounted last, after every route, or it catches nothing. Turns a request
// that failed into a plain answer instead of a hung phone.
app.use(errorHandler);
return app;
}

// Built by a function so tests can stand the real routes up without
// starting the five-minute sync, the Schwab stream or anything else.
module.exports = { buildApp, originAllowed };

if (require.main === module) {
const app = buildApp();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Strat Journal backend listening on port ${PORT}`);
  startAutoSync(process.env.SYNC_CRON || '*/5 * * * *'); // stays running as a safety net alongside the streamer
  startStreamer();
  // Every one of these is started and not waited on, so each needs its own
  // catch. A promise nobody is holding that fails is what ends the process.
  persistExistingFeedback().catch(err =>
    console.log('Could not make existing test feedback permanent:', err.message)); // one-time: stop older test feedback ageing out
});
}
