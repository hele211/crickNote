# CrickNote Spec 2: Knowledge Base Workflow

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Knowledge base structure, reading note ingestion (CREATE framework), kb_suggest, kb_apply, kb_lint tools, Review-Queue, Update Logs, Lint Reports.
**Depends on:** Spec 1 — Serial Numbering System
**Followed by:** Implementation planning for Spec 1 + Spec 2

---

## 1. Overview

CrickNote's experiment recording captures what a scientist does. This spec adds the second half: capturing what a scientist *knows* — compiled understanding from literature and experiments, maintained as a living knowledge base inside the same Obsidian vault.

### Goals

- Turn completed reading notes and experiment results into structured, evolving knowledge
- Human-in-the-loop at every judgment step — the LLM proposes, the user decides
- Small LLM context per operation — never load the whole knowledge base at once
- Full provenance — every claim traces back to a reading note or experiment
- Structural health monitoring via automated lint checks

### Non-goals

- Fully automated knowledge compilation (Karpathy-style LLM-only wiki)
- Zotero integration (future enhancement)
- Web clipping / defuddle integration (future enhancement)
- Vector/graph database beyond existing SQLite

---

## 2. Knowledge Folder Structure

```
Knowledge/
  Concepts/
    _index.md                              # auto-maintained catalog
    cd4-cd8-interaction.md
    cytokine-mediated-suppression.md
  Entities/
    _index.md                              # auto-maintained catalog
    il-42.md
    granzyme-b.md
    hela-cell-line.md
  Methods/
    _index.md                              # auto-maintained catalog
    western-blot-optimization.md
  Review-Queue/
    2026-04-08-il42-suppression-magnitude.md
  _Ops/
    Update-Logs/
      2026-04-08T143012-smith-2026-il42.md
    Lint-Reports/
      2026-04-08.md
```

- No serial numbers on knowledge notes — semantic names are the identity
- `aliases` field in frontmatter handles synonym matching
- `entity_type` is free text (gene, protein, cytokine, cell-line, mouse-strain, drug, organism, etc.) — grows organically, no fixed enum
- Each subfolder (`Concepts/`, `Entities/`, `Methods/`) has an `_index.md` auto-maintained by the agent

### Wikilink convention

All wikilinks use **filename-only style** (no path prefixes), consistent with Spec 1:
- `[[cd4-cd8-interaction]]` — not `[[Knowledge/Concepts/cd4-cd8-interaction]]`
- `[[smith-2026-il42-signalling]]` — not `[[Reading/Papers/smith-2026-il42-signalling]]`
- `[[CM003-qpcr]]` — not `[[Projects/P001-CellMigration/CM003-qpcr]]`

Obsidian resolves filename-only links automatically. Path-prefixed links are fragile if files move between folders. The context assembler's existing resolution logic handles disambiguation.

---

## 3. Knowledge Note Templates

### Concept

```yaml
---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk, helper-cytotoxic interaction]
last_updated: 2026-04-08
compiled_from:
  - [[smith-2026-il42-signalling]]
  - [[CM003-qpcr]]
needs_review: false
related_projects: [P001, P003]
see_also:
  - [[t-cell-suppression]]
  - [[il-42]]
---

# CD4-CD8 Interaction

## Current View
<!-- 2-3 sentence synthesis of current understanding across all sources -->

## Key Claims
<!-- Structured claim format: each claim is a bullet with [relation] tag and [[source]] link -->
<!-- This format enables machine-parseable lint checks for unsourced claims -->
<!--
  Format:  - [supports|contradicts|extends] Claim text. [[source-note]]
  Example: - [supports] IL-42 suppresses CD8 activity by ~40% in vitro. [[smith-2026-il42-signalling]]
-->

## Contradictions and Caveats
<!-- Unresolved disagreements between sources -->

## Open Questions
<!-- What you still don't know -->

## See Also
<!-- Cross-links to related knowledge notes -->
```

### Entity

```yaml
---
type: knowledge
knowledge_kind: entity
title: IL-42
entity_type: cytokine
aliases: [interleukin-42, IL42]
last_updated: 2026-04-08
compiled_from:
  - [[smith-2026-il42-signalling]]
needs_review: false
related_projects: [P001]
see_also:
  - [[cd4-cd8-interaction]]
---

# IL-42

## Summary
<!-- What this entity is, brief factual description -->

## Key Findings
<!-- Structured format: - [supports|contradicts|extends] Finding text. [[source-note]] -->

## Contradictions and Caveats

## Open Questions

## See Also
```

### Method

```yaml
---
type: knowledge
knowledge_kind: method
title: Western Blot Optimization
aliases: [immunoblot, WB]
last_updated: 2026-04-08
compiled_from:
  - [[jones-2025-wb-troubleshooting]]
  - [[CM001-western-blot]]
related_protocols:
  - [[PR001-western-blot]]
needs_review: false
related_projects: [P001]
see_also:
  - [[protein-quantification]]
---

# Western Blot Optimization

## Current Best Practice
<!-- Synthesized understanding of how to get this right -->

## Key Findings
<!-- Structured format: - [supports|contradicts|extends] Finding text. [[source-note]] -->

## Common Pitfalls

## Open Questions

## See Also
```

---

## 4. Structured Claim Format

All claims/findings in Knowledge notes use a structured bullet format that is both human-readable and machine-parseable:

