#!/bin/bash
# Runs on a schedule (see com.cricknote.voicememowatch.plist) and feeds any
# new voice-memo transcripts to Claude Code so cricknote-voice-memo logs them
# into the vault. Meant to replace a "check every couple hours" habit that
# used to go through ChatGPT.
#
# Transcript source: Voice Memos has no Shortcuts action and no documented
# API (see discover.sh for what was checked), so for now this watches a
# plain drop folder instead of reading Voice Memos directly. After recording
# on iPhone/Watch, once it syncs and Voice Memos auto-transcribes it: open
# the recording > Share (or Copy Transcript) > save the text as a .txt file
# into DROP_FOLDER below. This script picks it up on its next run.
#
# launchd's environment is minimal (no shell profile is sourced), so PATH is
# set explicitly rather than assumed. If `which claude` or `which node` on
# your machine point somewhere else (e.g. nvm), add that directory here too.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

set -euo pipefail

DATA_DIR="${CRICKNOTE_DATA_DIR:-$HOME/.cricknote}"
DROP_FOLDER="${CRICKNOTE_VOICE_MEMO_DROP:-$HOME/Documents/CrickNote-VoiceMemoDrops}"
STATE_FILE="$DATA_DIR/voice-memo-watch.last-run"
LOG_FILE="$DATA_DIR/voice-memo-watch.log"
PROCESSED_DIR="$DROP_FOLDER/processed"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"; }

mkdir -p "$DATA_DIR" "$DROP_FOLDER" "$PROCESSED_DIR"

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
  log "first run — baseline set, nothing to process yet (drop new memo transcripts in $DROP_FOLDER)"
  exit 0
fi

NEW_FILES=()
while IFS= read -r -d '' f; do
  NEW_FILES+=("$f")
done < <(find "$DROP_FOLDER" -maxdepth 1 -type f \( -iname '*.txt' -o -iname '*.md' \) -newer "$STATE_FILE" -print0 2>/dev/null)

if [ "${#NEW_FILES[@]}" -eq 0 ]; then
  log "no new voice memos"
  touch "$STATE_FILE"
  exit 0
fi

log "found ${#NEW_FILES[@]} new voice memo file(s): ${NEW_FILES[*]}"

TRANSCRIPTS=""
for f in "${NEW_FILES[@]}"; do
  TRANSCRIPTS+=$'\n---\n'"$(cat "$f")"
done

PROMPT="New voice memo transcript(s) below, from the drop folder. Use the cricknote-voice-memo skill to log them (extract tasks, write to Memory/VoiceMemos/<date>.md).
$TRANSCRIPTS"

if ( cd "$VAULT_PATH" && claude -p "$PROMPT" >> "$LOG_FILE" 2>&1 ); then
  log "logged successfully — archiving processed file(s)"
  for f in "${NEW_FILES[@]}"; do mv "$f" "$PROCESSED_DIR/"; done
  touch "$STATE_FILE"
else
  log "claude -p failed (see output above in this log) — leaving files in place to retry next run"
  exit 1
fi
