#!/usr/bin/env node
// End to end: this server over stdio runs a broadcast's host booth on a
// real GifOS 0.9.23b site, a separate headless browser watches as a viewer,
// and Meeting Bot watches too and writes down what the host says. Each
// check reads what the viewer's own page, or the bot's lines, show.
//
//   GIFOS_APP_DIR=../gifos-app MEETING_BOT_SRC=../gifos-apps-source/meeting-bot \
//   E2E_RELAY=wss://your-gifos-0.9.23b-relay E2E_VIDEO=/path/clip.webm npm run test:e2e
//
// The GifOS checkout is served on 127.0.0.1:E2E_SITE_PORT (19512) with
// Meeting Bot and two tiny speech apps added to its store (nothing is
// written into the checkout). The booth uses Chromium's test camera and a
// noise file as its microphone. Screenshots go to E2E_PROOF_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchInstalled } from 'gifos-mcp-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packApp, startSite } from './site.js';
import { SYNTH_LINE, SYNTH_STT, SYNTH_TTS } from './synth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_DIR = process.env.GIFOS_APP_DIR ? path.resolve(process.env.GIFOS_APP_DIR) : '';
const BOT_SRC = process.env.MEETING_BOT_SRC ? path.resolve(process.env.MEETING_BOT_SRC) : '';
const SITE_PORT = Number(process.env.E2E_SITE_PORT || 19512);
const SITE = 'http://127.0.0.1:' + SITE_PORT;
const RELAY = String(process.env.E2E_RELAY || '');
const VIDEO = process.env.E2E_VIDEO ? path.resolve(process.env.E2E_VIDEO) : '';
const PROOF = path.resolve(process.env.E2E_PROOF_DIR || path.join(REPO, '.e2e', 'proof'));
const HOST_PW = 'booth-e2e-' + Math.random().toString(36).slice(2, 10);
const t0 = Date.now();
const say = (s) => process.stdout.write(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's ' + s + '\n');
let failed = 0;
function check(name, ok, detail) {
  say((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  (' + String(detail).slice(0, 300) + ')' : ''));
  if (!ok) failed++;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); }
  return v;
}

if (!SITE_DIR || !BOT_SRC || !RELAY || !VIDEO) {
  console.error('Set GIFOS_APP_DIR, MEETING_BOT_SRC, E2E_RELAY and E2E_VIDEO.');
  process.exit(2);
}
fs.mkdirSync(PROOF, { recursive: true });
const home = fs.mkdtempSync(path.join(os.homedir(), '.gifos-bc-e2e-'));
let viewerBrowser = null;
let client = null;
let site = null;

// Two seconds of a loud tone with noise, then quiet: the synthetic speech app hears it as SYNTH_LINE.
function noiseWav(dest) {
  const rate = 44100, loud = rate * 2, quiet = Math.floor(rate * 1.2);
  const data = Buffer.alloc((loud + quiet) * 2);
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 0x100000000) * 2 - 1; };
  for (let i = 0; i < loud; i++) data.writeInt16LE((Math.max(-1, Math.min(1, 0.55 * Math.sin(2 * Math.PI * 440 * i / rate) + 0.4 * rnd())) * 32767) | 0, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(dest, Buffer.concat([h, data]));
}

