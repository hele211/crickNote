# CrickNote Spec: Reading-Intake Friction Fixes

**Date:** 2026-06-13
**Status:** Draft
**Scope:** Remove six friction points in the reading-intake pipeline surfaced by real-usage feedback (analysing a 20-page paper from Zotero): a too-low source-text cap, a documented Zotero path that produces an un-compilable note, logs contaminating stdout JSON, awkward `zotero_prepare_bundle` ergonomics, no section-level write, and figure-locating during Figure Map drafting. Adds a thin `zotero_intake` orchestrator and a body-only write tool.
**Depends on:** Spec 2 — Knowledge Base Workflow (CREATE/compile), Zotero Integration (2026-04-18), Figure Map (2026-06-13)
**Does NOT touch:** DB schema, KB pipeline (`kb_suggest`/`kb_apply`/mapping artifacts), serial numbering, the CREATE acronym framework, frontmatter field set

---

## 1. Problem

Feedback from an end-to-end intake of a single paper identified six friction points. The author believed the CLI was unpatchable ("not in this vault"); in fact all six live in this repo's `src/` and are fixable. Verified against source:

| # | Friction | Verified location |
|---|----------|-------------------|
| 1 | `compile_reading_note` caps source text at 10k tokens / 40k chars per source — a 29k-token paper returned only through ~Fig 6 (no Discussion/Methods/Figs 7–8). A second hidden cap parses only the first 20 PDF pages. | `PER_SOURCE_TOKEN_CAP = 10_000`, `SESSION_TOKEN_CAP = 30_000` ([source-loader.ts:14](../../../src/knowledge/source-loader.ts)); `pdfParse(buffer, { max: 20 })` (line 46) |
| 2 | The documented Zotero path (`fetch → prepare_bundle → create_reading_note`) creates a note with no `sources:`, so `compile` returns `sources_missing`. `create_reading_note` only sets sources when explicitly passed; the skill never passes them. | [SKILL.md:14,19](../../../skills/cricknote-reading-intake/SKILL.md); [templates.ts:53](../../../src/agent/tools/templates.ts); [kb-tools.ts:79](../../../src/agent/tools/kb-tools.ts) |
| 3 | Non-error logs are written to stdout — the same stream as the JSON result — so every captured call has an `INFO [source-loader] …` line prepended, breaking `json.load`. | [logger.ts:109,123](../../../src/utils/logger.ts) write to `process.stdout`; result written to stdout at [cli.ts:44](../../../src/cli.ts) |
| 4 | `zotero_prepare_bundle` can't take the `citekey` `fetch` just returned, ignores the `slug_prefix` `fetch` computed (forcing the agent to invent a slug), and reports a missing slug as `"Invalid slug format"` (sounds malformed). | [zotero-tools.ts:557](../../../src/agent/tools/zotero-tools.ts) params; `slug_prefix` returned at line 224; error at line 571 |
| 5 | To add analysis, `vault_write` demands the *entire* file including frontmatter — the agent must reproduce the folded-YAML title, 18-author list, and sources block exactly. No body-only or section-level write exists. | [vault.ts:142](../../../src/agent/tools/vault.ts) (`vault_write`), `vault_append` is end-only (line 105) |
| 6 | Figure *panels* extract as garbled symbol/whitespace soup; the Figure Map output already ships, but the compiled text has no page boundaries to help locate figures. | `source-loader` returns raw `pdf-parse` text, no page markers |

---

## 2. Decisions (resolved during brainstorming)

