# CrickNote Vault — Agent Guide

This is a lab notebook vault managed by CrickNote. You (Claude Code / Codex) are
the lab assistant. The Obsidian vault is the source of truth; a SQLite index at
`~/.cricknote/db.sqlite` provides search and serial numbering.

## The one rule for writes

NEVER create or edit serialized notes (projects, experiments, protocols, series,
reading notes, knowledge notes, tasks) with your own file tools. ALWAYS go
through the CrickNote CLI:

    cricknote tool <name> '<json-args>'

It allocates serial IDs, renders templates, writes atomically, records an audit
log, updates the changelog, and refreshes the search index. Writing files
directly bypasses all of that and corrupts the numbering system.

Freeform notes with no serial (scratch, meeting notes) may be edited directly.

## At the start of a lab session

Run `cricknote reindex` once to pick up any edits you made by hand in Obsidian.

## Discovering tools

`cricknote tools` prints the full catalog (name, description, JSON parameters).

## Folder layout

- `Projects/P###-<slug>/` — project folders; `_index.md` is the project home.
  Experiments live here as `<PREFIX>###-<slug>.md`, series as `<PREFIX>S###`.
- `Protocols/PR###-<slug>.md` — protocols.
- `Reading/Papers/`, `Reading/Threads/` — reading notes; `Reading/attachments/<slug>/` — PDFs/sources.
- `Knowledge/Concepts|Entities|Methods/` — knowledge base notes.
- `Memory/Daily/<date>.md`, `Memory/Weekly/<week>.md` — diary and planning.

## Serial IDs

Projects are `P001`, `P002`… Each project reserves a 2–3 letter prefix; its
experiments use that prefix (`IL001`), its series append S (`ILS001`). Protocols
are `PR001`. Never invent or hand-edit a serial — the tools allocate them.

## Writing into the vault

A human reviews these notes in Obsidian and agents read them later. When you write
prose into the vault, follow `.claude/skills/_shared/readable-output.md`: answer
first, one idea per sentence, keep every qualifier, number what others will cite,
and use text-native visuals only (tables, callouts, Mermaid flowcharts).

Reading notes have a fixed layout, described in
`.claude/skills/_shared/reading-note-layout.md`. After writing one, run
`cricknote tool lint_reading_note '{"path":"Reading/Papers/<slug>.md"}'`, fix the
`warn` findings in at most one corrective write, and report what remains. Only
reading notes are linted.

## Common workflows

See the skills in `.claude/skills/cricknote-*`. Summary:
- Record an experiment → `cricknote-record-experiment`
- Import & analyze a paper → `cricknote-reading-intake`
- Map a source into the knowledge base → `cricknote-kb-update`
- Daily/weekly review → `cricknote-daily-review`
- Push tasks to Apple Reminders → `cricknote-reminders`
