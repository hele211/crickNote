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
  If none is found, say so plainly and ask the user to paste a transcript —
  their phone's Voice Memos app, dictation, or another transcription tool
  all produce one.

## Extract tasks first
Pull out clear action items and add each one — this also creates today's
diary note if it doesn't exist yet, using the standard template:
`cricknote tool task_add '{"description":"<item>","project":"<if mentioned>"}'`
Check `cricknote tool task_list '{"status":"pending","days":1}'` first so you
don't add a duplicate of something already logged today.

## Log the memo itself
1. `cricknote tool get_today_diary '{}'` — see whether today's note exists
   and whether it already has a `## Voice Memos` section.
2. If it exists (it will, if you added any tasks above): append a timestamped
   entry, reusing the existing `## Voice Memos` heading if there is one:
   `cricknote tool vault_append '{"path":"Memory/Daily/<date>.md","content":"\n## Voice Memos\n- HH:MM <summary or raw transcript>"}'`
3. If it still doesn't exist (no tasks were extracted): create it in one shot
   instead of append —
   `cricknote tool vault_write '{"path":"Memory/Daily/<date>.md","content":"---\ndate: <date>\ntype: daily-diary\n---\n\n# <date>\n\n## Tasks\n\n## Voice Memos\n- HH:MM <summary or raw transcript>\n"}'`

Keep the log entry itself short — a timestamped summary, not a full
verbatim dump, unless the user wants the raw transcript kept.

## Route lab content
If the memo describes bench work on an open experiment rather than a
standalone task or note, offer to log it on the experiment note instead via
`vault_append` (skill: cricknote-record-experiment) so it doesn't get buried
in the diary.

## No background scheduler
CrickNote has no daemon — the user brings a memo whenever they have one
(roughly every couple of hours works well). Each check-in is independent:
reread today's diary if you're unsure what's already logged rather than
assuming an earlier memo from the same session is still accurate.
