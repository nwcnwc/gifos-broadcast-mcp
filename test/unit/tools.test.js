// The broadcast tools over a real MCP client/server pair, with the browser
// replaced: a fake Meet Bot and a fake booth pool that records what the
// booth was asked to do. test/e2e/booth.js drives the real booth.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, MeetingStore, hostKey, linkParams } from 'gifos-mcp-core';
import { createServer } from '../../src/server.js';
import { tmpHome } from './fixtures/tmp-home.js';

const HOST_PW = 'church-host-pass-77';

class FakeBot {
  constructor() { this.calls = []; this.seq = 0; }
  async ensureStarted() {}
  async join(link, password) { this.calls.push(['join', link, password]); return 'mt_' + (++this.seq); }
  async leave(id) { this.calls.push(['leave', id]); }
  async transcribe() {}
  async transcript() { return ''; }
  async info() { return { state: 'ready' }; }
  async setVoice(v) { return { applied: true, result: v }; }
}

class FakeBooths {
  constructor() { this.calls = []; this.map = new Map(); }
  get(id) { return this.map.get(id) || null; }
  async open(m, key, opts) {
    this.calls.push(['open', m.meeting_id, key.verifier, opts.hostName || null]);
    const calls = this.calls;
    const state = { open: true, on_air: false, prerecorded: null, start: 'Start time', visit: 'Visit link', ended: false };
    const b = {
      key,
      state: async () => ({ ...state }),
      goLive: async () => { calls.push(['goLive']); state.on_air = true; return { ...state }; },
      playVideo: async (p) => { calls.push(['playVideo', p]); state.prerecorded = 'Prerecorded · ' + path.basename(p); return { ...state }; },
      stopVideo: async () => { calls.push(['stopVideo']); state.prerecorded = null; return { ...state }; },
      setStart: async (at) => { calls.push(['setStart', at]); return { ...state }; },
      setVisit: async (u) => { calls.push(['setVisit', u]); return { ...state }; },
      end: async () => { calls.push(['end']); state.ended = true; return { ...state }; },
      close: async () => { calls.push(['close']); this.map.delete(m.meeting_id); },
    };
    this.map.set(m.meeting_id, b);
    return b;
  }
}

let home, bot, booths, client;
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content[0].text;
const json = (r) => JSON.parse(text(r));

beforeEach(async () => {
  home = tmpHome('gifos-bc-unit-');
  const cfg = loadConfig({ GIFOS_MCP_HOME: home, GIFOS_URL: 'http://127.0.0.1:19510/', GIFOS_BOT_NAME: 'notes-test', GIFOS_BOT_PASSWORD: 'quiet-cedar-42' });
  bot = new FakeBot();
  booths = new FakeBooths();
  const server = createServer({ cfg, meetings: new MeetingStore(home), bot, booths, botName: 'notes-test', botPassword: 'quiet-cedar-42' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'unit', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

test('the broadcast tools and the shared tools are listed, with no confirmation step', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['create_broadcast', 'join_broadcast', 'open_booth', 'go_live', 'play_video', 'stop_video', 'set_start_time',
    'set_visit_link', 'end_broadcast', 'booth_status', 'close_booth', 'wait_lines', 'say', 'get_transcript', 'schedule_meeting']) {
    assert.ok(names.includes(n), n);
  }
  for (const n of ['confirm_action', 'set_voice', 'create_meeting']) assert.equal(names.includes(n), false, n);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description && t.description.length > 30, t.name);
    assert.equal('confirm' in (t.inputSchema.properties || {}), false, t.name + ' has no confirm argument');
  }
  assert.match(tools.find((t) => t.name === 'go_live').description, /everyone watching/);
  assert.match(tools.find((t) => t.name === 'end_broadcast').description, /Ends the broadcast for everyone/);
});

