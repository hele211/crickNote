# Prune Retired Runtime (embedding + websocket service)

**Date:** 2026-06-12
**Branch:** `claude/general-session-Gs88j`
**Status:** PLAN — awaiting approval before execution

## Why

CrickNote is pivoting to an **agent-native CLI bridge** (cf. merged PR #3
`feat/agent-native-bridge`, plus `feat(cli): expose 'tool' and 'tools' commands
for agent access` and `perf(search): drop query-time semantic rank so CLI search
needs no model`). In that model an external AI agent drives the vault by shelling
out to `cricknote tool <name>` / `cricknote tools`. The legacy runtime — local
embeddings, a background file watcher/worker, and a long-running WebSocket server
that the Obsidian chat plugin connected to — is now dead weight: search is already
BM25 + metadata only (no query-time embeddings), and nothing in the agent path
loads a model or opens a socket.

This plan removes that retired runtime, the heavy dependencies it dragged in, and
the now-orphaned tests, leaving a lean embedding-free CLI.

> **Note on lost work:** a prior session performed this prune inside an isolated
> git worktree that was removed; none of those commits (`72d38d4`…`1ed0481`)
> survived. This plan re-derives the work from the *current* `main`/session tree
> (`0f9d075`) and will commit **directly to the session branch** so it cannot
> vanish again.

## Baseline (verify before starting)

- `npx tsc --noEmit` clean
- `npx vitest run` green — record file/test counts as the regression gate.

## Inventory (current codebase, verified)

### Delete (retired runtime)
| File | Role | Real importers |
|---|---|---|
| `src/ingestion/embedder.ts` | `@xenova/transformers` embeddings | `worker.ts`, `indexer.ts`* |
| `src/ingestion/watcher.ts` | `chokidar` file watcher | `worker.ts` |
| `src/ingestion/worker.ts` | background ingestion loop | `service.ts` |
| `src/retrieval/semantic-ranker.ts` | vector rerank (reads `chunk_embeddings`) | **none (orphaned)** |
| `src/retrieval/context-assembler.ts` | LLM context builder | **none (orphaned)** |
| `src/server/websocket.ts` | `ws` server for Obsidian plugin | `service.ts`, `cli.ts` |
| `src/server/auth.ts` | token gen/rotate for the socket | `cli.ts`, `setup.ts` |
| `src/server/rate-limiter.ts` | per-connection rate limiting | `websocket.ts` |
| `src/service.ts` | wires server + worker for `start` | `cli/start.ts` |
| `src/cli/start.ts` | `cricknote start` long-running service | `cli.ts` |

\* `indexer.ts` is **kept** but surgically edited (see below).

### Keep — confirmed still in use (do NOT delete)
- `src/retrieval/structured-filter.ts`, `src/retrieval/query-parser.ts` — both
  imported by `src/agent/tools/search.ts` (the live BM25 search). The
  "feed the semantic ranker" comment in `structured-filter.ts` is stale prose
  only; reword, don't delete.
- `src/ingestion/indexer.ts`, `index-file.ts`, `parser.ts`, `chunker.ts`,
  `ignore.ts` — the embedding-free index path used by `reindex` and the tools.
- `src/cli/reindex.ts` — already standalone, embedding-free (the `watcher` grep
  hit was a `// no watcher` comment, not an import).

### Surgically edit (kept files that reference deleted code)
1. **`src/ingestion/indexer.ts`** — remove `import { embeddingToBuffer } from './embedder.js'`,
   drop the `embeddings: Float32Array[]` input field and the
   `INSERT INTO chunk_embeddings` loop. `index-file.ts` already passes
   `embeddings: []`, so this is dead at runtime; update its call site to stop
   passing the field.
