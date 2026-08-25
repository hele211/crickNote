#!/bin/bash
# Self-test for watch.sh's control flow: stubs whisper/ffmpeg/claude so it
# runs without real transcription, a real vault, or a real Claude Code
# login. Runs in CI on macos-latest (see
# ../../.github/workflows/voice-memo-watch-macos.yml), and works locally on
# Linux too — GNU/BSD date differences are handled the same way watch.sh
# itself handles them, so this doubles as a way to catch a wrong flag before
# it ever reaches a real Mac.
set -uo pipefail

WATCH_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/watch.sh"
BASE_PATH="$PATH"
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  ok - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  NOT OK - %s\n' "$1"; }
assert_eq()         { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
assert_exists()     { if [ -e "$2" ]; then ok "$1"; else bad "$1 ($2 missing)"; fi; }
assert_not_exists() { if [ ! -e "$2" ]; then ok "$1"; else bad "$1 ($2 unexpectedly present)"; fi; }

# now_minus_minutes MIN FILE — sets FILE's mtime to (now - MIN). Same
# BSD/GNU-date detection watch.sh itself uses for advance_state, so this
# also proves that detection works on whatever OS is actually running this.
now_minus_minutes() {
  local min="$1" file="$2" target
  if date -v-1M >/dev/null 2>&1; then
    target="$(date -v-${min}M +%Y%m%d%H%M.%S)"
  else
    target="$(date -d "-${min} minutes" +%Y%m%d%H%M.%S)"
  fi
  touch -t "$target" "$file"
}

# new_sandbox — isolated HOME with stub whisper/ffmpeg/claude on PATH, a fake
# vault + CrickNote config, and the env vars watch.sh reads. Call once per
# scenario so scenarios can't leak state into each other.
new_sandbox() {
  SANDBOX="$(mktemp -d)"
  export HOME="$SANDBOX/home"
  mkdir -p "$HOME/.cricknote" "$SANDBOX/vault" "$SANDBOX/bin" "$SANDBOX/recordings" "$HOME/Documents"
  echo "{\"vaultPath\": \"$SANDBOX/vault\"}" > "$HOME/.cricknote/config.json"

  cat > "$SANDBOX/bin/whisper" <<'STUB'
#!/bin/bash
file="$1"; shift
dir=""
while [ $# -gt 0 ]; do [ "$1" = "--output_dir" ] && dir="$2"; shift; done
base="$(basename "$file")"; base="${base%.*}"
echo "stub transcript for $base" > "$dir/$base.txt"
STUB

  cat > "$SANDBOX/bin/ffmpeg" <<'STUB'
#!/bin/bash
exit 0
STUB

  cat > "$SANDBOX/bin/claude" <<'STUB'
#!/bin/bash
# args: -p "<prompt>" — writes the prompt out so the test can inspect it.
echo "$2" > "$HOME/claude-last-prompt.txt"
echo "STUB CLAUDE INVOKED"
STUB
  chmod +x "$SANDBOX/bin/whisper" "$SANDBOX/bin/ffmpeg" "$SANDBOX/bin/claude"

  export PATH="$SANDBOX/bin:$BASE_PATH"
  export CRICKNOTE_DATA_DIR="$HOME/.cricknote"
  export CRICKNOTE_VOICE_MEMO_RECORDINGS="$SANDBOX/recordings"
  export CRICKNOTE_VOICE_MEMO_DROP="$HOME/Documents/CrickNote-VoiceMemoDrops"
  unset CRICKNOTE_VOICE_MEMO_SETTLE_MINUTES
  LOG="$CRICKNOTE_DATA_DIR/voice-memo-watch.log"
}

run_watch() { timeout 30 bash "$WATCH_SH"; }

echo "== Scenario 1: first run establishes a baseline, processes nothing =="
new_sandbox
run_watch; code=$?
assert_eq "exits 0" "0" "$code"
assert_exists "state file created" "$CRICKNOTE_DATA_DIR/voice-memo-watch.last-run"
grep -q "first run" "$LOG" && ok "log mentions first run" || bad "log missing first-run message"

echo "== Scenario 2: mixed drop-folder audio + text gets transcribed, logged, archived =="
new_sandbox
run_watch >/dev/null
sleep 1
echo "fake audio" > "$CRICKNOTE_VOICE_MEMO_DROP/memo1.m4a"
echo "pasted text" > "$CRICKNOTE_VOICE_MEMO_DROP/memo2.txt"
run_watch; code=$?
assert_eq "exits 0" "0" "$code"
grep -q "stub transcript for memo1" "$HOME/claude-last-prompt.txt" 2>/dev/null && ok "whisper output reached the claude prompt" || bad "whisper output missing from prompt"
grep -q "pasted text" "$HOME/claude-last-prompt.txt" 2>/dev/null && ok "drop-folder text reached the claude prompt" || bad "drop-folder text missing from prompt"
assert_exists "audio archived" "$CRICKNOTE_VOICE_MEMO_DROP/processed/memo1.m4a"
assert_exists "text archived" "$CRICKNOTE_VOICE_MEMO_DROP/processed/memo2.txt"

echo "== Scenario 3: nothing new — no-op, no claude call =="
rm -f "$HOME/claude-last-prompt.txt"
run_watch; code=$?
assert_eq "exits 0" "0" "$code"
assert_not_exists "claude not invoked again" "$HOME/claude-last-prompt.txt"

echo "== Scenario 4: transcription failure leaves the file in place for retry =="
new_sandbox
run_watch >/dev/null
cat > "$SANDBOX/bin/whisper" <<'STUB'
#!/bin/bash
echo "simulated crash" >&2
exit 1
STUB
sleep 1
echo "fake audio" > "$CRICKNOTE_VOICE_MEMO_DROP/memo.m4a"
run_watch; code=$?
assert_eq "exits 1 on failure" "1" "$code"
assert_exists "file NOT archived, left for retry" "$CRICKNOTE_VOICE_MEMO_DROP/memo.m4a"
assert_not_exists "file not moved to processed" "$CRICKNOTE_VOICE_MEMO_DROP/processed/memo.m4a"

echo "== Scenario 5: no whisper CLI at all — clear error, file preserved =="
new_sandbox
run_watch >/dev/null
rm "$SANDBOX/bin/whisper"
sleep 1
echo "fake audio" > "$CRICKNOTE_VOICE_MEMO_DROP/memo.m4a"
run_watch; code=$?
assert_eq "exits 1" "1" "$code"
grep -q "no whisper CLI found" "$LOG" && ok "clear error logged" || bad "missing whisper-not-found error"
assert_exists "file preserved" "$CRICKNOTE_VOICE_MEMO_DROP/memo.m4a"

echo "== Scenario 6: a too-fresh Recordings-folder file is never permanently lost =="
# This is the bug the settle-window rework exists to fix: a recording that's
# too fresh to process THIS run must not be silently dropped forever just
# because something else succeeded and advanced the state marker.
new_sandbox
export CRICKNOTE_VOICE_MEMO_SETTLE_MINUTES=1   # so this test takes ~65s, not 5+ minutes
run_watch >/dev/null   # baseline: state = now - 1min

echo "fake audio bytes" > "$CRICKNOTE_VOICE_MEMO_RECORDINGS/fresh.m4a"
# Something else succeeds in the same run — this is what used to advance the
# state marker to raw "now" and strand fresh.m4a behind it.
echo "pasted text" > "$CRICKNOTE_VOICE_MEMO_DROP/other.txt"
run_watch; code=$?
assert_eq "exits 0 (the other item succeeded)" "0" "$code"
assert_exists "fresh recording still untouched (never moved, it's not ours to move)" "$CRICKNOTE_VOICE_MEMO_RECORDINGS/fresh.m4a"
if grep -q "fresh" "$HOME/claude-last-prompt.txt" 2>/dev/null; then bad "fresh recording was processed before it settled"; else ok "fresh recording correctly skipped this run"; fi
if [ "$CRICKNOTE_VOICE_MEMO_RECORDINGS/fresh.m4a" -nt "$CRICKNOTE_DATA_DIR/voice-memo-watch.last-run" ]; then
  ok "fresh recording is still newer than the state marker (would be lost under the old bug)"
else
  bad "fresh recording fell behind the state marker — it will never be picked up"
fi

echo "   (waiting ~65s for the settle window to actually pass, for a real end-to-end check)"
sleep 65
rm -f "$HOME/claude-last-prompt.txt"
run_watch; code=$?
assert_eq "exits 0" "0" "$code"
grep -q "stub transcript for fresh" "$HOME/claude-last-prompt.txt" 2>/dev/null && ok "previously-too-fresh recording was picked up once settled" || bad "recording was never retried — permanently lost"

echo
echo "== Results: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
