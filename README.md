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
