# CrickNote Spec: Indexer Hardening + KB Mapping Pipeline

**Date:** 2026-05-05
**Status:** Approved
**Scope:** Phase 1 — indexer reliability; Phase 2 — structured mapping artifact (schema v2), `kb_suggest` dedup, and KB tool updates.
**Depends on:** Spec 2 — Knowledge Base Workflow (2026-04-10)
**Out of scope:** Automatic post-ingest draft mapping creation. Phase 2 prepares the structured mapping machinery; the actual post-ingest automation is a later phase.

---

## Background

Two separate problems motivated this spec:

1. **Indexer stuck state.** CrickNote's SQLite index was left at `state = indexing` / `indexed_files = 13` / `total_files = 20` after a mid-run crash. The Pogorelyy paper and one project index file were missing from `note_metadata`, `note_chunks`, and search. Stale rows remained for deleted files. No code path wrote `state = error` on failure.

2. **Mapping artifact is prose-only.** `kb_write_mapping` writes a markdown table; `kb_apply` and `kb_apply_advance` parse and patch that table with regex. There is no machine-readable canonical target list, no dedup guard, and no structured output from `kb_suggest` for tests or validation.

---

## Phase 1 — Indexer Hardening

### Files changed

- `src/ingestion/worker.ts`
- `src/ingestion/indexer.ts` (new export: `deleteStaleNotes`)

### Changes

**Stale row cleanup in `fullIndex()`.**
After the file loop completes, compare the set of `path` values in `note_metadata` against `indexableFiles`. Call `deleteNote()` for each path present in the DB but absent from `indexableFiles`. This removes orphan rows for deleted or moved files and rows for paths that were previously indexed but are now excluded by `shouldIgnoreIngestionPath`.

`indexableFiles` is the post-filter set:
```typescript
const indexableFiles = allFiles.filter(f => !shouldIgnoreIngestionPath(f));
```
Raw `allFiles` is not used for this comparison because `shouldIgnoreIngestionPath` excludes paths (e.g. Knowledge indexes, lint reports, mapping artifacts) that are intentionally not indexed.

**Error state in `fullIndex()`.**
Wrap the body of `fullIndex()` in `try/catch`. If anything throws, call `updateIndexingStatus('error', totalFiles, indexedCount, err.message)` before re-throwing. `totalFiles` and `indexedCount` are declared in outer scope so the catch can reference them.

Revised shape:

```typescript
private async fullIndex(): Promise<void> {
  let totalFiles = 0;
  let indexedCount = 0;

  try {
    const allFiles = await VaultWatcher.getAllMarkdownFiles(this.vaultPath);
    const indexableFiles = allFiles.filter(f => !shouldIgnoreIngestionPath(f));

    totalFiles = indexableFiles.length;
    updateIndexingStatus('indexing', totalFiles, 0);
    this.emit('progress', 0, totalFiles);

    for (const relativePath of indexableFiles) {
      if (!this.running) break;
      try {
        await this.processFile(relativePath);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error', err, relativePath);
      }
      indexedCount++;
      updateIndexingStatus('indexing', totalFiles, indexedCount);
      this.emit('progress', indexedCount, totalFiles);
    }

    deleteStaleNotes(indexableFiles);   // new export in indexer.ts — see below
    markFullIndexComplete();
    log.info('Full index complete', { indexed: indexedCount, total: totalFiles });
    this.emit('status', 'idle', `Full index complete. ${indexedCount}/${totalFiles} files indexed.`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    updateIndexingStatus('error', totalFiles, indexedCount, err.message);
    this.emit('status', 'error', `Full index failed: ${err.message}`);
    this.emit('error', err);
    throw err;
  }
}
```

**Startup recovery logging (observability only).**
In `start()`, before calling `fullIndex()`, query `indexing_status`. If `state = 'indexing'`, log a warning: `"Previous index run did not complete — restarting full index."` No additional recovery logic is needed: `fullIndex()` resets the counter to 0 at the start of every run.

**`deleteStaleNotes(validPaths: string[])` (new export in `indexer.ts`).**
Queries all `path` values from `note_metadata`, diffs against `validPaths`, calls `deleteNote()` for each orphan in a single transaction. Lives in `indexer.ts` alongside all other DB writes. `worker.ts` calls it with `indexableFiles` after the main loop.

### Tests (4)