```
- [supports] IL-42 suppresses CD8 activity by ~40% in vitro. [[smith-2026-il42-signalling]]
- [contradicts] Direct contact model is the primary suppression mechanism. [[zhang-2022-direct-contact]]
- [extends] IL-42 effect is cell-line dependent — 12% in HeLa vs 40% in Jurkat. [[CM003-qpcr]]
```

**Format:** `- [{relation}] {claim text}. [[{source-note}]]`

**Relation tags:** `supports`, `contradicts`, `extends`

**Why this matters:** `kb_lint` check #2 ("claim without source link") requires a machine-testable format. Free-form prose cannot be reliably scanned for unsourced claims. This bullet format lets the linter regex-match for `- \[` bullets and verify each has a `[[` source link.

`kb_apply` writes all new claims in this format. The agent is instructed (via Strong Rules) to always use this format when adding claims.

---

## 5. Knowledge Index Files

Each Knowledge subfolder has an `_index.md` auto-maintained by the agent on every `kb_apply` that creates or modifies a note in that folder.

Example `Knowledge/Concepts/_index.md`:

```markdown
---
type: index
folder: Knowledge/Concepts
last_updated: 2026-04-08
---

# Concepts

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
| [[cd4-cd8-interaction]] | cd4 cd8 crosstalk | 2026-04-08 | 2 |
| [[cytokine-mediated-suppression]] | cytokine suppression | 2026-04-08 | 1 |
| [[t-cell-suppression]] | T cell inhibition | 2026-04-05 | 3 |
```

These indexes serve dual purpose:
- **For the user:** browsable catalog in Obsidian
- **For `kb_suggest`:** compact view of all titles + aliases for concept matching, much cheaper than loading every knowledge note

---

## 6. Reading Note Ingestion

### Raw source storage

Raw inputs (PDF, NotebookLM output, web content, personal notes) are stored as attachments:

```
Reading/
  Papers/
    smith-2026-il42-signalling.md              ← the reading note
    smith-2026-il42-signalling-mapping.md      ← kb mapping artifact (later)
  attachments/
    smith-2026-il42-signalling/
      smith-2026-il42.pdf                      ← from Zotero or direct download
      notebooklm-summary.md                    ← AI-generated summary
      web-discussion.md                        ← clipped web content
      my-rough-notes.md                        ← your thoughts
```

### Reading note frontmatter

```yaml
---
title: IL-42 mediated CD4-CD8 suppression
authors: [Smith, Jones]
year: 2026
journal: Nature Immunology
doi: 10.xxxx/xxxxx
read_date: 2026-04-06
status: draft                    # draft | in-progress | complete
kb_status: pending               # pending | mapped | merged | merged_with_review | skipped
sources:
  - type: pdf
    path: smith-2026-il42.pdf
  - type: notebooklm
    path: notebooklm-summary.md
  - type: web
    path: web-discussion.md
  - type: notes
    path: my-rough-notes.md
related_projects: [P001, P003]
tags: [reading]
---
```

### The CREATE framework

Reading note body uses the CREATE scientific reading framework. This structures both human comprehension and LLM extraction:

```markdown
# {Title}
**Authors:** {authors}
**Journal:** {journal} ({year})
**DOI:** {doi}

## Claims
<!-- What does this paper assert? Main findings and conclusions -->

## Reasoning
<!-- How did they reach these conclusions? Key methods and logic -->

## Evidence
<!-- What data supports the claims? Key figures, statistics -->

## Assumptions
<!-- What's taken for granted? Potential weaknesses or limitations -->

## Takeaways
<!-- What matters for YOUR research? Why did you read this? -->

## Extensions
<!-- Open questions this raises. Where could this lead? -->
```

### How CREATE maps to KB extraction

`kb_suggest` reads across all CREATE sections — it does not extract per-section. But `kb_apply` uses specific sections for different purposes:

| CREATE section | What kb_suggest extracts | What kb_apply uses it for |
|---|---|---|
| Claims | Assertions about phenomena → Concepts | Supports or contradicts existing claims |
| | Assertions about named things → Entities | |
| Reasoning | Techniques used → Methods | Method-specific insights |
| | Named tools/assays → Entities | |
| Evidence | (enriches Claims mapping) | Strength of support/contradiction |
| Assumptions | Caveats, limitations | Contradictions and Caveats section |
| | Contradictions with consensus → Concepts | Review-Queue candidates |
| Takeaways | Project relevance | `related_projects` field |
| | New concepts identified → Concepts (NEW) | |
| Extensions | Open questions | Open Questions in knowledge notes |
| | Suggested future work → Concepts/Entities (NEW) | |

### Source loaders

When the compile step reads files listed in `sources`, different file types require different handling:

| File type | Loader | Behavior |
|-----------|--------|----------|
| `.md` | Direct read | Load full content into context |
| `.txt` | Direct read | Load full content into context |
| `.pdf` | PDF extractor | Extract text via the Read tool's PDF support. Limit to first 20 pages. If extraction fails, log warning and skip. |
| `.xlsx`, `.csv` | Not supported (v1) | Log warning: "Cannot read spreadsheet — paste key data into a .md source file" |
| Images (`.png`, `.jpg`) | Not supported (v1) | Log warning: "Cannot read image — describe key figures in a .md source file" |

