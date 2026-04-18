# Reading Intake Pipeline — Implementation Plan

> **For agentic workers:** Keep this plan vault-first. Do not start with plugin upload. Reuse the current `compile_reading_note -> kb_suggest -> kb_write_mapping -> kb_apply -> kb_apply_advance` flow and add a thin intake/orchestration layer around it.

**Goal:** Let a user point CrickNote at a folder under `Reading/attachments/<slug>/` containing a paper PDF plus AI-generated notes, have CrickNote discover the readable files automatically, generate and store a CREATE-based reading note, then move that reading note through the existing Knowledge workflow so Concepts, Entities, Methods, Review-Queue, and Update Logs are updated in the normal way.

**Current reality in this repo:**
- `compile_reading_note` already exists and can read `pdf`, `.md`, and `.txt` sources listed in a reading note.
- `kb_suggest`, `kb_write_mapping`, `kb_apply`, and `kb_apply_advance` already exist and handle downstream KB work.
- The missing piece is the **intake layer**: creating a valid reading note with `sources`, guiding the next step, and reducing manual bookkeeping.
- The Obsidian chat view does **not** currently support binary file upload. Under the current code base, the safest first delivery is **vault-native intake**: files are already in `Reading/attachments/<slug>/`, then the agent registers and processes them.
- Reading notes are still validated as normal reading notes by the parser, which means new ingested notes must still have `title`, `authors`, `year`, `journal`, and `read_date`.
- This phase covers **newly ingested reading notes only**. It does **not** include automatic migration of older `Summary / Key Findings / Notes` reading notes.

**Non-goals for the main phase:**
- Direct Zotero API integration
- One-shot fully automatic KB changes without user review
- Starting with websocket file upload before the vault-native workflow is stable

**Architecture:**
- Keep the vault as the system of record.
- Add a shared reading-note helper so `create_reading_note`, intake tools, and status logic all use the same CREATE skeleton and `sources` format.
- Add a small intake toolset that discovers attachment files from a bundle folder, verifies selected files, creates or updates the reading note, and reports the next action.
- Reuse the current KB tools instead of replacing them.
- Define an explicit **active mapping artifact** rule so reruns are deterministic instead of “whatever mapping file happens to exist”.
- Ship chat upload as a later optional phase only after the vault-native pipeline works cleanly.

**Tech Stack:** TypeScript, gray-matter, pdf-parse, existing `safe-writer`, existing `autoWrite/frontmatterFieldUpdate`, Vitest, existing websocket chat loop.

## Scope Decisions

- **Folder discovery is in scope for Phase 2.** The user should not need to type exact filenames like `paper.pdf` or `claude-notes.md` just to register a bundle.
- **Bibliographic metadata is still required at ingest time.** The agent can discover files automatically, but it still needs `title`, `authors`, `year`, and `journal` because the current parser treats those as required reading-note fields.
- **KB reruns are in scope for v1.** `reading_pipeline_status` must understand timestamped rerun mapping artifacts and choose the active one deterministically.
- **Legacy reading-note migration is out of scope here.** Only newly ingested notes are normalized to the CREATE shape in this phase.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/knowledge/reading-note.ts` | Shared reading-note helpers: slugging, CREATE body, source normalization, frontmatter merge |
| Create | `src/agent/tools/reading-intake.ts` | `discover_reading_bundle`, `ingest_reading_bundle`, `reading_pipeline_status`, `set_reading_note_status` |
| Modify | `src/knowledge/source-loader.ts` | Reuse shared reading-source typing/validation |
| Modify | `src/agent/tools/templates.ts` | Upgrade `create_reading_note` to CREATE scaffold + optional `sources` |
| Modify | `src/agent/tools/kb-tools.ts` | Expose compile/status hints cleanly for the intake workflow |
| Modify | `src/agent/runtime.ts` | Register new intake tools |
| Modify | `src/agent/context.ts` | Teach the agent the preferred reading pipeline order |
| Modify | `src/editing/auto-writer.ts` | Allow single-field reading-note `status` updates |
| Create | `tests/unit/reading-note.test.ts` | Helper coverage |
| Create | `tests/unit/reading-intake.test.ts` | Bundle intake coverage |
| Create | `tests/unit/reading-pipeline-status.test.ts` | Status/next-step coverage |
| Create | `tests/integration/reading-pipeline.test.ts` | End-to-end state transition coverage |
| Modify | `tests/unit/template-tools.test.ts` | CREATE scaffold + source-aware note creation |
| Modify | `tests/unit/source-loader.test.ts` | Shared source validation coverage |
| Modify | `tests/unit/kb-tools.test.ts` | Compile tool output remains compatible with the new pipeline |
| Modify | `tests/unit/auto-writer.test.ts` | Reading-note `status` frontmatter updates |

**Optional later phase only:**

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/server/file-intake.ts` | Staging and validation for uploaded files |
| Modify | `src/server/websocket.ts` | Add upload/intake message types |
| Modify | `obsidian-plugin/websocket-client.ts` | Send upload/intake messages |
| Modify | `obsidian-plugin/chat-view.ts` | File picker / drag-and-drop UI |