1. Startup with `state = 'indexing'` in DB logs a recovery warning and completes successfully.
2. Full index removes DB rows for files deleted from the vault.
3. Full index failure mid-run (e.g. `embedTexts()` throws during the loop) writes `state = 'error'`.
4. New files added to the vault appear in `note_metadata` after indexing.

---

## Phase 2 — KB Mapping Pipeline

### Files changed / created

| File | Change |
|------|--------|
| `src/knowledge/mapping-artifact.ts` | **New.** Shared types, `readMappingArtifact()`, `writeMappingArtifact()`, `normalizeMappingSource()`, internal `parseMappingTargets()` |
| `src/agent/tools/kb-tools.ts` | Update `kb_suggest`, `kb_write_mapping`, `kb_apply`, `kb_apply_advance`. Remove `updateMappingTargetState()`. Remove `parseMappingTargets()` (moved). |

### 2.1 `src/knowledge/mapping-artifact.ts`

#### Types

```typescript
export type MappingTargetState = 'pending' | 'applied' | 'skipped' | 'deferred';
export type MappingTargetKind = 'Concepts' | 'Entities' | 'Methods';
export type MappingTargetAction = 'create' | 'update';
export type MappingTargetConfidence = 'high' | 'medium' | 'low';

export interface MappingArtifactTarget {
  slug: string;
  title?: string;
  kind?: MappingTargetKind;
  action: MappingTargetAction;
  state: MappingTargetState;
  confidence?: MappingTargetConfidence;
  reason?: string;
  reviewQueue?: string;   // wikilink to Review-Queue note when state = deferred
  updated?: string;       // ISO timestamp when state was last changed
}

export interface MappingArtifact {
  schemaVersion: 1 | 2;
  source: string;          // [[slug]] wikilink
  sourceSlug: string;      // bare slug, no brackets
  sourcePath?: string;     // vault-relative path
  sourceHash?: string;     // SHA-256 of source note content at suggestion time
  created: string;         // YYYY-MM-DD
  status: 'draft' | 'confirmed' | 'applied';
  targets: MappingArtifactTarget[];
  rejected: Array<{ slug: string; reason?: string }>;
  warnings?: string[];
}
```

#### `normalizeMappingSource(value)`

Handles malformed `source` values found in existing artifacts (nested arrays like `[['slug']]`, plain strings, `[[slug]]` wikilinks):

```typescript
export function normalizeMappingSource(
  value: unknown
): { source: string; sourceSlug: string }
```

Returns a canonical `[[slug]]` string and the bare slug. If the value cannot be normalized, returns empty strings (not a hard error — lets the artifact still load).

#### `readMappingArtifact(absPath)`

```typescript
export function readMappingArtifact(absPath: string): MappingArtifact
```

1. Read file and parse frontmatter via `gray-matter`.
2. Call `normalizeMappingSource(frontmatter.source)` for `source` / `sourceSlug`.
3. If `frontmatter.schema_version === 2` and `frontmatter.targets` is a non-empty array → use frontmatter targets as canonical (`schemaVersion: 2`).
4. Otherwise → fall back to `parseMappingTargets(body)` (`schemaVersion: 1`). Targets from the table are converted to `MappingArtifactTarget` objects with `action`, `state`, and `reviewQueue` only (no `kind`, `confidence`, `reason` — these were not in schema v1).
5. Throws if file does not exist.

#### `writeMappingArtifact(absPath, artifact, vaultPath)`

```typescript
export function writeMappingArtifact(
  absPath: string,
  artifact: MappingArtifact,
  vaultPath: string
): void
```

Always writes schema v2. Produces:

```yaml
---
type: kb-mapping
schema_version: 2
source: [[slug]]
source_path: Reading/Papers/slug.md
source_hash: sha256...
created: 2026-05-05
status: confirmed
targets:
  - slug: tirtl-seq
    title: TIRTL-seq
    kind: Methods
    action: create
    state: pending
    confidence: high
    reason: Main sequencing method introduced by the paper.
rejected: []
---
```

Then regenerates the `## Targets` markdown table from `artifact.targets` (columns: Target | Kind | Action | State | Confidence | Reason | Review-Queue | Updated). The table is pure display — it is fully regenerated from the YAML on every write and is never parsed back.

Calls `autoWrite(absPath, content, vaultPath)` internally.

#### `parseMappingTargets(body)` (internal, not exported)

Moved from `kb-tools.ts`. Same logic as current implementation. Used only by `readMappingArtifact()` for schema v1 fallback. Not deleted until all fallback tests pass.

