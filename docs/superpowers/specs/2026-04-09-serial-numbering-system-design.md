# CrickNote Spec 1: Serial Numbering System

**Date:** 2026-04-09
**Status:** Draft
**Scope:** Serial numbering for projects, experiments, series, and protocols. Vault folder restructuring. Tool changes. Database additions.
**Depends on:** Nothing (fresh vault, no migration)
**Followed by:** Spec 2 — Knowledge Base Workflow

---

## 1. Overview

CrickNote currently uses date-based filenames and free-text project folder names. This spec introduces a serial numbering system that gives every project, experiment, experiment series, and protocol a short, stable, human-friendly identifier (e.g. `P001`, `CM001`, `CMS001`, `PR001`).

### Goals

- Quick verbal and written reference ("run CM003 again")
- Clear ordering and counting within a project
- Stable identifiers that don't change when titles are edited
- Consistent naming grammar across the entire vault

### Non-goals

- Migrating existing notes (vault will be recreated fresh)
- Knowledge base workflow (deferred to Spec 2)
- Obsidian Base (`.base`) file views (future enhancement)
- Web clipping / defuddle integration (future enhancement)

---

## 2. Vault Folder Structure

```
Projects/
  P001-CellMigration/
    _index.md                          # auto-maintained project index
    CMS001-p53-characterization.md     # series header
    CM001-western-blot.md              # experiment (in series)
    CM002-imaging.md                   # experiment (in series)
    CM003-qpcr.md                      # experiment (in series)
    CM004-migration-assay.md           # experiment (solo, no series)
    attachments/
      CM001/
        gel-image.png
        quantification.xlsx
      CMS001/
        summary-figure.png

Protocols/
  PR001-western-blot.md
  PR002-pcr-standard.md
  attachments/
    PR001/
      example-gel.png

Reading/
  Papers/
    smith-2026-il42-signalling.md
  Threads/
    il42-cd4-controversy.md
  attachments/
    smith-2026-il42-signalling/
      figure3-redrawn.png

Knowledge/                             # structure created now, workflow in Spec 2
  Concepts/
  Entities/
  Methods/
  Review-Queue/
  _Ops/
    Update-Logs/
    Lint-Reports/

Memory/
  Daily/
  Weekly/

Agent/
  agent.md
  soul.md
  skills/
  experiment-types.yml
```

### Attachment folders

- Located at `attachments/{id}/` directly under the parent area folder (e.g. `Projects/P001-CellMigration/attachments/CM001/`)
- Created **lazily** — only when the first attachment is added, not at note creation
- Flat structure within the ID folder (no sub-nesting like `images/`, `data/`)
- **Reading note attachments:** canonical path is `Reading/attachments/{sourceSlug}/` — a single shared `attachments/` folder at the `Reading/` level, keyed by the source note's slug. This applies to both `Reading/Papers/*` and `Reading/Threads/*` notes. The path is NOT relative to the note's parent folder — it is always `Reading/attachments/{slug}/` regardless of whether the note is in `Papers/` or `Threads/`. This canonical rule is used by source path resolution in `kb_suggest` (Spec 2 §8).

---

## 3. Serial Numbering Scheme

### ID Formats

| Note type | Format | Example | Counter scope |
|-----------|--------|---------|---------------|
| Project | `P{NNN}` | `P001` | `project` |
| Experiment | `{prefix}{NNN}` | `CM001` | `{prefix}` (e.g. `CM`) |
| Series | `{prefix}S{NNN}` | `CMS001` | `{prefix}-S` (e.g. `CM-S`) |
| Protocol | `PR{NNN}` | `PR001` | `protocol` |
| Reading note | No serial | — | — |
| Knowledge note | No serial | — | — |
| Diary note | No serial | — | — |

All serials are zero-padded to 3 digits (001–999). If a scope reaches 999, the system widens to 4 digits (1000+) for subsequent serials. Existing 3-digit IDs remain unchanged — file sorting will break at the boundary, but this is an acceptable tradeoff for a situation that indicates the project should likely be split.

### Project prefix

- 2-3 uppercase characters chosen by the user at project creation
- The system suggests a prefix derived from the project title (first letter of each word)
- User can accept or override the suggestion
- Must be unique across all projects — enforced by checking `serial_counters` table
- Collisions are rejected with a clear error message

### Reserved prefixes

The following prefixes are permanently reserved and may never be used for projects:

| Reserved | Reason |
|----------|--------|
| `PR` | Protocol namespace — all protocols are `PR{NNN}` |
| `P` | Project ID prefix — project folders are `P{NNN}-…` |

### Series ID collision rule

Series IDs are `{prefix}S{NNN}` (e.g. prefix `CM` → series `CMS001`). This means a prefix `CMS` would produce experiments `CMS001`, `CMS002`, … which collide with prefix `CM`'s series IDs in the global `note_id` unique index.

**Validation at `create_project` / `reserve_prefix`:** Before accepting a new prefix `X`, enforce:

1. `X` is not in the reserved list (`PR`, `P`)
2. `X + "S"` does not match any existing prefix in `serial_counters` (e.g. reject `CM` if `CMS` is already registered)
3. No existing prefix `Y` satisfies `Y + "S" = X` (e.g. reject `CMS` if `CM` is already registered)

These checks run against both `serial_counters` (permanent registrations) and `prefix_reservations` (unexpired temporary reservations). Violations are hard errors with a clear message naming the conflicting prefix.

### Naming conventions

| Item | Convention | Example |
|------|-----------|---------|
| Project folder | `P{NNN}-{PascalCase}` | `P001-CellMigration` |
| Experiment file | `{prefix}{NNN}-{kebab-case}.md` | `CM001-western-blot.md` |
| Series file | `{prefix}S{NNN}-{kebab-case}.md` | `CMS001-p53-characterization.md` |
| Protocol file | `PR{NNN}-{kebab-case}.md` | `PR001-western-blot.md` |
| Reading file | `{author}-{year}-{kebab-slug}.md` | `smith-2026-il42-signalling.md` |
| Attachment folder | `attachments/{id}/` | `attachments/CM001/` |

Visual grammar: hyphens for folder names and identifiers, underscores are not used in filenames.

---

## 4. Frontmatter Schemas

### Project `_index.md`

```yaml
---
note_kind: project
id: P001
prefix: CM
title: Cell Migration
status: active           # active | paused | completed | archived
created: 2026-01-15
---
```

