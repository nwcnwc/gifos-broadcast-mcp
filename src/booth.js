// The booth: the host's own seat in a broadcast, in a headless Chromium on
// this computer. It holds the host key for as long as it is open (derived
// from the host password, never stored) and drives the GifOS page the way a
// host does: go live, play a video into the broadcast (viewers see
// Prerecorded), set the start time and the Visit link, end the broadcast.
//
// Each booth is its own browser context (its own GifOS profile, gone when
// the booth closes). Nothing here talks to anything but the GifOS site and
// its relay.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { log, launchInstalled } from 'gifos-mcp-core';

const DEFAULT_WAIT = 30000;

export class BoothPool {
  // cfg: the core config. opts: { fakeMedia, cameraFile, launch } (launch is for tests).
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.fakeMedia = opts.fakeMedia != null ? !!opts.fakeMedia : process.env.GIFOS_BOOTH_FAKE_MEDIA === '1';
    this.cameraFile = opts.cameraFile != null ? opts.cameraFile : String(process.env.GIFOS_BOOTH_CAMERA_FILE || '').trim();
    this.audioFile = opts.audioFile != null ? opts.audioFile : String(process.env.GIFOS_BOOTH_AUDIO_FILE || '').trim();
    this.launchFn = opts.launch || null;
    this.browser = null;
    this.starting = null;
    this.booths = new Map();
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.starting) return this.starting;
    const args = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
    // A computer with no camera can still go live from a file standing in
    // for one (GIFOS_BOOTH_CAMERA_FILE, .y4m or .mjpeg); tests use Chromium's
    // test pattern (GIFOS_BOOTH_FAKE_MEDIA=1).
    if (this.fakeMedia || this.cameraFile || this.audioFile) args.push('--use-fake-device-for-media-stream');
    if (this.cameraFile) args.push('--use-file-for-fake-video-capture=' + path.resolve(this.cameraFile));
    if (this.audioFile) args.push('--use-file-for-fake-audio-capture=' + path.resolve(this.audioFile));
    const opts = { headless: this.cfg.headless !== false, args };
    // The browser already on this computer (GIFOS_CHROME, Chrome, Edge); never a download.
    const started = this.launchFn
      ? this.launchFn(opts).then((b) => ({ browser: b, used: 'test' }))
      : launchInstalled((o) => chromium.launch(o), opts, this.cfg);
    this.starting = started.then(({ browser: b, used }) => {
      log('booth browser: ' + used);
      this.browser = b;
      this.starting = null;
      return b;
    }, (e) => { this.starting = null; throw e; });
    return this.starting;
  }

  get(id) { return this.booths.get(id) || null; }

  // broadcast: { meeting_id, room, link }. key: { verifier, seedHex }.
  async open(broadcast, key, { hostName } = {}) {
    const had = this.booths.get(broadcast.meeting_id);
    if (had && !had.closed) return had;
    const browser = await this.ensureBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
    const booth = new Booth(this, broadcast, ctx, this.cfg.timeoutMs || DEFAULT_WAIT);
    this.booths.set(broadcast.meeting_id, booth);
    try {
      await booth.start(key, hostName || 'Host');
    } catch (e) {
      await booth.close().catch(() => {});
      throw e;
    }
    return booth;
  }

  async close(id) {
    const b = this.booths.get(id);
    if (b) await b.close();
  }

  async closeAll() {
    for (const b of [...this.booths.values()]) await b.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}

export class Booth {
  constructor(pool, broadcast, ctx, waitMs) {
    this.pool = pool;
    this.broadcast = broadcast;
    this.ctx = ctx;
    this.waitMs = waitMs;
    this.page = null;
    this.closed = false;
    this.ended = false;
    this.errors = [];
  }

  async start(key, hostName) {
    const room = this.broadcast.room;
    await this.ctx.addInitScript(([r, v, k, n]) => {
      try {
        localStorage.setItem('gifos_vadm_' + r + '.' + v, k);
        localStorage.setItem('gifos_name', n);
        sessionStorage.setItem('gifos_appeared', '1');
      } catch (e) { /* storage blocked: the page asks for the host key */ }
    }, [room, key.verifier, key.seedHex, hostName]);
    // Headless Chromium has the speech recognition API but no engine behind
    // it, so the booth would claim its own voice and write nothing. Without
    // the API, Meeting Bot (when it watches) writes the host down.
    await this.ctx.addInitScript(() => { try { window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined; } catch (e) { /* read-only */ } });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', (e) => { this.errors.push(String((e && e.message) || e).slice(0, 300)); });
    await this.page.goto(this.broadcast.link, { waitUntil: 'domcontentloaded', timeout: this.waitMs });
    await this.page.waitForFunction(() => document.body.classList.contains('bc-host'), null, { timeout: this.waitMs })
      .catch(() => { throw new Error('The booth did not become the host of this broadcast. Check the host password.'); });
    // A GifOS host comes in with the camera on, which is live. Opening the
    // booth is not going live: the camera goes off until go_live.
    await this.page.waitForSelector('#cam', { state: 'attached', timeout: this.waitMs });
    await this.page.waitForTimeout(1500);
    await this.page.evaluate(() => { const b = document.getElementById('cam'); if (b && !b.classList.contains('off')) b.click(); });
    await this.waitState((st) => !st.on_air, 'The booth could not start off air', 15000);
    log('booth open for ' + this.broadcast.meeting_id);
  }

