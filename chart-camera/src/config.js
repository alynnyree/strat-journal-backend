'use strict';
// The camera's settings: one small file on the camera itself
// (config.json beside this folder, or the path in CHART_CAMERA_CONFIG).
// Every setting has a default except the three that are his: where his
// service is, his app key, and the link to his TradingView chart layout.
// The app key is never written anywhere else, never logged, never sent
// anywhere but his own service.
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  serviceUrl: null,          // e.g. https://strat-journal-backend.onrender.com
  appKey: null,              // the same key as the App Key box in the journal
  chartUrl: null,            // his TradingView chart layout link
  defaultSymbol: 'SPY',      // shown when no trade is open
  symbolParam: 'symbol',     // the chart link's symbol setting (?symbol=IWM)
  symbolSettleMs: 5000,      // how long a switched chart takes to show the new symbol
  intervalMinutes: 5,
  preRollSeconds: 60,
  postRollSeconds: 60,
  maxVideoMinutes: 45,
  keepHeadMinutes: 40,
  keepTailMinutes: 5,
  maxDuringPerTrade: 30,
  fps: 5,
  width: 1920,
  height: 1080,
  display: ':99',
  segmentSeconds: 10,
  recordCrf: 23,
  phoneVideoHeight: 720,
  phoneVideoCrf: 30,
  pictureWidth: 1600,
  recordStart: '09:25',      // New York time, weekdays
  recordEnd: '16:20',
  dataDir: null,             // where recordings live (the SSD); defaults to ./data
  keepRawHours: 48,
  pollSeconds: 3,
  heartbeatSeconds: 60,
  browserPath: null,         // found automatically when left empty
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  lateSwitchWithinMs: 15000, // a chart that switched to the right symbol within this long after the moment
  latePictureWithinMs: 2 * 60 * 60 * 1000,
});

const REQUIRED = ['serviceUrl', 'appKey', 'chartUrl'];

// Where the settings are: the path the service file gives, else the place
// the installer puts them, else beside this folder.
const INSTALLED = '/etc/chart-camera/config.json';
function configPath() {
  if (process.env.CHART_CAMERA_CONFIG) return process.env.CHART_CAMERA_CONFIG;
  if (fs.existsSync(INSTALLED)) return INSTALLED;
  return path.join(__dirname, '..', 'config.json');
}

// Answers with what is wrong, in plain words, never a bare failure.
function loadConfig(file = configPath(), overrides = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const why = e.code === 'ENOENT' ? `there is no settings file at ${file}` : `the settings file at ${file} is not readable (${e.message})`;
    return { ok: false, why, cfg: null };
  }
  const cfg = Object.assign({}, DEFAULTS, raw, overrides);
  const missing = REQUIRED.filter(k => !cfg[k] || typeof cfg[k] !== 'string');
  if (missing.length) return { ok: false, why: `the settings file is missing: ${missing.join(', ')}`, cfg };
  const example = REQUIRED.filter(k => /PUT-YOUR-/.test(cfg[k]));
  if (example.length) return { ok: false, why: `the settings file still has the example value for: ${example.join(', ')} (see Step 6 of the guide)`, cfg };
  try { new URL(cfg.serviceUrl); new URL(cfg.chartUrl); }
  catch (e) { return { ok: false, why: 'the service address or the chart link in the settings file is not a web address', cfg }; }
  cfg.serviceUrl = cfg.serviceUrl.replace(/\/+$/, '');
  cfg.dataDir = cfg.dataDir || path.join(__dirname, '..', 'data');
  if (cfg.keepHeadMinutes + cfg.keepTailMinutes > cfg.maxVideoMinutes) {
    return { ok: false, why: 'keepHeadMinutes plus keepTailMinutes is longer than maxVideoMinutes', cfg };
  }
  return { ok: true, why: null, cfg };
}

module.exports = { DEFAULTS, REQUIRED, loadConfig, configPath };
