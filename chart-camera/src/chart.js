'use strict';
// THE CHART ON THE CAMERA'S SCREEN: his own TradingView layout, opened in a
// browser that remembers his sign-in, full-screen on the virtual display
// the recorder films. It switches to the symbol of a trade when one opens,
// and keeps a log of which symbol was on screen from when, so a picture
// can never be passed off as showing a symbol it did not show.
const fs = require('fs');
const path = require('path');

const BROWSER_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];

function findBrowser(cfg) {
  if (cfg.browserPath) return fs.existsSync(cfg.browserPath) ? cfg.browserPath : null;
  return BROWSER_CANDIDATES.find(p => fs.existsSync(p)) || null;
}

function symbolUrl(cfg, symbol) {
  const u = new URL(cfg.chartUrl);
  u.searchParams.set(cfg.symbolParam, symbol);
  return u.toString();
}

class Chart {
  constructor(cfg, log, playwright) {
    this.cfg = cfg; this.log = log || (() => {});
    this.pw = playwright || null;
    this.ctx = null; this.page = null;
    this.symbol = null;              // what is on screen (once settled)
    this.history = [];               // [{symbol, from}] -- from when each symbol was on screen
    this.problem = null;             // why the chart is not showing, in plain words
    this.signedOut = null;           // true / false / null (could not tell)
  }

  loadPlaywright() {
    if (this.pw) return this.pw;
    try { this.pw = require('playwright-core'); }
    catch (e) { this.pw = null; }
    return this.pw;
  }

  async open(symbol) {
    const pw = this.loadPlaywright();
    if (!pw) { this.problem = 'the browser-control part is not installed (playwright-core)'; return false; }
    const exe = findBrowser(this.cfg);
    if (!exe) { this.problem = 'no Chromium browser was found on the camera'; return false; }
    const profile = path.join(this.cfg.dataDir, 'browser-profile');   // keeps his TradingView sign-in
    fs.mkdirSync(profile, { recursive: true });
    try {
      this.ctx = await pw.chromium.launchPersistentContext(profile, {
        headless: false, viewport: null, executablePath: exe,
        env: Object.assign({}, process.env, { DISPLAY: this.cfg.display }),
        args: [`--window-size=${this.cfg.width},${this.cfg.height}`, '--window-position=0,0', '--kiosk',
          '--no-first-run', '--noerrdialogs', '--disable-infobars', '--disable-session-crashed-bubble',
          '--password-store=basic', '--disable-features=Translate'],
      });
      this.ctx.on('close', () => { this.ctx = null; this.page = null; this.problem = 'the browser closed'; });
      this.page = this.ctx.pages()[0] || await this.ctx.newPage();
    } catch (e) {
      this.problem = `the browser would not open (${String(e.message).split('\n')[0]})`;
      this.ctx = null; this.page = null;
      return false;
    }
    return this.show(symbol);
  }

  get isOpen() { return !!(this.ctx && this.page && !this.page.isClosed()); }

  // Switch the chart to `symbol`. The log records it from when it is
  // settled on screen, not from when it was asked for. One switch at a
  // time: a second request waits for the first to settle.
  show(symbol) {
    const next = (this.switching || Promise.resolve()).then(() => this.showNow(symbol), () => this.showNow(symbol));
    this.switching = next.catch(() => {});
    return next;
  }

  async showNow(symbol) {
    if (!this.isOpen) return false;
    if (this.symbol === String(symbol || '').toUpperCase() && this.problem == null) return true;
    const sym = String(symbol || this.cfg.defaultSymbol).toUpperCase();
    try {
      await this.page.goto(symbolUrl(this.cfg, sym), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(this.cfg.symbolSettleMs);
    } catch (e) {
      this.problem = `the chart page would not load for ${sym} (${String(e.message).split('\n')[0]})`;
      return false;
    }
    this.symbol = sym;
    this.history.push({ symbol: sym, from: Date.now() });
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.problem = null;
    await this.checkSignedIn();
    this.log('chart', `showing ${sym}`);
    return true;
  }

  // Which symbol was on screen at moment `t`, and from when.
  symbolAt(t) {
    let cur = null;
    for (const h of this.history) { if (h.from <= t) cur = h; else break; }
    return cur;
  }
  // When the chart first settled on `symbol` at or after `t`, if it did.
  switchedTo(symbol, t) {
    const h = this.history.find(x => x.from >= t && x.symbol === symbol);
    return h ? h.from : null;
  }

  // TradingView shows a "Sign in" button when the session has lapsed. If
  // it cannot be told, that is said ("not known"), never guessed.
  async checkSignedIn() {
    if (!this.isOpen) { this.signedOut = null; return null; }
    try {
      const btn = this.page.locator('button:has-text("Sign in"), a:has-text("Sign in")').first();
      this.signedOut = await btn.isVisible({ timeout: 1000 });
    } catch (e) { this.signedOut = null; }
    return this.signedOut;
  }

  async close() {
    const c = this.ctx; this.ctx = null; this.page = null;
    if (c) { try { await c.close(); } catch (e) { /* already gone */ } }
  }
}

module.exports = { Chart, findBrowser, symbolUrl };
