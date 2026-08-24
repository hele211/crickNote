---
name: cricknote-voice-memo
description: Use when the user hands over a voice memo — dictated text, a pasted transcript, or an audio recording — to log during the day. Typically recurs every couple of hours as a running check-in, replacing a manual digest through an external chat tool.
---

# Voice memo intake

The point is that the memo's content lands in the vault, not just in the
conversation — a task or note the agent didn't write down didn't happen.

## Get the transcript
- If the user pastes or dictates text, that's the transcript — use it as-is.
- If the user instead points to an audio file: Claude Code has no built-in
  audio transcription. Check for a local transcription CLI (e.g. `whisper`
  on PATH); if one exists, shell out to it and read back the resulting text.
  If none is found, say so plainly and ask the user for a transcript instead
  — e.g. the on-device transcript Apple Voice Memos generates automatically
  on iPhone/Apple Watch recordings, phone dictation, or another tool.

## Log the raw memo
Voice memos get their own dated file, separate from the diary, at
`Memory/VoiceMemos/<date>.md`.
1. `cricknote tool vault_read '{"path":"Memory/VoiceMemos/<date>.md"}'` — check
   whether today's file exists yet.
2. If it exists: append a timestamped entry —
   `cricknote tool vault_append '{"path":"Memory/VoiceMemos/<date>.md","content":"\n- HH:MM <summary or transcript>"}'`
3. If it doesn't exist yet: create it —
   `cricknote tool vault_write '{"path":"Memory/VoiceMemos/<date>.md","content":"---\ndate: <date>\ntype: voice-memo-log\n---\n\n# Voice Memos — <date>\n\n- HH:MM <summary or transcript>\n"}'`

Keep each entry a timestamped summary, not a full verbatim dump, unless the
user wants the raw transcript kept.

## Extract tasks
Pull out clear action items and add each one — this also creates today's
diary note if it doesn't exist yet:
`cricknote tool task_add '{"description":"<item>","project":"<if mentioned>"}'`
Check `cricknote tool task_list '{"status":"pending","days":1}'` first so you
don't add a duplicate of something already logged today.

## Route lab content
If the memo describes bench work on an open experiment rather than a
standalone task or note, offer to log it on the experiment note instead via
`vault_append` (skill: cricknote-record-experiment) so it doesn't get buried
in the voice memo log.

## No background scheduler
CrickNote itself has no daemon and this skill only runs when someone actually
invokes Claude Code — nothing here will proactively fire on its own every two
hours. A real recurring check needs to run on something with access to both
the source of the memos (the Apple account / Voice Memos) and the vault —
realistically the user's own Mac or iPhone (a Shortcuts automation, a
scheduled script, etc.), not this repo. That's a separate piece of setup;
don't imply it already exists.
