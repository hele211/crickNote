# Voice memo watch (macOS)

Replaces a "check every couple of hours" habit that used to run through
ChatGPT: on a schedule, transcribe any new voice memos locally and hand the
text to Claude Code so `cricknote-voice-memo` logs them into the vault —
unattended, and nothing leaves your machine for the transcription step.

This lives outside `cricknote`'s own source — it's a personal automation you
install on your Mac, since it needs to reach both your Voice Memos and your
vault, neither of which this repo has access to.

## What's here

- `watch.sh` — the driver. Finds new recordings, transcribes them locally
  with `whisper`, hands the text to `claude -p` to log via the
  `cricknote-voice-memo` skill, and archives what it processed.
- `discover.sh` — read-only. Confirms where Voice Memos actually stores
  recordings on your Mac (the path is a well-known but undocumented
  default — this checks it rather than assuming it).
- `com.cricknote.voicememowatch.plist` — a `launchd` agent that runs
  `watch.sh` every 2 hours.

## How memos reach it

`watch.sh` reads two places, so it works whether or not the automatic path
below pans out:

1. **Automatic**: Voice Memos syncs recordings via iCloud, so one made on
   your iPhone or Watch should show up locally in
   `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/`
   on its own — no action needed. This path is a well-known default, not
   something Apple documents, so run `bash discover.sh` first to confirm it
   (or find the real one) before relying on it. If it's different, set
   `CRICKNOTE_VOICE_MEMO_RECORDINGS` to the real path.
2. **Manual drop folder** (`~/Documents/CrickNote-VoiceMemoDrops` by
   default): drop an audio file (or already-transcribed text) here yourself
   — for a memo from somewhere else, or if the automatic path above doesn't
   work out for you. Processed files get moved to a `processed/`
   subfolder afterward. (Files picked up from Voice Memos' own folder are
   never moved or touched — only read — since that folder belongs to the
   app, not this script.)

Transcription is local via [`whisper`](https://github.com/openai/whisper)
(the `openai-whisper` package) — nothing here calls an external API for it.
Install it if you don't have it: `pip install -U openai-whisper` and
`brew install ffmpeg` (whisper shells out to ffmpeg to decode `.m4a`). If you
use whisper.cpp instead, `watch.sh`'s `transcribe_audio()` function has a
comment marking where to wire it in — its binary name varies by
install/version, so it isn't auto-detected.

## Setup

**0. Prerequisites** — `cricknote setup` already run for this vault, the
`claude` CLI installed and logged in, and `whisper`/`ffmpeg` installed (see
above).

**1. Let Claude actually run unattended.** In non-interactive mode (`-p`),
a tool call with no matching permission rule is silently denied rather than
prompting you — so without this step, `watch.sh` will run but nothing will
actually get written. Add to `<your vault>/.claude/settings.local.json`
(create it if it doesn't exist):

```json
{
  "permissions": {
    "allow": [
      "Bash(cricknote tool:*)",
      "Bash(cricknote reindex)"
    ]
  }
}
```

This scopes the automation to exactly the two commands this workflow needs.
Deliberately not using `--dangerously-skip-permissions` on the `claude -p`
call itself — that would let an unattended session run *any* command, and
the input driving it (a phone recording) isn't something to fully trust
with no one watching. Scoped like this, the worst case is still contained to
`cricknote`'s own vault-boundary checks.

If a rule here doesn't match and it still prompts (or silently no-ops),
check `claude config`/current docs for the permission-rule syntax — this is
the one thing here that's Claude Code version-dependent rather than
Apple-version-dependent.

**2. Confirm where your recordings actually are:**

```bash
bash discover.sh
```

It tells you whether the default path has your `.m4a` files, or gives you
the real one to set via `CRICKNOTE_VOICE_MEMO_RECORDINGS`.

**3. Test manually before automating:**

```bash
bash watch.sh   # first run just sets a baseline and exits — that's expected
# record a test memo (or drop an audio/text file into the drop folder), then:
bash watch.sh   # should transcribe it, log it via Claude Code, and archive it
cat ~/.cricknote/voice-memo-watch.log
```

If `claude`, `whisper`, `ffmpeg`, or `node` aren't found, check `which
<tool>` in your normal Terminal and add those directories to the `PATH` line
near the top of `watch.sh` — `launchd` doesn't source your shell profile, so
anything set up there (nvm, pyenv, a custom Homebrew prefix, etc.) needs to
be listed explicitly.

**4. Install the scheduled job** once step 3 works cleanly:

```bash
cp com.cricknote.voicememowatch.plist ~/Library/LaunchAgents/
# edit the copy: replace REPLACE/WITH/ABSOLUTE/PATH/TO/watch.sh with the
# real absolute path to your watch.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cricknote.voicememowatch.plist
```

To stop it: `launchctl bootout gui/$(id -u)/com.cricknote.voicememowatch`.

## Troubleshooting

- Everything the script does is logged to `~/.cricknote/voice-memo-watch.log`
  — check there first. A failed transcription or a failed `claude -p` call
  leaves the source file in place and doesn't advance the run marker, so
  it's retried next run rather than silently dropped.
- "Permission denied" reading anything under `~/Library`: grant Full Disk
  Access to `/bin/bash` specifically (System Settings > Privacy & Security >
  Full Disk Access > + > press Cmd+Shift+G and type `/bin/bash`) — Terminal
  having access doesn't cover the `launchd`-run script, since they're
  different executables as far as macOS's privacy permissions are concerned.
- Nothing happens on schedule but manual runs work: almost always PATH —
  see step 3 above.