---

## Phase 1: Shared Reading-Note Model

**Why first:** Right now the repo has two different ideas of a reading note:
- `create_reading_note` creates a simple Summary/Key Findings/Notes skeleton
- `compile_reading_note` expects a CREATE-style reading note with `sources`

That mismatch should be fixed before adding new intake tools.

**Files:**
- Create: `src/knowledge/reading-note.ts`
- Modify: `src/knowledge/source-loader.ts`
- Create: `tests/unit/reading-note.test.ts`
- Modify: `tests/unit/source-loader.test.ts`

- [ ] **Step 1: Create `src/knowledge/reading-note.ts`**

Add shared helpers:
- `type ReadingSourceType = 'pdf' | 'notes' | 'notebooklm' | 'web' | 'other'`
- `interface ReadingSourceInput { type: ReadingSourceType; path: string }`
- `slugifyReadingTitle(title: string): string`
- `normalizeReadingSources(sources: ReadingSourceInput[]): ReadingSourceInput[]`
- `buildCreateReadingBody(meta): string`
- `buildReadingFrontmatter(meta, sources, existingFrontmatter?): Record<string, unknown>`

Rules:
- keep filenames slug-based and ASCII-safe
- keep `sources[].path` relative to `Reading/attachments/<slug>/`
- preserve existing frontmatter keys that the intake layer does not own
- default new notes to `status: draft` and `kb_status: pending`
- do **not** silently rewrite legacy `Summary / Key Findings / Notes` bodies in this phase; that is a separate migration problem

- [ ] **Step 2: Update `src/knowledge/source-loader.ts` to reuse shared source typing**

Do not change loader behavior yet. Only tighten the interface:
- validate `type` against the shared union
- keep unsupported extensions warning behavior
- keep token limits and ordering unchanged

- [ ] **Step 3: Write tests**

`tests/unit/reading-note.test.ts`
- slug generation is stable
- duplicate/invalid sources are normalized or rejected cleanly
- CREATE body includes `Claims`, `Reasoning`, `Evidence`, `Assumptions`, `Takeaways`, `Extensions`
- frontmatter merge preserves user fields like `related_projects`
- helper behavior for newly ingested notes is explicit; no legacy-section migration is attempted

Extend `tests/unit/source-loader.test.ts`
- rejects absolute/traversal source paths
- warns on unknown file type
- continues loading valid sources when one source is bad

- [ ] **Step 4: Verification**

Run:

```bash
npm test -- tests/unit/reading-note.test.ts tests/unit/source-loader.test.ts
./node_modules/.bin/tsc --noEmit
```

**Acceptance:**
- one canonical CREATE reading-note shape exists for newly ingested notes
- source validation lives in one place
- no intake logic exists yet

---

## Phase 2: Vault-Native Bundle Discovery and Intake

**Why second:** Once the reading-note shape is stable, add the smallest usable intake path that fits the current architecture: user places files in `Reading/attachments/<slug>/`, the agent discovers the files in that folder automatically, and the user provides the bibliography metadata once.