  async state() {
    if (this.closed || !this.page) return { open: false, ended: this.ended };
    const s = await this.page.evaluate(() => {
      const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
      const badge = document.getElementById('livebadge');
      const cam = document.getElementById('cam');
      const left = document.getElementById('left-modal');
      return {
        host: document.body.classList.contains('bc-host'),
        badge: badge ? badge.dataset.state || '' : '',
        air: txt('airkind'),
        watching: txt('airwho'),
        status: txt('status'),
        prerecorded: document.body.classList.contains('rb-on') ? txt('rb-now-txt') : '',
        camera_on: !!(cam && !cam.classList.contains('off')),
        mic_on: !!(document.getElementById('mic') && !document.getElementById('mic').classList.contains('off')),
        start_label: txt('bcwhen-lbl'),
        visit_label: txt('bcvisit-lbl'),
        // Left, or (a recorded service) the ended sheet with its seat kept.
        left: !!(left && left.style.display === 'flex') || !!document.getElementById('se-leave'),
      };
    });
    return {
      open: true,
      host: s.host,
      // On air: the host's picture goes out (camera on), or a video plays.
      on_air: s.camera_on || !!s.prerecorded,
      prerecorded: s.prerecorded || null,
      camera: s.camera_on,
      microphone: s.mic_on,
      badge: s.badge,
      air: s.air,
      watching: s.watching,
      status: s.status,
      start: s.start_label,
      visit: s.visit_label,
      ended: this.ended || s.left,
      page_errors: this.errors.slice(-3),
    };
  }

  async waitState(test, what, ms) {
    const end = Date.now() + (ms || this.waitMs);
    let last = null;
    while (Date.now() < end) {
      last = await this.state();
      if (test(last)) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(what + ' (the booth reads ' + JSON.stringify({ badge: last && last.badge, air: last && last.air, status: last && last.status }) + ').');
  }

  need() {
    if (this.closed || !this.page) throw new Error('The booth for this broadcast is not open. Call open_booth first.');
    if (this.ended) throw new Error('This broadcast has ended.');
  }

  // The host's camera on: the broadcast is live for everyone watching.
  async goLive() {
    this.need();
    const now = await this.state();
    if (now.on_air && !now.prerecorded) return now;
    await this.page.evaluate(() => {
      for (const id of ['cam', 'mic']) { const b = document.getElementById(id); if (b && b.classList.contains('off')) b.click(); }
    });
    return this.waitState((s) => s.on_air, 'The broadcast did not go live. This computer may have no camera; play_video plays a file instead', 20000);
  }

  // A video file from this computer, played live into the broadcast.
  async playVideo(file) {
    this.need();
    const abs = path.resolve(String(file || ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('No video file at ' + abs + '.');
    const s = await this.state();
    if (s.prerecorded) throw new Error('A video is already playing. Call stop_video first.');
    await this.page.evaluate(() => { const b = document.getElementById('rbbtn'); if (b) b.click(); });
    const input = this.page.locator('#rb-file');
    await input.waitFor({ state: 'attached', timeout: 10000 }).catch(() => { throw new Error('This GifOS has no Rebroadcast. It needs GifOS 0.9.23b or newer.'); });
    await input.setInputFiles(abs);
    return this.waitState((st) => !!st.prerecorded, 'The video did not start', 30000);
  }

  async stopVideo() {
    this.need();
    await this.page.evaluate(() => { const b = document.getElementById('rb-stop'); if (b) b.click(); });
    return this.waitState((s) => !s.prerecorded, 'The video did not stop', 10000);
  }

  // at: epoch ms, or null to clear.
  async setStart(at) {
    this.need();
    await this.page.evaluate((ms) => {
      const el = document.getElementById('bcwhen');
      if (!el) throw new Error('This GifOS has no start time for a broadcast.');
      if (ms == null) el.value = '';
      else {
        const d = new Date(ms); const z = (n) => String(n).padStart(2, '0');
        el.value = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes());
      }
      el.dispatchEvent(new Event('change'));
    }, at == null ? null : Number(at));
    return this.state();
  }

  async setVisit(url) {
    this.need();
    await this.page.evaluate((u) => {
      const el = document.getElementById('bcvisit');
      if (!el) throw new Error('This GifOS has no Visit link for a broadcast.');
      el.value = u || '';
      el.dispatchEvent(new Event('change'));
    }, url || '');
    return this.state();
  }

  // End: the host leaves the way the End button does. Everyone watching is told.
  async end() {
    this.need();
    await this.page.evaluate(() => { const b = document.getElementById('leavebtn'); if (b) b.click(); });
    // The End question: press End on it, the way the host does.
    await this.page.waitForFunction(() => { const a = document.getElementById('leave-ask'); return a && a.style.display === 'flex'; }, null, { timeout: 10000 })
      .catch(() => { throw new Error('The End question did not open.'); });
    await this.page.evaluate(() => document.getElementById('leave-go').click());
    const s = await this.waitState((st) => st.ended, 'The broadcast did not end', 15000);
    this.ended = true;
    // The ended word rides the host's status to everyone watching; give it
    // a moment to go out before the booth closes.
    await this.page.waitForTimeout(3000);
    return s;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pool.booths.delete(this.broadcast.meeting_id);
    await this.ctx.close().catch(() => {});
  }
}
