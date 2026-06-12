---
name: cricknote-daily-review
description: Use when the user wants a review of open lab work — unfinished experiments, stuck reading notes, pending tasks — or a daily/weekly planning summary in CrickNote.
---

# Daily / weekly review in CrickNote

## Refresh first
Run `cricknote reindex` to absorb manual Obsidian edits.

## Gather state
- `cricknote tool get_today_diary '{}'` and `cricknote tool get_week_plan '{}'`.
- `cricknote tool task_list '{"status":"pending","days":90}'` — open tasks.
- `cricknote tool vault_list '{"folder":"Projects","status":"in-progress"}'` —
  experiments still open.
- `cricknote tool reading_pipeline_status '{}'` for stuck reading bundles.
- `cricknote tool get_workflow_events '{}'` for recent history.

## Present
Summarize: open experiments, stuck reading notes, pending KB targets, due tasks.
Lead with what is overdue or blocking.

## Reminder reconciliation
If the user uses Apple Reminders (skill: cricknote-reminders), ask whether any
reminders were completed on their phone and, for each, mark the matching diary
task done with `cricknote tool task_complete '{"task_description":"<text>"}'`.
