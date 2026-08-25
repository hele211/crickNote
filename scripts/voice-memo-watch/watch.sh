#!/bin/bash
# Runs on a schedule (see com.cricknote.voicememowatch.plist) and feeds any
# new voice memos to Claude Code so cricknote-voice-memo logs them into the
# vault. Meant to replace a "check every couple hours" habit that used to go
# through ChatGPT.
#
# Audio source: Voice Memos has no Shortcuts action and no documented API
# (see discover.sh for what was checked), so this doesn't call into the app
# itself. Instead it reads straight from where Voice Memos already stores
# its recordings on disk — since Voice Memos syncs via iCloud, a memo
# recorded on iPhone/Watch should show up there with no action on your part.
# RECORDINGS_DIR below is a best guess (Apple doesn't document this path);
# run discover.sh first to confirm it, or fix it if it's wrong.
#
# A second, manually-fed DROP_FOLDER also exists alongside it, for audio (or
# already-transcribed text) you want to hand over some other way.
#
# Transcription is local: nothing here calls any external API. Requires a
# whisper CLI on PATH — see check_whisper() below for what's supported.
#
# launchd's environment is minimal (no shell profile is sourced), so PATH is
# set explicitly rather than assumed. If `which claude`/`node`/`whisper`/
# `ffmpeg` on your machine point somewhere else (e.g. nvm, pipx), add that
# directory here too.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

set -euo pipefail

DATA_DIR="${CRICKNOTE_DATA_DIR:-$HOME/.cricknote}"
RECORDINGS_DIR="${CRICKNOTE_VOICE_MEMO_RECORDINGS:-$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings}"
DROP_FOLDER="${CRICKNOTE_VOICE_MEMO_DROP:-$HOME/Documents/CrickNote-VoiceMemoDrops}"
STATE_FILE="$DATA_DIR/voice-memo-watch.last-run"
LOG_FILE="$DATA_DIR/voice-memo-watch.log"
WHISPER_MODEL="${WHISPER_MODEL:-base}"
SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cricknote-voice-memo.XXXXXX")"
PROCESSED_DIR="$DROP_FOLDER/processed"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"; }
cleanup() { rm -rf "$SCRATCH_DIR"; }
trap cleanup EXIT

mkdir -p "$DATA_DIR" "$DROP_FOLDER" "$PROCESSED_DIR"

# --- whisper detection -------------------------------------------------
# Only openai-whisper's `whisper` CLI is auto-wired, since its interface
# (flags, model download, ffmpeg-based decoding) is stable and documented.
# whisper.cpp works too but its installed binary name varies by version —
# if that's what you have, tell Claude the exact command and this branch
# can be filled in.
transcribe_audio() {
  local audio_file="$1" text=""
  if command -v whisper >/dev/null 2>&1; then
    if ! command -v ffmpeg >/dev/null 2>&1; then
      log "ERROR: 'whisper' found but 'ffmpeg' is not on PATH (openai-whisper needs it to decode .m4a). Install with 'brew install ffmpeg'."
      return 1
    fi
    local base out
    base="$(basename "$audio_file")"; base="${base%.*}"
    if ! whisper "$audio_file" --model "$WHISPER_MODEL" --output_format txt --output_dir "$SCRATCH_DIR" < /dev/null >> "$LOG_FILE" 2>&1; then
      log "ERROR: whisper transcription failed for $audio_file"
      return 1
    fi
    out="$SCRATCH_DIR/$base.txt"
    [ -f "$out" ] && text="$(cat "$out")"
  else
    log "ERROR: no whisper CLI found on PATH. Install openai-whisper: 'pip install -U openai-whisper' plus 'brew install ffmpeg'. (whisper.cpp also works but needs a manual wire-up — see comment above transcribe_audio in this script.)"
    return 1
  fi
  printf '%s' "$text"
}

# Resolve the vault path from CrickNote's own config so it isn't duplicated
# here — falls back to CRICKNOTE_VAULT_PATH if set, for a manual override.
VAULT_PATH="${CRICKNOTE_VAULT_PATH:-}"
if [ -z "$VAULT_PATH" ]; then
  VAULT_PATH="$(node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    if (cfg.vaultPath) process.stdout.write(cfg.vaultPath);
  " "$DATA_DIR/config.json" 2>/dev/null || true)"
