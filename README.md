# CrickNote

CrickNote is a local research assistant for an Obsidian vault. It indexes your markdown notes, lets an AI search them, and can propose safe edits that you approve before anything is written.

## What You Need

- Node.js 22 or newer
- An Obsidian vault
- An API key for the language model provider you choose during setup

## First-Time Setup

Install the project dependencies:

```bash
npm install
```

Build the TypeScript code and the Obsidian plugin:

```bash
npm run build
```

Run setup:

```bash
npm run setup
```

Setup asks where your Obsidian vault is and which AI provider to use. It saves the app config under your home folder in `.cricknote`.

## Start CrickNote

```bash
npm run start
```

Leave this running while you use the Obsidian plugin. The service starts a local WebSocket server and indexes your vault in the background.

## Run Checks

Run the main test suite:

```bash
npm test
```

Run the build check:

```bash
npm run build
```

Run the optional socket end-to-end tests:

```bash
CRICKNOTE_RUN_SOCKET_TESTS=1 npm test
```

Those optional tests start a real local WebSocket server, so they are useful before a release.

## Project Map

- `src/ingestion`: reads markdown files, parses metadata, chunks note text, and indexes notes
- `src/retrieval`: searches indexed notes and assembles context for the AI
- `src/agent`: connects the AI provider to CrickNote tools
- `src/editing`: creates safe edit proposals, diffs, conflict checks, and audit logs
- `src/storage`: owns the SQLite database and migrations
- `src/server`: runs the local WebSocket server used by the Obsidian plugin
- `obsidian-plugin`: plugin code that connects Obsidian to the local service
- `tests`: unit, integration, and end-to-end tests

## Common Commands

```bash
npm test        # run tests
npm run build   # compile TypeScript and build the plugin
npm run start   # start the local CrickNote service
npm run setup   # configure CrickNote after building
```

## Safety Notes

CrickNote treats your vault as the source of truth. Most AI-written changes are returned as pending edits, so you can inspect the diff before applying them.

The app also tries to keep file access inside your configured vault. Symlinks and path traversal are rejected in the main vault access paths.