**Size limits:**
- **Per-source cap:** Each source file is capped at 10,000 tokens. If a source exceeds this, the loader truncates with a warning.
- **Total session cap:** The combined loaded content for a single compile step is capped at 30,000 tokens. Sources are loaded in priority order: (1) the main `.md`/`.txt` source, (2) PDF, (3) NotebookLM summary, (4) web content, (5) personal notes. If the running total hits the cap, remaining sources are skipped with a warning suggesting the user consolidate key points into fewer source files.

**Fallback:** If a source path does not exist or cannot be read, the compile step logs a warning and continues with remaining sources. It does not fail the entire compile.

### Compile step

When the user has added raw sources and says "compile this reading note":

1. Load all files listed in `sources` using the appropriate loader (see table above)
2. LLM reads loaded content and drafts CREATE sections
3. Reading note is written via safe-writer (user reviews diff)
4. User edits — especially Assumptions, Takeaways, Extensions (personal judgment)
5. User marks `status: complete` when satisfied

The LLM draft is clearly a starting point. The scientific value comes from the user's edits and thinking.

---

## 7. `kb_status` State Machine

```
pending → mapped → merged
                 → merged_with_review
                 → skipped
```

- **`pending`** — reading note is `status: complete`, not yet processed by `kb_suggest`
- **`mapped`** — `kb_suggest` done, mapping confirmed by user, `kb_apply` not yet run (or partially run)
- **`merged`** — all `kb_apply` updates complete, no items deferred to Review-Queue
- **`merged_with_review`** — all `kb_apply` updates complete, but one or more items were deferred to Review-Queue. This reading note has unresolved knowledge. When the last deferred Review-Queue item linked to this source is resolved, the status transitions to `merged`.
- **`skipped`** — user decided this reading note has no knowledge-base-worthy content

This supports crash recovery: if a session drops between suggest and apply, the note is `mapped` and the mapping artifact exists on disk. Pick up where you left off.

The distinction between `merged` and `merged_with_review` matters for `kb_lint`: a `merged_with_review` note has outstanding intellectual debt. Lint check #4 can surface these alongside `pending` notes.

Experiment notes do not have `kb_status`. Their contribution to knowledge is tracked from the other side — the knowledge note's `compiled_from` lists the experiment.

---

## 8. Tools

### `kb_suggest`

**Purpose:** Given a source note, propose which Knowledge notes to update or create.

**Input:**
- `source` (required): path to any note (reading, experiment, series) — passed through `resolveVaultPath()` before any file read

**Flow:**
1. Read source note in full (entire content regardless of note type — no section filtering)
2. Read `Knowledge/Concepts/_index.md`, `Knowledge/Entities/_index.md`, `Knowledge/Methods/_index.md` — get all titles and aliases in one compact load
3. Match source content against titles + aliases
4. Also run `vault_search` against `Knowledge/` for semantic matches the index might miss
5. Propose mapping with confidence tiers:

```
PROPOSED KNOWLEDGE UPDATES:

HIGH confidence:
  [[cd4-cd8-interaction]]  — paper's central topic
  [[il-42]]                — key entity discussed

MEDIUM confidence:
  [[western-blot-optimization]] — method used

NEW (not yet in knowledge base):
  Suggest creating: Knowledge/Entities/granzyme-b (entity_type: protein)
  Suggest creating: Knowledge/Concepts/cytokine-mediated-suppression
```

6. User confirms, edits, or rejects each proposed link via conversation

**Two outcomes after user response:**

**A. User confirms at least one target:**
7. Auto-write confirmed mapping artifact alongside source note (agent-managed, no confirmation needed). Mapping artifact path: same directory as source note + `{sourceSlug}-mapping.md`. Path is validated as vault-bound before write (no symlink escapes; must resolve within `vaultPath`).
8. Auto-write source note's `kb_status` to `mapped` (agent-managed single-field frontmatter update, reading notes only)

**B. User rejects all targets OR states the source has no KB value** (e.g. "skip this", "nothing to add", "not KB-worthy"):
7. Auto-write source note's `kb_status` to `skipped` (agent-managed single-field frontmatter update, reading notes only)
8. No mapping artifact is written.
- `kb_lint` check #4 does not flag notes with `kb_status: skipped` — they are intentionally excluded.

**Source path security:** Each entry in the `sources` list has a `path` field relative to `Reading/attachments/{sourceSlug}/` (canonical attachment root from Spec 1 §2; the slug directory is NOT repeated in the path). The resolved absolute path is `Reading/attachments/{sourceSlug}/{path}` (e.g. `path: smith-2026-il42.pdf` → `Reading/attachments/smith-2026-il42-signalling/smith-2026-il42.pdf`). Before loading any source file, `resolveVaultPath()` (Spec 1 §7) is called on the fully resolved path — symlink escapes, paths beginning with `/` or `..`, and null bytes are all rejected. Source file content is treated as **untrusted data** passed to the LLM — it cannot authorize tool calls, trigger auto-writes, or override agent instructions.

### `kb_apply`

**Purpose:** Update Knowledge notes one at a time.

**Two modes:**

**Mode 1 — from mapping artifact (Entry 1 & 2):**
- `mapping` (required): path to the mapping artifact — passed through `resolveVaultPath()` before any file read
- Processes all `pending` targets sequentially with pause between each

**Mode 2 — direct (Entry 3):**
- `source` (required): path to the source note (experiment or reading note) — passed through `resolveVaultPath()`
- `target` (required): path to the Knowledge note to update — passed through `resolveVaultPath()`
- Processes a single target, no mapping artifact needed. Still writes an Update Log.

