require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { router: authRouter } = require('./auth');
const apiRouter = require('./api');
const { startAutoSync } = require('./cron');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/auth', authRouter);
app.use('/api', apiRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Strat Journal backend listening on port ${PORT}`);
  startAutoSync(process.env.SYNC_CRON || '*/5 * * * *');
});
