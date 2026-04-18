---
phase: reading-intake-pipeline
fixed_at: 2026-04-14T07:18:41Z
review_path: docs/superpowers/plans/2026-04-14-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 11
skipped: 0
status: all_fixed
---

# Reading Intake Pipeline — Code Review Fix Report

**Fixed at:** 2026-04-14T07:18:41Z
**Source review:** docs/superpowers/plans/2026-04-14-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 11 (CR-01 through CR-04, WR-01 through WR-07)
- Fixed: 11
- Skipped: 0

## Fixed Issues

### CR-01: `set_reading_note_status` writes directly to disk — violates the safe-edit protocol

**Files modified:** `src/agent/tools/reading-intake.ts`, `tests/unit/reading-pipeline-status.test.ts`
**Commit:** a5608ad
**Applied fix:** Replaced the direct `frontmatterFieldUpdate` call with a read-parse-modify-return pattern that produces a `pending_edit` payload. The unused `frontmatterFieldUpdate` import was also removed. The test was updated to expect `type: 'pending_edit'` and verify the file on disk is NOT modified until the user confirms.

---

### CR-02: `parseMappingTargets` silently drops rows containing wikilink display aliases

**Files modified:** `src/agent/tools/kb-tools.ts`
**Commit:** 8185d13
**Applied fix:** Added a `collapsed = line.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, '[[$1]]')` step before `split('|')` so that display aliases inside wikilinks are stripped before cell-splitting. Simplified the slug-extraction regex to a plain `\[\[([^\]]+)\]\]` match against the already-collapsed cell. `updateMappingTargetState` already had alias-aware regex so no change was needed there.

---

### CR-03: `ingest_reading_bundle` checks bundle existence after resolving sources from the discovery result

**Files modified:** `src/agent/tools/reading-intake.ts`
**Commit:** be63d9b
**Applied fix:** Moved the `if (!discovery.folderExists)` guard to immediately after `discoverBundle`, before excluded-paths normalization and source selection. Users now receive the accurate "Reading bundle not found" error regardless of whether they provided explicit sources or not.

---

### CR-04: Phase 4 integration test is absent

**Files modified:** `tests/integration/reading-pipeline.test.ts` (created)
**Commit:** fe82dd0
**Applied fix:** Created the Phase 4 integration test with 6 test cases covering: (1) ingest produces `pending_edit`, (2) status reports `needs_human_review` after compile, (3) `set_reading_note_status` returns `pending_edit` and after applying it status advances to `ready_for_kb_mapping`, (4) full `kb_write_mapping` → `kb_apply` → `kb_apply_advance` loop sets `kb_status` to `merged`, (5) active-mapping selection picks `confirmed` over older `applied` artifact, (6) opaque error when both slug and path are omitted (WR-05 integration check).

---

### WR-01: `needs_mapping_cleanup` status is unimplemented — multiple confirmed artifacts are silently mis-selected

**Files modified:** `src/knowledge/reading-note.ts`, `src/agent/tools/reading-intake.ts`, `tests/unit/reading-pipeline-status.test.ts`
**Commit:** bc9fb55
**Applied fix:** Added `'needs_mapping_cleanup'` to the `ReadingPipelineStep` union. Updated `MappingArtifactSummary` with optional `needsCleanup` and `cleanupCandidates` fields. Updated `findRelevantMappingArtifact` to detect multiple confirmed candidates and return the cleanup signal instead of guessing. Updated `determinePipelineStep` to check `mapping.needsCleanup` first and return `'needs_mapping_cleanup'`. Exposed `mapping_cleanup_candidates` in the `reading_pipeline_status` response payload. Added a test asserting the new step is returned.

---

### WR-02: `create_reading_note` always replaces the body on update — loses drafted CREATE content

**Files modified:** `src/agent/tools/templates.ts`, `tests/unit/template-tools.test.ts`
**Commit:** 4a6238d
**Applied fix:** Added imports for `hasMeaningfulReadingBody` and `syncReadingBodyTitle` from `reading-note.ts`. The execute handler now reads the existing body when the note exists and only uses `buildCreateReadingBody` when the body is still an empty scaffold; otherwise it calls `syncReadingBodyTitle` to preserve content while keeping the title in sync. Added a test that writes a note with drafted Claims/Reasoning content and verifies it is preserved after calling `create_reading_note`.

---

### WR-03: `kb_apply` recursive `findInDir` has no depth guard — symlink loops crash the process

**Files modified:** `src/agent/tools/kb-tools.ts`
**Commit:** c5e46f9
**Applied fix:** Added a `depth = 0` parameter to `findInDir` with an early return when `depth > 8`. Added `if (entry.isSymbolicLink()) continue` before `entry.isDirectory()` check to skip symlinks entirely, preventing both infinite recursion and cross-vault symlink traversal.

---

### WR-04: Wikilink slugs in mapping artifacts are not validated for path separators

**Files modified:** `src/agent/tools/kb-tools.ts`
**Commit:** 21abfe8
**Applied fix:** Added an `isValidSlug(t.slug)` check inside the confirmed-targets validation loop in `kb_write_mapping`. Returns an error with a clear message before any artifact is written if a slug contains path separators or other disallowed characters.

---

### WR-05: `reading_pipeline_status` — both inputs optional; opaque error when both are missing

**Files modified:** `src/agent/tools/reading-intake.ts`
**Commit:** c0e1160
**Applied fix:** Added an early guard at the top of the `reading_pipeline_status` execute handler: `if (args.path === undefined && args.slug === undefined) return JSON.stringify({ error: 'Either "slug" or "path" is required.' })`. This fires before the confusing `normalizeBundleSlug` throw.

---

### WR-06: `source-loader.ts` emits the session-cap warning twice when a single source triggers the cap

**Files modified:** `src/knowledge/source-loader.ts`
**Commit:** f465636
**Applied fix:** Added a `sessionCapWarningEmitted` boolean flag initialized to `false` before the source loop. The session-cap warning message is now guarded by `if (!sessionCapWarningEmitted)` and sets the flag to `true` at both emission sites (the loop-top early-exit path and the mid-source truncation path).

---

### WR-07: `ingest_reading_bundle` always targets `Reading/Papers/` — cannot ingest a thread note

**Files modified:** `src/agent/tools/reading-intake.ts`
**Commit:** 1ac142e
**Applied fix:** Before resolving the note path, `findReadingNoteBySlug` is called to check whether a note already exists under `Reading/Papers/` or `Reading/Threads/`. If found, that absolute path is used directly; otherwise the code falls back to `Reading/Papers/<slug>.md` as before. This ensures ingesting a bundle that has a pre-existing thread note updates that note rather than creating a duplicate.

---

## Skipped Issues

None — all 11 in-scope findings were fixed.

---

_Fixed: 2026-04-14T07:18:41Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