2. **`src/ingestion/index-file.ts`** — drop `embeddings: []` from the `indexNote` call.
3. **`src/cli.ts`** — remove the `start` command + import, the `rotate-token`
   command + `rotateToken` import, and the now-unused `crypto` only if it
   becomes unused (it's still used by the `tool` command — keep). Keep `setup`,
   `reindex`, `tool`, `tools`.
4. **`src/cli/setup.ts`** — remove `generateToken/getTokenPath` import + the
   "Generate auth token" block (lines ~187-189) and the `server:` field in the
   saved config (line ~171). Re-inspect the obsidian-plugin install block
   (~222+) under the plugin decision below.
5. **`src/config/config.ts`** — remove the unused `embeddingModelPath?` and
   `server: { host; port }` fields from `CrickNoteConfig`, the `server` default
   in `DEFAULT_CONFIG` (leaving `{}` or removing the spread), and any
   `config.server`/`config.llm` start-banner usage in deleted `start.ts`
   (already covered by deletion).
6. **`README.md`** — drop the "Start CrickNote" / `npm run start` / WebSocket
   sections and the `src/server` + plugin transport bullets; describe the CLI
   tool entrypoint instead.
7. **`package.json`** — remove the `start` script (its command is gone); keep
   `setup`/`reindex`/`test`. Remove deps `@xenova/transformers`, `chokidar`,
   `ws` (each used only by a deleted file; `openai` + `@anthropic-ai/sdk` stay).

### Delete orphaned tests (only those whose subject is deleted)
`worker.test.ts`, `watcher.test.ts`, `websocket-client.test.ts`,
`websocket-mapper.test.ts`, `tests/e2e/server.e2e.test.ts`,
`auth-validation.test.ts`, `rate-limiter.test.ts`, `context-assembler.test.ts`.
(No `embedder`/`semantic-ranker` test exists.) Every other test stays; if any
kept test transitively imports deleted code it must be **rewritten to cover the
retained behavior**, not dropped.

## Open decisions (need your call)

1. **`obsidian-plugin/` + `scripts/build-plugin.sh` + `build:plugin` script.**
   The plugin (`websocket-client.ts`, `chat-view.ts`, `main.ts`) connects *only*
   via the WebSocket server we're deleting, so it becomes non-functional.
   - **(Recommended) Delete it** in a final layer — it's the whole point of the
     agent-native pivot, and leaving dead plugin code + build step is misleading.
   - Keep it untouched (document as deprecated) if you still want the chat UI.
2. **`chunk_embeddings` table.** Created by migration `001-initial.ts`. After the
   prune nothing reads or writes it.
   - **(Recommended) Leave the table** — never rewrite historical migrations;
     an empty unused table is harmless and zero-risk.
   - Add a new `004` migration to `DROP TABLE chunk_embeddings` if you want a
     fully clean schema (slightly more risk, more test churn).

## Execution — layered, each layer a commit behind a green gate

Each layer: delete/edit → fix fallout in kept code → remove only genuinely
orphaned tests → `tsc --noEmit` clean → `vitest run` green → commit. Stop and
report if a layer can't go green.

- **L0** Baseline: record tsc + test counts.
- **L1 — Retrieval orphans.** Delete `semantic-ranker.ts`, `context-assembler.ts`
  + `context-assembler.test.ts`. Reword stale comment in `structured-filter.ts`.
  (Zero importers → smallest, safest first.)
- **L2 — Ingestion runtime.** Delete `embedder.ts`, `watcher.ts`, `worker.ts` +
  their tests. Surgically strip embeddings from `indexer.ts` + `index-file.ts`.
- **L3 — Server.** Delete `src/server/` (websocket, auth, rate-limiter) + their
  tests (`websocket-*`, `auth-validation`, `rate-limiter`, `server.e2e`).
- **L4 — Service + CLI surface.** Delete `service.ts`, `cli/start.ts`; edit
  `cli.ts` (drop `start` + `rotate-token`) and `setup.ts` (drop token/server).
- **L5 — Config + docs.** Trim `config.ts` fields; update `README.md`.
- **L6 — Deps.** `npm rm @xenova/transformers chokidar ws`; drop `start` script;
  verify lockfile + tsc + tests; confirm no dangling references via grep.
- **L7 — (pending decision 1)** Delete `obsidian-plugin/`, `build-plugin.sh`,
  `build:plugin`, and the plugin step in `setup.ts` + `build` script.

## Risks / guards
- Hidden transitive imports (like the prior session's `registry.ts` →
  `providers/base.ts` coupling): each layer greps for dangling references before
  committing.
- Don't over-delete `structured-filter`/`query-parser` — they're live.
- Keep historical migrations intact.
- Commit per layer on the session branch; never use an isolated worktree.
