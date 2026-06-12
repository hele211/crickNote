# Phase 3: Prune the Retired Runtime — Plan

> Executes Phase 3 of the agent-native-bridge effort. The bridge (PR #3) is merged to main; the Obsidian chat runtime it replaced is now dead weight. This plan deletes it.

**Goal:** Remove the ~5,000 lines of runtime/server/embedding code the CLI bridge replaced, drop 4 heavy dependencies, and keep the suite green throughout.

**Branch:** `chore/prune-retired-runtime` off `main` (`0f9d075`).

**Method:** One logical layer per commit. After EVERY layer: `npx tsc --noEmit` clean AND `npx vitest run` green before committing. Deletion-driven — delete a module, then fix imports in KEPT files and remove/rewrite tests that exclusively covered the deleted code.

## Two corrections to the original Phase-3 sketch (found by dependency tracing)

1. **KEEP `SafeWriter` and `ConflictDetector` whole.** `applyPendingEdit` calls `proposeEdit` + `confirmEdit('apply')`; `buildToolRegistry` passes a `ConflictDetector` to tools. Both are load-bearing for the CLI now. The original "gut safe-writer" step would have broken the bridge.
2. **`context-assembler.ts` is now orphaned** (Task 9 removed its last live caller from `vault_search`). Decision: DELETE it. It is no longer "kept because vault_search uses it."

## Keep-list (live via the bridge — do NOT delete)

`src/editing/safe-writer.ts`, `conflict-detector.ts`, `changelog.ts`, `auto-writer.ts`, `diff-generator.ts`; `src/retrieval/query-parser.ts`, `structured-filter.ts`; `src/agent/build-registry.ts`, all `src/agent/tools/*`, `tools/registry.ts`; `src/cli/apply-edit.ts`, `tool-dispatch.ts`, `install-agent-assets.ts`, `reindex.ts`, `setup.ts`, `reindex`; `src/ingestion/ignore.ts`, `index-file.ts`, `indexer.ts` (simplified), `parser.ts`, `chunker.ts`; `src/storage/*`, `src/config/*`, `src/utils/*`, `src/knowledge/*`, `src/templates/*`.

## Test-coupling caution

12 test files match "auth" but most are false positives (`author` in reading-note tests). Only delete a test after confirming it EXCLUSIVELY covers deleted code. A test that mixes kept + deleted concerns must be rewritten (to the CLI path) or have only its deleted-coverage removed — never silently dropped if it still guards kept behavior. The `vitest run` import-error output after each deletion identifies orphaned tests precisely.

## Layers

### Layer 1 — Obsidian chat plugin
- Delete: `obsidian-plugin/` (chat-view.ts, main.ts/js, websocket-client.ts, manifest.json, styles.css — verified pure chat client).
- Delete test: `tests/unit/websocket-client.test.ts`.
- Edit `package.json`: remove `build:plugin` script and the `&& bash scripts/build-plugin.sh` from `build`. Delete `scripts/build-plugin.sh` if it exists and is plugin-only.
- Gate + commit: `chore(prune): remove Obsidian chat plugin`.

### Layer 2 — Server + service + start command
- Delete: `src/server/websocket.ts`, `src/server/rate-limiter.ts`, `src/service.ts`, `src/cli/start.ts`.
- Edit `src/cli.ts`: remove the `start` command + its `import { start }`.
- Delete tests: `tests/unit/websocket-mapper.test.ts`, `tests/unit/rate-limiter.test.ts`, `tests/e2e/server.e2e.test.ts`. Inspect `tests/unit/action-validation.test.ts` and `tests/unit/symlinked-vault.test.ts` — they exercise the websocket/runtime mapping; delete if exclusively runtime/server, else rewrite the kept assertions to the dispatcher.
- Gate + commit: `chore(prune): remove websocket server, service, and start command`.

### Layer 3 — Runtime + providers + context + router
- Delete: `src/agent/runtime.ts`, `src/agent/providers/` (anthropic.ts, openai.ts, base.ts), `src/agent/context.ts`, `src/agent/tool-router.ts`.
- Delete tests: `tests/unit/runtime-routing.test.ts`, `tests/unit/provider-config.test.ts`, `tests/unit/context-prompt.test.ts`, `tests/unit/tool-router.test.ts`, `tests/unit/zotero-runtime.test.ts`. Inspect `tests/integration/reading-pipeline.test.ts` (uses runtime) — rewrite to drive the pipeline through `runTool`, or delete if redundant with `cricknote-workflows`/`cli-bridge`.
- Gate + commit: `chore(prune): remove LLM runtime, providers, context assembly, tool router`.

### Layer 4 — Auth / token
- Delete: `src/server/auth.ts` (and `src/server/` dir if now empty).
- Edit `src/cli.ts`: remove `rotate-token` command + `import { rotateToken }`.
- Edit `src/cli/setup.ts`: remove `generateToken`/`getTokenPath` import + the token-generation block (the websocket auth token is meaningless without the server).
- Delete test: `tests/unit/auth-validation.test.ts`.
- Gate + commit: `chore(prune): remove websocket auth token (no server to authenticate)`.

### Layer 5 — Embedding + indexing daemon
- Delete: `src/ingestion/embedder.ts`, `src/ingestion/watcher.ts`, `src/ingestion/worker.ts`.
- Edit `src/ingestion/indexer.ts`: remove `embeddings` from `IndexNoteInput`, delete the `insertEmbedding` prepare + its use, remove `import { embeddingToBuffer }`. Keep BM25 + metadata + experiment-type tracking. The `chunk_embeddings` table stays in migrations (harmless; no migration churn).
- Edit `src/ingestion/index-file.ts`: drop `embeddings: []` from the `indexNote(...)` call.
- Delete tests: `tests/unit/worker.test.ts`, `tests/unit/watcher.test.ts`. Simplify or delete `tests/unit/search-no-embed.test.ts` (its purpose — "search loads no model" — is moot once the embedder is gone; if kept, it must not import the deleted `embedder.js`).
- Gate + commit: `chore(prune): remove embedder, watcher, worker; index BM25+metadata only`.

### Layer 6 — Orphaned retrieval
- Delete: `src/retrieval/semantic-ranker.ts`, `src/retrieval/context-assembler.ts`.
- Delete test: `tests/unit/context-assembler.test.ts`. (semantic-ranker had no test.)
- Confirm no kept file imports either (grep first).
- Gate + commit: `chore(prune): remove orphaned semantic-ranker and context-assembler`.

### Layer 7 — Drop heavy dependencies
- `npm uninstall @xenova/transformers @anthropic-ai/sdk openai ws` (confirm zero remaining imports of each via grep FIRST).
- Gate + commit: `chore(prune): drop transformers, LLM SDKs, and ws dependencies`.

### Layer 8 — Docs + final gate
- Update `README.md`: replace "run the service + open Obsidian chat" with the agent-native workflow (`cricknote setup`, run Claude Code/Codex from the vault, `cricknote tool`/`tools`/`reindex`).
- Final: `npx tsc --noEmit` clean, `npx vitest run` green, `npx tsc` builds `dist/`.
- Commit: `docs: document agent-native workflow; remove chat-runtime references`.

## Risk & rollback

Every deletion is recoverable from `main`/merge commit `0f9d075` via `git checkout 0f9d075 -- <path>`. If real-use validation later reveals a bridge gap, the runtime is one checkout away. The test gate after each layer is the tripwire: if deleting a layer breaks a KEPT test, that reveals a coupling to investigate before proceeding.