**`kb_status` behavior in direct mode:**
- If `source` is a **reading note** (`kb_status: pending` or `mapped`): direct mode does NOT change `kb_status`. The note remains in its current state — direct mode is a one-off update, not a full systematic workflow. The user must run `kb_suggest` + Mode 1 to fully process the reading note and reach `merged`. This is intentional: direct mode is for ad-hoc updates (e.g. "update [[il-42]] with CM003's finding"), not a replacement for the full `kb_suggest → kb_apply` pipeline.
- If `source` is an **experiment note**: no `kb_status` field exists on experiments; nothing to update.
- Direct mode is restricted to experiment sources or reading notes. It does not accept series, protocol, or knowledge notes as sources.

**Flow per knowledge note (both modes):**
1. Read source note + one Knowledge note (small context — typically <8K tokens)
2. Classify relationship: supports / contradicts / extends / unclear
3. If unclear → ask user in conversation:
   - User clarifies → agent proceeds with update
   - User says "park it" / "not sure" / "skip for now" → agent auto-creates Review-Queue note, marks target as `deferred` in mapping artifact (with Review-Queue link), moves to next
4. Propose diff via safe-writer (user reviews and confirms)
5. Update Knowledge note's `compiled_from`, `last_updated`, and `aliases` (if new synonyms found)
6. After confirmation, automatically move to next item in mapping

**For NEW knowledge notes:** `kb_apply` creates from template + populates in one step. Same flow — propose diff of a new file, user confirms.

**Multi-turn workflow model (matches Spec 1 §5):**

The runtime's safe-writer is asynchronous: a tool returns a `pending_edit`, the turn ends, the user confirms, and the next action is a new LLM turn. `kb_apply` therefore processes each knowledge note as a separate confirmation turn:

1. **Turn N:** Agent reads source + one target knowledge note, proposes diff → `pending_edit` for the knowledge note. Turn ends.
2. **Turn N+1:** User confirms (or rejects/defers) and sends "continue". Agent auto-writes mapping artifact state update for that target (agent-managed, no confirmation needed), then reads the next `pending` target and proposes its diff → `pending_edit`. Turn ends.
3. Repeat until all targets are processed.

The mapping artifact update, `kb_status` update, index file updates, and Update Log write are all **agent-managed** (see §8 "Agent-managed file ownership policy") and do not require user confirmation. Only knowledge note diffs are user-owned and require confirmation.

If a session drops mid-workflow, the mapping artifact's per-target states record exactly where to resume.

**Crash recovery dedupe rules:** If a session drops after the user confirms a knowledge note diff but before the mapping artifact is updated (i.e., a target is `pending` in the mapping but its content appears already updated on disk), the agent must not re-apply the same source claims. On resume, before proposing a diff for any `pending` target, the agent checks the target knowledge note's `compiled_from` list: if the source is already listed, skip this target and immediately mark it `applied` in the mapping artifact. This prevents duplicate `compiled_from` entries and duplicate claim bullets. The `compiled_from` list acts as the idempotency key — it is a **set** (no duplicate source links; duplicates are silently deduplicated on write).

**Workflow continuation:** After each confirmation, the UI shows a "Continue" button (see Spec 1 §5 "Workflow continuation after confirmation"). The user clicks it or types "continue". The agent calls `get_workflow_events` (cursor-based — see Spec 1 §7 for details) to see what was confirmed, then checks mapping artifact state to find the next `pending` target. This is the same user-driven continuation model used by all multi-turn workflows.

**After all items processed (final turn):**
1. Update source note's `kb_status`: `merged` if no items were deferred to Review-Queue, `merged_with_review` if any were deferred (reading notes only)
2. Update mapping artifact's `status` to `applied`
3. Update relevant `Knowledge/{kind}/_index.md` files — by **scanning the subfolder directly**: the agent reads all `.md` files in `Knowledge/Concepts/`, `Knowledge/Entities/`, or `Knowledge/Methods/` (excluding `_index.md`) and extracts `title`, `aliases`, `last_updated`, and `compiled_from` count from their frontmatter. This avoids stale DB rows — the DB may not yet reflect recently confirmed knowledge note writes. Direct folder scan is the authoritative source for index rebuilds. Rows are sorted by `title asc` (case-insensitive) for stable, diff-friendly output.
4. Write Update Log to `Knowledge/_Ops/Update-Logs/`

### Agent-managed file ownership policy

Not every vault write needs user confirmation. Ownership is defined at the **section level**, not the file level. A single file can contain both user-owned and agent-managed sections.

**User-owned (require safe-writer confirmation):**
- Knowledge note content (`Knowledge/Concepts/`, `Entities/`, `Methods/`)
- Experiment note content, protocol note content
- Reading note content
- User-written sections in project `_index.md` (everything **outside** named `<!-- AUTO-GENERATED: … -->` / `<!-- END AUTO-GENERATED: … -->` fences: Related Knowledge, Related Reading, Related Protocols, Open Questions)
- User-written sections in series headers (everything outside fences: Objective, Summary — the agent never auto-writes Summary; see Spec 1 §9)

