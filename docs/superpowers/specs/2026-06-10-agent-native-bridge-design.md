# Agent-Native Bridge: CrickNote as a Claude Code / Codex Lab Assistant

**Date:** 2026-06-10
**Status:** Approved design, pending implementation plan

## 1. Goal

Make CrickNote's lab tools directly usable by terminal AI agents (Claude Code and
OpenAI Codex CLI), with the Obsidian vault remaining the only surface the user
looks at. The internal chat runtime, its Obsidian chat UI, and its LLM provider
plumbing are retired: the agent (Claude Code / Codex) replaces them.

The user runs the agent **from the vault directory** for lab work. The crickNote
repo remains the development workspace and the version-controlled source of the
CLI and skills.

### Why this shape (decision history)

- **Not an MCP server.** Both target agents run bash natively. A CLI dispatcher
  is one entry point with no transport, SDK, or daemon. MCP adds infrastructure
  without adding capability for short, synchronous operations.
- **Not a `src/core/` restructure.** The existing `ToolRegistry` /
  `ToolHandler` contract (JSON args in, JSON string out) is already the shared
  abstraction. Moving files first risks the working system and delivers nothing.
- **Full switch, not parallel interfaces.** The user decided to stop using the
  Obsidian chat UI once the bridge works. Obsidian remains as the vault
  viewer/editor only. This permits aggressive pruning (~half the codebase) in
  phase 3.

## 2. Non-Goals

- No MCP server, no Codex plugin packaging, no WebSocket compatibility.
- No two-way calendar/reminder sync. One-way push with human-mediated
  reconciliation during daily review.
- No rewrite of domain logic. Serial numbering, templates, Zotero integration,
  reading pipeline, and KB mapping pipeline are kept as-is.
- No automatic whole-library Zotero import. One paper at a time.

## 3. Current Architecture (verified)

~11.5k lines of TypeScript, splitting into:

**The asset (~4,500 lines)** — domain logic no agent has natively:

| Module | Lines | Role |
|---|---|---|
| `src/agent/tools/kb-tools.ts` | 1,279 | KB mapping pipeline (suggest → mapping artifact → apply loop) |
| `src/agent/tools/zotero-tools.ts` | 898 | Zotero Better BibTeX JSON-RPC, PDF bundling |
| `src/agent/tools/serial-tools.ts` | 714 | Atomic serial IDs, prefix reservations, project/series/protocol creation |
| `src/agent/tools/reading-intake.ts` | 626 | Reading bundle discovery, reading note pipeline |
| `src/templates/template-loader.ts` | 583 | Template validation and rendering |
| `src/knowledge/`, `src/storage/`, `src/editing/auto-writer.ts`, config, utils | ~1,400 | Mapping artifacts, DB, audit log, fenced-section updates |

**The scaffolding (~5,000 lines)** — replaced by the agent itself:

| Module | Lines | Replaced by |
|---|---|---|
| `src/agent/runtime.ts` + `src/agent/providers/` | ~900 | The agent IS the LLM loop |
| `src/server/` (WebSocket, auth, rate-limiter) | ~400 | No UI to serve |
| `src/editing/safe-writer.ts` confirm machinery, `conflict-detector.ts`, `diff-generator.ts` | ~540 | Agent's own permission prompt + diff display |
| `src/retrieval/semantic-ranker.ts` | ~130 | BM25 + grep are sufficient. **Correction (2026-06-10):** the rest of `src/retrieval/` (query-parser, structured-filter, context-assembler) is NOT scaffolding — `vault_search` depends on it and it stays |
| `src/ingestion/embedder.ts` + chunk embeddings | ~110 + deps | BM25 + grep are sufficient; drops `@xenova/transformers` |
| `obsidian-plugin/` chat UI | (separate) | Obsidian becomes viewer only |

### Critical mechanism: the `pending_edit` flow

Write-path tools (`create_project`, `create_experiment`, `task_add`,
`vault_append`, `vault_write`, …) do **not** write files. They return
`{type: 'pending_edit', path, newContent, operation}` (or `pending_edits` with
a batch array). Today `runtime.ts` intercepts these and, after user
confirmation, performs the apply path:

1. Atomic write via SafeWriter internals (tmp file + rename)
2. `edit_audit_log` insert (before/after content + hashes)
3. Folder changelog append (`appendFolderChangelog`)
4. Prefix reservation bookkeeping (`prefix_reservations` finalize on apply,
   delete on cancel/expiry)

**Any bridge must preserve this apply path.** A naive dispatcher that just
prints the pending_edit would orphan reservations and skip audit/changelog;
an agent writing the file itself with its own Write tool would do the same.
This is the single most important implementation constraint.

## 4. Target Architecture

```
You ←→ Claude Code / Codex            (run from the vault directory)
            │  bash
            ▼
   cricknote tool <name> '<json>'      (generic dispatcher — the new code)
            │
            ▼
   ToolRegistry → 35 existing tools    (unchanged)
            │
            ▼
   Obsidian Vault (source of truth) + SQLite (serials, index, audit, artifacts)
```

**Placement:**

- Repo (`~/crickNote`): code, CLI, skill sources (`skills/` directory in repo).
- Vault: `CLAUDE.md` + `AGENTS.md` (conventions + tool catalog), and
  `.claude/skills/` + `.agents/skills/` installed by `cricknote setup`
  (**copied** from the repo — copies are robust to vault sync tools and agent
  skill loaders; re-running setup refreshes them; the repo stays the
  version-controlled source).
- `~/.cricknote/config.json`: unchanged; the CLI resolves the vault path from
  it, so the dispatcher works regardless of the agent's working directory.

## 5. The Dispatcher (the only substantial new code)

```
cricknote tool <name> '<json-args>' [--session <id>] [--no-apply]
cricknote tools                      # list tool catalog (name, description, params)
```

Estimated ~150–250 lines. Responsibilities:

1. **Execute:** look up `<name>` in the registry, parse the JSON args, run the
   tool, print the JSON result to stdout. Unknown tool / malformed JSON →
   non-zero exit with a JSON error object.
2. **Apply pending edits:** extract the runtime's confirm path into a shared
   `applyPendingEdit()` function (atomic write, audit log, changelog,
   reservation finalize). The dispatcher applies immediately by default.
   *Justification:* the agent's own bash-permission prompt shows the full
   command before execution — that is the propose+confirm flow, relocated to
   the agent layer. Two confirmation layers would be pure friction.
   `--no-apply` exists for inspection/debugging.
3. **Incremental index:** any file the dispatcher writes is re-indexed
   immediately (single-file index update) so `vault_search` / `vault_list`
   never go stale. Hand-edits in Obsidian are caught by a session-start
   `cricknote reindex` (instructed in skills/CLAUDE.md). The always-on watcher
   daemon is retired.
4. **Session ID:** generate per invocation, or accept `--session` so a skill
   can thread one session ID through a multi-step workflow; keeps
   `edit_audit_log` and `workflow_events` attributable.
5. **Batch support:** handle both `pending_edit` and `pending_edits` result
   shapes.

## 6. Use Cases (requirements)

### Lab recording

| # | Use case | Tools | Output |
|---|---|---|---|
| 1 | Create project | `create_project`, `register_project_counters` | `Projects/P###-<slug>/P###-index.md`, prefix reserved |
| 2 | Create experiment | `create_experiment` (validates protocol/series) | `<PREFIX>###-<slug>.md` with samples table; project index updated |
| 3 | Log steps during the day | `vault_read` + `vault_append` | Timestamped log entries |
| 4 | Add results/analysis, close out | `vault_append`/`vault_write` + frontmatter status | Results/Analysis filled, `status: complete` |
| 5 | Group into series | `create_series`, `update_series_table` | `<PREFIX>S###` series note |
| 6 | Create/derive protocol | `create_protocol` | `Protocols/PR###-<slug>.md` with lineage |

### Reading & knowledge

