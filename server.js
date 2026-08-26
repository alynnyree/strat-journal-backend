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

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/debug', streamerTestRouter);
app.use('/media', mediaRouter);
app.use('/ai', aiRoutes);
app.use('/browser', browserEventsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Strat Journal backend listening on port ${PORT}`);
  startAutoSync(process.env.SYNC_CRON || '*/5 * * * *'); // stays running as a safety net alongside the streamer
  startStreamer();
  persistExistingFeedback(); // one-time: stop older test feedback ageing out
});