test('create_broadcast returns the watch link and every invite detail, with nothing live, joined or sent', async () => {
  const r = json(await call('create_broadcast', {
    title: 'Sunday service', host_password: HOST_PW, start: '2026-10-25T10:00', timezone: 'America/Chicago',
    description: 'Live from the hall.', visit_url: 'https://example.org/give', host_name: 'Pastor Kim',
  }));
  const p = linkParams(r.watch_url);
  assert.equal(p.get('bc'), '1');
  assert.match(p.get('av'), /^[0-9a-f]{24}$/);
  assert.equal(p.get('at'), String(Date.parse('2026-10-25T15:00:00Z') / 1000));
  assert.equal(p.get('visit'), 'https://example.org/give');
  const key = await hostKey(p.get('v'), HOST_PW);
  assert.equal(p.get('av'), key.verifier, 'the link carries the verifier of this host password');
  assert.equal(r.invite.kind, 'broadcast');
  assert.equal(r.invite.start.local, '2026-10-25 10:00');
  assert.equal(r.invite.watch_url, r.watch_url);
  assert.match(r.invite.text, /Watch: /);
  const raw = JSON.stringify(r) + fs.readFileSync(path.join(home, 'meetings.json'), 'utf8');
  assert.equal(raw.includes(HOST_PW), false, 'the host password is not returned or stored');
  assert.equal(raw.includes(key.seedHex), false, 'nor is the host key');
  assert.equal(bot.calls.length + booths.calls.length, 0);
  const s = json(await call('create_broadcast', { title: 'Friday night', host_password: HOST_PW, stream: true }));
  assert.equal(linkParams(s.watch_url).get('st'), '1');
  assert.equal(s.invite.kind, 'stream');
  const bad = await call('create_broadcast', { title: 'x', host_password: HOST_PW, visit_url: 'http://example.org' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /https/);
});

test('the booth opens only with the host password the broadcast was made with, and every action is one call', async () => {
  const r = json(await call('create_broadcast', { title: 'Service', host_password: HOST_PW }));
  const wrong = await call('go_live', { meeting_id: r.meeting_id });
  assert.equal(wrong.isError, true);
  assert.match(text(wrong), /open_booth/);
  const badPw = await call('open_booth', { meeting_id: r.meeting_id, host_password: 'not-it-123' });
  assert.equal(badPw.isError, true);
  assert.match(text(badPw), /not the one/);
  assert.equal(text(badPw).includes('not-it-123'), false);
  const opened = json(await call('open_booth', { meeting_id: r.meeting_id, host_password: HOST_PW, host_name: 'Pastor Kim' }));
  assert.equal(opened.booth.open, true);
  assert.equal(JSON.stringify(opened).includes(HOST_PW), false);
  assert.equal(json(await call('go_live', { meeting_id: r.meeting_id })).booth.on_air, true);
  const vid = path.join(home, 'clip.webm'); fs.writeFileSync(vid, 'x');
  assert.match(json(await call('play_video', { meeting_id: r.meeting_id, path: vid })).booth.prerecorded, /Prerecorded/);
  json(await call('stop_video', { meeting_id: r.meeting_id }));
  const at = json(await call('set_start_time', { meeting_id: r.meeting_id, start: '2026-10-25T10:00', timezone: 'America/Chicago' }));
  assert.equal(at.start, '2026-10-25T15:00:00.000Z');
  json(await call('set_start_time', { meeting_id: r.meeting_id, start: '' }));
  assert.equal(json(await call('set_visit_link', { meeting_id: r.meeting_id, url: 'https://example.org/give' })).visit_url, 'https://example.org/give');
  assert.equal((await call('set_visit_link', { meeting_id: r.meeting_id, url: 'javascript:alert(1)' })).isError, true);
  const ended = json(await call('end_broadcast', { meeting_id: r.meeting_id }));
  assert.equal(ended.ended, true);
  assert.equal(json(await call('booth_status', { meeting_id: r.meeting_id })).booth.open, false);
  const key = await hostKey(linkParams(r.watch_url).get('v'), HOST_PW);
  assert.deepEqual(booths.calls.map((c) => c[0]), ['open', 'goLive', 'playVideo', 'stopVideo', 'setStart', 'setStart', 'setVisit', 'end', 'close']);
  assert.deepEqual(booths.calls[0], ['open', r.meeting_id, key.verifier, 'Pastor Kim']);
  assert.deepEqual(booths.calls[5], ['setStart', null]);
});

test('join_broadcast puts the note-taking bot in as a viewer; a meeting link is refused', async () => {
  const r = json(await call('create_broadcast', { title: 'Service', host_password: HOST_PW }));
  const j = json(await call('join_broadcast', { link: r.watch_url }));
  assert.equal(j.state, 'live');
  assert.equal(bot.calls[0][0], 'join');
  const notBc = await call('join_broadcast', { link: 'http://127.0.0.1:19510/run.html#v=abc' });
  assert.equal(notBc.isError, true);
  assert.match(text(notBc), /broadcast link/);
});