| # | Use case | Tools | Output |
|---|---|---|---|
| 7 | Import paper from Zotero | `zotero_fetch_item`, `zotero_prepare_bundle`, `create_reading_note` | PDF bundled, reading note skeleton |
| 8 | Analyze paper | `compile_reading_note` → agent drafts → `vault_write` | CREATE sections filled (Claims, Reasoning, Evidence, Assumptions, Takeaways, Extensions) |
| 9 | Map into knowledge base | `kb_suggest` → confirm → `kb_write_mapping` → `kb_apply` loop → `kb_apply_advance` | Mapping artifact + updated/new Knowledge notes; resumable |
| 10 | Non-Zotero sources | `discover_reading_bundle`, `create_reading_note` | Same pipeline via `Reading/Threads/` |

### Planning & review

| # | Use case | Tools | Output |
|---|---|---|---|
| 11 | Add/complete tasks | `task_add`, `task_complete` | Checkboxes in `Memory/Daily/<date>.md` |
| 12 | Daily/weekly review | `get_today_diary`, `get_week_plan`, `task_list`, `reading_pipeline_status`, `get_workflow_events` | Open work, stuck pipelines, next steps |
| 13 | Search history | `vault_search` (BM25), `vault_list` (metadata filters) | e.g. "failed qPCR experiments from May" |
| 14 | Calendar/reminder push | skill-level `osascript` after `task_add` or scheduling talk | Apple Reminder with due date; Calendar event for planned experiments |
| 15 | Reminder reconciliation | daily-review skill | One-way push; review asks "completed in Reminders → check off in diary?" |

KB mapping sources include completed **experiments and series**, not just
papers (use case 4 feeds use case 9).

## 7. Skills

Installed into the vault by setup; sourced from the repo.

| Skill | Covers | Key instructions |
|---|---|---|
| `cricknote-record-experiment` | UC 1–6 | Resolve project/protocol first; use `cricknote tool`; timestamp log entries; close-out checklist (results → analysis → status → offer KB mapping) |
| `cricknote-reading-intake` | UC 7–8, 10 | Zotero-first; one paper at a time; CREATE structure; check `reading_pipeline_status` before and after |
| `cricknote-kb-update` | UC 9 | Never skip the confirm gate between `kb_suggest` and `kb_write_mapping`; resume from mapping artifact state |
| `cricknote-daily-review` | UC 12–13, 15 | Session-start `reindex`; surface unfinished experiments, stuck reading bundles, pending KB targets; reminder reconciliation |
| `cricknote-reminders` | UC 14 | Locale-safe AppleScript date construction; search for existing reminder before creating (dedupe); append `⏰` marker to pushed task lines; include `[P###]` source marker in reminder name |

Vault-level `CLAUDE.md` and `AGENTS.md` carry: folder layout, serial ID scheme,
frontmatter schemas, the tool catalog (`cricknote tools` output), and the rule
that all vault writes go through `cricknote tool` (never raw file writes for
serialized note types).

## 8. Calendar / Reminders Design

- **Vault is the source of truth.** Tasks are markdown checkboxes in daily
  diary notes, as today.
- **One-way push:** when a task carries a deadline or the user schedules work,
  the skill creates an Apple Reminder (or Calendar event for planned
  experiments) via `osascript`. Works with iCloud sync (phone, watch, Siri).
- **No sync-back:** completing a reminder on the phone does not auto-check the
  vault. The daily-review skill reconciles by asking.
- **Dedupe:** reminder names embed the task's project/serial marker; the skill
  searches existing reminders before creating.
- **Marker:** pushed task lines get `⏰` appended so both the user and the
  skill can see push state in the vault.
- Zero new CrickNote code; this is entirely skill-level instruction.

## 9. Small Fixes (phase 1)

1. `task_list` scans only the last 14 days of diary notes — unfinished older
   tasks silently vanish. Widen to a `days` parameter, default 90.
2. `task_add` stores deadlines as raw text. Parse with `chrono-node` (already
   a dependency, used by the query parser) → ISO dates, making reminder push
   reliable.
3. Remove `node-cron` from `package.json` (declared, never imported).

### Corrections found during implementation planning (2026-06-10)

4. **Semantic ranking comes out of `vault_search` in phase 1, not phase 3.**
   `vault_search` lazy-loads the embedding model at query time when candidates
   exceed 5. Through the CLI every invocation is a fresh process, so this
   would add seconds of model-load latency per search. The semantic re-rank
   step (already wrapped in a fall-through try/catch) is removed in phase 1;
   structured filters + BM25 remain.
