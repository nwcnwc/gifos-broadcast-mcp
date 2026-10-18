---
name: gifos-broadcast
description: >-
  Make GifOS broadcasts (a service, a stream to friends) with everything an invite needs, run the host booth
  (go live, play a video live, set the start time and the Visit link, end the broadcast), and follow what is
  said with a note-taking bot. Use when the user wants to set up, announce, schedule, go live with, play a
  recording into, or end a GifOS broadcast or livestream.
metadata:
  author: GifOS
  short-description: GifOS broadcasts, invites, the host booth and live notes
---

# GifOS Broadcast

The `gifos-broadcast` MCP server runs on the user's own computer. **You are the brain**: there is no model
inside the server, and the tools do exactly what they say, with no confirmation step of their own. Before an
action that viewers will see or hear (`go_live`, `play_video`, `end_broadcast`), confirm with the user when it
is not clearly what they asked for.

## Make a broadcast (no join, nothing live, nothing sent)

1. `create_broadcast` with `title`, the user's `host_password`, and when known `start`, `end`, `timezone`
   (IANA), `description`, `visit_url` (https) and `host_name`. `stream: true` makes it "Stream to friends".
2. The result has `watch_url` and `invite`: `title`, start and end with time zone, the link, Visit, `admit`,
   `roles`, ready-to-send `text`, `calendar` fields. Viewers who open the link early see a countdown and Add
   to calendar; anyone who opens it after it ends reads that it ended.
3. **You send the invite** with the user's own mail, calendar or social connector, after the user approves.
   The server never sends anything and never writes a calendar file. The host password is never in an invite.

## Run the broadcast from this computer (the booth)

- `open_booth` with the `host_password`: the host's seat opens off air.
- `go_live`: the host camera and microphone of this computer go out to everyone watching.
- `play_video` with a file path: a video plays live into the broadcast; viewers see Prerecorded.
  `stop_video` stops it.
- `set_start_time`, `set_visit_link`: change what viewers see.
- `end_broadcast`: ends it for everyone and closes the booth. `booth_status` reads the state.

If the user goes live from their own phone or computer instead, they open the same link with the host
password; you can still make links, set nothing in the booth, and follow along with the bot.

## How the bot looks

- The operator may set its name and picture (`GIFOS_BOT_NAME`, `GIFOS_BOT_PICTURE`). If the user asks for another
  name or picture, call `set_bot_profile` with `name` and/or `picture_path` (a GIF, PNG, JPEG or WebP file, at most
  256 KB) before the bot joins; a new name is refused while the bot is in a room.

## Follow what is said

- `join_broadcast` with the link: Meet Bot watches as a viewer and writes down what is said on the Stage.
- Loop on `wait_lines` (pass `next` back as `since`) for new lines as they land; `get_transcript` after.
- `send_chat` posts in the broadcast chat as the bot. `end_meeting` takes the bot out.