**Files:**
- Create: `src/agent/tools/reading-intake.ts`
- Modify: `src/agent/tools/templates.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `tests/unit/template-tools.test.ts`
- Create: `tests/unit/reading-intake.test.ts`

- [ ] **Step 1: Upgrade `create_reading_note` in `src/agent/tools/templates.ts`**

Change it to use the new shared helper:
- body becomes CREATE-based instead of Summary/Key Findings/Notes
- accept optional `slug`
- accept optional `sources`
- accept optional `related_projects`
- preserve overwrite snapshot behavior already tested
- keep `title`, `authors`, `year`, and `journal` required for this manual template path

Keep it as a safe-writer-backed tool returning `pending_edit`.

- [ ] **Step 2: Add `src/agent/tools/reading-intake.ts`**

Create these tools:

1. `discover_reading_bundle`
- input:
  - `slug`
- behavior:
  - inspect `Reading/attachments/<slug>/`
  - classify readable candidates (`pdf`, `notes`, `notebooklm`, `web`, `other`)
  - return:
    - folder existence
    - discovered files
    - recommended `sources`
    - warnings for multiple PDFs, unreadable file types, or empty bundles
  - do **not** write anything

2. `ingest_reading_bundle`
- input:
  - `slug`
  - `title`, `authors`, `year`, `journal`
  - optional `doi`, `related_projects`
  - optional `sources`: array of `{ type, path }`
  - optional `exclude_paths`
- behavior:
  - resolve slug
  - if `sources` is omitted, reuse the recommended source list from bundle discovery
  - verify each selected file exists under `Reading/attachments/<slug>/`
  - require bibliographic metadata because the parser still validates new reading notes as normal reading notes
  - create or update `Reading/Papers/<slug>.md`
  - if the note already exists, merge frontmatter and preserve non-empty body sections
  - when updating an existing note, record a conflict-detector snapshot before returning the edit proposal
  - return a `pending_edit`

- [ ] **Step 3: Register the new tools in `src/agent/runtime.ts`**

Import and register `createReadingIntakeTools(vaultPath, conflictDetector?)` alongside the existing tool groups.

- [ ] **Step 4: Write tests**

`tests/unit/reading-intake.test.ts`
- `discover_reading_bundle` lists readable files and recommended sources from a bundle folder
- it warns clearly for multiple PDFs, unsupported files, and missing bundle folders
- `ingest_reading_bundle` creates a note when files exist
- it errors cleanly when a selected attachment is missing
- it uses discovered sources when explicit `sources` are omitted
- it preserves an existing body when updating metadata/sources
- it records a conflict snapshot when updating an existing note
- it returns an absolute safe-writer path

Extend `tests/unit/template-tools.test.ts`
- `create_reading_note` now produces CREATE headings
- `sources` appear in frontmatter when provided

- [ ] **Step 5: Verification**

Run:

```bash
npm test -- tests/unit/template-tools.test.ts tests/unit/reading-intake.test.ts
./node_modules/.bin/tsc --noEmit
```

**Acceptance:**
- user can point CrickNote at a bundle folder without typing exact filenames
- bibliographic metadata is still entered once at ingest time
- no compile or KB logic has been changed yet

---

## Phase 3: Guided Compile and Workflow Status

**Why third:** After intake, the agent needs a reliable way to know whether to ingest, compile, wait for user edits, or advance to KB. That requires a small amount of status automation.

**Files:**
- Modify: `src/editing/auto-writer.ts`
- Modify: `src/agent/tools/reading-intake.ts`
- Modify: `src/agent/tools/kb-tools.ts`
- Modify: `src/agent/context.ts`
- Create: `tests/unit/reading-pipeline-status.test.ts`
- Modify: `tests/unit/kb-tools.test.ts`
- Modify: `tests/unit/auto-writer.test.ts`

- [ ] **Step 1: Add `reading_pipeline_status` to `src/agent/tools/reading-intake.ts`**

Behavior:
- input: either `slug` or reading-note path
- if the reading note does not exist yet:
  - inspect `Reading/attachments/<slug>/`
  - report whether the bundle exists
  - report discovered/recommended sources
  - report that `title`, `authors`, `year`, and `journal` are still required for ingest
  - return the next step:
    - `missing_bundle`
    - `ready_to_ingest`
- if the reading note exists:
  - inspect frontmatter, CREATE headings, `sources`, `status`, and `kb_status`
  - return a machine-readable next step:
    - `needs_sources`
    - `ready_to_compile`
    - `needs_human_review`
    - `ready_for_kb_mapping`
    - `kb_apply_in_progress`
    - `done`

This tool is important. It gives the agent a deterministic first step instead of relying only on prompt interpretation.

- [ ] **Step 2: Allow reading-note `status` frontmatter updates in `src/editing/auto-writer.ts`**

Extend `isFrontmatterFieldAllowed()` so reading notes can update:
- `status`
- keep existing `kb_status` support

Do **not** allow arbitrary reading-note frontmatter changes. This phase only needs a narrow, explicit permission for workflow state.

- [ ] **Step 3: Add `set_reading_note_status` to `src/agent/tools/reading-intake.ts`**

Behavior:
- input: reading-note path + new status (`draft | in-progress | complete`)
- validate the note lives under `Reading/Papers/` or `Reading/Threads/`
- update only the `status` field via `frontmatterFieldUpdate`

This keeps “mark this reading note complete” simple and low-risk.

- [ ] **Step 4: Tighten `compile_reading_note` output in `src/agent/tools/kb-tools.ts`**

Keep the existing loader behavior, but return a little more structured context:
- current `status`
- current `kb_status`
- whether the CREATE headings are already present
- whether `sources` are missing
- recommended next step from the tool’s point of view

Do **not** move LLM drafting logic into the tool. The runtime loop already handles that.

- [ ] **Step 5: Teach the system prompt the preferred order in `src/agent/context.ts`**

Add a short workflow recipe:
1. call `reading_pipeline_status`
2. if the note does not exist yet, call `discover_reading_bundle` or `ingest_reading_bundle`
3. if ready, call `compile_reading_note`
4. after the user reviews the draft, call `set_reading_note_status` with `complete`
5. then start KB mapping

This is a prompt change, not a new framework.

- [ ] **Step 6: Write tests**

`tests/unit/reading-pipeline-status.test.ts`
- bundle folder missing -> `missing_bundle`
- bundle exists but note missing -> `ready_to_ingest`
- note with no sources -> `needs_sources`
- note with sources but empty CREATE sections -> `ready_to_compile`
- note with drafted CREATE sections but `status != complete` -> `needs_human_review`
- complete note with `kb_status: pending` -> `ready_for_kb_mapping`
- mapped note with pending mapping rows -> `kb_apply_in_progress`
- merged note -> `done`

Extend `tests/unit/kb-tools.test.ts`
- `compile_reading_note` still loads sources
- it now reports the extra status hints cleanly

Extend `tests/unit/auto-writer.test.ts`
- reading-note `status` updates are allowed
- unrelated reading-note fields are still rejected

- [ ] **Step 7: Verification**

Run:

```bash
npm test -- tests/unit/reading-pipeline-status.test.ts tests/unit/kb-tools.test.ts tests/unit/auto-writer.test.ts
./node_modules/.bin/tsc --noEmit
```

**Acceptance:**
- the agent has a deterministic next-step tool
- marking a reading note complete is easy and bounded
- compile remains human-in-the-loop

---

## Phase 4: Reading -> Knowledge Handoff Integration

**Why fourth:** The KB tools already exist. This phase is mostly about making the handoff from a complete reading note predictable and testable.

**Files:**
- Modify: `src/agent/tools/reading-intake.ts`
- Modify: `src/agent/tools/kb-tools.ts`
- Modify: `src/agent/context.ts`
- Create: `tests/integration/reading-pipeline.test.ts`

- [ ] **Step 1: Extend `reading_pipeline_status` with KB handoff awareness and rerun handling**

Make sure it reports:
- the **active** mapping artifact path if one exists
- whether `kb_status` is `pending`, `mapped`, `merged`, `merged_with_review`, or `skipped`
- whether Review-Queue items are still open for the source note

Active mapping rule for v1:
- look in the source note directory for files matching `<slug>-mapping*.md`
- keep only artifacts whose frontmatter `source` points at the source note slug
- if exactly one artifact has `status: confirmed`, choose that artifact as active
- if **multiple** artifacts have `status: confirmed`, do **not** guess; return `needs_mapping_cleanup` with the candidate paths
- otherwise, if one or more artifacts have `status: applied`, choose the newest applied artifact as the last completed run

- [ ] **Step 2: Keep KB tools intact, but align their returned guidance**

In `src/agent/tools/kb-tools.ts`, update instructional strings so they read naturally after the intake phase:
- after `compile_reading_note`, tell the agent to wait for user review before `status: complete`
- after `kb_write_mapping`, point to the mapping path and next `kb_apply` step clearly
- after final `kb_apply_advance`, point back to pipeline completion using the active mapping status terminology

Do not collapse `kb_suggest` and `kb_apply` into one giant tool. The current crash-safe artifact model is a strength.

- [ ] **Step 3: Add an integration test**

Create `tests/integration/reading-pipeline.test.ts` that simulates:
- attachment files exist
- `discover_reading_bundle` identifies them without exact filenames being supplied
- `ingest_reading_bundle` creates the reading note
- `compile_reading_note` loads the sources
- `set_reading_note_status(..., complete)` advances the note
- `kb_write_mapping` moves `kb_status` to `mapped`
- `kb_apply_advance` on the last target moves `kb_status` to `merged`

Also cover one rerun case:
- an older `*-mapping.md` is `applied`
- a newer `*-mapping-<timestamp>.md` is `confirmed`
- `reading_pipeline_status` selects the newer confirmed artifact as active

This integration test should not call the real LLM. Write the intermediate note content directly where needed.

- [ ] **Step 4: Verification**

Run:

```bash
npm test -- tests/integration/reading-pipeline.test.ts tests/unit/kb-tools-suggest.test.ts tests/unit/kb-tools-apply.test.ts
./node_modules/.bin/tsc --noEmit
```

**Acceptance:**
- a reading note can move from raw source bundle -> drafted note -> complete note -> mapped KB -> merged KB without ad hoc manual bookkeeping
- rerun mappings do not make status ambiguous

---

## Phase 5: Optional Obsidian “Send File in Chat” UX

**Do this only after Phases 1-4 are stable.**

The current plugin and websocket protocol are text-only. True “send the PDF and notes” UX requires transport work, not just prompt work.

**Files:**
- Create: `src/server/file-intake.ts`
- Modify: `src/server/websocket.ts`
- Modify: `obsidian-plugin/websocket-client.ts`
- Modify: `obsidian-plugin/chat-view.ts`

- [ ] **Step 1: Add a staging layer**

`src/server/file-intake.ts`
- validate file names
- write staged files under a controlled temp or vault intake directory
- return the staged relative paths that `ingest_reading_bundle` can consume

- [ ] **Step 2: Extend websocket protocol**

Add message types for:
- intake session start
- file chunk transfer or manifest-based upload
- intake session finalize

Keep size limits and MIME checks explicit. Reject unexpected binary types.

- [ ] **Step 3: Add chat UI affordance**

In `obsidian-plugin/chat-view.ts`
- add an Attach button
- optionally support drag/drop
- show selected files before send

In `obsidian-plugin/websocket-client.ts`
- wrap the upload message flow cleanly

- [ ] **Step 4: Verification**

Manual test:
1. attach PDF + one `.md` note in the chat UI
2. confirm files land in the staged location
3. confirm `ingest_reading_bundle` can create the reading note from them

**Acceptance:**
- user no longer has to pre-place files manually in the vault
- the rest of the pipeline remains unchanged

---

## Recommended Execution Order

1. **Phase 1** — unify reading-note shape first
2. **Phase 2** — add vault-native intake tools
3. **Phase 3** — add status transitions and workflow guidance
4. **Phase 4** — harden the KB handoff with integration coverage
5. **Phase 5** — only then add real plugin upload UX

This order matters. If you start with plugin upload, you will spend time moving bytes around before the repo has a stable internal reading pipeline to receive them.

---

## User Workflow After Phases 1-4

1. User exports a PDF from Zotero and places it in:
   - `Reading/attachments/<slug>/paper.pdf`
2. User places AI notes in the same folder:
   - `Reading/attachments/<slug>/notebooklm-summary.md`
   - `Reading/attachments/<slug>/claude-notes.md`
3. User tells CrickNote:
   - “Check this reading bundle: `<slug>`”
4. CrickNote discovers the files in that folder and asks for any missing metadata.
5. User provides the paper metadata once:
   - title
   - authors
   - year
   - journal
6. CrickNote creates:
   - `Reading/Papers/<slug>.md`
7. User tells CrickNote:
   - “Compile this reading note”
8. CrickNote drafts the CREATE sections.
9. User reviews and then says:
   - “Mark this reading note complete”
10. User tells CrickNote:
   - “Push this reading note into the knowledge base”
11. CrickNote runs:
   - `kb_suggest`
   - `kb_write_mapping`
   - `kb_apply`
   - `kb_apply_advance`
12. Knowledge notes, indexes, Update Logs, and Review-Queue update through the existing KB workflow.

---

## Recommendation

Ship **Phases 1-4 as the main “Reading intake pipeline” phase**.

That gives you the workflow you want using the current architecture:
- PDF + AI notes go into the vault
- CREATE reading note is generated and stored
- the reading note advances into Concepts / Entities / Methods through the current KB system

Treat **Phase 5** as a separate follow-up phase called something like:

**“Obsidian file upload UX for reading intake”**

That keeps the core pipeline stable before introducing websocket file transfer complexity.
