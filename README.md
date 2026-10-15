# CrickNote

CrickNote is a local lab notebook engine for an Obsidian vault. It assigns serial IDs to projects, experiments, protocols, and reading notes; renders them from templates; indexes your markdown for fast search; and applies edits atomically with an audit log.

You drive it with an AI coding agent — **Claude Code** or **OpenAI Codex** — running from your vault directory. The agent calls CrickNote's tools through a small CLI; the Obsidian vault stays the source of truth.

## What You Need

- Node.js 22 or newer
- An Obsidian vault
- Claude Code or Codex (the agent provides the language model — CrickNote needs no API key of its own)

## First-Time Setup

```bash
npm install
npm run build
npm run setup
```

`setup` asks where your Obsidian vault is, saves config under `~/.cricknote`, scaffolds the vault folders, and installs CrickNote's agent guides (`CLAUDE.md`, `AGENTS.md`) and workflow skills into the vault's `.claude/skills/` and `.agents/skills/`.

## Use It

Open Claude Code or Codex **in your vault directory** and talk to it normally:

> "Start a western blot experiment in project P001 and log that I began the lysis step."
> "Import this Zotero paper and draft a reading note."
> "What experiments did I leave unfinished?"

The agent discovers and calls CrickNote's tools via the CLI:

```bash
cricknote tools                      # list all tools (name, description, params)
cricknote tool <name> '<json-args>'  # run a tool (the agent does this for you)
cricknote reindex                    # refresh the search index after manual edits
```

Writes go through `cricknote tool`, which allocates serial IDs, renders templates, writes atomically, records an audit log and changelog, and updates the search index.

## Run Checks

```bash
npm test         # run the test suite
npm run build    # compile TypeScript
```

## Voice2note diary-first review (optional)

Use diary-first capture to keep dictated material in the full daily diary
before deciding whether an excerpt belongs in an experiment, project, or other
existing note. **Verify the real vault has the desired daily folder first**;
then configure the existing voice2note importer (not CrickNote) with:

```bash
VOICE2NOTE_CAPTURE_MODE=diary-first
VOICE2NOTE_DAILY_DIR=<vault>/Memory/Daily
```

Do **not** migrate or reset the importer's processed-history state. The daily
path may differ in an existing vault; this configuration does not change a
global CrickNote default or create folders.

At end of day, invoke review manually—there is no scheduler or automatic
sorting. First request `diary_review_context`; it returns the full diary,
voice2note blocks, source SHA-256, and indexed candidate paths/IDs. Use
`vault_search`/`vault_read` to inspect a destination; `vault_read` returns its
current `content_sha256` for `target_hash`. Before any write, preview the exact
mapping and quote with `--no-apply`, show it to the user, and get approval:

```bash
cricknote tool route_diary_excerpt '{"date":"2026-10-15","source_block_id":"voice2note-0123456789abcdef","source_quote":"exact dictated text","target_path":"Projects/P001-example/EX001.md","source_hash":"<context SHA-256>","target_hash":"<vault_read SHA-256>"}' --no-apply
```

Only after approval, repeat the same command without `--no-apply`. The CLI
otherwise applies pending edits immediately. Routing appends an exact quoted
excerpt and backlink to an **existing non-diary** target via the standard
SafeWriter/audit pipeline; it never edits/moves the diary or creates a target.
An idempotency marker in the target is the filing audit record, so a retry does
not need a premature diary marker.

`setup` copies all bundled skills and agent guides and can overwrite customized
vault copies. Existing users should back up any customization and refresh only
`cricknote-daily-review/SKILL.md` in both
`.claude/skills/` and `.agents/skills/`; run setup/install assets only when an
intentional full overwrite is wanted.

## Project Map

- `src/cli.ts`, `src/cli/`: the CLI — `tool`/`tools` dispatcher, `reindex`, `setup`, and the shared apply path
- `src/agent/tools`: the lab tools (projects, experiments, protocols, reading intake, Zotero, knowledge base, tasks, search)
- `src/agent/build-registry.ts`: builds the tool registry the CLI exposes
- `src/ingestion`: reads markdown, parses metadata, chunks text, and indexes notes (BM25 + metadata)
- `src/retrieval`: parses queries and builds structured SQL filters for search
- `src/editing`: atomic writes, diffs, conflict checks, audit log, changelog
- `src/knowledge`, `src/templates`: knowledge-base mapping and note templates
- `src/storage`: the SQLite database and migrations
- `tests`: unit and integration tests

## Safety Notes

CrickNote treats your vault as the source of truth. Serialized notes are written only through `cricknote tool`, so the agent's own permission prompt is your confirmation step — you see each command before it runs. File access is kept inside your configured vault; symlinks and path traversal are rejected.