### 2.2 `kb_suggest` — source_hash + dedup

**New behavior: source_hash.**
Compute `SHA-256(sourceNoteContent)` and include it in the return JSON as `source_hash`.

**New behavior: dedup guard.**
Before loading source context, check for an existing `*-mapping.md` at the expected artifact path. If it exists and `readMappingArtifact()` returns a `sourceHash` matching the current `source_hash`, and `status` is in `['draft', 'confirmed', 'applied']`, return early:

```json
{
  "status": "already_suggested",
  "sourceHash": "sha256...",
  "artifactPath": "Reading/Papers/slug-mapping.md",
  "mappingStatus": "confirmed",
  "message": "A mapping already exists for this version of the source note. Run kb_apply to continue."
}
```

If status is `applied`, add: `"Mapping already applied. Use rerun_confirmed: true with kb_write_mapping to re-map."`

**No file write.** `kb_suggest` does not write any file. `kb_write_mapping` is the only writer.

**Updated instruction in return JSON.**
The instruction field now tells the agent to format its mapping proposal as structured targets:

```
After calling vault_search, propose knowledge mapping targets in this format:
[{ slug, title, kind, action, confidence, reason }]
Then call kb_write_mapping with confirmed_targets (those the user approves) and
rejected_targets (those the user rejects), passing source_hash from this tool's output.
```

The agent's reasoning still generates the actual target list — the instruction standardizes the schema so the agent passes structured data to `kb_write_mapping`.

### 2.3 `kb_write_mapping` — schema v2 write

**Extended `confirmed_targets` items.** Each item now accepts optional `title`, `confidence`, `reason` (in addition to existing `slug`, `action`, `kind`). The `confirmed_targets` name is preserved for backward compatibility. When `status: draft`, these are proposed-but-not-confirmed targets; when `status: confirmed` (the default), they are user-approved targets. The distinction is conveyed by the `status` field, not by renaming the parameter.

**New `source_hash` parameter (optional string).** Passed through from `kb_suggest` return value. Stored in the artifact frontmatter.

**New `status` parameter (optional, `'draft' | 'confirmed'`, default `'confirmed'`).** Allows the artifact to be written as a draft for future automation. The existing user-confirmed flow passes no `status` and gets `confirmed` as before.

**Writes via `writeMappingArtifact()`.** The hand-built template string is removed.

**Collision handling** is unchanged from Spec 2 §10:
- Existing `applied` artifact → require `rerun_confirmed: true` to overwrite
- Existing `confirmed` artifact → return `already_in_progress`
- Existing `draft` artifact → overwrite silently

### 2.4 `kb_apply`

Replace `parseMappingTargets(parsed.content)` with `readMappingArtifact(artifactPath).targets`. The `pending` target lookup is unchanged. Schema v1 fallback is transparent.

### 2.5 `kb_apply_advance`

Replace the `parseMappingTargets` + `updateMappingTargetState` + `matter.stringify` sequence with:

1. `const artifact = readMappingArtifact(artifactPath)`
2. Find `targets[N]` where `slug === target_slug`; update `state`, `reviewQueue`, `updated`
3. Update `artifact.status` to `'confirmed'` or `'applied'` based on remaining pending targets
4. `writeMappingArtifact(artifactPath, artifact, vaultPath)`

Old table-only artifacts are read as schema v1 and written back as schema v2 — an implicit, one-way migration.

`updateMappingTargetState()` is deleted once all advance tests pass.

### Tests (5)

1. `writeMappingArtifact` + `readMappingArtifact` round-trip: schema v2 frontmatter is canonical; table is regenerated on write.
2. `readMappingArtifact` on old table-only artifact: falls back to table parser, returns correct targets with `schemaVersion: 1`.
3. `normalizeMappingSource` handles: clean `[[slug]]`, plain string, nested array `[['slug']]`.
4. `kb_suggest` dedup: same `source_hash` on existing artifact returns `already_suggested` without re-proposing.
5. `kb_apply_advance` on schema v1 artifact: reads table, updates state, writes back as schema v2.

---

## Migration Notes

- `npm run reindex` + `npm run start` clears the current stuck DB state immediately (no code change needed for Phase 1 repair).
- Existing `*-mapping.md` files with old table-only format continue to work via schema v1 fallback in `readMappingArtifact()`. They are silently upgraded to schema v2 the first time `kb_apply_advance` runs against them.
- `confirmed_targets` parameter name on `kb_write_mapping` is unchanged for backward compatibility.
