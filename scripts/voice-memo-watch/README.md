# Voice memo watch (macOS)

Replaces a "check every couple of hours" habit that used to run through
ChatGPT: on a schedule, hand any new voice-memo transcripts to Claude Code so
`cricknote-voice-memo` logs them into the vault, unattended.

This lives outside `cricknote`'s own source — it's a personal automation you
install on your Mac, since it needs to reach both your Voice Memos and your
vault, neither of which this repo has access to.

## What's here

- `watch.sh` — the driver. Checks a drop folder for new transcript files,
  hands any it finds to `claude -p` to log via the `cricknote-voice-memo`
  skill, archives what it processed.
- `discover.sh` — read-only. Looks for Voice Memos' local database so the
  drop-folder step below can eventually be automated away too.
- `com.cricknote.voicememowatch.plist` — a `launchd` agent that runs
  `watch.sh` every 2 hours.

## Why a drop folder, not full automation

Voice Memos has no Shortcuts action on at least the machine this was built
for (checked directly — nothing under "voice memo" in the actions list), and
there's no other documented API for reading a transcript out of it. The only
other route is Voice Memos' own local database, which is undocumented,
unsupported, and can change on any macOS update — not something to wire up
on a guess.

So for now: after a memo syncs and Voice Memos auto-transcribes it (on
iPhone/Watch recordings, this happens on-device, no extra step needed),
open the recording in Voice Memos, use Share (or Copy Transcript), and save
the text as a `.txt` file into the drop folder
(`~/Documents/CrickNote-VoiceMemoDrops` by default). `watch.sh` picks it up
on its next run. It's a few seconds of manual work per memo instead of zero.

If you want to chase full automation instead: run `bash discover.sh` and
share its output — if it finds a usable schema, `watch.sh`'s drop-folder
check can be replaced with a real query.

## Setup

**0. Prerequisites** — `cricknote setup` already run for this vault, and the
`claude` CLI installed and logged in (`claude` works from a normal Terminal
prompt).

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
the input driving it (a phone transcript) isn't something to fully trust
with no one watching. Scoped like this, the worst case is still contained to
`cricknote`'s own vault-boundary checks.

If a rule here doesn't match and it still prompts (or silently no-ops),
check `claude config`/current docs for the permission-rule syntax — this is
the one thing here that's Claude Code version-dependent rather than
Apple-version-dependent.

**2. Create the drop folder and test manually before automating:**

```bash
mkdir -p ~/Documents/CrickNote-VoiceMemoDrops
bash watch.sh   # first run just sets a baseline and exits — that's expected
# drop a test .txt transcript into the folder, then:
bash watch.sh   # should log it via Claude Code and archive the file
cat ~/.cricknote/voice-memo-watch.log
```

If `claude` or `node` aren't found, check `which claude` and `which node` in
your normal Terminal and add those directories to the `PATH` line near the
top of `watch.sh` — `launchd` doesn't source your shell profile, so anything
set up there (nvm, a custom Homebrew prefix, etc.) needs to be listed
explicitly.

**3. Install the scheduled job** once step 2 works cleanly:

```bash
cp com.cricknote.voicememowatch.plist ~/Library/LaunchAgents/
# edit the copy: replace REPLACE/WITH/ABSOLUTE/PATH/TO/watch.sh with the
# real absolute path to your watch.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cricknote.voicememowatch.plist
```

To stop it: `launchctl bootout gui/$(id -u)/com.cricknote.voicememowatch`.

## Troubleshooting

- Everything the script does is logged to `~/.cricknote/voice-memo-watch.log`
  — check there first.
- "Permission denied" reading anything under `~/Library`: grant Full Disk
  Access to Terminal (System Settings > Privacy & Security), open a new
  Terminal window, retry.
- Nothing happens on schedule but manual runs work: almost always PATH —
  see step 2 above.