fi
if [ -z "$VAULT_PATH" ] || [ ! -d "$VAULT_PATH" ]; then
  log "ERROR: no valid vault path (checked CRICKNOTE_VAULT_PATH and $DATA_DIR/config.json). Run 'cricknote setup' first."
  exit 1
fi

if [ ! -f "$STATE_FILE" ]; then
  touch "$STATE_FILE"
  log "first run — baseline set, nothing to process yet"
  exit 0
fi

# --- collect new files ---------------------------------------------------
# RECORDINGS_DIR is Voice Memos' own storage: read-only, always — never move
# or delete anything there, since its database references those files and
# this script has no business touching another app's data store. DROP_FOLDER
# is ours, so processed files get archived out of the way there.
#
# -mmin +5 skips anything touched in the last 5 minutes, in case a recording
# is still mid-sync from iCloud when this happens to run.
AUDIO_FILES=()
if [ -d "$RECORDINGS_DIR" ]; then
  while IFS= read -r -d '' f; do
    AUDIO_FILES+=("$f")
  done < <(find "$RECORDINGS_DIR" -maxdepth 1 -type f \( -iname '*.m4a' -o -iname '*.caf' \) -newer "$STATE_FILE" -mmin +5 -print0 2>/dev/null)
else
  log "NOTE: RECORDINGS_DIR not found at '$RECORDINGS_DIR' — skipping it this run, using DROP_FOLDER only. Run discover.sh to find the real path."
fi

DROP_AUDIO=()
DROP_TEXT=()
while IFS= read -r -d '' f; do
  DROP_AUDIO+=("$f")
done < <(find "$DROP_FOLDER" -maxdepth 1 -type f \( -iname '*.m4a' -o -iname '*.caf' -o -iname '*.wav' -o -iname '*.mp3' \) -newer "$STATE_FILE" -print0 2>/dev/null)
while IFS= read -r -d '' f; do
  DROP_TEXT+=("$f")
done < <(find "$DROP_FOLDER" -maxdepth 1 -type f \( -iname '*.txt' -o -iname '*.md' \) -newer "$STATE_FILE" -print0 2>/dev/null)

TOTAL=$(( ${#AUDIO_FILES[@]} + ${#DROP_AUDIO[@]} + ${#DROP_TEXT[@]} ))
if [ "$TOTAL" -eq 0 ]; then
  log "no new voice memos"
  touch "$STATE_FILE"
  exit 0
fi
log "found $TOTAL new voice memo file(s): synced=${#AUDIO_FILES[@]} drop-audio=${#DROP_AUDIO[@]} drop-text=${#DROP_TEXT[@]}"

# --- transcribe ------------------------------------------------------------
TRANSCRIPTS=""
FAILED=0

for f in "${AUDIO_FILES[@]}" "${DROP_AUDIO[@]}"; do
  text="$(transcribe_audio "$f")" || { FAILED=1; continue; }
  [ -n "$text" ] && TRANSCRIPTS+=$'\n---\n'"$text"
done
for f in "${DROP_TEXT[@]}"; do
  TRANSCRIPTS+=$'\n---\n'"$(cat "$f")"
done

if [ -z "$TRANSCRIPTS" ]; then
  log "nothing transcribed successfully this run — see errors above, will retry next run"
  exit 1
fi

PROMPT="New voice memo transcript(s) below (transcribed locally with whisper). Use the cricknote-voice-memo skill to log them (extract tasks, write to Memory/VoiceMemos/<date>.md).
$TRANSCRIPTS"

if ( cd "$VAULT_PATH" && claude -p "$PROMPT" < /dev/null >> "$LOG_FILE" 2>&1 ); then
  log "logged successfully"
  for f in "${DROP_AUDIO[@]}" "${DROP_TEXT[@]}"; do mv "$f" "$PROCESSED_DIR/"; done
  if [ "$FAILED" -eq 0 ]; then
    touch "$STATE_FILE"
  else
    log "NOTE: not advancing state file — at least one file failed to transcribe and will be retried next run"
  fi
else
  log "claude -p failed (see output above in this log) — not advancing state, will retry next run"
  exit 1
fi
