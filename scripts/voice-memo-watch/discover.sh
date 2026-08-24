#!/bin/bash
# Read-only. Locates Voice Memos' local storage on this Mac and dumps its
# database schema, so a fully-automatic export path can be wired up later.
#
# Why this exists: Shortcuts.app has no Voice Memo actions on at least some
# machines (confirmed on the machine this was written for), so there is no
# documented, supported way to pull a transcript out of Voice Memos
# automatically. The only remaining option is Voice Memos' own local
# database, which is undocumented and can change between macOS versions —
# this script just looks at what's actually there instead of guessing.
#
# Nothing here writes or deletes anything.
set -uo pipefail

echo "== Searching ~/Library for anything Voice-Memos-related =="
find "$HOME/Library" -maxdepth 4 -iname "*voicememo*" 2>/dev/null
echo

CANDIDATE="$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db"
echo "== Checking the usual path =="
echo "$CANDIDATE"
if [ -f "$CANDIDATE" ]; then
  echo "Found it."
  echo
  echo "-- tables --"
  sqlite3 "$CANDIDATE" ".tables"
  echo
  echo "-- full schema (look for anything transcript/title/date-shaped) --"
  sqlite3 "$CANDIDATE" ".schema"
else
  echo "Not found at that exact path."
  echo "If the search above turned up a different .db file, re-run this"
  echo "script's sqlite3 commands against that path instead."
  echo
  echo "If you got 'Permission denied' anywhere above: grant Full Disk"
  echo "Access to Terminal in System Settings > Privacy & Security > Full"
  echo "Disk Access, then open a new Terminal window and re-run this."
fi