### Experiment note

```yaml
---
note_kind: experiment
id: CM001
project_id: P001
title: Western Blot p53
experiment_type: western-blot
protocol: [[PR001-western-blot]]
samples:
  - name: SampleA
    condition: Treatment
reagents:
  - Antibody X
status: draft            # draft | in-progress | complete
series: CMS001           # optional, omitted for solo experiments
created: 2026-04-08
attachments:
  - CM001/gel-image.png
tags: [western-blot]
---
```

### Experiment date model

Experiments can span multiple lab sessions. Two sources of date information serve different purposes:

- **`created`** (frontmatter) — set once at creation. Used for sorting in Experiment Log and "nearby notes" queries. This is the canonical date for DB indexing and search.
- **`last_session`** (DB only, not in frontmatter) — computed read-only by the parser during indexing. The parser scans for `## \d{4}-\d{2}-\d{2}` headings in the body and stores the latest date found in the `last_session` column of `note_metadata`. If no dated headings exist, defaults to `created`. Used for staleness checks ("experiments not touched in 30 days").
- **Step headings** — `## 2026-04-08 - Sample Preparation`, `## 2026-04-09 - Gel Run` — the human-readable timeline of what happened when.

**Important:** `last_session` is never written back to the note's frontmatter. The parser is read-only — it extracts data into the DB but never modifies vault files. This prevents self-triggered watch loops in the file watcher pipeline.

```markdown
## 2026-04-08 - Sample Preparation
...
## 2026-04-09 - Gel Run
...
```

### Series header note

```yaml
---
note_kind: series
id: CMS001
project_id: P001
title: p53 Characterization Series
objective: Characterize p53 expression and localization in treated vs control
status: in-progress      # draft | in-progress | complete
created: 2026-04-08
---
```

### Unified `project_id` field

Both frontmatter and the DB column use `project_id` (not `project`). This avoids a naming split where frontmatter says `project` and the DB says `project_id` for the same value.

### Series membership: single source of truth

The experiment note's `series` field is the **sole source of truth** for series membership. The series header note does NOT store an `experiments` list in frontmatter.

Instead, the series header's body includes an auto-generated experiment list, rebuilt by querying all experiments where `series = CMS001`. This eliminates dual-ownership drift:

```markdown
# p53 Characterization Series

## Objective
Characterize p53 expression and localization in treated vs control

## Experiments
<!-- AUTO-GENERATED: experiment-list -->
| ID | Name | Status | Created |
|----|------|--------|---------|
| CM001 | western-blot | complete | 2026-04-08 |
| CM002 | imaging | complete | 2026-04-08 |
| CM003 | qpcr | in-progress | 2026-04-09 |
<!-- END AUTO-GENERATED: experiment-list -->

## Summary
<!-- User-owned. Write your own synthesis here when the series is complete. -->
```

The auto-generated section is fenced with named markers `<!-- AUTO-GENERATED: {section-name} -->` / `<!-- END AUTO-GENERATED: {section-name} -->`. `fencedSectionUpdate(filePath, sectionName, newContent)` matches markers by name. Series headers use section name `experiment-list`; project `_index.md` files use `experiment-log` and `project-summary`.

### Protocol

```yaml
---
id: PR001
title: Western Blot Standard
version: 3
category: protein-analysis
created: 2026-03-01
last_updated: 2026-03-01
derived_from:            # optional, e.g. [[PR003-western-blot]] (parent protocol)
---
```

### Reading note (modified from current)

```yaml
---
title: IL-42 mediated CD4-CD8 suppression
authors: [Smith, Jones]
year: 2026
journal: Nature Immunology
doi: 10.xxxx/xxxxx
read_date: 2026-04-06
status: complete         # draft | in-progress | complete
kb_status: pending       # pending | mapped | merged | merged_with_review | skipped (for Spec 2)
related_projects: [P001, P003]
tags: [reading]
---
```

---

## 5. Project `_index.md` Structure

```markdown
---
note_kind: project
id: P001
prefix: CM
title: Cell Migration
status: active
created: 2026-01-15
---

<!-- AUTO-GENERATED: experiment-log -->
## Experiment Log
| Series | ID | Name | Status | Created |
|--------|-----|------|--------|---------|
| CMS001 | CM001 | western-blot | complete | 2026-04-08 |
| CMS001 | CM002 | imaging | complete | 2026-04-08 |
| CMS001 | CM003 | qpcr | in-progress | 2026-04-09 |
| - | CM004 | migration-assay | draft | 2026-04-10 |
<!-- END AUTO-GENERATED: experiment-log -->

<!-- AUTO-GENERATED: project-summary -->
## Project Summary
(Agent-generated summary of project state — updated on-demand only)
<!-- END AUTO-GENERATED: project-summary -->

## Related Knowledge Concepts
<!-- Manually maintained -->

## Related Reading
<!-- Manually maintained -->

## Related Protocols
<!-- Manually maintained -->

## Open Questions
<!-- Manually maintained -->
```

### Generated section boundaries

Generated sections use **named fence markers**: `<!-- AUTO-GENERATED: {section-name} -->` / `<!-- END AUTO-GENERATED: {section-name} -->`. Files can have multiple named fenced sections (e.g. `experiment-log` and `project-summary` in `_index.md`). `fencedSectionUpdate(filePath, sectionName, newContent)` takes the section name as a parameter and matches only the markers with that exact name.

- **Experiment updates** (creation, status change) → rebuild `experiment-log` section only
- **On-demand rebuild** (user asks) → rebuild both `experiment-log` and `project-summary` sections

Manual sections outside all fences are never touched during auto-updates.

### Auto-update behavior

**Triggers:**
- Experiment creation (after safe-writer confirmation) — rebuilds Experiment Log table only
- Experiment status change to `complete` (after safe-writer confirmation) — rebuilds Experiment Log table only
- On-demand (user asks "update my project index") — rebuilds both Experiment Log table and Project Summary

**What is NOT auto-triggered:**
- Manual Obsidian edits or deletes: the file watcher can reindex files, but it cannot safely trigger an LLM-generated Project Summary without an agent turn. Manual vault changes that affect the Experiment Log (deletions, manual frontmatter edits) will be reflected in the DB after reindexing but will not automatically update the project `_index.md`. The user must ask the agent to rebuild on-demand.
- Series regrouping: handled explicitly by `create_series` tool flow.

