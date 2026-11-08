'use strict';
// TALKING TO HIS SERVICE. Every answer says which of three things happened,
// never folded into one: it could not be reached, it refused (and what it
// said), or it answered. The app key travels in a header, never in the
// address, and is never logged.
const fs = require('fs');
const http = require('http');
const https = require('https');

class Service {
  constructor(cfg) { this.cfg = cfg; }

  headers(extra) { return Object.assign({ Authorization: 'Bearer ' + this.cfg.appKey }, extra || {}); }

  async request(method, route, { query, json, form, timeoutMs = 20000 } = {}) {
    const u = new URL(this.cfg.serviceUrl + route);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    const opts = { method, headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (form) opts.body = form;
    const sentAt = Date.now();
    let r;
    try { r = await fetch(u, opts); }
    catch (e) { return { reached: false, ok: false, status: null, body: null, reason: `could not reach the service (${e.name === 'TimeoutError' ? 'no answer in time' : (e.cause && e.cause.code) || e.message})` }; }
    const text = await r.text().catch(() => '');
    let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    const rtt = Date.now() - sentAt;
    if (!r.ok) {
      const said = body && typeof body === 'object' && body.error ? body.error : (typeof body === 'string' ? body.slice(0, 200) : '');
      return { reached: true, ok: false, status: r.status, body, rtt, reason: `the service refused (${r.status}${said ? ': ' + said : ''})` };
    }
    return { reached: true, ok: true, status: r.status, body, rtt, reason: null };
  }

  events(after) { return this.request('GET', '/camera/events', { query: { after } }); }
  heartbeat(beat) { return this.request('POST', '/camera/heartbeat', { json: beat }); }

  // One picture, as a file field named "image" (what /media/upload takes).
  async picture(file, { at, moment, note, test }) {
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), 'chart.jpg');
    return this.request('POST', '/media/upload', {
      form, timeoutMs: 60000,
      query: { timestamp: new Date(at).toISOString(), moment, source: 'camera', note: note || null, test: test ? '1' : null },
    });
  }

  // One recording, straight to storage: ask for a link, send the file to
  // it, then tell the service it is there.
  async video(file, meta) {
    const link = await this.request('POST', '/camera/video-upload-url', { json: {} });
    if (!link.ok) return link;
    const { id, r2Key, uploadUrl, contentType } = link.body || {};
    if (!uploadUrl) return { reached: true, ok: false, reason: 'the service answered without an upload link' };
    const put = await putFile(uploadUrl, file, contentType || 'video/mp4');
    if (!put.ok) return put;
    return this.request('POST', '/camera/video-uploaded', { json: Object.assign({ id, r2Key }, meta) });
  }
}

// A file sent as it is read (a recording can be hundreds of megabytes),
// with its exact length, which storage requires.
function putFile(url, file, contentType, timeoutMs = 30 * 60 * 1000) {
  return new Promise(res => {
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return res({ reached: false, ok: false, reason: 'the recording file is missing on the camera' }); }
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'PUT', headers: { 'Content-Type': contentType, 'Content-Length': size }, timeout: timeoutMs }, r => {
      let body = ''; r.on('data', d => { body = (body + d).slice(-500); });
      r.on('end', () => res(r.statusCode >= 200 && r.statusCode < 300
        ? { reached: true, ok: true, status: r.statusCode, reason: null }
        : { reached: true, ok: false, status: r.statusCode, reason: `storage refused the recording (${r.statusCode})` }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', e => res({ reached: false, ok: false, reason: `could not reach storage (${e.code || e.message})` }));
    fs.createReadStream(file).on('error', e => req.destroy(e)).pipe(req);
  });
}

module.exports = { Service, putFile };