**Agent-managed sections within user-owned files (auto-updated via `fencedSectionUpdate()`, no confirmation needed):**
- Auto-generated sections between named `<!-- AUTO-GENERATED: {section-name} -->` / `<!-- END AUTO-GENERATED: {section-name} -->` fences in project `_index.md` (sections: `experiment-log`, `project-summary`)
- Auto-generated experiment table between `<!-- AUTO-GENERATED: experiment-list -->` / `<!-- END AUTO-GENERATED: experiment-list -->` fences in series headers

These are updated via the `fencedSectionUpdate()` function (see below), which only touches content between fence markers and errors if markers are missing.

**Agent-managed whole files (auto-written via `autoWrite()`, no confirmation needed):**
- Review-Queue notes (`Knowledge/Review-Queue/`) — created during "park it" deferral. The user has already expressed their decision to defer in conversation; the note is a machine-generated artifact of that decision.
- Mapping artifacts (`*-mapping.md`) — workflow state, not user content
- Update Logs (`Knowledge/_Ops/Update-Logs/`) — append-only audit trail
- Lint Reports (`Knowledge/_Ops/Lint-Reports/`) — diagnostic output
- `Knowledge/{kind}/_index.md` files — rebuilt by direct folder scan of each subfolder, no user-written content

### `fencedSectionUpdate(filePath, sectionName, newContent)` function

The **only legal write path** for auto-generated blocks in files that also contain user-owned content. It is a distinct higher-level operation from `autoWrite()` — it operates on **mixed-ownership files** (project `_index.md`, series headers) whereas `autoWrite()` operates on **wholly agent-managed files**.

**Eligible paths for `fencedSectionUpdate()`** (separate from the `autoWrite()` whole-file allowlist):
- `Projects/P{NNN}-*/_index.md` (project indexes)
- `Projects/P{NNN}-*/{prefix}S{NNN}-*.md` (series headers)

**Behavior:**
1. Verify `filePath` is on the `fencedSectionUpdate` eligible path list (hard error if not)
2. Read the file at `filePath` and capture its content hash (SHA-256 of file content)
3. Find `<!-- AUTO-GENERATED: {sectionName} -->` opening marker matching the given `sectionName`
4. Find the corresponding `<!-- END AUTO-GENERATED: {sectionName} -->` closing marker
5. Replace only the content between those markers with `newContent`
6. Leave everything outside those markers untouched (other named sections and user-written sections are unaffected)
7. Before writing, re-read the file and compare hash to the one captured in step 2
8. If hash matches → write the result using the same file-write primitive as `autoWrite()` (no safe-writer confirmation; logs to chat history; triggers file watcher)
9. If hash differs → the file was modified between read and write. **Retry once** (go back to step 2 with the fresh file content). If the second attempt also conflicts, abort with an error.

**Conflict protection:** The hash check (steps 7-9) mirrors the safe-writer's conflict detection (`safe-writer.ts` L81, L147) but without user confirmation. Since fenced-section updates are agent-managed, the retry-once-then-abort strategy is appropriate — it handles benign races (file watcher reindexing) while preventing silent data loss from concurrent edits.

**Error conditions (hard errors, not silent fallback):**
- `filePath` not on the eligible list → error: "fencedSectionUpdate not permitted for {filePath}"
- Opening marker for `sectionName` not found → error: "AUTO-GENERATED fence '{sectionName}' not found in {filePath}"
- Closing marker for `sectionName` not found → error: "END AUTO-GENERATED fence '{sectionName}' not found in {filePath}"
- Duplicate named marker → error: "Duplicate AUTO-GENERATED fence '{sectionName}' in {filePath}"
- Conflict after retry → error: "Conflict persists after retry for {filePath} — aborting fenced update"

This function is the safety mechanism that prevents agent-managed writes from overwriting user content. Path-based allowlists alone cannot provide this guarantee for mixed-ownership files.

### `autoWrite()` function

Writes **wholly agent-managed files** (no user-owned content). Bypasses safe-writer confirmation. This is the write primitive used internally by `fencedSectionUpdate()` for the final disk write, but `autoWrite()` called directly is restricted to whole-file targets only.

**Whole-file allowlist (direct `autoWrite()` targets):**
- `Knowledge/Review-Queue/*`
- Mapping artifacts: `Reading/Papers/{slug}-mapping.md`, `Reading/Threads/{slug}-mapping.md`, `Projects/P{NNN}-*/{slug}-mapping.md`
- `Knowledge/_Ops/Update-Logs/*`
- `Knowledge/_Ops/Lint-Reports/*`
- `Knowledge/{Concepts,Entities,Methods}/_index.md`

Single-field frontmatter updates (`kb_status`, `needs_review`, `review_flagged_at`) are **not** done via whole-file `autoWrite()`. They use the dedicated `frontmatterFieldUpdate()` function described below.

**All `autoWrite()` calls (whether direct or via `fencedSectionUpdate()`):**
- Resolve path to absolute; verify it stays within `vaultPath` (no symlink escapes)
- Still goes through the file watcher for reindexing
- Still logs the write to chat history so the user sees what happened

This policy eliminates the "confirmation fatigue" problem: a `kb_apply` session with 5 targets would otherwise require ~15 confirmations (5 knowledge note diffs + 5 mapping updates + index updates + update log + kb_status updates). With this policy, the user confirms only the 5 knowledge note diffs — the rest happens automatically.

### `frontmatterFieldUpdate(filePath, field, value)` function

The **only legal write path** for agent-managed single frontmatter field updates in user-owned files. Used for `kb_status` (reading notes), `needs_review`, and `review_flagged_at` (knowledge notes). NOT used for content fields — those go through safe-writer.