try {
  const logo = fs.readFileSync(path.join(REPO, 'assets', 'logo-512.png'));
  const extra = [{ slug: 'meeting-bot', ...(await packApp(BOT_SRC, SITE_DIR, ['manifest.json', 'index.html', 'app.js', 'protocol.js', 'voice.js', 'help.md', 'CONTROL.md', 'listing.json'])), cover: logo }];
  for (const [slug, files] of [['stt-synthetic', SYNTH_STT], ['tts-synthetic', SYNTH_TTS]]) {
    const dir = path.join(home, slug);
    fs.mkdirSync(dir);
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
    extra.push({ slug, ...(await packApp(dir, SITE_DIR, ['manifest.json', 'index.html'])), cover: logo });
  }
  site = await startSite({ siteDir: SITE_DIR, port: SITE_PORT, extraApps: extra });
  const noise = path.join(home, 'noise.wav');
  noiseWav(noise);
  say('site ' + SITE + ' from ' + path.basename(SITE_DIR) + '; relay ' + RELAY);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'bin', 'gifos-broadcast-mcp.js')],
    env: {
      ...process.env, GIFOS_URL: SITE, GIFOS_RELAY: RELAY, GIFOS_MCP_HOME: home, GIFOS_MCP_LAZY: '1',
      GIFOS_STT_APP: 'stt-synthetic', GIFOS_TTS_APP: 'tts-synthetic', GIFOS_BOOTH_FAKE_MEDIA: '1', GIFOS_BOOTH_AUDIO_FILE: noise,
    },
    stderr: 'pipe',
  });
  transport.stderr.on('data', (d) => process.stdout.write('        ' + String(d).trim().replace(/\n/g, '\n        ') + '\n'));
  client = new Client({ name: 'booth-e2e', version: '1' });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 120000 });
    if (r.isError) throw new Error(name + ': ' + r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  const startAt = new Date(Date.now() + 2 * 3600 * 1000 + 5 * 60 * 1000).toISOString();
  const made = await call('create_broadcast', { title: 'Booth test', host_password: HOST_PW, start: startAt, visit_url: 'https://example.org/visit' });
  check('create_broadcast gives a watch link with the start and Visit', /bc=1/.test(made.watch_url) && /at=\d+/.test(made.watch_url) && /visit=/.test(made.watch_url), made.watch_url);

  // A viewer early: the link alone says when it starts.
  viewerBrowser = (await launchInstalled((o) => chromium.launch(o), { args: ['--autoplay-policy=no-user-gesture-required'] }, {})).browser;
  const vctx = await viewerBrowser.newContext({ viewport: { width: 1280, height: 720 } });
  await vctx.addInitScript(() => { localStorage.setItem('gifos_name', 'Ruth'); sessionStorage.setItem('gifos_appeared', '1'); });
  const viewer = await vctx.newPage();
  await viewer.goto(made.watch_url + '&debug=on', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const early = await until(() => viewer.evaluate(() => { const e = document.getElementById('bc-ended'); const t = document.getElementById('bc-ended-txt'); return e && !e.hidden && /starts/.test(t.textContent) ? t.textContent : ''; }), 30000);
  check('an early viewer reads when it starts, with a countdown', /starts .+ in 2 h/.test(early || ''), early);
  await viewer.screenshot({ path: path.join(PROOF, 'viewer-early.png') });

  const opened = await call('open_booth', { meeting_id: made.meeting_id, host_password: HOST_PW, host_name: 'Pastor Kim' });
  check('open_booth: the booth is the host, off air', opened.booth.host === true && opened.booth.on_air === false, JSON.stringify(opened.booth));

  const viewerBadge = () => viewer.evaluate(() => (document.getElementById('livebadge') || {}).dataset.state || '');
  check('before go_live the viewer is not watching anyone live', (await viewerBadge()) !== 'watching', await viewerBadge());
  const live = await call('go_live', { meeting_id: made.meeting_id });
  check('go_live: the booth is on air', live.booth.on_air === true, JSON.stringify(live.booth));
  const badge = await until(async () => { const st = await call('booth_status', { meeting_id: made.meeting_id }); return st.booth.badge === 'live' ? st.booth : null; }, 10000);
  check('the host page\'s badge says LIVE', !!badge, badge ? badge.badge : 'still ' + (await call('booth_status', { meeting_id: made.meeting_id })).booth.badge);
  const picture = await until(() => viewer.evaluate(() => [...document.querySelectorAll('#stagefeed video, #feed video')].some((v) => v.videoWidth > 0 && !v.paused)), 60000);
  const watching = await until(async () => ((await viewerBadge()) === 'watching' ? 'watching' : ''), 30000);
  check('the viewer sees the host\'s live picture and reads WATCHING', !!picture && !!watching, await viewerBadge());
  await viewer.screenshot({ path: path.join(PROOF, 'viewer-live.png') });

  // Meeting Bot watches the broadcast and writes down the host.
  const bot = await call('join_broadcast', { link: made.watch_url, topic: 'Booth test' });
  check('join_broadcast: Meeting Bot watches the broadcast', bot.state === 'live' && bot.transcribing, JSON.stringify(bot));
  let heard = null;
  let since = 0;
  const hearEnd = Date.now() + 120000;
  while (!heard && Date.now() < hearEnd) {
    const w = await call('wait_lines', { meeting_id: bot.meeting_id, since, timeout_ms: 20000, kinds: ['speech'] });
    since = w.next;
    heard = w.lines.find((l) => l.speaker === 'Pastor Kim' && l.text === SYNTH_LINE) || null;
  }
  check('wait_lines returns what the host said, credited to the host', !!heard, heard ? JSON.stringify(heard) : 'no host line in 120 s');
  const tr = await client.callTool({ name: 'get_transcript', arguments: { meeting_id: bot.meeting_id } });
  check('get_transcript has the host\'s line', new RegExp('^Pastor Kim: ' + SYNTH_LINE.replace('?', '\\?'), 'm').test(tr.content[0].text), tr.content[0].text.slice(0, 200));

  const played = await call('play_video', { meeting_id: made.meeting_id, path: VIDEO });
  check('play_video: the booth plays the file', /Prerecorded/.test(played.booth.prerecorded || ''), played.booth.prerecorded);
  const pre = await until(() => viewer.evaluate(() => { const b = document.getElementById('livebadge'); const p = document.getElementById('bc-pre'); return (b && b.dataset.state === 'pre') || (p && !p.hidden) ? (b && b.textContent) || 'pre' : ''; }), 30000);
  check('the viewer sees Prerecorded', !!pre, pre);
  await viewer.screenshot({ path: path.join(PROOF, 'viewer-prerecorded.png') });

  const stopped = await call('stop_video', { meeting_id: made.meeting_id });
  check('stop_video: the video stops', !stopped.booth.prerecorded, JSON.stringify(stopped.booth));

  const ended = await call('end_broadcast', { meeting_id: made.meeting_id });
  check('end_broadcast: the booth ends it and closes', ended.ended === true, JSON.stringify(ended.booth));
  const over = await until(() => viewer.evaluate(() => { const e = document.getElementById('bc-ended'); const t = document.getElementById('bc-ended-txt'); return e && !e.hidden && /ended/.test(t.textContent) ? t.textContent : ''; }), 30000);
  check('the viewer reads that the broadcast has ended', /ended/.test(over || ''), over || (await viewer.evaluate(() => (document.getElementById('status') || {}).textContent)));
  await viewer.screenshot({ path: path.join(PROOF, 'viewer-ended.png') });
  const left = await call('end_meeting', { meeting_id: bot.meeting_id });
  check('end_meeting takes the bot out and keeps its transcript', left.state === 'ended' && left.transcript_lines > 0, JSON.stringify(left));
} catch (e) {
  check('the run finished', false, (e && e.stack) || e);
} finally {
  if (client) await client.close().catch(() => {});
  if (viewerBrowser) await viewerBrowser.close().catch(() => {});
  if (site && site.close) { try { await site.close(); } catch (e) { /* already closed */ } }
  fs.rmSync(home, { recursive: true, force: true });
}
say(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
