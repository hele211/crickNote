# Phase 2: KB Mapping Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prose-only mapping artifact with a schema v2 format where YAML frontmatter `targets` is canonical, add `readMappingArtifact`/`writeMappingArtifact` helpers, wire `kb_suggest` source_hash dedup, and update `kb_apply`/`kb_apply_advance`/`kb_write_mapping` to use the shared helpers.

**Architecture:** New `src/knowledge/mapping-artifact.ts` owns all artifact types and read/write logic. `kb-tools.ts` imports from it; old `parseMappingTargets` and `updateMappingTargetState` are deleted after all callers are migrated. Schema v1 (table-only) artifacts continue to read correctly via fallback; `kb_apply_advance` silently migrates them to v2 on write.

**Tech Stack:** TypeScript, gray-matter, better-sqlite3 (for existing tests), Vitest, Node.js fs

---

## File Map

| File | Change |
|------|--------|
| `src/knowledge/mapping-artifact.ts` | **New.** Types, `normalizeMappingSource`, `readMappingArtifact`, `writeMappingArtifact`, internal `parseMappingTargets` |
| `src/agent/tools/kb-tools.ts` | Update `kb_suggest`, `kb_write_mapping`, `kb_apply`, `kb_apply_advance`. Remove `parseMappingTargets`, `updateMappingTargetState`. |
| `tests/unit/mapping-artifact.test.ts` | **New.** Tests for all helpers (6 spec tests) |
| `tests/unit/kb-tools-suggest.test.ts` | Add source_hash dedup test |
| `tests/unit/kb-tools-apply.test.ts` | Add advance-migration-to-v2 test |

---

### Task 1: Create `mapping-artifact.ts` — types and `normalizeMappingSource`

**Files:**
- Create: `src/knowledge/mapping-artifact.ts`
- Create: `tests/unit/mapping-artifact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mapping-artifact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeMappingSource } from '../../src/knowledge/mapping-artifact.js';

describe('normalizeMappingSource', () => {
  it('handles clean [[slug]] wikilink', () => {
    expect(normalizeMappingSource('[[smith-2026-il42]]')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles plain string slug', () => {
    expect(normalizeMappingSource('smith-2026-il42')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles nested array [["slug"]] (malformed old format)', () => {
    expect(normalizeMappingSource([['smith-2026-il42']])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles single-level array ["slug"]', () => {
    expect(normalizeMappingSource(['smith-2026-il42'])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('returns empty strings for null/undefined', () => {
    expect(normalizeMappingSource(null)).toEqual({ source: '', sourceSlug: '' });
    expect(normalizeMappingSource(undefined)).toEqual({ source: '', sourceSlug: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/knowledge/mapping-artifact.ts` with types and `normalizeMappingSource`**

```typescript
import fs from 'node:fs';
import matter from 'gray-matter';
import { autoWrite } from '../editing/auto-writer.js';

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
  reviewQueue?: string;
  updated?: string;
}

export interface MappingArtifact {
  schemaVersion: 1 | 2;
  source: string;
  sourceSlug: string;
  sourcePath?: string;
  sourceHash?: string;
  created: string;
  status: 'draft' | 'confirmed' | 'applied';
  targets: MappingArtifactTarget[];
  rejected: Array<{ slug: string; reason?: string }>;
  warnings?: string[];
}

export function normalizeMappingSource(value: unknown): { source: string; sourceSlug: string } {
  let raw: string;
  if (Array.isArray(value)) {
    const inner = value[0];
    raw = Array.isArray(inner) ? String(inner[0] ?? '') : String(inner ?? '');
  } else {
    raw = String(value ?? '');
  }
  const slug = raw.replace(/^\[\[|\]\]$/g, '').trim();
  if (!slug) return { source: '', sourceSlug: '' };
  return { source: `[[${slug}]]`, sourceSlug: slug };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: PASS — 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/mapping-artifact.ts tests/unit/mapping-artifact.test.ts
git commit -m "feat(mapping): add MappingArtifact types and normalizeMappingSource"
```

---

### Task 2: Add `parseMappingTargets` (internal) and `readMappingArtifact`

**Files:**
- Modify: `src/knowledge/mapping-artifact.ts`
- Modify: `tests/unit/mapping-artifact.test.ts`

