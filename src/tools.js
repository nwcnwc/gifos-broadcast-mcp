// The tools only gifos-broadcast-mcp has: make a broadcast (with everything
// an invite needs), put the note-taking bot in it, and the booth, the
// host's own seat that goes live, plays a video, sets the start time and
// the Visit link, and ends the broadcast. Transcripts, speaking, chat and
// the join schedule are the shared tools from gifos-mcp-core.
//
// None of these asks for a confirmation: the assistant calling them decides
// what to confirm with its user. Each description says what it does.
import { z } from 'zod';
import {
  meetingIdFor, newRoom, hostKey, broadcastLink, roomFromLink, linkParams, cleanVisit, plainLink,
  broadcastInvite, parseWhen, publicView, scrub, assertNotPast,
} from 'gifos-mcp-core';

const hostPassword = z.string().min(1).max(200).describe('The host password of this broadcast. Used to hold the host key while the call runs; never stored, logged or returned.');

export function registerBroadcastTools(server, ctx) {
  const meetingId = meetingIdFor('gifos-broadcast-mcp');
  const { cfg, meetings, ok, fail, guarded, need, secrets, joinByLink } = ctx;
  const booths = ctx.booths;
  const hide = (...extra) => secrets().concat(extra.filter(Boolean));
  const withPassword = (fn) => async (args) => {
    try { return await fn(args); } catch (e) {
      return { isError: true, content: [{ type: 'text', text: scrub(String((e && e.message) || e), hide(args.host_password)) }] };
    }
  };
  const okHidden = (obj, ...extra) => ({ content: [{ type: 'text', text: scrub(JSON.stringify(obj, null, 2), hide(...extra)) }] });

  function broadcastOf(id) {
    const m = need(id);
    if (!linkParams(m.link).get('bc')) throw new Error('Meeting ' + id + ' is not a broadcast.');
    return m;
  }
  function boothOf(id) {
    const b = booths.get(id);
    if (!b) throw new Error('The booth for ' + id + ' is not open. Call open_booth with the host password first.');
    return b;
  }

  server.registerTool('create_broadcast', {
    title: 'Create a GifOS broadcast (link and invite details, no join)',
    description: 'Mints a GifOS broadcast and returns the watch link plus everything an invite needs: title, start and end with time zone, the link, the Visit link, description, how viewers get in, and who does what, as fields and as ready-to-send text. Viewers open the same link to watch; the host goes live from it with the host password. Nothing goes live, nothing joins and nothing is sent. stream makes it a "Stream to friends" broadcast. The host password is used for this call only: it is not stored, logged or returned.',
    inputSchema: {
      title: z.string().min(1).max(200).describe('The broadcast title.'),
      host_password: hostPassword,
      start: z.string().max(64).optional().describe('Start time: ISO with an offset, or a local time such as 2026-10-25T10:00 read in timezone. Early viewers see a countdown and Add to calendar.'),
      end: z.string().max(64).optional().describe('End time, same forms. Default start plus one hour.'),
      timezone: z.string().max(80).optional().describe('IANA time zone, for example America/Chicago. Default UTC.'),
      description: z.string().max(4000).optional().describe('What the broadcast is, for the invite.'),
      visit_url: z.string().max(2048).optional().describe('An https link painted on the picture and on the ended card (Visit).'),
      stream: z.boolean().optional().describe('Stream to friends: the same broadcast with friendlier words.'),
      host_name: z.string().max(80).optional().describe('Who hosts, for the invite text.'),
    },
  }, withPassword(async (args) => {
    const room = newRoom();
    const key = await hostKey(room, args.host_password);
    const zone = args.timezone || 'UTC';
    const at = args.start ? parseWhen(args.start, zone) : null;
    const visit = cleanVisit(args.visit_url || '');
    const link = plainLink(broadcastLink(cfg.gifosUrl, room, { relay: cfg.relay, verifier: key.verifier, startAt: at, visit, stream: !!args.stream }), '');
    const invite = broadcastInvite({ title: args.title, link, start: args.start, end: args.end, timezone: zone, description: args.description, visit, stream: !!args.stream, hostName: args.host_name });
    assertNotPast(invite);
    const m = meetings.add({ topic: args.title, room, link, start_time: invite.start ? invite.start.iso : null });
    return okHidden({ meeting_id: m.meeting_id, watch_url: link, invite }, args.host_password, key.seedHex);
  }));

  server.registerTool('join_broadcast', {
    title: 'The note-taking bot watches a broadcast',
    description: 'Meeting Bot opens a GifOS broadcast link as a viewer and writes down what is said on the Stage. It never goes on air. Use wait_lines or get_transcript to follow it.',
    inputSchema: {
      link: z.string().url().max(2048).describe('The GifOS broadcast link (…/run.html#v=…&bc=1).'),
      topic: z.string().max(200).optional().describe('A name for this broadcast in the local list.'),
    },
  }, guarded(async ({ link, topic }) => {
    if (!roomFromLink(link) || !linkParams(link).get('bc')) return fail('That is not a GifOS broadcast link (expected …/run.html#v=<room>&…&bc=1).');
    const { meeting, note } = await joinByLink(link, '', topic);
    return ok(note ? { ...publicView(meeting), note } : publicView(meeting));
  }));

  server.registerTool('open_booth', {
    title: 'Open the host booth for a broadcast',
    description: 'Opens the host\'s seat for this broadcast in a headless browser on this computer, off air. It holds the host key (from host_password, never stored) until close_booth or end_broadcast. While open, go_live, play_video, set_start_time, set_visit_link and end_broadcast work. Opening does not go live.',
    inputSchema: {
      meeting_id: meetingId.optional(),
      link: z.string().url().max(2048).optional().describe('A broadcast link not made here. Give meeting_id or link.'),
      host_password: hostPassword,
      host_name: z.string().max(80).optional().describe('The name viewers see for the host. Default Host.'),
    },
  }, withPassword(async ({ meeting_id, link, host_password, host_name }) => {
    let m;
    if (meeting_id) m = broadcastOf(meeting_id);
    else if (link) {
      const room = roomFromLink(link);
      if (!room || !linkParams(link).get('bc')) throw new Error('That is not a GifOS broadcast link.');
      m = meetings.byRoom(room) || meetings.add({ topic: '', room, link: plainLink(link, '') });
    } else throw new Error('Give meeting_id or link.');
    const key = await hostKey(m.room, host_password);
    if (linkParams(m.link).get('av') !== key.verifier) throw new Error('That host password is not the one this broadcast was made with.');
    const booth = await booths.open(m, key, { hostName: host_name });
    return okHidden({ meeting_id: m.meeting_id, booth: await booth.state() }, host_password, key.seedHex);
  }));

  server.registerTool('go_live', {
    title: 'Go live',
    description: 'Starts the live broadcast: the booth turns the host camera and microphone on, and everyone watching sees and hears the host from this computer. Needs a camera on this computer (or GIFOS_BOOTH_CAMERA_FILE); without one, use play_video.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => ok({ meeting_id, booth: await boothOf(meeting_id).goLive() })));

  server.registerTool('play_video', {
    title: 'Play a video live into the broadcast',
    description: 'Plays a video file from this computer live into the broadcast for everyone watching, now. Viewers see a Prerecorded mark and cannot skip or save it. One video at a time; stop_video stops it.',
    inputSchema: {
      meeting_id: meetingId,
      path: z.string().min(1).max(4096).describe('Path to a video file on this computer (for example .mp4 or .webm).'),
    },
  }, guarded(async ({ meeting_id, path: file }) => ok({ meeting_id, booth: await boothOf(meeting_id).playVideo(file) })));

  server.registerTool('stop_video', {
    title: 'Stop the video',
    description: 'Stops the video play_video started. The broadcast stays open.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => ok({ meeting_id, booth: await boothOf(meeting_id).stopVideo() })));

  server.registerTool('set_start_time', {
    title: 'Set when the broadcast starts',
    description: 'Sets the start time viewers see before the broadcast: a countdown and Add to calendar. Pass an empty start to clear it. Needs the open booth.',
    inputSchema: {
      meeting_id: meetingId,
      start: z.string().max(64).describe('ISO with an offset, a local time read in timezone, or empty to clear.'),
      timezone: z.string().max(80).optional().describe('IANA time zone, for example America/Chicago. Default UTC.'),
    },
  }, guarded(async ({ meeting_id, start, timezone }) => {
    const at = start ? parseWhen(start, timezone || 'UTC') : null;
    return ok({ meeting_id, start: at == null ? null : new Date(at).toISOString(), booth: await boothOf(meeting_id).setStart(at) });
  }));

  server.registerTool('set_visit_link', {
    title: 'Set the Visit link',
    description: 'Sets the https link every viewer sees on the picture and on the ended card (Visit). Pass an empty url to clear it. Needs the open booth.',
    inputSchema: {
      meeting_id: meetingId,
      url: z.string().max(2048).describe('An https URL, or empty to clear.'),
    },
  }, guarded(async ({ meeting_id, url }) => {
    const visit = cleanVisit(url || '');
    return ok({ meeting_id, visit_url: visit || null, booth: await boothOf(meeting_id).setVisit(visit) });
  }));

  server.registerTool('end_broadcast', {
    title: 'End the broadcast',
    description: 'Ends the broadcast for everyone: the host leaves the way the End button does, viewers are told it ended, and the booth closes. The note-taking bot, if it is watching, stays until end_meeting.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const booth = boothOf(meeting_id);
    const st = await booth.end();
    await booth.close();
    return ok({ meeting_id, ended: true, booth: st });
  }));

  server.registerTool('booth_status', {
    title: 'What the booth shows',
    description: 'Read-only: whether the booth is open, on air, playing a video, how many are watching, the start time and the Visit link as the host page shows them.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const b = booths.get(meeting_id);
    return ok({ meeting_id, booth: b ? await b.state() : { open: false } });
  }));

  server.registerTool('close_booth', {
    title: 'Close the booth without ending',
    description: 'Closes the host seat on this computer without the End step. If the host was live, viewers see the host leave. Use end_broadcast to end it for everyone.',
    inputSchema: { meeting_id: meetingId },
  }, guarded(async ({ meeting_id }) => {
    const b = booths.get(meeting_id);
    if (b) await b.close();
    return ok({ meeting_id, closed: true });
  }));
}