**Eligible paths:**
- `Reading/Papers/*` and `Reading/Threads/*` → `kb_status` field only
- `Knowledge/{Concepts,Entities,Methods}/*` (excluding `_index.md`) → `needs_review` and `review_flagged_at` fields only

**Behavior:**
1. Call `resolveVaultPath()` on `filePath` (Spec 1 §7)
2. Verify `filePath` is on the eligible path list for the given `field` (hard error otherwise)
3. Read the file and capture SHA-256 hash
4. Parse YAML frontmatter; update **only** the specified `field`; leave all other keys unchanged (including unknown user keys)
5. Re-read the file and compare hash
6. If hash matches → write the updated frontmatter back (file-write primitive, no safe-writer; logs to chat history; triggers file watcher)
7. If hash differs → retry once from step 3. If still conflicts → abort with error: "Conflict updating {field} in {filePath} — file changed during update"

This is identical in structure to `fencedSectionUpdate()` but operates at the YAML frontmatter level instead of the markdown fence level. Both share the same retry-once-then-abort conflict strategy.

### `kb_lint`

**Purpose:** Structural health check of the knowledge base.

**Input:**
- `target` (optional): specific folder or note to lint — passed through `resolveVaultPath()` if provided. Default: entire vault.

**8 checks:**

Urgent:
1. Knowledge note has no `compiled_from` — no source attribution
2. Claim in a Knowledge note has no source link — unattributed assertion
3. Broken wikilinks between any notes — link target doesn't exist

Needs attention:
4. Reading note is `status: complete` + `kb_status` in (`pending`, `mapped`, `merged_with_review`) — unfinished KB work
5. Knowledge note has `needs_review: true` where `review_flagged_at` is older than 14 days — stale review flag (see `needs_review` transitions below)
6. Review-Queue item where `created` date is older than 14 days and `status: pending` — forgotten item

Nice to improve:
7. Duplicate/overlapping Knowledge notes — similar titles or heavy alias overlap
8. Knowledge note not updated despite newer related reading notes existing — stale content

**Output:** Writes report to `Knowledge/_Ops/Lint-Reports/{YYYY-MM-DD}.md`

**Periodic reminder:** If lint hasn't run in 14 days, agent includes a one-line nudge in the daily diary context injection: "KB lint hasn't run in 14 days. N reading notes have unfinished KB work (pending, mapped, or merged_with_review)."

---

## 9. Three Entry Points

### Entry 1: Reading note → systematic KB update

```
You write reading note, mark status: complete
  │
  ▼
kb_suggest (reads note + Knowledge indexes)
  │
  ▼
Proposes mapping (HIGH / MEDIUM / NEW)
  │
  ▼
You confirm/edit/reject in conversation
  │
  ▼
Mapping artifact saved, kb_status → mapped
  │
  ▼
kb_apply (sequential, one concept at a time)
  │
  ├─ Clear relationship → propose diff → you confirm
  ├─ Unclear → ask you → you clarify or park it → Review-Queue
  │
  ▼
All done → kb_status → merged (or merged_with_review if items deferred)
         → Index files updated
         → Update Log written
```

### Entry 2: Experiment → "where does this fit?"

```
You say "which concept does CM003's finding fit into?"
  │
  ▼
kb_suggest (reads CM003 in full + Knowledge indexes)
  │
  ▼
Same flow as Entry 1 from here
(no kb_status update — experiments don't have kb_status)
```

### Entry 3: Direct update

```
You say "update cd4-cd8-interaction with CM003's result"
  │
  ▼
kb_apply directly (reads CM003 + one concept note)
  │
  ▼
Classify relationship → propose diff → you confirm
  │
  ▼
compiled_from updated, index updated, Update Log written
```

---

## 10. Mapping Artifact

Saved alongside the source note. For reading notes: `Reading/Papers/{slug}-mapping.md` or `Reading/Threads/{slug}-mapping.md`. For experiments: alongside the experiment note in the project folder (e.g. `Projects/P001-CellMigration/CM003-qpcr-mapping.md`).