5. **`cricknote reindex` must be rewritten in phase 1.** Today it only clears
   derived tables and instructs the user to restart the service — it cannot
   index standalone. With the service retired, phase 1 gives it a real
   standalone full-index loop (parse → chunk → BM25/metadata, no embeddings,
   no model load).
6. **Reservation lifecycle (verified):** `create_project` returns a
   `pending_edit` carrying `reservation: {project_id, prefix}`. The apply path
   stamps `prefix_reservations.edit_id`; on failure/cancel the reservation row
   is deleted; on success it remains until `register_project_counters`
   upgrades it to permanent. The dispatcher must mirror exactly this.

## 10. Pruning (phase 3)

Delete once the bridge has covered real lab work for a week or two:

- `src/agent/runtime.ts`, `src/agent/providers/` (anthropic, openai, base)
- `src/server/` (websocket, auth, rate-limiter)
- `src/editing/safe-writer.ts` confirm/session machinery and
  `conflict-detector.ts` — **keep** the atomic-write + audit internals consumed
  by `applyPendingEdit()` (relocate as needed), and **keep** `auto-writer.ts`
  (used by kb-tools/serial-tools)
- `src/retrieval/semantic-ranker.ts` only — **keep** `query-parser.ts`,
  `structured-filter.ts`, `context-assembler.ts` (all consumed by
  `vault_search`; correction 2026-06-10)
- `src/ingestion/embedder.ts`, `chunk_embeddings` usage, watcher daemon;
  drop `@xenova/transformers`, `ws`, LLM SDK deps (`@anthropic-ai/sdk`,
  `openai`), `node-cron`
- `obsidian-plugin/` chat UI
- `chat_sessions` / `chat_messages` usage (tables may remain in old DBs;
  no migration needed)
- `src/agent/tool-router.ts` and `src/agent/context.ts` (system prompt
  assembly) — the agent brings its own context management
- Tests covering deleted modules

Expected result: roughly half the codebase removed, dependency count cut from
13 to ~7.

## 11. Testing

TDD throughout, consistent with the existing vitest culture:

- **Dispatcher unit tests:** arg parsing, unknown tool, malformed JSON, error
  shapes, `--no-apply`, session ID threading.
- **Apply-path unit tests:** `applyPendingEdit()` writes atomically, audit log
  row created, changelog appended, reservation finalized on apply / released
  on failure; batch `pending_edits` handling.
- **Incremental index test:** file written through dispatcher is immediately
  findable via `vault_search`.
- **Integration test:** full cycle through the CLI against a temp vault —
  create project → register counters → create experiment → append log →
  complete → `task_add` with chrono deadline → `task_list` finds it.
- **Regression:** existing suite stays green in phases 1–2; pruned
  accordingly in phase 3.

## 12. Phases

1. **Bridge:** extract `applyPendingEdit()`; build dispatcher (+ `cricknote
   tools` catalog command); incremental indexing; task fixes (window,
   chrono-node); write vault `CLAUDE.md`/`AGENTS.md`; extend `cricknote setup`
   to install them.
2. **Skills:** the five skills, validated against real vault workflows from
   the vault directory with both Claude Code and Codex.
3. **Prune:** delete scaffolding per §10 after real-use confidence; update
   README and docs.

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Dispatcher apply path misses a side effect the runtime performed | Extract the runtime code (don't reimplement); apply-path unit tests assert audit/changelog/reservation effects |
| Agent bypasses `cricknote tool` and writes serialized notes directly | CLAUDE.md/AGENTS.md rule + skills instruct tool-first; audit log makes violations visible; acceptable residual risk for single user |
| Stale index after hand-edits in Obsidian | Session-start `reindex` instruction; incremental index on every dispatcher write |
| AppleScript locale fragility | Skill uses locale-safe date construction; chrono-normalized ISO dates as input |
| Pruning breaks a kept module via hidden import | Prune last, after bridge proven; TypeScript build + test suite as the gate |