**Rebuild timing and the safe-writer flow:**

The current safe-writer pipeline is asynchronous: the tool returns a `pending_edit`, the user confirms, the file is written, and reindexing happens later via the file watcher. This means the DB is not yet updated when the tool completes.

For index rebuilds, the agent must NOT query the DB immediately after confirmation. Instead:

1. The tool writes the experiment note via safe-writer (user confirms)
2. After confirmation, the agent rebuilds the project `_index.md` by **scanning the project folder directly**: it reads the frontmatter of every `.md` file in `Projects/P001-CellMigration/` (excluding `_index.md` itself) to get all experiments and series metadata
3. The file watcher picks up the changes and reindexes in the background

Direct folder scan is authoritative — it reflects the confirmed disk state without waiting for the async file watcher to update the DB.

**Sort order for generated tables:** All generated tables must use a stable, deterministic sort to prevent noisy diffs on re-render:
- **Experiment Log** (`_index.md`): sort by `created asc`, then `note_id asc` as a tiebreaker
- **Series experiment table** (series header): sort by `created asc`, then `note_id asc`
- **Knowledge `_index.md` catalogs**: sort by `title asc` (case-insensitive)

**What gets updated (inside fence only):**
- **Project Summary** — full rewrite from all experiments in the project (via direct folder scan).
- **Experiment Log** — table rebuilt from direct folder scan of the project folder.

Auto-generated sections (between named `<!-- AUTO-GENERATED: {section-name} -->` / `<!-- END AUTO-GENERATED: {section-name} -->` fences) in project `_index.md` and series headers are **agent-managed** — they are updated via `fencedSectionUpdate(filePath, sectionName, newContent)` without safe-writer confirmation. User-written sections outside the fences are never touched. Ownership is defined at the **section level**, not the file level. See Spec 2 §8 "Agent-managed file ownership policy" for the full model, including the `fencedSectionUpdate()` specification.

**What is NOT auto-updated:**
- Related Knowledge Concepts, Related Reading, Related Protocols, Open Questions — these are below the fence and never touched.

### Multi-step workflow model

The current runtime (`runtime.ts`) works as follows: a tool call returns a `pending_edit`, the LLM turn ends, the user confirms/rejects, and `confirmEdit()` is a separate call with **no continuation hook**. The tool cannot "continue" after confirmation — the next action must be a new LLM turn.

This means multi-step workflows (e.g. `create_experiment` → write note → rebuild index) cannot be expressed as a single tool execution. Instead, they are **multi-turn agent conversations**:

**Pattern: create_experiment (2 turns)**
1. **Turn 1 (tool call):** `create_experiment` validates inputs, allocates serial, builds note content, returns `pending_edit` for the experiment note. Tool execution ends.
2. **Turn 2 (continuation):** User confirms and clicks "Continue". The agent calls `get_workflow_events` to verify the edit was applied, then auto-updates the project `_index.md` via `fencedSectionUpdate()` by scanning the project folder directly (no DB query — avoids stale rows). If the experiment is in a series, also auto-updates the series header's fenced experiment table via `fencedSectionUpdate()` using the same direct folder scan. Both are agent-managed section updates — no further confirmation needed. Done.

**Pattern: create_series (2+ turns)**
1. **Turn 1:** `create_series` creates the series header note → `pending_edit`.
2. **Turn 2:** User confirms and clicks "Continue". If existing experiments were specified, agent issues `pending_edit`(s) to add `series: CMS001` to each experiment's frontmatter (one per file, sequential turns).
3. **Turn 3+ (if experiments were specified):** User confirms each experiment update. After the last confirmation, agent auto-updates the series header's fenced experiment table and the project `_index.md` via `fencedSectionUpdate()`. No further confirmation needed. Done.

**Design rule:** No tool assumes it can continue after a `pending_edit`. Each step that writes a file is a separate turn. The agent (LLM) is the orchestrator that tracks progress across turns.

**Recovery model — vault state is the source of truth, not session state.** If a session drops mid-workflow, the agent recovers by inspecting vault and DB state on the next interaction, not by replaying session-scoped events. Specifically:
- Serial numbers are already allocated (DB) — they persist across sessions.
- Files already confirmed are on disk — they persist across sessions.
- Remaining steps can be derived from what exists: e.g. if `P001-CellMigration/_index.md` exists on disk but no `CM` counter exists in `serial_counters`, the agent knows it must call `register_project_counters`.
- Mapping artifacts (Spec 2) record per-target state on disk — they persist across sessions.
- `workflow_events` are a **convenience for within-session continuation**, not a recovery mechanism. On a fresh session, the agent inspects vault/DB state directly rather than reading old workflow events.

This same pattern applies to Spec 2's `kb_apply` sequential updates — each knowledge note update is its own confirmation turn.

### Workflow continuation after confirmation

The current runtime does **not** automatically trigger a new assistant turn after `edit_confirm`. The websocket handler (`websocket.ts`) sends an `edit_result` back, and the UI updates the buttons, but no new message enters the chat loop.

**Chosen model: User-driven continuation with dedicated workflow events.**

The current runtime's message model only supports `user | assistant | tool` roles (`base.ts` Message type). The Anthropic adapter coerces any other role to `user | assistant`. Injecting a `system` role into `chat_messages` would be silently corrupted. Therefore, edit confirmations are stored in a **separate table**, not in chat history.

**New table: `workflow_events`** (see §6 for canonical schema)

Edit confirmations are stored in a dedicated `workflow_events` table. The agent reads them via the `get_workflow_events` tool (§7) using cursor-based pagination.

**Server change (websocket.ts):** After a successful `edit_confirm`, the server inserts a row into `workflow_events` (not `chat_messages`).

**UI change (chat-view.ts):** After receiving `edit_result`, the UI shows a **"Continue"** button that sends a pre-filled chat message `"continue"`. The user can also type a different message to redirect the workflow.

**Agent resume logic:** On receiving a "continue" message, the agent:
1. Calls `get_workflow_events` to see what was applied/cancelled (see tool spec in §7)
2. Inspects vault state and/or mapping artifacts to determine the next step
3. Issues the next `pending_edit` or reports completion

If the user sends a non-"continue" message instead, the agent treats it as a new intent and responds normally — the workflow is interruptible by design.

