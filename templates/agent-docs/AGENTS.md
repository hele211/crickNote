# CrickNote Vault — Agent Guide

(Identical guidance to CLAUDE.md — Codex reads AGENTS.md.)

This is a lab notebook vault managed by CrickNote. The Obsidian vault is the
source of truth; SQLite at `~/.cricknote/db.sqlite` provides search and serials.

## The one rule for writes

Route ALL serialized-note writes through:

    cricknote tool <name> '<json-args>'

Never write project/experiment/protocol/series/reading/knowledge/task notes with
raw file tools — that bypasses serial allocation, audit log, and indexing.

## Start of session

Run `cricknote reindex` to absorb manual Obsidian edits.

## Catalog

`cricknote tools` lists every tool with parameters.

## Layout & serials

Projects `Projects/P###-<slug>/`, experiments `<PREFIX>###`, series `<PREFIX>S###`,
protocols `PR###`, reading `Reading/Papers|Threads/`, knowledge
`Knowledge/Concepts|Entities|Methods/`, diary `Memory/Daily/<date>.md`.

## Writing into the vault

Humans review notes in Obsidian; agents read them later. Follow
`.agents/skills/_shared/readable-output.md` (answer first, short sentences, keep
qualifiers, text-native visuals only). Reading notes use the layout in
`.agents/skills/_shared/reading-note-layout.md`; after writing one run
`cricknote tool lint_reading_note '{"path":"Reading/Papers/<slug>.md"}'`, fix `warn`
findings in at most one corrective write, and report what remains. Lint reading
notes only.

Skills live in `.agents/skills/cricknote-*`.
