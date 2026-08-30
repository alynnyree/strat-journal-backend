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
const { startAutoSync } = require('./cron');
const { startStreamer } = require('./schwabStreamer');
const { installCrashGuards, getCrashes, uptimeSeconds, startedAt, memoryMb, watchMemory } = require('./crashGuard');
const { wrap, errorHandler } = require('./asyncRoute');

// Installed before anything is started, so a failure while starting up is
// caught too. Without this, one unwrapped failure anywhere in a background
// job ends the whole process -- which is what "Exited with status 1" in
// Render's alert email means.
installCrashGuards();
watchMemory();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
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
app.get('/health', wrap(async (req, res) => {
  let crashes = [];
  try { crashes = await getCrashes(5); } catch (err) { /* never let this route fail */ }
  const mem = memoryMb();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    startedAt,
    uptimeSeconds: uptimeSeconds(),
    memoryMb: mem.nowMb,
    peakMemoryMb: mem.peakMb,
    recentFailures: crashes,
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
