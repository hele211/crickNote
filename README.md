# CrickNote

CrickNote is a local research assistant for an Obsidian vault. It indexes your markdown notes, lets an AI search them, and can propose safe edits that you approve before anything is written. CrickNote runs as a set of command-line tools that an AI agent drives directly — there is no long-running service.

## What You Need

- Node.js 22 or newer
- An Obsidian vault (or any folder of markdown notes)
- An API key for the language model provider you choose during setup

## First-Time Setup

Install the project dependencies:

```bash
npm install
```

Build the TypeScript code:

```bash
npm run build
```

Run setup:

```bash
npm run setup
```

Setup asks where your vault is and which AI provider to use. It saves the app config under your home folder in `.cricknote`.

## Index Your Vault

```bash
npm run reindex
```

This performs a full BM25 + metadata index of every markdown file in the vault. Re-run it whenever notes change; no background process is needed.

## Driving CrickNote from an Agent

An AI agent interacts with the vault through the CLI:

```bash
cricknote tools                 # list the available tools and their parameters
cricknote tool <name> '<json>'  # execute a tool with JSON arguments
```

Most write tools return a pending edit by default; pass `--no-apply` to inspect the diff without writing.

## Run Checks

Run the main test suite:

```bash
npm test
```

Run the build check:

```bash
npm run build
```

## Project Map

- `src/ingestion`: reads markdown files, parses metadata, chunks note text, and indexes notes (BM25 + metadata)
- `src/retrieval`: parses queries and builds structured filters over the index
- `src/agent`: connects the AI provider to CrickNote tools and routes tool calls
- `src/cli`: setup, reindex, and the `tool`/`tools` dispatch entrypoints
- `src/editing`: creates safe edit proposals, diffs, conflict checks, and audit logs
- `src/storage`: owns the SQLite database and migrations
- `tests`: unit and integration tests

## Common Commands

```bash
npm test          # run tests
npm run build     # compile TypeScript
npm run reindex   # full vault re-index
npm run setup     # configure CrickNote after building
```

## Safety Notes

CrickNote treats your vault as the source of truth. Most AI-written changes are returned as pending edits, so you can inspect the diff before applying them.

The app also tries to keep file access inside your configured vault. Symlinks and path traversal are rejected in the main vault access paths.