- [ ] **Step 1: Write failing tests** (append to `tests/unit/mapping-artifact.test.ts`)

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMappingArtifact } from '../../src/knowledge/mapping-artifact.js';

const V1_ARTIFACT = `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | pending | | |

## Rejected
(none)
`;

const V2_ARTIFACT = `---
type: kb-mapping
schema_version: 2
source: "[[smith-2026-il42]]"
source_hash: "sha256abc"
created: 2026-04-08
status: confirmed
targets:
  - slug: tirtl-seq
    kind: Methods
    action: create
    state: pending
    confidence: high
    reason: Main method
rejected: []
---

## Targets

| Target | Kind | Action | State | Confidence | Reason | Review-Queue | Updated |
|--------|------|--------|-------|------------|--------|--------------|---------|
| [[WRONG-TABLE]] | Methods | create | pending | high | Wrong | | |
`;

describe('readMappingArtifact', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads schema v1 table-only artifact and returns schemaVersion 1', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V1_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.sourceSlug).toBe('smith-2026-il42');
    expect(artifact.targets).toHaveLength(1);
    expect(artifact.targets[0].slug).toBe('cd4-cd8-interaction');
    expect(artifact.targets[0].state).toBe('pending');
  });

  it('reads schema v2 frontmatter as canonical, ignores table content', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V2_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.sourceHash).toBe('sha256abc');
    expect(artifact.targets).toHaveLength(1);
    expect(artifact.targets[0].slug).toBe('tirtl-seq');
    expect(artifact.targets[0].kind).toBe('Methods');
    expect(artifact.targets[0].confidence).toBe('high');
  });

  it('schema v2 frontmatter wins when table disagrees', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V2_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.targets.every(t => t.slug !== 'WRONG-TABLE')).toBe(true);
    expect(artifact.targets[0].slug).toBe('tirtl-seq');
  });

  it('reads schema v2 with empty targets array (valid draft)', () => {
    const content = `---\ntype: kb-mapping\nschema_version: 2\nsource: "[[slug]]"\ncreated: 2026-05-05\nstatus: draft\ntargets: []\nrejected: []\n---\n\n## Targets\n`;
    const p = path.join(tmpDir, 'empty-mapping.md');
    fs.writeFileSync(p, content);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.targets).toHaveLength(0);
  });

  it('throws if file does not exist', () => {
    expect(() => readMappingArtifact('/nonexistent/path.md')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: FAIL — `readMappingArtifact` not exported

- [ ] **Step 3: Add `parseMappingTargets` (internal) and `readMappingArtifact` to `mapping-artifact.ts`**

Append to `src/knowledge/mapping-artifact.ts`:

```typescript
// Internal — used only by readMappingArtifact for schema v1 fallback.
// Not deleted until all fallback tests pass.
function parseMappingTargets(body: string): MappingArtifactTarget[] {
  const targets: MappingArtifactTarget[] = [];
  const sectionMatch = body.match(/## Targets\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!sectionMatch) return targets;
  for (const line of sectionMatch[1].split('\n')) {
    if (!line.includes('[[')) continue;
    const collapsed = line.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, '[[$1]]');
    const cells = collapsed.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 5) continue;
    const slugMatch = cells[0].match(/\[\[([^\]]+)\]\]/);
    if (!slugMatch) continue;
    const slug = slugMatch[1].trim();
    if (!slug) continue;
    targets.push({
      slug,
      action: cells[1].trim() as MappingTargetAction,
      state: cells[2].trim() as MappingTargetState,
      reviewQueue: cells[3].trim() || undefined,
      updated: cells[4].trim() || undefined,
    });
  }
  return targets;
}

export function readMappingArtifact(absPath: string): MappingArtifact {
  const raw = fs.readFileSync(absPath, 'utf-8');
  const parsed = matter(raw);
  const fm = parsed.data;

  const { source, sourceSlug } = normalizeMappingSource(fm['source']);
  const isV2 = fm['schema_version'] === 2 && Array.isArray(fm['targets']);

  let targets: MappingArtifactTarget[];
  const schemaVersion: 1 | 2 = isV2 ? 2 : 1;

  if (isV2) {
    targets = (fm['targets'] as unknown[]).map((t: unknown) => {
      const tgt = t as Record<string, unknown>;
      return {
        slug: String(tgt['slug'] ?? ''),
        title: tgt['title'] != null ? String(tgt['title']) : undefined,
        kind: tgt['kind'] as MappingTargetKind | undefined,
        action: String(tgt['action'] ?? 'update') as MappingTargetAction,
        state: String(tgt['state'] ?? 'pending') as MappingTargetState,
        confidence: tgt['confidence'] as MappingTargetConfidence | undefined,
        reason: tgt['reason'] != null ? String(tgt['reason']) : undefined,
        reviewQueue: tgt['review_queue'] != null ? String(tgt['review_queue']) : undefined,
        updated: tgt['updated'] != null ? String(tgt['updated']) : undefined,
      };
    });
  } else {
    targets = parseMappingTargets(parsed.content);
  }

  const fmRejected = fm['rejected'];
  const rejected: MappingArtifact['rejected'] = Array.isArray(fmRejected)
    ? (fmRejected as unknown[]).map((r: unknown) => {
        if (typeof r === 'object' && r !== null) {
          const obj = r as Record<string, unknown>;
          return { slug: String(obj['slug'] ?? ''), reason: obj['reason'] != null ? String(obj['reason']) : undefined };
        }
        return { slug: String(r) };
      })
    : [];

  return {
    schemaVersion,
    source,
    sourceSlug,
    sourcePath: fm['source_path'] != null ? String(fm['source_path']) : undefined,
    sourceHash: fm['source_hash'] != null ? String(fm['source_hash']) : undefined,
    created: String(fm['created'] ?? new Date().toISOString().slice(0, 10)),
    status: (fm['status'] as MappingArtifact['status']) ?? 'confirmed',
    targets,
    rejected,
    warnings: Array.isArray(fm['warnings']) ? (fm['warnings'] as unknown[]).map(String) : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: PASS — all 5 `normalizeMappingSource` tests + 5 `readMappingArtifact` tests

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/mapping-artifact.ts tests/unit/mapping-artifact.test.ts
git commit -m "feat(mapping): add readMappingArtifact with v1 fallback and v2 canonical read"
```

---

### Task 3: Add `writeMappingArtifact`

**Files:**
- Modify: `src/knowledge/mapping-artifact.ts`
- Modify: `tests/unit/mapping-artifact.test.ts`

- [ ] **Step 1: Write failing test** (append to test file)

```typescript
import { writeMappingArtifact } from '../../src/knowledge/mapping-artifact.js';

describe('writeMappingArtifact round-trip', () => {
  let tmpDir: string;
  let vaultPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-test-'));
    vaultPath = tmpDir;
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes schema v2 and reads back identical targets', () => {
    const artifact: MappingArtifact = {
      schemaVersion: 2,
      source: '[[pogorelyy-2026-tirtl-seq]]',
      sourceSlug: 'pogorelyy-2026-tirtl-seq',
      sourcePath: 'Reading/Papers/pogorelyy-2026-tirtl-seq.md',
      sourceHash: 'sha256abc',
      created: '2026-05-05',
      status: 'confirmed',
      targets: [
        { slug: 'tirtl-seq', title: 'TIRTL-seq', kind: 'Methods', action: 'create', state: 'pending', confidence: 'high', reason: 'Main method' },
        { slug: 'tcr-repertoire', kind: 'Concepts', action: 'update', state: 'pending' },
      ],
      rejected: [{ slug: 'western-blot', reason: 'not novel' }],
    };
    const p = path.join(tmpDir, 'test-mapping.md');
    writeMappingArtifact(p, artifact, vaultPath);

    const readBack = readMappingArtifact(p);
    expect(readBack.schemaVersion).toBe(2);
    expect(readBack.sourceHash).toBe('sha256abc');
    expect(readBack.targets).toHaveLength(2);
    expect(readBack.targets[0].slug).toBe('tirtl-seq');
    expect(readBack.targets[0].kind).toBe('Methods');
    expect(readBack.targets[0].confidence).toBe('high');
    expect(readBack.targets[1].slug).toBe('tcr-repertoire');
    expect(readBack.rejected[0].slug).toBe('western-blot');
  });

  it('regenerates markdown table from frontmatter (table is display-only)', () => {
    const artifact: MappingArtifact = {
      schemaVersion: 2,
      source: '[[slug]]',
      sourceSlug: 'slug',
      created: '2026-05-05',
      status: 'confirmed',
      targets: [{ slug: 'tirtl-seq', kind: 'Methods', action: 'create', state: 'pending' }],
      rejected: [],
    };
    const p = path.join(tmpDir, 'test-mapping.md');
    writeMappingArtifact(p, artifact, vaultPath);
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toContain('## Targets');
    expect(content).toContain('| [[tirtl-seq]]');
    expect(content).toContain('schema_version: 2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: FAIL — `writeMappingArtifact` not exported

- [ ] **Step 3: Add `writeMappingArtifact` to `mapping-artifact.ts`**

Append to `src/knowledge/mapping-artifact.ts`:

```typescript
export function writeMappingArtifact(
  absPath: string,
  artifact: MappingArtifact,
  vaultPath: string
): void {
  const sanitize = (s: string) => s.replace(/[|\n\r]/g, ' ').trim();

  const fmTargets = artifact.targets.map(t => ({
    slug: t.slug,
    ...(t.title != null ? { title: t.title } : {}),
    ...(t.kind != null ? { kind: t.kind } : {}),
    action: t.action,
    state: t.state,
    ...(t.confidence != null ? { confidence: t.confidence } : {}),
    ...(t.reason != null ? { reason: t.reason } : {}),
    ...(t.reviewQueue != null ? { review_queue: t.reviewQueue } : {}),
    ...(t.updated != null ? { updated: t.updated } : {}),
  }));

  const frontmatter: Record<string, unknown> = {
    type: 'kb-mapping',
    schema_version: 2,
    source: artifact.source,
    ...(artifact.sourcePath != null ? { source_path: artifact.sourcePath } : {}),
    ...(artifact.sourceHash != null ? { source_hash: artifact.sourceHash } : {}),
    created: artifact.created,
    status: artifact.status,
    targets: fmTargets,
    rejected: artifact.rejected,
    ...(artifact.warnings != null ? { warnings: artifact.warnings } : {}),
  };

  const tableRows = artifact.targets.map(t =>
    `| [[${sanitize(t.slug)}]] | ${t.kind ?? ''} | ${t.action} | ${t.state} | ${t.confidence ?? ''} | ${t.reason ? sanitize(t.reason) : ''} | ${t.reviewQueue ?? ''} | ${t.updated ?? ''} |`
  ).join('\n');

  const rejectedLines = artifact.rejected.map(r =>
    `- [[${sanitize(r.slug)}]]${r.reason ? ` — "${sanitize(r.reason)}"` : ''}`
  ).join('\n') || '(none)';

  const body = `\n## Targets\n\n| Target | Kind | Action | State | Confidence | Reason | Review-Queue | Updated |\n|--------|------|--------|-------|------------|--------|--------------|---------|${artifact.targets.length ? '\n' + tableRows : ''}\n\n## Rejected\n${rejectedLines}\n`;

  autoWrite(absPath, matter.stringify(body, frontmatter), vaultPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/mapping-artifact.test.ts
```
Expected: PASS — all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/mapping-artifact.ts tests/unit/mapping-artifact.test.ts
git commit -m "feat(mapping): add writeMappingArtifact, always writes schema v2 with regenerated table"
```

---

### Task 4: Update `kb_apply` to use `readMappingArtifact`

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (`kb_apply` execute handler, ~lines 402–520)

- [ ] **Step 1: Add import to `kb-tools.ts`**

Add to the imports at the top of `src/agent/tools/kb-tools.ts`:

```typescript
import { readMappingArtifact } from '../../knowledge/mapping-artifact.js';
```

- [ ] **Step 2: Replace the parsing block in `kb_apply` execute**

Find the block in `kb_apply` execute (after `artifactPath` validation) that reads:
```typescript
const raw = fs.readFileSync(artifactPath, 'utf-8');
const parsed = matter(raw);
const targets = parseMappingTargets(parsed.content);

const pending = targets.find(t => t.state === 'pending');
...
const sourceWikilink = String(parsed.data['source'] || '');
const sourceSlug = sourceWikilink.replace(/^\[\[|\]\]$/g, '').trim();
```

Replace with:
```typescript
const artifact = readMappingArtifact(artifactPath);
const pending = artifact.targets.find(t => t.state === 'pending');
...
const sourceSlug = artifact.sourceSlug;
```

Also update the `compiled_from` dedup check at ~line 492 — it uses `sourceSlug` which is now `artifact.sourceSlug`.

- [ ] **Step 3: Run existing tests to verify no regressions**

```bash
npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: PASS — all existing apply tests still pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/kb-tools.ts
git commit -m "refactor(kb-apply): use readMappingArtifact instead of parseMappingTargets"
```

---

### Task 5: Update `kb_apply_advance` to use `readMappingArtifact` + `writeMappingArtifact`

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (`kb_apply_advance` execute handler, ~lines 553–735)
- Modify: `tests/unit/kb-tools-apply.test.ts`

- [ ] **Step 1: Write failing test** (append to `tests/unit/kb-tools-apply.test.ts`)

```typescript
import { readMappingArtifact } from '../../src/knowledge/mapping-artifact.js';

const V1_MAPPING_FOR_ADVANCE = `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | pending | | |

## Rejected
(none)
`;

it('kb_apply_advance migrates v1 artifact to v2 on write', async () => {
  const mappingPath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
  fs.writeFileSync(mappingPath, V1_MAPPING_FOR_ADVANCE);
  fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), SOURCE_NOTE);

  const advanceTool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
  const result = JSON.parse(await advanceTool.execute({
    mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
    target_slug: 'cd4-cd8-interaction',
    state: 'applied',
    contradiction_added: false,
    update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
  }));

  expect(result.status).toBe('applied');
  const written = readMappingArtifact(mappingPath);
  expect(written.schemaVersion).toBe(2);
  expect(written.targets[0].slug).toBe('cd4-cd8-interaction');
  expect(written.targets[0].state).toBe('applied');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: FAIL — written artifact is still schema v1

- [ ] **Step 3: Update `kb_apply_advance` in `kb-tools.ts`**

Add `writeMappingArtifact` to the import from `mapping-artifact.js`.

Find the `kb_apply_advance` execute handler. Replace the block that reads the artifact and updates it (the `parseMappingTargets` + `updateMappingTargetState` + `matter.stringify` sequence, ~lines 581–678):

```typescript
// OLD:
const raw = fs.readFileSync(artifactPath, 'utf-8');
const parsed = matter(raw);
const allTargetsBefore = parseMappingTargets(parsed.content);
// ... sourceSlugRaw extraction via replace(/^\[\[|\]\]$/) ...
// ... updateMappingTargetState + matter.stringify ...

// NEW:
const artifact = readMappingArtifact(artifactPath);
const allTargetsBefore = artifact.targets;
const sourceSlugRaw = artifact.sourceSlug;  // replaces manual extraction

// ... validation logic unchanged (use allTargetsBefore) ...

// After the Review-Queue and needs_review side effects:
const targetIndex = artifact.targets.findIndex(t => t.slug === slug);
if (targetIndex === -1) {
  return JSON.stringify({ error: `Target slug "${slug}" not found in mapping artifact.` });
}
artifact.targets[targetIndex] = {
  ...artifact.targets[targetIndex],
  state: state as MappingTargetState,
  reviewQueue: rqLink || undefined,
  updated: new Date().toISOString().slice(0, 16),
};

const anyPending = artifact.targets.some(t => t.state === 'pending');
artifact.status = anyPending ? 'confirmed' : 'applied';

writeMappingArtifact(artifactPath, artifact, vaultPath);
```

Also remove the `{ content: newBody, updated: rowUpdated }` destructuring and the `rowUpdated` check — replace with a direct index lookup. Update the `allTargets` references after write to use `artifact.targets`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: PASS — existing tests + new migration test

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-tools-apply.test.ts
git commit -m "refactor(kb-apply-advance): use readMappingArtifact+writeMappingArtifact, migrate v1→v2 on write"
```

---

### Task 6: Update `kb_write_mapping` to write schema v2

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (`kb_write_mapping` execute handler, ~lines 268–380)

- [ ] **Step 1: Add `writeMappingArtifact` import** (already added in Task 5 if not already)

Verify the import line includes `writeMappingArtifact`.

- [ ] **Step 2: Extend `confirmed_targets` schema in the tool definition**

In the `kb_write_mapping` definition's `parameters.properties.confirmed_targets.items`, add optional fields:

```typescript
items: {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    action: { type: 'string', enum: ['update', 'create'] },
    kind: { type: 'string', description: 'Concepts|Entities|Methods (required for create)' },
    title: { type: 'string', description: 'Human-readable title for the knowledge note' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'Why this target was proposed' },
  },
  required: ['slug', 'action'],
},
```

Also add to the tool definition parameters:
```typescript
source_hash: { type: 'string', description: 'SHA-256 of source note content from kb_suggest output' },
status: { type: 'string', enum: ['draft', 'confirmed'], description: 'Artifact status. Default: confirmed.' },
```

- [ ] **Step 3: Replace `artifactContent` build in `kb_write_mapping` execute**

Remove the hand-built `artifactContent` template string and the `autoWrite` call for it. Replace with:

```typescript
const artifactStatus = ((args.status as string) === 'draft' ? 'draft' : 'confirmed') as 'draft' | 'confirmed';
const sourceHash = args.source_hash as string | undefined;
const today = new Date().toISOString().slice(0, 10);

const artifactObj: MappingArtifact = {
  schemaVersion: 2,
  source: `[[${sourceSlug}]]`,
  sourceSlug,
  sourcePath: sourceRel,
  ...(sourceHash != null ? { sourceHash } : {}),
  created: today,
  status: artifactStatus,
  targets: confirmedTargets.map(t => ({
    slug: t.slug,
    title: t.title as string | undefined,
    kind: t.kind as MappingTargetKind | undefined,
    action: t.action as MappingTargetAction,
    state: 'pending' as MappingTargetState,
    confidence: (t as Record<string, unknown>)['confidence'] as MappingTargetConfidence | undefined,
    reason: (t as Record<string, unknown>)['reason'] as string | undefined,
  })),
  rejected: rejectedTargets.map(t => ({ slug: t.slug, reason: t.reason })),
};

writeMappingArtifact(path.join(vaultPath, artifactRel), artifactObj, vaultPath);
```

Add the `MappingArtifact`, `MappingTargetKind`, `MappingTargetAction`, `MappingTargetState`, `MappingTargetConfidence` imports from `mapping-artifact.js`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-tools.test.ts tests/unit/kb-tools-apply.test.ts tests/unit/kb-tools-suggest.test.ts
```
Expected: PASS — all existing tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts
git commit -m "feat(kb-write-mapping): write schema v2 artifact via writeMappingArtifact, add source_hash/status/title/confidence/reason params"
```

---

### Task 7: Update `kb_suggest` with source_hash and dedup guard

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (`kb_suggest` execute handler, ~lines 175–222)
- Modify: `tests/unit/kb-tools-suggest.test.ts`

- [ ] **Step 1: Write failing test** (append to `tests/unit/kb-tools-suggest.test.ts`)

```typescript
import crypto from 'node:crypto';

it('kb_suggest returns already_suggested when source_hash matches existing artifact', async () => {
  const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
  const sourcePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md');
  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex');

  // Write an existing confirmed artifact with matching hash
  const artifactContent = `---\ntype: kb-mapping\nschema_version: 2\nsource: "[[smith-2026-il42]]"\nsource_hash: "${sourceHash}"\ncreated: 2026-04-08\nstatus: confirmed\ntargets: []\nrejected: []\n---\n`;
  fs.writeFileSync(
    path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
    artifactContent
  );

  const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
  expect(result.status).toBe('already_suggested');
  expect(result.mappingStatus).toBe('confirmed');
  expect(result.artifactPath).toContain('smith-2026-il42-mapping.md');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/kb-tools-suggest.test.ts
```
Expected: FAIL — `kb_suggest` does not return `already_suggested`

- [ ] **Step 3: Add source_hash and dedup to `kb_suggest` execute in `kb-tools.ts`**

Add `crypto` import at top: `import crypto from 'node:crypto';`

At the start of the `kb_suggest` execute handler, after `notePath` validation, add:

```typescript
// Compute source_hash for dedup guard
const sourceContentForHash = fs.readFileSync(notePath, 'utf-8');
const sourceHash = crypto.createHash('sha256').update(sourceContentForHash).digest('hex');

// Dedup: check for existing artifact with matching hash
const sourceSlugForDedup = path.basename(args.source as string, '.md');
const sourceDirForDedup = path.dirname((args.source as string).replace(/\\/g, '/'));
const artifactRelForDedup = `${sourceDirForDedup}/${sourceSlugForDedup}-mapping.md`;
const artifactAbsForDedup = path.join(vaultPath, artifactRelForDedup);

if (fs.existsSync(artifactAbsForDedup)) {
  try {
    const existingArtifact = readMappingArtifact(artifactAbsForDedup);
    if (existingArtifact.sourceHash === sourceHash && ['draft', 'confirmed', 'applied'].includes(existingArtifact.status)) {
      const message = existingArtifact.status === 'applied'
        ? 'Mapping already applied. Use rerun_confirmed: true with kb_write_mapping to re-map.'
        : 'A mapping already exists for this version of the source note. Run kb_apply to continue.';
      return JSON.stringify({
        status: 'already_suggested',
        sourceHash,
        artifactPath: artifactRelForDedup,
        mappingStatus: existingArtifact.status,
        message,
      });
    }
  } catch {
    // Artifact exists but unreadable — proceed with fresh suggestion
  }
}
```

Also add `source_hash` to the return JSON at the end of the execute handler:
```typescript
return JSON.stringify({
  sourceContent,
  sourcePath: args.source,
  source_hash: sourceHash,
  indexes,
  instruction: [
    // ... existing instruction lines ...
    'STEP 3: Format your proposal as structured targets:',
    '[{ slug, title, kind (Concepts|Entities|Methods), action (create|update), confidence (high|medium|low), reason }]',
    'Then call kb_write_mapping with confirmed_targets (user-approved), rejected_targets (rejected), and source_hash from this tool output.',
  ].join('\n'),
});
```

Add `readMappingArtifact` to the import from `mapping-artifact.js`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-tools-suggest.test.ts
```
Expected: PASS — existing tests + new dedup test

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-tools-suggest.test.ts
git commit -m "feat(kb-suggest): add source_hash computation and dedup guard"
```

---

### Task 8: Remove old helpers from `kb-tools.ts`

**Files:**
- Modify: `src/agent/tools/kb-tools.ts`

- [ ] **Step 1: Delete `parseMappingTargets` from `kb-tools.ts`**

Find and remove the `parseMappingTargets` function (~lines 47–64) and the `MappingTarget` interface (~lines 39–45) from `kb-tools.ts`. These are now in `mapping-artifact.ts`.

- [ ] **Step 2: Delete `updateMappingTargetState` from `kb-tools.ts`**

Find and remove the `updateMappingTargetState` function (~lines 67–80) and the `escapeRegex` helper (~line 35) from `kb-tools.ts`.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: All tests pass with no references to deleted functions.

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/kb-tools.ts
git commit -m "refactor(kb-tools): remove parseMappingTargets and updateMappingTargetState (moved to mapping-artifact.ts)"
```

---

### Task 9: Run full test suite and verify

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: All tests pass.

- [ ] **Step 2: Smoke test — run `kb_suggest` on the Pogorelyy paper**

After Phase 1 is merged and the DB is reindexed, open CrickNote and run:

```
kb_suggest source: "Reading/Papers/pogorelyy-2026-tirtl-seq-deep-quantitative-and-affordable-paired-tcr-repertoire-sequencing.md"
```

Verify:
- Returns `source_hash` in the result
- Returns structured `instruction` text requesting `[{ slug, title, kind, action, confidence, reason }]` format
- Running it a second time returns `already_suggested` if you call `kb_write_mapping` first

- [ ] **Step 3: Smoke test — run `kb_write_mapping` and verify schema v2 artifact**

After `kb_suggest`, call `kb_write_mapping` with a confirmed target. Open the resulting `*-mapping.md` file in Obsidian and verify:
- `schema_version: 2` in frontmatter
- `targets:` array in frontmatter
- `## Targets` table rendered below