**Future upgrade path:** If the confirmation-per-step friction becomes excessive, the server can be upgraded to automatically trigger `runtime.chat()` with a synthetic continuation message after confirmation. The data model supports both; only the orchestration layer changes.

### Partial confirmation of batched edits

With the section-level ownership model, most multi-step workflows now require only **one user confirmation** (the primary note creation), followed by agent-managed `fencedSectionUpdate()` calls for index/series rebuilds. This greatly reduces the batching problem.

The remaining case where multiple `pending_edit`s may be batched is `create_series` with existing experiments (step 4: updating each experiment's frontmatter). For this case:

- **All applied:** Workflow proceeds — agent auto-updates fenced sections.
- **All cancelled:** Workflow halts. The series header exists but has no members. The user must explicitly ask to retry.
- **Partial (some applied, some cancelled):** The agent acknowledges which experiments were updated and which were not, then auto-updates the fenced sections to reflect only the successfully updated experiments. The user can add the remaining experiments later.

**Preferred approach:** Issue experiment frontmatter updates **one per turn** (strictly sequential) to avoid partial-confirmation ambiguity.

### Pending-edit expiry enforcement

The prefix reservation TTL is 30 minutes, matching the expected human response time for a pending edit. To prevent a stale `edit_confirm` from finalizing a project whose prefix reservation has already expired (and potentially been reclaimed), the runtime must enforce this bound at confirmation time:

Two separate cleanup actions are required — they must not be confused:

1. **Pending-edit expiry** (`safeWriter.cleanupExpired()` — already exists in `safe-writer.ts`): removes expired pending edits from the `pending_edits` table. `confirmEdit()` must reject any edit older than 30 minutes with: "Edit proposal expired — please re-run the operation."

2. **Reservation expiry** (new runtime action — does NOT exist yet): removes expired rows from `prefix_reservations` where `expires_at < now`. This is a separate DB operation from pending-edit cleanup and must be implemented independently. The runtime runs this on every `edit_confirm` call (before processing) and periodically in the background (e.g. on websocket heartbeat or session start).

Running both before every `edit_confirm` ensures a stale confirmation can never finalize a project whose prefix reservation has already expired and been reclaimed.

### Serial allocation and cancellation

`getNextSerial()` is called **before** the user confirms the note creation. If the user cancels:

- **Counters are monotonic — gaps are acceptable.** Cancelled serial numbers (e.g. `CM003`) are never reused. The next creation gets `CM004`. This is simpler and safer than rollback (which would require tracking "in-flight" serials across sessions).
- **Project counters persist even if the first note is cancelled.** If `create_series` allocates `CMS001` and the user cancels, the `CM-S` counter stays at 2. The next series will be `CMS002`.
- **`create_project` defers side effects.** Folder creation and prefix counter registration happen only after the user confirms the `_index.md`. If the user cancels, only the project serial number (e.g. `P001`) is consumed — no folder exists, no prefix counters are registered, and the prefix remains available for future projects. This is the cleanest cancellation model: the only pre-confirmation side effect is the project-level serial increment, which is monotonic and gap-safe.

---

## 6. Database Changes

### New table: `workflow_events`

```sql
CREATE TABLE workflow_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'edit_confirmed' | 'edit_cancelled'
  payload    TEXT NOT NULL,          -- JSON: {"editId":"...","path":"...","action":"apply","success":true}
  timestamp  INTEGER NOT NULL
);
CREATE INDEX idx_workflow_events_session ON workflow_events(session_id, id);
```

Used by the workflow continuation model (§5) for **within-session convenience only**. The agent reads events via `get_workflow_events` using cursor-based pagination (`after_event_id`). Events are never mutated or deleted — the cursor tracks progress.

**Important:** `workflow_events` is NOT a recovery mechanism. `session_id` is volatile (created fresh per websocket connection in `websocket.ts`). If the session drops, the agent recovers by inspecting vault and DB state directly (see §5 Recovery Model), not by reading old workflow events. This is the single canonical schema definition for this table.

### New table: `prefix_reservations`

```sql
CREATE TABLE prefix_reservations (
  prefix     TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,          -- the project ID that reserved this prefix (e.g. P001)
  edit_id    TEXT,                   -- initially null; filled by the runtime after safeWriter.proposeEdit() returns the editId. Used for server-side cancel correlation.
  expires_at INTEGER NOT NULL        -- Unix timestamp, TTL = 30 minutes from creation/refresh
);
```

Temporary reservations created by `reserve_prefix` during `create_project`. Prevents concurrent prefix claims. Keyed by `project_id` (not `session_id`) so the reservation survives reconnects. Rows are deleted when `register_project_counters` finalizes the project, or expire after TTL. Expired rows are cleaned up lazily (checked on read).

### New table: `serial_counters`

```sql
CREATE TABLE serial_counters (
  scope      TEXT PRIMARY KEY,
  next_val   INTEGER NOT NULL DEFAULT 1,
  project_id TEXT              -- null for global scopes ('project', 'protocol'), set for prefix scopes ('CM', 'CM-S')
);
```

Rows created during setup and project creation:

| scope | project_id | purpose | created when |
|-------|-----------|---------|-------------|
| `project` | null | P001, P002, ... | app setup |
| `protocol` | null | PR001, PR002, ... | app setup |
| `CM` | P001 | CM001, CM002, ... | P001-CellMigration created |
| `CM-S` | P001 | CMS001, CMS002, ... | P001-CellMigration created |

The `project_id` column enables `register_project_counters` to verify idempotency: if counters already exist for a prefix, the tool checks whether they belong to the same project before returning success.

### `getNextSerial(scope)` function

- Atomic read-and-increment: `UPDATE serial_counters SET next_val = next_val + 1 WHERE scope = ? RETURNING next_val - 1`
- Returns zero-padded string: 3 digits (001–999), widening to 4 digits (1000+) per the widening rule in §3
- Throws error if scope does not exist (never silently creates a counter)

### Schema additions to `note_metadata`

```sql
ALTER TABLE note_metadata ADD COLUMN note_id TEXT;
ALTER TABLE note_metadata ADD COLUMN series TEXT;
ALTER TABLE note_metadata ADD COLUMN project_id TEXT;
ALTER TABLE note_metadata ADD COLUMN last_session TEXT;

CREATE UNIQUE INDEX idx_note_metadata_note_id ON note_metadata(note_id);
CREATE INDEX idx_note_metadata_series ON note_metadata(series);
CREATE INDEX idx_note_metadata_project_id ON note_metadata(project_id);
```

- `note_id`: the serial identifier (CM001, CMS001, P001, PR001) extracted from frontmatter
- `series`: the series ID from experiment frontmatter, null for non-experiment notes
- `project_id`: the project ID (P001) from experiment/series frontmatter. Enables `vault_list` filtering within a project without relying on folder path parsing
- `last_session`: the most recent dated heading in the experiment body, auto-extracted by the parser. Used for staleness queries
- Unique index on `note_id` prevents duplicate IDs across the entire vault

### `created` field mapping

The existing `note_metadata.date` column stores the frontmatter `created` field for experiment, series, project, and protocol notes. The parser stores `created` → `note_metadata.date` for these note types on every index pass. This is the canonical date used for Experiment Log sorting and "nearby notes" queries. Diary and reading notes continue to use `date` as before (their frontmatter date field maps to the same column).

---

## 7. Tools

### New tools

#### `create_project`

**Purpose:** Create a new project with folder, index, and serial counters.

**Inputs:**
- `title` (required): project name, e.g. "Cell Migration"
- `prefix` (optional): 2-3 char uppercase prefix. If omitted, system suggests one from the title.

**Flow (multi-turn, see §5 Workflow Model):**
1. If no prefix provided, suggest one (first letter of each word). Present to user for confirmation.
2. **Validate prefix fully before consuming any serial.** Run the full validation from §3 and `reserve_prefix` logic: check that the prefix is not in the reserved list (`PR`, `P`), that `prefix + "S"` does not collide with any existing prefix in `serial_counters` or `prefix_reservations`, and that no existing prefix `Y` satisfies `Y + "S" = prefix`. Reject immediately if any check fails. This step is read-only — no IDs are allocated yet. This prevents burning a project serial on an always-invalid prefix.
3. Reserve the project serial: `getNextSerial('project')` → `001`. (Serial counter is monotonic, gap-safe.)
4. Reserve the prefix via `reserve_prefix(prefix, project_id='P001')` (inserts row into `prefix_reservations` with **30-minute TTL**, keyed by project_id). This prevents a concurrent `create_project` from claiming the same prefix. The reservation survives reconnects because it's keyed by project_id, not session_id.
5. Build `_index.md` content with frontmatter and empty template sections → `pending_edit` for the `_index.md`. To enable runtime correlation, the tool includes reservation context in the pending edit payload:
   ```json
   {
     "type": "pending_edit",
     "operation": "create_project",
     "path": "Projects/P001-CellMigration/_index.md",
     "newContent": "...",
     "reservation": { "project_id": "P001", "prefix": "CM" }
   }
   ```
   The **runtime** uses this `reservation` field to immediately store the returned `editId` into `prefix_reservations.edit_id` for `project_id = "P001"` as a direct DB write — no extra tool round-trip required. The folder and prefix counters are NOT yet created. Tool execution ends.
6. *(After user confirms and clicks "Continue")* The agent calls `register_project_counters` to perform the deferred DB side effects:
   - Register prefix counters `(CM, 1)` and `(CM-S, 1)` in `serial_counters`
   - Remove the prefix reservation (it's now permanently registered)
   - The folder already exists (safe-writer creates parent directories when writing `_index.md`)
   - Project is ready.
7. *(If user cancels)* Only the project serial number is consumed (P001 is burned, next project gets P002). The server's `edit_confirm` cancel handler looks up the cancelled `editId` in `prefix_reservations.edit_id` and immediately deletes the matching row — no agent round-trip needed. This works because the `editId` was stored in step 5. TTL remains as a crash-recovery fallback for cases where the server crashes before the cancel handler runs.

**TTL race recovery (post-confirmation conflict):** If the 30-minute TTL expires before the user confirms AND another project registers the same prefix in that window, `register_project_counters` will hard-fail with "Prefix CM is already registered to project P002." The `_index.md` already exists on disk but has no counters. Recovery flow:
- The agent informs the user: "Prefix CM was claimed while waiting for your confirmation. Your project file exists. Please choose a new prefix."
- User picks a new prefix (e.g. `CL`)
- Agent calls `reserve_prefix(prefix='CL', project_id='P001')`, updates the `_index.md` frontmatter via safe-writer (user confirms the single-field change), then calls `register_project_counters(project_id='P001', prefix='CL')`.
- The old prefix-bearing `_index.md` draft is overwritten in this same flow.

#### `create_series`

**Purpose:** Create an experiment series within a project.

**Inputs:**
- `project_id` (required): project ID (e.g. `P001`). Must be an exact ID — title-based lookup is not supported for mutation tools to avoid ambiguity.
- `title` (required): series name
- `objective` (optional): series objective
- `experiments` (optional): list of existing experiment IDs to include in this series

**Project resolution (run first — same rule as `create_experiment`):**

Glob `Projects/{project_id}-*/_index.md`. Exactly one match is required — if more than one path matches, hard-error: "Duplicate project folders for {project_id} — fix the vault structure before continuing." If one match found with counters → proceed. If one match found without counters → auto-run `register_project_counters` silently, then proceed. If no match → error: "Project {project_id} does not exist".

**Validation (run after project resolution):**

| Condition | Error |
|-----------|-------|
| Experiment ID in `experiments` list does not exist | "Experiment {id} not found" |
| Experiment in `experiments` belongs to a different project | "Experiment {id} belongs to project {other_project_id}, not {project_id}" |
| Experiment in `experiments` already member of a series | "Experiment {id} is already in series {series_id}. Remove it from that series first, or omit it from this list" |
| Duplicate IDs in `experiments` list | "Duplicate experiment ID {id} in input" |

**Flow (multi-turn, see §5 Workflow Model):**
1. Run validation matrix above. Abort with first error found.
2. Resolve `project_id` → look up prefix from project's `_index.md` frontmatter
3. `getNextSerial('{prefix}-S')` → `001`
4. Create `CMS001-{slug}.md` with frontmatter and empty auto-generated experiment table → `pending_edit` (tool execution ends)
5. *(After user confirms)* If existing experiments specified, issue `pending_edit`(s) to add `series: CMS001` to each experiment's frontmatter
6. *(After last experiment confirmed)* Auto-update series header's fenced experiment table via `fencedSectionUpdate()` by scanning the project folder directly + auto-update project `_index.md` fenced sections via `fencedSectionUpdate()` by the same direct scan. No confirmation needed.

#### `create_experiment`

**Purpose:** Create an experiment note within a project, optionally within a series.

**Inputs:**
- `project_id` (required): project ID (e.g. `P001`). Must be an exact ID — title-based lookup is not supported for mutation tools to avoid ambiguity.
- `title` (required): short experiment name for the slug
- `experiment_type` (required): e.g. "western-blot"
- `protocol` (optional): protocol reference, e.g. "PR001-western-blot"
- `samples` (optional): array of {name, condition}
- `reagents` (optional): array of strings
- `series` (optional): series ID (CMS001) to add this experiment to

**Project resolution (run first, before validation matrix):**

1. Glob `Projects/{project_id}-*/_index.md` on disk. Require exactly one match — if more than one path matches, hard-error: "Duplicate project folders for {project_id} — fix the vault structure before continuing."
2. If one match found **and** `serial_counters` has a row for its prefix → project is fully initialized. Proceed.
3. If one match found **but** `serial_counters` has no row for its prefix → project is half-created (session dropped after `_index.md` was confirmed but before `register_project_counters` ran). Auto-run `register_project_counters(project_id, prefix)` to finalize it, then proceed as normal.
4. If no match and no `serial_counters` row → return error: "Project {project_id} does not exist".

This resolution order ensures that a recoverable half-created project is never incorrectly rejected. The auto-run of `register_project_counters` is silent (no user interaction needed) — it is idempotent and purely a DB side effect.

**Validation (run after project resolution):**

| Condition | Error |
|-----------|-------|
| `series` provided but series ID not found in project | "Series {series_id} not found in project {project_id}" |
| `series` belongs to a different project | "Series {series_id} belongs to project {other_project_id}, not {project_id}" |
| `protocol` provided but protocol ID not found | "Protocol {protocol_id} not found — create it first with create_protocol" |

**Flow (multi-turn, see §5 Workflow Model):**
1. Run project resolution above. Abort with error if project not found; auto-finalize if half-created.
2. Run validation matrix above. Abort with first error found.
2. Resolve `project_id` → look up prefix from project's `_index.md` frontmatter
3. `getNextSerial('{prefix}')` → `001`
4. Build filename: `CM001-{slug}.md`
5. Generate note with frontmatter + body template (first step heading with today's date) → `pending_edit` (tool execution ends)
6. *(After user confirms)* Auto-update project `_index.md` fenced sections via `fencedSectionUpdate()` by scanning the project folder directly. If series provided, also auto-update series header's fenced experiment table via `fencedSectionUpdate()` using the same direct scan. No further confirmation needed — these are agent-managed sections.

#### `create_protocol`

**Purpose:** Create a protocol note.

**Inputs:**
- `title` (required): protocol name
- `category` (required): e.g. "protein-analysis"
- `derived_from` (optional): parent protocol reference

**Flow (multi-turn, see §5 Workflow Model):**
1. `getNextSerial('protocol')` → `001`
2. Create `Protocols/PR001-{slug}.md` with frontmatter and template body → `pending_edit` (tool execution ends)
3. *(After user confirms)* Protocol is ready. No further auto-generated steps.

#### `get_workflow_events`

**Purpose:** Read recent edit confirmation/cancellation events for the current session. Used by the agent to determine what happened since the last turn during multi-step workflows.

**Inputs:**
- `after_event_id` (optional): return only events with `id > after_event_id`. If omitted, returns all events for the current session (useful on the first call in the current session). Note: `workflow_events` are session-scoped and not a recovery mechanism — on a fresh session the agent recovers by inspecting vault/DB state directly, not by reading old events (see §5 Recovery Model).

**Output:** JSON object:
```json
{
  "events": [
    {"id": 42, "event_type": "edit_confirmed", "payload": {...}, "timestamp": 1712600000}
  ],
  "cursor": 42
}
```
Events are returned in ascending `id` order. `cursor` is the highest `id` returned (the agent passes this as `after_event_id` on the next call).

**Behavior:**
- The runtime injects the current `session_id` implicitly — it is NOT a user-supplied parameter. The tool handler receives session context from the runtime (similar to how vault path is injected), not from the LLM's tool arguments.
- Events are **read-only** — they are never mutated, consumed, or deleted. The agent tracks its position via the `cursor` value. This is safe for crash recovery: if the agent crashes after reading events but before acting, it can re-read the same events on the next call (same `after_event_id` or no `after_event_id`).
- Idempotency is the agent's responsibility: it checks vault state before acting. If an index was already rebuilt (e.g. from a previous attempt), the agent skips that step. The events are informational — they tell the agent what happened, not what to do.

**Failure behavior:**
- No events found → returns `{"events": [], "cursor": null}` (not an error). The agent should inspect vault state to determine next steps.

### `resolveVaultPath(inputPath)` — shared path safety rule

All tool inputs that accept a file path (read **or** write) must pass through `resolveVaultPath()` before any file operation:

1. Resolve `inputPath` to an absolute path relative to `vaultPath`
2. **For reads and writes to existing files:** Call `fs.realpathSync()` on the resolved path (follows symlinks). If the real path does not start with `vaultPath` → reject with error: "Path {inputPath} resolves outside vault root".
   **For writes to new files (path does not yet exist):** Walk up the path until finding the nearest existing parent directory. Call `fs.realpathSync()` on that parent. Verify the resolved parent starts with `vaultPath`. Append the remaining (non-existent) path components unchanged. Reject if any remaining component is `..` or is an absolute path segment.
3. Return the resolved absolute path for use in the file operation

This applies to: `source`, `target`, `mapping`, `filePath` arguments on all new tools (Spec 1 and Spec 2). Existing tools should be audited to apply the same rule.

### Session-scoped tool context injection

The tool registry currently only passes user-supplied args (`registry.ts` L5). Several new tools require runtime context that the LLM should not supply:

**Tools requiring injected context:**
| Tool | Injected context | Why |
|------|-----------------|-----|
| `get_workflow_events` | `session_id` | Scopes event query to current connection |
| `reserve_prefix` | (none — uses explicit `project_id` input) | — |
| `register_project_counters` | (none — uses explicit `project_id` input) | — |

**Implementation:** Extend the tool handler interface to accept an optional `context` object alongside `args`:

```typescript
export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<string>;
}

export interface ToolContext {
  sessionId: string;
  vaultPath: string;
}
```

The runtime populates `context` from the current session state and passes it on every tool call. Tools that don't need it ignore the parameter. This is a minimal change — existing tools continue to work unchanged.

#### `reserve_prefix`

**Purpose:** Temporarily reserve a project prefix to prevent concurrent `create_project` flows from claiming the same prefix.

**Inputs:**
- `prefix` (required): 2-3 char uppercase prefix to reserve
- `project_id` (required): the project ID that will own this prefix (e.g. `P001`)

**Output:** `{"reserved": true, "expires_at": <timestamp>}` on success.

**Behavior:**
- Cleans up expired reservations lazily before checking availability.
- Enforces the full collision rule from §3: checks that `prefix`, `prefix + "S"`, and any existing prefix `Y` where `Y + "S" = prefix` are all clear in both `serial_counters` and `prefix_reservations`.
- Also checks that `prefix` is not in the reserved list (`PR`, `P`).
- If available, inserts into `prefix_reservations` with `project_id` and `expires_at = now + 30 minutes`.
- Idempotent: if the same `project_id` already holds a reservation for this prefix, the TTL is refreshed to `now + 30 minutes`.
- `edit_id` is initially null when the reservation is created. The runtime fills it in after `safeWriter.proposeEdit()` returns the `editId` (see `create_project` step 5). `reserve_prefix` never touches `edit_id`.

**Failure behavior:**
- Prefix already registered in `serial_counters` → error: "Prefix {prefix} is permanently registered to an existing project"
- Prefix reserved by a different `project_id` (unexpired) → error: "Prefix {prefix} is temporarily reserved by project {other_project_id} (expires at {time})"

#### `register_project_counters`

**Purpose:** Finalize a project by registering its prefix counters in `serial_counters`. Called by the agent after the user confirms the project `_index.md`.

**Inputs:**
- `project_id` (required): the project ID (e.g. `P001`)
- `prefix` (required): the project prefix (e.g. `CM`)

**Output:** `{"registered": true, "counters": ["CM", "CM-S"]}` on success.

**Behavior:**
- Before inserting, re-validates the full series-collision rule from §3: confirms `prefix + "S"` is not in either `serial_counters` or unexpired `prefix_reservations`, and no existing prefix `Y` in either table satisfies `Y + "S" = prefix`. If the reservation is still active this check is a no-op; on the auto-heal path it catches any collision that occurred while the session was down.
- Inserts `(prefix, 1)` and `(prefix-S, 1)` into `serial_counters`
- Deletes the corresponding row from `prefix_reservations`
- All operations are in a single transaction

**Failure behavior:**
- Prefix already exists in `serial_counters` AND was registered by this `project_id` → idempotent success (agent retried after a crash). Return success without modifying existing counters.
- Prefix already exists in `serial_counters` AND was registered by a different project → **hard error**: "Prefix {prefix} is already registered to project {other_project_id}"
- Reservation held by a different `project_id` AND prefix is not yet in `serial_counters` → **hard error**: "Reservation for prefix {prefix} is owned by project {other_project_id}"

**Recovery from expired reservation (cross-session healing):**
If no active reservation exists AND the prefix is NOT in `serial_counters`, the tool checks whether a project `_index.md` already exists on disk by globbing `Projects/{project_id}-*/_index.md` (the tool only knows `project_id`, not the title). Exactly one match is required — if more than one path matches, hard-error: "Duplicate project folders for {project_id} — fix the vault structure before continuing." Otherwise, verify matching `id` and `prefix` in the found file's frontmatter:
- **File exists with matching frontmatter** → the project was confirmed but counters were never registered (session dropped). The tool proceeds: registers counters and returns success. This is the **auto-heal** path.
- **File does not exist** → **hard error**: "No active reservation and no confirmed project file for prefix {prefix}. Re-run create_project."

This auto-heal mechanism ensures that a confirmed `_index.md` on disk is never left in a broken state. The vault file is the source of truth for recovery, not the session.

**Idempotency:** Safe to retry — if counters already exist for this `project_id`/`prefix` pair, the tool returns success.

### Modified tools

#### `create_reading_note`

**Changes:** Add `status` (default: "draft"), `kb_status` (default: "pending"), `related_projects` (optional, list of project IDs) to frontmatter template.

#### `vault_search`

**Changes:** When the query contains a serial ID pattern (e.g. "CM001", "P001", "PR003"), match against the `note_id` column in `note_metadata` for fast exact lookup before falling through to the existing search pipeline.

#### `vault_list`

**Changes:** When listing a project folder, support displaying experiments grouped by series. Uses the new `project_id` column on `note_metadata` for filtering (the current parser only stores top-level folder, which is insufficient for per-project listing).

### Series grouping via conversation

Grouping existing solo experiments into a series does not require a dedicated tool. The agent handles it through `create_series` + frontmatter editing:

1. User says "group CM001, CM002, CM003 into a series called p53 characterization"
2. Agent calls `create_series` with `experiments: [CM001, CM002, CM003]`
3. `create_series` follows the multi-turn flow: creates series header → confirms → adds `series: CMS001` to each experiment → confirms → auto-updates series header's fenced experiment table and project `_index.md` via `fencedSectionUpdate()` by scanning the project folder directly. No confirmation for the fenced-section updates.

The experiment notes' `series` field is the sole source of truth. The series header's fenced experiment table is always regenerated using `fencedSectionUpdate()` by scanning the project folder directly — reading frontmatter from all experiment files to get current series membership. This avoids waiting for the async file watcher to reindex.

---

## 8. Parser Changes

### Note sub-type classification

The parser currently classifies notes by top-level folder only. It needs to additionally recognize sub-types within folders:

**Within `Projects/`:** distinguished by `note_kind` frontmatter field:
- `note_kind: project` → project index (`_index.md`)
- `note_kind: series` → series header
- `note_kind: experiment` → experiment

All three note types in `Projects/` must include a `note_kind` field. This is set at creation time by the respective tools and never changes. Using an explicit discriminator avoids fragile heuristics (checking for `prefix`, `experiments`, or `experiment_type` to guess the type).

**Within `Reading/`:** distinguished by subfolder:
- `Reading/Papers/*` → reading (paper)
- `Reading/Threads/*` → reading (thread)

**Within `Knowledge/`:** distinguished by subfolder (for Spec 2):
- `Knowledge/Concepts/_index.md`, `Knowledge/Entities/_index.md`, `Knowledge/Methods/_index.md` → **`note_type: index`** (classified first, before subfolder rules below; excluded from all KB lint, suggest, and apply flows)
- `Knowledge/Concepts/*` (except `_index.md`) → knowledge (concept)
- `Knowledge/Entities/*` (except `_index.md`) → knowledge (entity)
- `Knowledge/Methods/*` (except `_index.md`) → knowledge (method)
- `Knowledge/Review-Queue/*` → knowledge (review)

The `_index.md` classification takes priority. Any file with basename `_index.md` inside a `Knowledge/` subfolder is always `note_type: index` regardless of its frontmatter `type` field.

### Metadata extraction

The parser extracts from frontmatter and stores in `note_metadata`:
- `note_id` → the `id` field (CM001, CMS001, P001, PR001)
- `series` → the `series` field (CMS001 or null)
- `project_id` → the `project_id` field from experiment/series frontmatter (P001 or null)
- `last_session` → computed by scanning the note body for `## \d{4}-\d{2}-\d{2}` headings, storing the latest date found. Falls back to `created` if no dated headings exist. This is a **read-only computation** — the parser never writes it back to frontmatter (see §4 Experiment date model).

---

## 9. Note Body Templates

### Experiment note body

```markdown
# {Title}

## Objective
{objective or "TODO: Describe objective"}

## {YYYY-MM-DD} - {First Step}
Following [[{protocol}]] with modifications:
- TODO: List modifications

### Observations

### Results

## Notes
```

Each subsequent lab session adds a new dated heading (`## 2026-04-09 - Gel Run`). The first heading is generated at creation time using today's date. Steps within a heading use `###` subheadings for Observations and Results.

### Series header note body

```markdown
# {Title}

## Objective
{objective}

## Experiments
<!-- AUTO-GENERATED: experiment-list -->
| ID | Name | Status | Created |
|----|------|--------|---------|
<!-- END AUTO-GENERATED: experiment-list -->

## Summary
<!-- User-owned. Write your own synthesis here when the series is complete. -->
```

**Ownership note:** `Summary` is user-owned content, outside the auto-generated fence. The agent never auto-writes to it. When the user marks a series `status: complete`, they write the Summary themselves. The agent may suggest draft text via the chat (not safe-writer), which the user can paste in.

### Protocol note body

```markdown
# {Title}

## Overview

## Materials

## Procedure

## Troubleshooting

## References
```

### Project `_index.md` body

See Section 5.

---

## 10. Wikilink Resolution

Wikilinks use the **filename-only** style: `[[CM001-western-blot]]`, `[[PR001-western-blot]]`, `[[cd4-cd8-interaction]]`.

### Resolver changes required

The current context assembler (`context-assembler.ts`) searches `Protocols/` first, then `Projects/`, `Reading/`, `Memory/`, `Agent/`. It does NOT search `Knowledge/`. This must be extended:

**New search order:**
1. `Protocols/` (direct child)
2. `Knowledge/` (one level deep: `Knowledge/Concepts/`, `Knowledge/Entities/`, `Knowledge/Methods/`)
3. `Projects/` (two levels deep: `Projects/{project}/`)
4. `Reading/` (one level deep: `Reading/Papers/`, `Reading/Threads/`)
5. `Memory/`, `Agent/`

### Filename uniqueness enforcement

Filename-only links are ambiguous if two files in different folders share the same basename. To prevent this:

- **Serial-numbered notes** (experiments, series, protocols) are inherently unique — the serial guarantees it.
- **Knowledge notes** use semantic names that could theoretically collide across `Concepts/`, `Entities/`, `Methods/`. In practice this is unlikely (you wouldn't name a concept and an entity identically), but if the parser detects a duplicate basename during indexing, it logs a warning. `kb_lint` check #7 (duplicate/overlapping notes) catches this.
- **Reading notes** use author-year-slug which is unique in practice.

If a collision does occur, the behavior depends on context:

- **Write operations** (any tool that modifies or creates content): ambiguous resolution is a **hard error**. The tool aborts and asks the user to disambiguate or rename one of the colliding files.
- **Mutation-feeding reads** (reads that directly inform a subsequent write — e.g. `kb_suggest` reading knowledge indexes, `kb_apply` reading a target note, context assembly for any tool that proposes edits): also a **hard error**. A wrong read silently propagated into a write is the same correctness risk as a wrong write.
- **Display-only reads** (user-initiated search results, vault browsing, context shown to the user for informational purposes): the resolver returns the first match and logs a warning. The user can resolve by renaming one of the files.

In practice, the resolver should check an `intent` flag passed by the caller: `'write'`, `'mutation-read'`, or `'display'`. Write and mutation-read intents trigger the hard error; display intent allows the fallback.

---

## 11. Setup Changes

The `cricknote setup` command creates the following folder structure on a fresh vault:

```
Projects/
Protocols/
Reading/
  Papers/
  Threads/
  attachments/
Knowledge/
  Concepts/
  Entities/
  Methods/
  Review-Queue/
  _Ops/
    Update-Logs/
    Lint-Reports/
Memory/
  Daily/
  Weekly/
Agent/
  agent.md
  soul.md
  skills/
  experiment-types.yml
```

And initializes `serial_counters` with:

```sql
INSERT INTO serial_counters (scope, next_val) VALUES ('project', 1);
INSERT INTO serial_counters (scope, next_val) VALUES ('protocol', 1);
```

Project-specific counters (`CM`, `CM-S`, etc.) are created when each project is created.

---

## 12. Future Enhancements (Out of Scope)

These are noted for future work and not part of this spec:

- **Obsidian Base files** — `.base` files for dynamic queryable views of the Experiment Log, replacing or supplementing the markdown table
- **Web clipping / defuddle** — integration for feeding web content (AI tool outputs, paper discussions) into Reading notes
- **obsidian-skills** — integration for improving Obsidian-specific markdown formatting
- **Knowledge Base workflow** — Spec 2 covers `kb_suggest`, `kb_apply`, `kb_lint`, and the concept compilation pipeline