1. **Orchestration:** *Fix the seams + add a thin wrapper.* The discrete tools (`fetch`/`prepare_bundle`/`ingest`/`compile`) are well-factored and individually useful (abstract-only mode, multi-file bundles, re-ingest). Fix every seam so the manual chain is painless, then add a thin `zotero_intake` that calls the same three internally for the common one-call case. Discrete tools stay public. (Rejected: thick orchestrator that hides the steps and concentrates partial-failure recovery in one tool.)
2. **Truncation (#1):** *Raise caps so a normal paper returns whole in one call; add `offset`/`max_tokens` as the escape hatch* for the rare overflow. (Rejected: pagination-first — too many round-trips for the 95% case.)
3. **Figure input (#6):** *Page markers now, noise-stripping deferred.* Raising the caps removed the token-budget rationale for risky heuristic stripping of scientific text (α/β/γ, equations, data tables). Page boundaries give most of the locating benefit at zero content-loss risk.
4. **Body-only write (#5):** *`vault_write_body` (whole body, frontmatter preserved)*, not surgical per-section replace — the agent drafts all 7 sections (Figure Map + 6 CREATE) at once, so one call / one confirmation beats N confirmations.
5. **`create_reading_note` (#2):** *Repoint the skill to `ingest_reading_bundle` AND make `create_reading_note` defensive* (auto-discover bundle files when `sources` omitted and a bundle exists). Keeps `create`'s legitimate "note before any files" capability while closing the footgun.

---

## 3. Phased design

Four phases, ordered by risk. Each is independently shippable and TDD-tested (vitest, `tests/unit/*`).

### Phase 1 — Seam fixes (low risk, high relief)

**1a · Raise caps (#1).** In `source-loader.ts`:
- Let a single source draw the full session budget (drop the artificial 10k per-source ceiling below the session cap).
- Raise `SESSION_TOKEN_CAP` so a normal paper fits in one call (recommended **50_000** tokens ≈ 200k chars; tunable in plan — covers a long review + a NotebookLM summary while staying bounded).
- Raise the PDF page cap `pdfParse(buffer, { max: 20 })` → **`{ max: 80 }`** (covers paper + supplement; the token cap remains the real governor).

**1b · Logs → stderr (#3).** In `logger.ts`, route *all* levels to `process.stderr` (not just `error`). stdout becomes exclusively the result channel, so `cricknote tool …` output is always clean, pipeable JSON.

**1c · Slug error message (#4b).** In `zotero_prepare_bundle`, split the check: missing/empty slug → `slug is required.`; present-but-non-matching → `Invalid slug format: "<value>" (expected lowercase kebab-case).`

**1d · Skill repoint + defensive `create` (#2).**
- `SKILL.md`: change the Zotero path (line 14) and local-files path (line 19) from `create_reading_note` → `ingest_reading_bundle`.
- `create_reading_note`: when `sources` is omitted *and* `Reading/attachments/<slug>/` exists, auto-discover readable files (reuse the `discoverBundle` logic) and register them — so a direct call can't silently create a sourceless note.

### Phase 2 — `compile` pagination + page markers (#1b, #6)

**2a · Pagination.** `compile_reading_note` and `loadSources` gain optional `offset` (token offset into the compiled source stream, default 0) and `max_tokens` (per-call budget override, default = session cap). The payload gains a top-level `truncated: boolean`, `next_offset: number | null` (null when exhausted), and `tokens_remaining: number`, so overflow is unmistakable and pageable. Pagination operates over the concatenated source text in existing priority order (`notes → pdf → notebooklm → web → other`).

**2b · Page markers.** Switch `extractPdf` to per-page extraction (`pdf-parse` `pagerender` / page callback) and join with `\n\n--- page N ---\n\n` separators. **No content removed.** Helps the LLM cite "Fig 3 is on page 7" while drafting the Figure Map.

### Phase 3 — Body-only write (#5)

New `vault_write_body { path, body }` tool in `vault.ts`:
- Reads the existing file, splits it at the end of the frontmatter block, and replaces **only** the body region with `body` — the original frontmatter text is kept **verbatim** (no re-serialization, so quote style, key order, and folded-YAML author lists are untouched). Returns a `pending_edit` (same safe-write flow as `vault_append`, including `conflictDetector.recordFileRead`).
- Errors if the file does not exist (use `vault_write` to create) or has no frontmatter block (use `vault_write`).
- The agent drafts the full body (Figure Map + CREATE sections) and saves once — no frontmatter reproduction.

### Phase 4 — `zotero_intake` thin wrapper (#4a, orchestration)

New `zotero_intake { citekey? , doi?, zotero_key?, slug?, related_projects?, …selection-resume fields }` in `zotero-tools.ts`:
- Runs **fetch → prepare_bundle → ingest** internally by composing the existing handlers' `execute()` and parsing the JSON between steps (to detect `error` / `needs_*`). `fetch` and `prepare_bundle` are in-module; `ingest` is reached via a dynamic import of `createReadingIntakeTools(vaultPath)` with `conflictDetector` omitted — safe because a fresh note skips the conflict-snapshot path. (No 3-tool refactor required.)
- **Slug composition:** if `slug` given, validate and use it; else use `fetch`'s `slug_prefix` directly (already a valid slug). The agent never hand-threads `pdf_path` or invents a slug.
- **Metadata:** derived from `fetch`'s normalized CSL (title/authors/year/journal/doi); caller may override.
- **Passthrough:** if `fetch` returns `needs_item_selection` / `needs_attachment_selection`, return that payload unchanged (caller resolves, then retries) — the wrapper does not reimplement resume.
- **Returns:** the note's `pending_edit` plus `meta { slug, bundle_path, files_created }`, so the agent compiles next.
- **Partial failure is recoverable:** `prepare_bundle` copies the PDF (idempotent — matching hash is skipped) before `ingest` returns a `pending_edit`; a later failure leaves a valid bundle that re-running reuses.

---

## 4. Deferred (explicitly out of scope)

- **#6 figure noise-stripping** — dropping garbled panel lines while keeping legends. Deferred to a separate, carefully-validated pass (must not eat α/β/γ, equations, or data tables). Raising the caps removed its urgency.
- **Section-addressed `vault_replace_section`** — superseded by `vault_write_body` for the reading-note use case; revisit only if surgical single-section edits are needed elsewhere.
- **Forced template migration** for installs that predate page markers — same limitation noted in the Figure Map spec.

---

## 5. Critical-review findings (verified against source before implementation)

A pre-implementation pass confirmed feasibility and surfaced these notes — folded into the plan:

- **The stale worktree is not a blocker.** `.worktrees/feat-zotero` is fully merged into `main` (main 82 commits ahead, branch 0 ahead) and its `zotero-tools.ts` is byte-identical to main. Leftover cruft — flagged for separate cleanup, not touched here.
- **`logger.test.ts` encodes the old behaviour.** Seven assertions expect `info`/`warn`/`debug` on **stdout** (e.g. lines 25, 39, 52, 127). Routing all levels to stderr is a deliberate test rewrite (flip to `stderrSpy`), not a silent change. Intended: stdout becomes a pure data channel.
- **Cap tests change.** `source-loader.test.ts:34,63` assert the 10k/30k thresholds; both fixtures + expectations move to the new budget.
- **`discoverBundle` is private** (`reading-intake.ts:80`). Extract it to a shared module (e.g. `src/knowledge/reading-bundle.ts`) so `create_reading_note` (Phase 1d) reuses it rather than duplicating.
- **Page markers are feasible** via a custom `pdf-parse` `pagerender` that collects per-page text through a closure counter (pdf-parse 1.1.4 calls it sequentially per page).
- **Phase 4 is testable** with the existing `vi.mock('node:http')` pattern (`zotero-tools.test.ts:24`) — no live Zotero needed.
- **⚠️ Path-coupling constraint (latent bug).** `prepare_bundle` writes to `config.zotero.vault_pdf_dir/<slug>`, but `discover`/`ingest`/`compile` hardcode `Reading/attachments/<slug>`. They coincide **only because `vault_pdf_dir` defaults to `Reading/attachments`** (`config.ts:20`). The Zotero→ingest path (#2) and `zotero_intake` (Phase 4) therefore assume the default. **Mitigation (Phase 1d):** when Zotero is enabled and `vault_pdf_dir !== 'Reading/attachments'`, `zotero_intake` returns a clear error instead of silently producing a sourceless note. Full path-unification (threading `vault_pdf_dir` into discover/ingest/compile) is out of scope.

---

## 6. What Changes

### `src/knowledge/source-loader.ts` (Phase 1a, 2a, 2b)
- Replace the fixed 10k per-source *ceiling* so a single source can use the remaining session budget; raise `SESSION_TOKEN_CAP` to `50_000`.
- `extractPdf`: raise `{ max: 20 }` → `{ max: 80 }`; switch to per-page extraction and insert `--- page N ---` separators.
- `loadSources`: accept `{ offset?, maxTokens? }`; return `truncated`, `nextOffset`, `tokensRemaining` alongside `sources`/`warnings`/`totalTokens`.

### `src/agent/tools/kb-tools.ts` (Phase 2a)
- `compile_reading_note`: declare `offset` and `max_tokens` params; thread them into `loadSources`; surface `truncated`/`next_offset`/`tokens_remaining` in the payload and in the `instruction` text (tell the LLM how to fetch the rest).

### `src/utils/logger.ts` (Phase 1b)
- `log()`: write every level to `process.stderr` (remove the `level === 'error'` stdout/stderr branch in both `json` and `pretty` formats). File output unchanged.

### `src/agent/tools/zotero-tools.ts` (Phase 1c, 4)
- `zotero_prepare_bundle`: split the missing-vs-malformed slug error.
- Add `zotero_intake` tool (fetch→prepare→ingest orchestration, §3 Phase 4).

### `src/agent/tools/templates.ts` (Phase 1d)
- `create_reading_note`: when `sources` omitted and the bundle dir exists, auto-discover readable files and register them. Factor bundle discovery so it is shared with `reading-intake.ts` (avoid duplicating `discoverBundle`).

### `src/agent/tools/vault.ts` (Phase 3)
- Add `vault_write_body` tool (§3 Phase 3).

### `skills/cricknote-reading-intake/SKILL.md` (Phase 1d, 4)
- Repoint both paths to `ingest_reading_bundle`; add a one-line `zotero_intake` shortcut for the common case; mention `vault_write_body` in the "Write it" step; note the new `offset`/`max_tokens` for long papers.

### `src/agent/build-registry.ts` (Phase 3, 4)
- Register `vault_write_body` and `zotero_intake`.

### Tests (all phases)
- `tests/unit/source-loader.test.ts`: single large source uses full session budget; `SESSION_TOKEN_CAP` boundary; `offset`/`max_tokens` paging returns correct slices, `next_offset`/`tokens_remaining`/`truncated`; page markers present and content intact.
- `tests/unit/reading-note.test.ts` / new: `create_reading_note` auto-discovers when sources omitted + bundle exists; still works with no bundle (placeholder).
- New `vault_write_body` tests: frontmatter preserved exactly, body replaced, missing-file error, conflict snapshot recorded.
- New `zotero_intake` tests: slug from `slug_prefix`; explicit slug override; `needs_*_selection` passthrough; metadata derived from fetch; partial-failure idempotency.
- `logger` test: all levels go to stderr; stdout stays empty for non-result writes.

---

## 7. What Does Not Change

- Discrete tools `zotero_fetch_item`, `zotero_prepare_bundle`, `ingest_reading_bundle`, `compile_reading_note`, `vault_write`, `vault_append` keep their existing contracts (only additive params/fields).
- `create_reading_note`'s "create a note before any files exist" capability — preserved.
- CREATE framework, `hasCreateHeadings`, `inferReadingPipelineStep`, Figure Map output format.
- DB schema, KB pipeline, mapping artifacts, frontmatter field set, safe-write/conflict-detection flow.

---

## 8. Design Decisions and Rationale

**Why a thin wrapper, not a thick one?** The friction was in the seams, not the existence of steps. A thin `zotero_intake` reuses the discrete tools' logic and passes through their resume states, so flexibility and partial-failure recovery are preserved while the common case becomes one call.

**Why raise caps instead of paginating by default?** A typical paper (~29k tokens) is below a 50k session budget, so it returns whole in one call — what deep analysis needs. `offset`/`max_tokens` exist for the rare overflow without burdening the 95% case.

**Why defer figure noise-stripping?** Heuristics that detect "garbled" lines risk deleting real scientific content (symbols, equations, tables). With caps raised, the noise is affordable; page markers deliver the locating benefit safely. Stripping deserves its own validated pass.

**Why body-only write, not section-addressed?** The reading-note workflow fills all sections at once. Body-only is one call / one confirmation and structurally cannot clobber frontmatter — directly answering the feedback ("can't clobber frontmatter, far lighter on tokens").

**Why keep `create_reading_note` at all?** `ingest_reading_bundle` requires an existing bundle; `create` uniquely supports notes with no files yet (Threads, deferred captures). Making it defensive closes the footgun without losing that capability.

**Why logs to stderr (all levels), not just gated?** A CLI whose contract is "stdout = JSON result" must keep stdout pristine. Mixing any log line breaks `json.load`. stderr is the correct sink for all diagnostics; the optional log file already captures everything for later inspection.
