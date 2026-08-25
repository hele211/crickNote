#!/bin/bash
# Read-only. Confirms (or corrects) where Voice Memos stores its recordings
# on this Mac, since watch.sh reads .m4a files from there directly rather
# than going through the app. Nothing here writes or deletes anything.
set -uo pipefail

echo "== Searching ~/Library for anything Voice-Memos-related =="
find "$HOME/Library" -maxdepth 4 -iname "*voicememo*" 2>/dev/null
echo

CANDIDATE="$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
echo "== Checking the usual Recordings path =="
echo "$CANDIDATE"
if [ -d "$CANDIDATE" ]; then
  echo "Found it. Contents:"
  ls -la "$CANDIDATE"
  echo
  COUNT=$(find "$CANDIDATE" -maxdepth 1 -iname '*.m4a' 2>/dev/null | wc -l | tr -d ' ')
  echo "$COUNT .m4a file(s) found directly in this folder."
  if [ "$COUNT" -gt 0 ]; then
    echo "This is the right path — it already matches watch.sh's default."
  else
    echo "Folder exists but no .m4a directly inside — recordings may be"
    echo "nested a level deeper, or use a different extension. Check the"
    echo "listing above and point CRICKNOTE_VOICE_MEMO_RECORDINGS at the"
    echo "real folder if it differs."
  fi
else
  echo "Not found at that exact path."
  echo "If the search above turned up a different folder, use that path"
  echo "instead — set CRICKNOTE_VOICE_MEMO_RECORDINGS to it (see README)."
fi

echo
echo "If you got 'Permission denied' anywhere above: grant Full Disk Access"
echo "to Terminal in System Settings > Privacy & Security > Full Disk"
echo "Access, then open a new Terminal window and re-run this. watch.sh"
echo "will need the same grant, but for /bin/bash — see the README."

DB="$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db"
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  echo
  echo "== Bonus: found Voice Memos' database too (not required by watch.sh,"
  echo "   which transcribes audio directly, but useful if you ever want"
  echo "   real titles/dates instead of just file timestamps) =="
  sqlite3 "$DB" ".tables" 2>/dev/null
fi