**Collision handling:** If a mapping artifact already exists when `kb_suggest` completes:
- If the existing artifact has `status: applied` → the source was fully processed. Ask the user: "This source already has a completed mapping. Run again to update new knowledge notes?" If yes, create a **new artifact** with a precise timestamp suffix: `{slug}-mapping-{YYYY-MM-DD}T{HHmmss}.md` (same precision as Update Logs, preventing same-day collision). Old artifact is preserved.
- If the existing artifact has `status: confirmed` (in-progress) → **resume**: do not overwrite. Inform the user: "A mapping is already in progress. Run `kb_apply` to continue." Agent proceeds to `kb_apply` with the existing artifact.
- If the existing artifact has `status: draft` (unconfirmed) → overwrite with the new `kb_suggest` output (the user hadn't confirmed it yet).

```yaml
---
type: kb-mapping
source: [[smith-2026-il42-signalling]]
created: 2026-04-08
status: confirmed        # draft | confirmed | applied
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | applied | | 2026-04-08T14:30 |
| [[il-42]] | create | applied | | 2026-04-08T14:35 |
| [[granzyme-b]] | create | deferred | [[2026-04-08-granzyme-role]] | 2026-04-08T14:40 |
| [[cytokine-mediated-suppression]] | create | pending | | |

## Rejected
- [[western-blot-optimization]] — "just used as method, no new insight"
```

### Per-target state for crash recovery

Each target in the mapping artifact has its own state: `pending`, `applied`, `skipped`, or `deferred`. If a session drops mid-way through `kb_apply`, the mapping artifact records exactly which targets were completed. On resume, `kb_apply` reads the mapping, skips targets already marked `applied` or `deferred`, and continues from the first `pending` target.

- **`pending`** — not yet processed
- **`applied`** — successfully updated/created, user confirmed
- **`skipped`** — user explicitly rejected this target (no future action)
- **`deferred`** — user expressed uncertainty, a Review-Queue note was created. The `Review-Queue` column links to the created Review-Queue note for traceability. Distinguished from `skipped` because `deferred` represents outstanding intellectual debt.

The top-level `status` field reflects the aggregate:
- `draft` → `kb_suggest` output before user confirmation
- `confirmed` → user approved, at least one target still `pending`
- `applied` → all targets are `applied`, `skipped`, or `deferred` (none `pending`)

---

## 11. Review-Queue

### When items are created

Auto-created by the agent when the user expresses uncertainty during `kb_apply`:
- "Park it", "not sure", "skip for now", "I'll look at this later"
- The agent recognizes deferral language and creates the note automatically

### Template

```yaml
---
type: review-queue
source: [[smith-2026-il42-signalling]]
target_concept: [[cd4-cd8-interaction]]
reason: ambiguous-relationship
created: 2026-04-08
status: pending          # pending | resolved | dismissed
---

# IL-42 suppression magnitude — context conflict

## The Issue
Smith 2026 reports 40% CD8 suppression via IL-42 in Jurkat cells.
Existing concept note cites Zhang 2022 at 15% in primary T cells.
Unclear if this is a genuine contradiction or a cell-line effect.

## Source Claim
<!-- What the new source says -->

## Existing Knowledge
<!-- What the concept note currently says -->

## Resolution
<!-- Filled in when you resolve it -->
```

### Resolution flow

User says "let's resolve the IL-42 conflict":
1. Agent reads the Review-Queue note, asks what to do
2. User decides in conversation
3. Agent runs `kb_apply` on the target concept with the user's guidance (user confirms diff)

**"Resolve review item" transaction — all state updates after the user confirms the kb_apply diff:**

| What | Update | Why |
|------|--------|-----|
| Review-Queue note | `status: resolved` + one-line summary in Resolution section | Marks the item as done |
| Target Knowledge note `needs_review` | Set to `false`, `review_flagged_at` = null (if no other pending Review-Queue items target this note) | Clears the lint flag |
| Mapping artifact row (if one exists) | Target state: `deferred` → `applied` | Keeps the mapping artifact accurate |
| Source reading note `kb_status` | If this was the **last** unresolved Review-Queue item linked to this source: `merged_with_review` → `merged` | Reflects that all intellectual debt is cleared |

The agent checks "is this the last one?" by **scanning `Knowledge/Review-Queue/` files directly** — not the DB — because the just-auto-written Review-Queue note (marked `status: resolved`) may not yet be reindexed by the async file watcher. Direct file scan reads frontmatter from every `.md` file in `Knowledge/Review-Queue/` and counts those where `rq_source` matches the source and `status: pending`. This avoids stale DB counts.

The DB query below is provided for staleness checks in `kb_lint` only (where DB currency is acceptable for lint purposes):

```sql
SELECT COUNT(*) FROM note_metadata
WHERE knowledge_kind = 'review' AND rq_source = ? AND status = 'pending'
```

No separate `review_queue` table is needed. Review-Queue notes are indexed by the parser like any other note type.

If other Review-Queue items remain for the same source or the same target, only the applicable subset of updates are performed.

---

## 12. Update Log

One log per `kb_apply` session, written to `Knowledge/_Ops/Update-Logs/`. Filename uses a timestamp suffix to prevent same-day collision: `{YYYY-MM-DD}T{HHmmss}-{sourceSlug}.md` (e.g. `2026-04-08T143012-smith-2026-il42.md`). This ensures multiple `kb_apply` sessions for the same source on the same day do not overwrite each other's audit trail.

```yaml
---
type: update-log
source: [[smith-2026-il42-signalling]]
date: 2026-04-08
---

# KB Update Log — smith-2026-il42

## Updated
- [[cd4-cd8-interaction]] — added IL-42 suppression claim (contradicts Zhang 2022)

## Created
- [[il-42]] — new entity note
- [[granzyme-b]] — new entity note

## Deferred to Review
- [[2026-04-08-il42-suppression-magnitude]]

## Notes
- User confirmed cell-line effect as possible explanation for magnitude difference
```

---

## 13. Lint Report

One report per lint run, written to `Knowledge/_Ops/Lint-Reports/`.

```yaml
---
type: lint-report
date: 2026-04-08
---

# KB Lint Report — 2026-04-08

## Urgent
- [[t-cell-suppression]] has 2 claims without source links
- [[western-blot-optimization]] links to a missing note

## Needs Attention
- [[jones-2025-wb-troubleshooting]] is complete but not merged
- Review-Queue item [[2026-04-08-il42-suppression-magnitude]] pending 12 days

## Nice to Improve
- [[cell-migration]] may overlap with [[cell-motility]]
- [[il-42]] not updated since 2026-04-08, 2 newer related reading notes exist
```

---

## 14. Strong Rules for KB Tools

These rules are encoded in the agent's system prompt / skills file. They govern LLM behavior during `kb_suggest` and `kb_apply`:

1. **Prefer updating an existing Knowledge note over creating a new one.** Only suggest NEW when no existing note covers the topic.
2. **Every structured claim bullet must have a source link.** Claims in "Key Claims" / "Key Findings" sections use the `- [{relation}] {text}. [[{source}]]` format. `kb_lint` enforces this mechanically. Prose synthesis sections ("Current View", "Summary", "Current Best Practice") are exempt from per-sentence source links — they are the user's own synthesis. However, the agent should include inline `[[source]]` references in prose when making specific factual statements.
3. **Never silently delete an old claim.** If a new source disagrees, add the new claim with a contradiction tag. The old claim stays with a note that it's been challenged.
4. **Put disagreements into Contradictions and Caveats.** Don't bury conflicts — surface them explicitly.
5. **If confidence is low, ask the user.** Don't guess. If the user is also unsure, park it in Review-Queue.
6. **One source should usually update 1-5 existing knowledge notes.** Creating new notes has no limit — a paper introducing a new pathway might create 10 entity notes. But if `kb_suggest` proposes updating more than 5 existing concept notes, flag it — the source may warrant a Thread note first.
7. **Current View is a synthesis, not a copy.** The "Current View" section should reflect overall understanding across all sources, not just repeat the latest paper. It is the user's own interpretation and does not require per-sentence attribution.
8. **Aliases must be maintained.** When `kb_apply` encounters a new synonym for an existing concept/entity, add it to the `aliases` field.

---

## 15. Database Changes

### New columns on `note_metadata`

```sql
ALTER TABLE note_metadata ADD COLUMN kb_status TEXT;
ALTER TABLE note_metadata ADD COLUMN knowledge_kind TEXT;
ALTER TABLE note_metadata ADD COLUMN needs_review INTEGER DEFAULT 0;
ALTER TABLE note_metadata ADD COLUMN review_flagged_at TEXT;
ALTER TABLE note_metadata ADD COLUMN aliases TEXT;
ALTER TABLE note_metadata ADD COLUMN rq_source TEXT;
ALTER TABLE note_metadata ADD COLUMN rq_target TEXT;
```

- `kb_status`: pending / mapped / merged / merged_with_review / skipped (reading notes only)
- `knowledge_kind`: concept / entity / method / review (knowledge and review-queue notes). The `review` value is set for `Knowledge/Review-Queue/*` notes, enabling the resolution flow query.
- `needs_review`: boolean flag for lint checks
- `review_flagged_at`: ISO timestamp of when `needs_review` was set to true
- `aliases`: JSON array of alternative names for matching
- `rq_source`: for Review-Queue notes, the wikilink target of the `source` frontmatter field (e.g. `smith-2026-il42-signalling`). Extracted by parser.
- `rq_target`: for Review-Queue notes, the wikilink target of the `target_concept` frontmatter field. Extracted by parser.

Review-Queue notes are indexed by the parser like any other note type. Their `status` (pending/resolved/dismissed) is stored in the existing `status` column on `note_metadata`. The `rq_source` and `rq_target` columns support lint and reporting queries (e.g. `kb_lint` check #6). The resolution flow "is this the last one?" check uses **direct file scan** of `Knowledge/Review-Queue/` (see §11) — not a DB query — because just-written notes may not yet be reindexed.

### New indexes

```sql
CREATE INDEX idx_note_metadata_kb_status ON note_metadata(kb_status);
CREATE INDEX idx_note_metadata_needs_review ON note_metadata(needs_review);
```

Enables lint queries like:
- `WHERE note_type = 'reading' AND status = 'complete' AND kb_status IN ('pending', 'mapped', 'merged_with_review')` → unfinished KB work
- `WHERE needs_review = 1 AND review_flagged_at < date('now', '-14 days')` → stale review items

### `needs_review` state transitions

The `needs_review` flag on Knowledge notes is set and cleared by specific events:

**Set to `true` (and `review_flagged_at` = now):**
- `kb_apply` adds a contradiction to the note's "Contradictions and Caveats" section
- A Review-Queue item is created that targets this Knowledge note
- The user manually flags a note for review via conversation

**Set to `false` (and `review_flagged_at` = null):**
- The user resolves all Review-Queue items targeting this note
- The user explicitly clears the flag via conversation ("mark cd4-cd8-interaction as reviewed")
- `kb_apply` updates the note and the user confirms the contradictions are resolved

---

## 16. Setup Changes

The `cricknote setup` command creates the Knowledge folder structure:

```
Knowledge/
  Concepts/
    _index.md
  Entities/
    _index.md
  Methods/
    _index.md
  Review-Queue/
  _Ops/
    Update-Logs/
    Lint-Reports/
```

Reading subfolder structure:

```
Reading/
  Papers/
  Threads/
  attachments/
```

Initial `_index.md` files are created with empty tables and correct frontmatter.

---

## 17. Future Enhancements (Out of Scope)

- **Zotero integration** — auto-populate reading note metadata from Zotero library entries
- **Web clipping / defuddle** — feed web content directly into reading note sources
- **obsidian-skills integration** — improve Obsidian-specific formatting
- **Obsidian Base files** — `.base` views for Knowledge indexes
- **Thread compilation** — cross-paper analysis notes that synthesize multiple reading notes before updating knowledge
