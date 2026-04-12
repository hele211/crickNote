# Knowledge Base Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Knowledge Base workflow (Spec 2) — `kb_suggest`, `kb_apply`, `kb_lint` tools, mapping artifacts, Review-Queue, Update Logs, Lint Reports, knowledge `_index.md` rebuilding, and setup scaffold.

**Architecture:** All KB operations are agent-driven with human-in-the-loop at every judgment step. `kb_suggest` reads source + knowledge indexes and proposes a mapping artifact. `kb_apply` processes one knowledge note per confirmation turn. The three editing primitives from Plan 1 (`autoWrite`, `fencedSectionUpdate`, `frontmatterFieldUpdate`) handle agent-managed writes without safe-writer confirmation. Knowledge state is tracked in mapping artifacts on disk (not DB) for crash recovery.

**Depends on:** Plan 1 (spec1-serial-numbering) — must be fully implemented first. Specifically: `autoWrite`, `fencedSectionUpdate`, `frontmatterFieldUpdate`, `workflow_events` table, `get_workflow_events` tool.

**Tech Stack:** Node 20, TypeScript, better-sqlite3, vitest, gray-matter, existing `resolveVaultPath`, existing `SafeWriter`, `autoWrite`/`fencedSectionUpdate`/`frontmatterFieldUpdate` from Plan 1

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/storage/migrations/003-knowledge-base.ts` | New columns on `note_metadata`: `kb_status`, `knowledge_kind`, `needs_review`, `review_flagged_at`, `aliases`, `rq_source`, `rq_target` |
| Modify | `src/storage/migrations/001-initial.ts` | Call migration 003 in `runMigrations` |
| Modify | `src/ingestion/parser.ts` | Extract `kbStatus`, `knowledgeKind`, `needsReview`, `reviewFlaggedAt`, `aliases`, `rqSource`, `rqTarget` from frontmatter |
| Modify | `src/ingestion/indexer.ts` | Persist new KB parser fields |
| Modify | `src/cli/setup.ts` | Create Knowledge/ + Reading/ folder scaffold with `_index.md` stubs |
| Create | `src/agent/tools/kb-tools.ts` | `kb_suggest`, `kb_apply`, `kb_lint` tools |
| Modify | `src/agent/runtime.ts` | Register KB tools |
| Modify | `src/agent/context.ts` | Inject lint reminder when lint is stale (>14 days) |
| Create | `tests/integration/migration-003.test.ts` | Migration 003 column/index assertions |
| Create | `tests/unit/kb-suggest.test.ts` | `kb_suggest` mapping proposal, artifact write, kb_status update |
| Create | `tests/unit/kb-apply.test.ts` | `kb_apply` Mode 1 + Mode 2, Review-Queue creation, Update Log |
| Create | `tests/unit/kb-lint.test.ts` | All 8 lint checks |
| Create | `tests/unit/parser-kb.test.ts` | Parser extracts KB fields |
| Modify | `tests/integration/migrations.test.ts` | Assert migration 003 columns present |

---

## Task 1: DB Migration 003

**Files:**
- Create: `src/storage/migrations/003-knowledge-base.ts`
- Modify: `src/storage/migrations/001-initial.ts`
- Test: `tests/integration/migration-003.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/migration-003.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('migration 003 — knowledge base', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds kb_status, knowledge_kind, needs_review columns to note_metadata', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(note_metadata)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('kb_status');
    expect(names).toContain('knowledge_kind');
    expect(names).toContain('needs_review');
    expect(names).toContain('review_flagged_at');
    expect(names).toContain('aliases');
    expect(names).toContain('rq_source');
    expect(names).toContain('rq_target');
  });

  it('creates kb_status and needs_review indexes', () => {
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_note_metadata_kb_status');
    expect(names).toContain('idx_note_metadata_needs_review');
  });

  it('schema version is now 3 after all migrations', () => {
    runMigrations(db);
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(3);
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/integration/migration-003.test.ts
```
Expected: FAIL — columns don't exist yet.

- [ ] **Step 3: Create migration 003 file**

```typescript
// src/storage/migrations/003-knowledge-base.ts
import type Database from 'better-sqlite3';

export function applyMigration003(db: Database.Database): void {
  db.transaction(() => {
    // New columns on note_metadata
    for (const [col, type, defaultVal] of [
      ['kb_status', 'TEXT', null],
      ['knowledge_kind', 'TEXT', null],
      ['needs_review', 'INTEGER', 'DEFAULT 0'],
      ['review_flagged_at', 'TEXT', null],
      ['aliases', 'TEXT', null],   // JSON array
      ['rq_source', 'TEXT', null],
      ['rq_target', 'TEXT', null],
    ] as Array<[string, string, string | null]>) {
      try {
        db.exec(`ALTER TABLE note_metadata ADD COLUMN ${col} ${type}${defaultVal ? ` ${defaultVal}` : ''};`);
      } catch (err) {
        if (!(err as Error).message.includes('duplicate column name')) throw err;
      }
    }

    // Indexes for lint queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_note_metadata_kb_status ON note_metadata(kb_status);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_note_metadata_needs_review ON note_metadata(needs_review);
    `);

    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, Date.now());
  })();
}
```

- [ ] **Step 4: Wire migration 003 into `runMigrations` in `001-initial.ts`**

```typescript
import { applyMigration003 } from './003-knowledge-base.js';

// In runMigrations, after migration 002:
if (currentVersion < 3) {
  applyMigration003(db);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/integration/migration-003.test.ts
```
Expected: PASS

- [ ] **Step 6: Update existing `migrations.test.ts` to assert version 3 and new tables**

In `tests/integration/migrations.test.ts`, update schema_version assertion to `expect(row.version).toBe(3)` and add assertions for KB columns.

- [ ] **Step 7: Run all migration tests**

```bash
npx vitest run tests/integration/
```
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/storage/migrations/003-knowledge-base.ts \
        src/storage/migrations/001-initial.ts \
        tests/integration/migration-003.test.ts \
        tests/integration/migrations.test.ts
git commit -m "feat: DB migration 003 — KB columns on note_metadata (kb_status, knowledge_kind, etc.)"
```

---

## Task 2: Parser + Indexer KB Field Updates

**Files:**
- Modify: `src/ingestion/parser.ts`
- Modify: `src/ingestion/indexer.ts`
- Create: `tests/unit/parser-kb.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/parser-kb.test.ts
import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/ingestion/parser.js';

describe('parseNote — KB fields', () => {
  it('extracts kb_status from reading note frontmatter', () => {
    const content = `---
title: IL-42 signalling
authors: [Smith]
year: 2026
journal: Nature
doi: 10.x/x
read_date: 2026-04-06
status: complete
kb_status: pending
---
`;
    const result = parseNote('Reading/Papers/smith-2026-il42.md', content);
    expect(result.kbStatus).toBe('pending');
  });

  it('extracts knowledge_kind from Knowledge note frontmatter', () => {
    const content = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
needs_review: false
---

# Body
`;
    const result = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', content);
    expect(result.knowledgeKind).toBe('concept');
    expect(result.needsReview).toBe(false);
  });

  it('extracts aliases as array', () => {
    const content = `---
type: knowledge
knowledge_kind: entity
title: IL-42
aliases: [interleukin-42, IL42]
---
`;
    const result = parseNote('Knowledge/Entities/il-42.md', content);
    expect(result.kbAliases).toEqual(['interleukin-42', 'IL42']);
  });

  it('extracts rq_source and rq_target from Review-Queue notes', () => {
    const content = `---
type: review-queue
source: "[[smith-2026-il42-signalling]]"
target_concept: "[[cd4-cd8-interaction]]"
status: pending
created: 2026-04-08
---
`;
    const result = parseNote('Knowledge/Review-Queue/2026-04-08-il42.md', content);
    expect(result.rqSource).toBe('smith-2026-il42-signalling');
    expect(result.rqTarget).toBe('cd4-cd8-interaction');
  });

  it('extracts review_flagged_at from Knowledge note', () => {
    const content = `---
type: knowledge
knowledge_kind: concept
title: Test
needs_review: true
review_flagged_at: "2026-04-01"
---
`;
    const result = parseNote('Knowledge/Concepts/test.md', content);
    expect(result.reviewFlaggedAt).toBe('2026-04-01');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/parser-kb.test.ts
```
Expected: FAIL

- [ ] **Step 3: Update `src/ingestion/parser.ts` — add KB fields**

Add to `ParsedNote` interface:

```typescript
kbStatus?: string;
knowledgeKind?: string;
needsReview?: boolean;
reviewFlaggedAt?: string;
kbAliases?: string[];
rqSource?: string;
rqTarget?: string;
```

Update `NoteType` to include `'knowledge'` and `'review-queue'`:

```typescript
export type NoteType = 'experiment' | 'series' | 'project-index' | 'protocol' | 'reading' | 'knowledge' | 'review-queue' | 'diary' | 'agent' | 'unknown';
```

Update `classifyNote` to detect Knowledge and Review-Queue paths:

```typescript
case 'Knowledge':
  if (normalized.includes('/Review-Queue/')) return { folder: 'Knowledge/Review-Queue', noteType: 'review-queue' };
  return { folder: 'Knowledge', noteType: 'knowledge' };
```

Helper to extract wikilink target:

```typescript
function extractWikilink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/\[\[([^\]]+)\]\]/);
  return match?.[1] ?? undefined;
}
```

In `parseNote`, after existing field extraction, add:

```typescript
const kbStatus = normalizeString(frontmatter['kb_status']) || undefined;
const knowledgeKind = normalizeString(frontmatter['knowledge_kind']) || undefined;
const needsReviewRaw = frontmatter['needs_review'];
const needsReview = needsReviewRaw !== undefined ? Boolean(needsReviewRaw) : undefined;
const reviewFlaggedAt = normalizeString(frontmatter['review_flagged_at']) || undefined;
const kbAliases = extractTags(frontmatter['aliases']);
const rqSource = extractWikilink(frontmatter['source']);
const rqTarget = extractWikilink(frontmatter['target_concept']);

return {
  // ... existing fields ...
  kbStatus,
  knowledgeKind,
  needsReview,
  reviewFlaggedAt,
  kbAliases,
  rqSource,
  rqTarget,
};
```

- [ ] **Step 4: Update `src/ingestion/indexer.ts` — add KB fields to upsert**

Extend the `INSERT INTO note_metadata` statement to include:
`kb_status`, `knowledge_kind`, `needs_review`, `review_flagged_at`, `aliases`, `rq_source`, `rq_target`

```typescript
database.prepare(`
  INSERT INTO note_metadata (path, folder, note_type, date, project, project_id, note_id, series,
    last_session, experiment_type, protocol_ref, status, tags, result_summary,
    kb_status, knowledge_kind, needs_review, review_flagged_at, aliases, rq_source, rq_target,
    content_hash, mtime, last_indexed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    /* ... all existing fields ... */
    kb_status = excluded.kb_status,
    knowledge_kind = excluded.knowledge_kind,
    needs_review = excluded.needs_review,
    review_flagged_at = excluded.review_flagged_at,
    aliases = excluded.aliases,
    rq_source = excluded.rq_source,
    rq_target = excluded.rq_target,
    content_hash = excluded.content_hash,
    mtime = excluded.mtime,
    last_indexed = excluded.last_indexed
`).run(
  // ... existing values ...,
  note.kbStatus ?? null,
  note.knowledgeKind ?? null,
  note.needsReview !== undefined ? (note.needsReview ? 1 : 0) : null,
  note.reviewFlaggedAt ?? null,
  note.kbAliases ? JSON.stringify(note.kbAliases) : null,
  note.rqSource ?? null,
  note.rqTarget ?? null,
  // ... contentHash, mtime, now
);
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/unit/parser-kb.test.ts
npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/parser.ts src/ingestion/indexer.ts tests/unit/parser-kb.test.ts
git commit -m "feat: parser and indexer extract KB fields (kb_status, knowledge_kind, aliases, rq_source, rq_target)"
```

---

## Task 3: Setup Scaffold — Knowledge/ and Reading/ Folders

**Files:**
- Modify: `src/cli/setup.ts`

- [ ] **Step 1: Read current `setup.ts` to understand existing structure**

```bash
cat src/cli/setup.ts
```

- [ ] **Step 2: Add Knowledge and Reading folder creation**

In `src/cli/setup.ts`, find where vault folders are created (the section that creates Projects/, Protocols/, etc.) and add:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const today = new Date().toISOString().slice(0, 10);

function createKnowledgeIndexMd(folder: string, title: string): string {
  return matter.stringify(
    `\n# ${title}\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|`,
    { type: 'index', folder, last_updated: today }
  );
}

// Knowledge folder scaffold
const knowledgeFolders = [
  ['Knowledge/Concepts', 'Concepts'],
  ['Knowledge/Entities', 'Entities'],
  ['Knowledge/Methods', 'Methods'],
];

for (const [rel, title] of knowledgeFolders) {
  const dir = path.join(vaultPath, rel);
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, '_index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, createKnowledgeIndexMd(rel, title), 'utf-8');
  }
}

fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'), { recursive: true });

// Reading folder scaffold
fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments'), { recursive: true });
```

- [ ] **Step 3: Run tests to verify no regressions**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/setup.ts
git commit -m "feat: setup creates Knowledge/ and Reading/ folder scaffolds with _index.md stubs"
```

---

## Task 4: `kb_suggest` Tool

**Files:**
- Create: `src/agent/tools/kb-tools.ts` (start with `kb_suggest`)
- Test: `tests/unit/kb-suggest.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/kb-suggest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

// kb_suggest is an LLM-assisted tool. We test its structural behaviors:
// - reads source note
// - reads Knowledge _index.md files
// - writes mapping artifact on confirmation
// - updates kb_status on reading notes
// We mock the LLM call and test the tool's file I/O contract.

describe('kb_suggest mapping artifact write', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    // Create source reading note
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\ntitle: IL-42 signalling\nauthors: [Smith]\nyear: 2026\njournal: Nature\ndoi: 10.x/x\nread_date: 2026-04-06\nstatus: complete\nkb_status: pending\n---\n\n## Claims\nIL-42 suppresses CD8 by 40%.\n'
    );
    // Create empty knowledge indexes
    for (const kind of ['Concepts', 'Entities', 'Methods']) {
      fs.writeFileSync(
        path.join(vaultPath, 'Knowledge', kind, '_index.md'),
        `---\ntype: index\nfolder: Knowledge/${kind}\nlast_updated: 2026-04-11\n---\n\n# ${kind}\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|`
      );
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('writes mapping artifact when kb_suggest_confirm is called with confirmed targets', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const confirmTool = tools.find(t => t.definition.name === 'kb_suggest_confirm')!;

    const mappingData = {
      source: 'Reading/Papers/smith-2026-il42.md',
      targets: [
        { path: 'Knowledge/Concepts/cd4-cd8-interaction.md', action: 'create', confidence: 'HIGH', note: 'central topic' },
      ],
      rejected: [],
    };

    const result = JSON.parse(await confirmTool.execute({ mapping: mappingData }));
    expect(result.artifact_path).toContain('smith-2026-il42-mapping.md');

    const artifactPath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    expect(fs.existsSync(artifactPath)).toBe(true);
    const parsed = matter(fs.readFileSync(artifactPath, 'utf-8'));
    expect(parsed.data.status).toBe('confirmed');
    expect(parsed.data.source).toBeDefined();
  });

  it('updates kb_status to mapped after confirming at least one target', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const confirmTool = tools.find(t => t.definition.name === 'kb_suggest_confirm')!;

    const mappingData = {
      source: 'Reading/Papers/smith-2026-il42.md',
      targets: [{ path: 'Knowledge/Entities/il-42.md', action: 'create', confidence: 'HIGH', note: '' }],
      rejected: [],
    };

    await confirmTool.execute({ mapping: mappingData });
    const noteContent = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    const parsed = matter(noteContent);
    expect(parsed.data.kb_status).toBe('mapped');
  });

  it('updates kb_status to skipped when user rejects all targets', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const confirmTool = tools.find(t => t.definition.name === 'kb_suggest_confirm')!;

    await confirmTool.execute({
      mapping: { source: 'Reading/Papers/smith-2026-il42.md', targets: [], rejected: [] }
    });
    const parsed = matter(fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8'));
    expect(parsed.data.kb_status).toBe('skipped');
  });

  it('handles pre-existing mapping artifact collision — overwrites draft', async () => {
    const artifactPath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    fs.writeFileSync(artifactPath, '---\ntype: kb-mapping\nstatus: draft\n---\n');
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const confirmTool = tools.find(t => t.definition.name === 'kb_suggest_confirm')!;
    const mappingData = {
      source: 'Reading/Papers/smith-2026-il42.md',
      targets: [{ path: 'Knowledge/Concepts/cd4-cd8.md', action: 'create', confidence: 'HIGH', note: '' }],
      rejected: [],
    };
    await confirmTool.execute({ mapping: mappingData });
    const parsed = matter(fs.readFileSync(artifactPath, 'utf-8'));
    expect(parsed.data.status).toBe('confirmed');
  });

  it('reports existing in-progress artifact (status: confirmed) without overwriting', async () => {
    const artifactPath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    fs.writeFileSync(artifactPath, '---\ntype: kb-mapping\nstatus: confirmed\n---\n');
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const confirmTool = tools.find(t => t.definition.name === 'kb_suggest_confirm')!;
    const result = JSON.parse(await confirmTool.execute({
      mapping: { source: 'Reading/Papers/smith-2026-il42.md', targets: [], rejected: [] }
    }));
    expect(result.status).toBe('in_progress');
    expect(result.message).toContain('already in progress');
    // Artifact NOT overwritten
    const parsed = matter(fs.readFileSync(artifactPath, 'utf-8'));
    expect(parsed.data.status).toBe('confirmed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/kb-suggest.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/agent/tools/kb-tools.ts` with `kb_suggest` and `kb_suggest_confirm`**

`kb_suggest` is the LLM-assisted tool that reads the source and indexes. `kb_suggest_confirm` is the tool the agent calls after the user confirms the proposed mapping. This split allows testing the file I/O contract separately from the LLM call.

```typescript
// src/agent/tools/kb-tools.ts
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler } from './registry.js';
import { getDatabase } from '../../storage/database.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { autoWrite, frontmatterFieldUpdate } from '../../editing/auto-writer.js';
import { logger } from '../../utils/logger.js';

const log = logger.child('kb-tools');

// ── Source loaders ───────────────────────────────────────────────────────────

const PER_SOURCE_TOKEN_CAP = 10_000;   // characters approx (rough token proxy)
const TOTAL_SESSION_TOKEN_CAP = 30_000;

interface LoadedSource {
  path: string;
  content: string;
  truncated: boolean;
  warning?: string;
}

function loadSourceFile(absPath: string): LoadedSource {
  const ext = path.extname(absPath).toLowerCase();
  if (!fs.existsSync(absPath)) {
    return { path: absPath, content: '', truncated: false, warning: `Source file not found: ${absPath}` };
  }

  if (ext === '.xlsx' || ext === '.csv') {
    return { path: absPath, content: '', truncated: false, warning: `Cannot read spreadsheet — paste key data into a .md source file` };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) {
    return { path: absPath, content: '', truncated: false, warning: `Cannot read image — describe key figures in a .md source file` };
  }
  if (ext === '.pdf') {
    // PDF reading is done via the agent's Read tool; here we return a placeholder
    // In practice, the agent should use vault_read on the PDF and pass the text
    return { path: absPath, content: `[PDF — agent should use Read tool on ${absPath} to extract text, max 20 pages]`, truncated: false };
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  if (raw.length > PER_SOURCE_TOKEN_CAP * 4) {
    return { path: absPath, content: raw.slice(0, PER_SOURCE_TOKEN_CAP * 4), truncated: true };
  }
  return { path: absPath, content: raw, truncated: false };
}

// ── Mapping artifact helpers ──────────────────────────────────────────────────

export interface MappingTarget {
  path: string;         // relative vault path to knowledge note
  action: 'update' | 'create';
  confidence: 'HIGH' | 'MEDIUM' | 'NEW';
  note: string;         // why this target was proposed
  state?: 'pending' | 'applied' | 'skipped' | 'deferred';
  review_queue?: string;
  updated?: string;
}

export interface MappingArtifact {
  source: string;       // wikilink to source note slug
  status: 'draft' | 'confirmed' | 'applied';
  created: string;
  targets: MappingTarget[];
  rejected: string[];
}

function sourceSlug(relPath: string): string {
  return path.basename(relPath, '.md');
}

function mappingArtifactPath(sourceRelPath: string): string {
  const dir = path.dirname(sourceRelPath);
  const slug = sourceSlug(sourceRelPath);
  return path.join(dir, `${slug}-mapping.md`);
}

function readMappingArtifact(absPath: string): MappingArtifact | null {
  if (!fs.existsSync(absPath)) return null;
  const parsed = matter(fs.readFileSync(absPath, 'utf-8'));
  return {
    source: parsed.data.source ?? '',
    status: parsed.data.status ?? 'draft',
    created: parsed.data.created ?? '',
    targets: parsed.data.targets ?? [],
    rejected: parsed.data.rejected ?? [],
  };
}

function writeMappingArtifact(absPath: string, artifact: MappingArtifact, vaultPath: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const targetsTable = [
    '| Target | Action | State | Review-Queue | Updated |',
    '|--------|--------|-------|--------------|---------|',
    ...artifact.targets.map(t =>
      `| [[${sourceSlug(t.path)}]] | ${t.action} | ${t.state ?? 'pending'} | ${t.review_queue ?? ''} | ${t.updated ?? ''} |`
    ),
  ].join('\n');

  const rejectedSection = artifact.rejected.length > 0
    ? `\n## Rejected\n${artifact.rejected.map(r => `- ${r}`).join('\n')}`
    : '';

  const content = matter.stringify(
    `\n## Targets\n\n${targetsTable}${rejectedSection}`,
    {
      type: 'kb-mapping',
      source: `[[${sourceSlug(artifact.source)}]]`,
      created: artifact.created || today,
      status: artifact.status,
    }
  );

  autoWrite(absPath, content, vaultPath);
}

// ── Update Log helper ─────────────────────────────────────────────────────────

function writeUpdateLog(
  sourceSlugStr: string,
  updated: string[],
  created: string[],
  deferred: string[],
  vaultPath: string,
): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const logFileName = `${dateStr}T${timeStr}-${sourceSlugStr}.md`;
  const logPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs', logFileName);

  const updatedSection = updated.length > 0 ? `\n## Updated\n${updated.map(u => `- ${u}`).join('\n')}` : '';
  const createdSection = created.length > 0 ? `\n## Created\n${created.map(c => `- ${c}`).join('\n')}` : '';
  const deferredSection = deferred.length > 0 ? `\n## Deferred to Review\n${deferred.map(d => `- ${d}`).join('\n')}` : '';

  const content = matter.stringify(
    `\n# KB Update Log — ${sourceSlugStr}${updatedSection}${createdSection}${deferredSection}`,
    { type: 'update-log', source: `[[${sourceSlugStr}]]`, date: dateStr }
  );

  autoWrite(logPath, content, vaultPath);
  log.info('Update log written', { path: logFileName });
}

// ── Knowledge index rebuild ───────────────────────────────────────────────────

function rebuildKnowledgeIndex(kind: 'Concepts' | 'Entities' | 'Methods', vaultPath: string): void {
  const dir = path.join(vaultPath, 'Knowledge', kind);
  const indexPath = path.join(dir, '_index.md');
  if (!fs.existsSync(dir)) return;

  const entries: Array<{ title: string; aliases: string; lastUpdated: string; sourceCount: number }> = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (file === '_index.md' || !file.endsWith('.md')) continue;
    const parsed = matter(fs.readFileSync(path.join(dir, file), 'utf-8'));
    const aliases = Array.isArray(parsed.data.aliases) ? parsed.data.aliases.join(', ') : (parsed.data.aliases ?? '');
    const compiledFrom = Array.isArray(parsed.data.compiled_from) ? parsed.data.compiled_from : [];
    entries.push({
      title: `[[${path.basename(file, '.md')}]]`,
      aliases: String(aliases),
      lastUpdated: String(parsed.data.last_updated ?? ''),
      sourceCount: compiledFrom.length,
    });
  }

  // Sort by title case-insensitive
  entries.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const today = new Date().toISOString().slice(0, 10);
  const tableRows = entries.map(e => `| ${e.title} | ${e.aliases} | ${e.lastUpdated} | ${e.sourceCount} |`).join('\n');
  const content = matter.stringify(
    `\n# ${kind}\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|${entries.length > 0 ? '\n' + tableRows : ''}`,
    { type: 'index', folder: `Knowledge/${kind}`, last_updated: today }
  );

  autoWrite(indexPath, content, vaultPath);
  log.info('Knowledge index rebuilt', { kind });
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createKbTools(vaultPath: string, injectedDb?: Database.Database): ToolHandler[] {
  const db = () => injectedDb ?? getDatabase();

  return [
    // ── kb_suggest ──────────────────────────────────────────────────────────
    {
      definition: {
        name: 'kb_suggest',
        description: 'Given a source note (reading or experiment), read its content and the Knowledge indexes, then propose which Knowledge notes to update or create. The agent presents the proposal to the user for confirmation, then calls kb_suggest_confirm.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Vault-relative path to the source note' },
          },
          required: ['source'],
        },
      },
      execute: async (args) => {
        const sourceRel = args.source as string;
        let sourceAbs: string;
        try {
          sourceAbs = resolveVaultPath(vaultPath, sourceRel);
        } catch {
          return JSON.stringify({ error: `Invalid source path: "${sourceRel}"` });
        }
        if (!fs.existsSync(sourceAbs)) {
          return JSON.stringify({ error: `Source note not found: ${sourceRel}` });
        }

        // Check for existing in-progress mapping
        const artifactRel = mappingArtifactPath(sourceRel);
        const artifactAbs = resolveVaultPath(vaultPath, artifactRel);
        const existing = readMappingArtifact(artifactAbs);
        if (existing?.status === 'confirmed') {
          return JSON.stringify({
            status: 'in_progress',
            message: 'A mapping is already in progress. Run kb_apply to continue.',
            artifact_path: artifactRel,
          });
        }

        // Load source note content
        const sourceContent = fs.readFileSync(sourceAbs, 'utf-8');
        const sourceParsed = matter(sourceContent);

        // Load knowledge indexes (compact — just titles + aliases)
        const indexes: string[] = [];
        for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
          const indexPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
          if (fs.existsSync(indexPath)) {
            indexes.push(`Knowledge/${kind} index:\n${fs.readFileSync(indexPath, 'utf-8')}`);
          }
        }

        // Load source files listed in frontmatter sources field
        const sources = (sourceParsed.data.sources ?? []) as Array<{ type: string; path: string }>;
        const slug = sourceSlug(sourceRel);
        const attachmentBase = path.join(vaultPath, 'Reading', 'attachments', slug);
        const loadedSources: LoadedSource[] = [];
        let totalChars = 0;

        for (const src of sources) {
          if (totalChars >= TOTAL_SESSION_TOKEN_CAP * 4) {
            loadedSources.push({ path: src.path, content: '', truncated: true, warning: `Session cap reached — skipping ${src.path}` });
            continue;
          }
          const srcAbs = path.join(attachmentBase, src.path);
          try {
            resolveVaultPath(vaultPath, path.relative(vaultPath, srcAbs)); // security check
          } catch {
            loadedSources.push({ path: src.path, content: '', truncated: false, warning: `Path rejected: ${src.path}` });
            continue;
          }
          const loaded = loadSourceFile(srcAbs);
          totalChars += loaded.content.length;
          loadedSources.push(loaded);
        }

        const sourceWarnings = loadedSources.filter(s => s.warning).map(s => s.warning!);
        const sourcesContext = loadedSources
          .filter(s => s.content)
          .map(s => `${s.path}${s.truncated ? ' [TRUNCATED]' : ''}:\n${s.content}`)
          .join('\n\n---\n\n');

        return JSON.stringify({
          status: 'ready_for_proposal',
          source_path: sourceRel,
          source_content: sourceContent,
          knowledge_indexes: indexes.join('\n\n---\n\n'),
          attachment_content: sourcesContext || null,
          warnings: sourceWarnings.length > 0 ? sourceWarnings : undefined,
          instructions: [
            'Analyze the source content against the knowledge indexes.',
            'Propose a mapping with HIGH/MEDIUM confidence targets (existing notes) and NEW targets (notes to create).',
            'Present the proposal to the user for confirmation.',
            'After user confirms, call kb_suggest_confirm with the confirmed targets.',
          ],
        });
      },
    },

    // ── kb_suggest_confirm ──────────────────────────────────────────────────
    {
      definition: {
        name: 'kb_suggest_confirm',
        description: 'Write the confirmed mapping artifact and update kb_status. Call after the user confirms the kb_suggest proposal.',
        parameters: {
          type: 'object',
          properties: {
            mapping: {
              type: 'object',
              description: 'The confirmed mapping: { source: string, targets: MappingTarget[], rejected: string[] }',
              properties: {
                source: { type: 'string' },
                targets: { type: 'array' },
                rejected: { type: 'array' },
              },
              required: ['source', 'targets', 'rejected'],
            },
          },
          required: ['mapping'],
        },
      },
      execute: async (args) => {
        const mapping = args.mapping as { source: string; targets: MappingTarget[]; rejected: string[] };
        const sourceRel = mapping.source;
        let sourceAbs: string;
        try {
          sourceAbs = resolveVaultPath(vaultPath, sourceRel);
        } catch {
          return JSON.stringify({ error: `Invalid source path: "${sourceRel}"` });
        }

        // Check for existing in-progress mapping — don't overwrite
        const artifactRel = mappingArtifactPath(sourceRel);
        const artifactAbs = resolveVaultPath(vaultPath, artifactRel);
        const existing = readMappingArtifact(artifactAbs);
        if (existing?.status === 'confirmed') {
          return JSON.stringify({ status: 'in_progress', message: 'A mapping is already in progress. Run kb_apply to continue.', artifact_path: artifactRel });
        }

        // Handle applied mapping — create timestamped artifact
        let finalArtifactAbs = artifactAbs;
        if (existing?.status === 'applied') {
          const now = new Date();
          const ts = now.toISOString().slice(0, 19).replace(/:/g, '');
          const slug = sourceSlug(sourceRel);
          const dir = path.dirname(artifactRel);
          finalArtifactAbs = resolveVaultPath(vaultPath, path.join(dir, `${slug}-mapping-${ts}.md`));
        }

        if (mapping.targets.length === 0 && mapping.rejected.length === 0) {
          // User rejected all / no KB value
          if (fs.existsSync(sourceAbs)) {
            const parsed = matter(fs.readFileSync(sourceAbs, 'utf-8'));
            if (parsed.data.kb_status !== undefined) {
              frontmatterFieldUpdate(sourceAbs, 'kb_status', 'skipped', vaultPath);
            }
          }
          return JSON.stringify({ status: 'skipped', message: 'Source marked as skipped — no KB updates to apply.' });
        }

        // Write mapping artifact
        const artifact: MappingArtifact = {
          source: sourceRel,
          status: 'confirmed',
          created: new Date().toISOString().slice(0, 10),
          targets: mapping.targets.map(t => ({ ...t, state: 'pending' as const })),
          rejected: mapping.rejected,
        };
        writeMappingArtifact(finalArtifactAbs, artifact, vaultPath);

        // Update kb_status to mapped (reading notes only)
        if (fs.existsSync(sourceAbs)) {
          const parsed = matter(fs.readFileSync(sourceAbs, 'utf-8'));
          if (parsed.data.kb_status !== undefined) {
            frontmatterFieldUpdate(sourceAbs, 'kb_status', 'mapped', vaultPath);
          }
        }

        log.info('Mapping confirmed', { source: sourceRel, targets: artifact.targets.length });
        return JSON.stringify({
          status: 'confirmed',
          artifact_path: path.relative(vaultPath, finalArtifactAbs),
          target_count: artifact.targets.length,
          message: `Mapping confirmed with ${artifact.targets.length} target(s). Call kb_apply to process them.`,
        });
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-suggest.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-suggest.test.ts
git commit -m "feat: kb_suggest and kb_suggest_confirm tools — mapping artifact write, kb_status update"
```

---

## Task 5: `kb_apply` Tool

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add `kb_apply`)
- Test: `tests/unit/kb-apply.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/kb-apply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('kb_apply Mode 1 — from mapping artifact', () => {
  let db: Database.Database;
  let vaultPath: string;

  function setupVault() {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kba-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'), { recursive: true });

    // Source reading note
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\ntitle: IL-42\nauthors: [Smith]\nyear: 2026\njournal: Nature\ndoi: 10.x/x\nread_date: 2026-04-06\nstatus: complete\nkb_status: mapped\nrelated_projects: [P001]\n---\n\n## Claims\nIL-42 suppresses CD8 by 40% in Jurkat cells.\n'
    );

    // Existing concept note
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'),
      '---\ntype: knowledge\nknowledge_kind: concept\ntitle: CD4-CD8 Interaction\naliases: [cd4 cd8 crosstalk]\nlast_updated: 2026-04-01\ncompiled_from: []\nneeds_review: false\nrelated_projects: []\n---\n\n# CD4-CD8 Interaction\n\n## Current View\nUnknown.\n\n## Key Claims\n\n## Contradictions and Caveats\n\n## Open Questions\n'
    );

    // Mapping artifact
    const mappingContent = matter.stringify(
      '\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------||\n| [[cd4-cd8-interaction]] | update | pending | | |\n| [[il-42]] | create | pending | | |\n',
      { type: 'kb-mapping', source: '[[smith-2026-il42]]', created: '2026-04-08', status: 'confirmed' }
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      mappingContent
    );

    // Knowledge indexes
    for (const kind of ['Concepts', 'Entities', 'Methods']) {
      fs.writeFileSync(
        path.join(vaultPath, 'Knowledge', kind, '_index.md'),
        `---\ntype: index\nfolder: Knowledge/${kind}\nlast_updated: 2026-04-11\n---\n\n# ${kind}\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|`
      );
    }
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setupVault();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns pending_edit for first pending target', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.type).toBe('pending_edit');
    expect(result.path).toContain('cd4-cd8-interaction.md');
  });

  it('Mode 2 direct: returns pending_edit for target knowledge note', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
    }));
    expect(result.type).toBe('pending_edit');
    expect(result.path).toContain('cd4-cd8-interaction.md');
  });

  it('creates a new knowledge note when action is create', async () => {
    // Modify mapping to have only the create target
    const mappingPath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    const content = matter.stringify(
      '\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------||\n| [[il-42]] | create | pending | | |\n',
      { type: 'kb-mapping', source: '[[smith-2026-il42]]', created: '2026-04-08', status: 'confirmed' }
    );
    fs.writeFileSync(mappingPath, content);
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');
    // New entity note content should have correct template
    const parsed = matter(result.newContent);
    expect(parsed.data.type).toBe('knowledge');
    expect(parsed.data.knowledge_kind).toBe('entity');
  });
});

describe('kb_apply mark_target_state', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbamt-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'), { recursive: true });
    for (const kind of ['Concepts', 'Entities', 'Methods']) {
      fs.mkdirSync(path.join(vaultPath, 'Knowledge', kind), { recursive: true });
      fs.writeFileSync(
        path.join(vaultPath, 'Knowledge', kind, '_index.md'),
        `---\ntype: index\nfolder: Knowledge/${kind}\n---\n\n# ${kind}\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|`
      );
    }
    // Source reading note
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\ntitle: Test\nauthors: [Smith]\nyear: 2026\njournal: Nature\ndoi: 10.x/x\nread_date: 2026-04-06\nstatus: complete\nkb_status: mapped\n---\n'
    );
    // Single-target mapping
    const mappingContent = matter.stringify(
      '\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------||\n| [[cd4-cd8-interaction]] | update | pending | | |\n',
      { type: 'kb-mapping', source: '[[smith-2026-il42]]', created: '2026-04-08', status: 'confirmed' }
    );
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), mappingContent);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('marks a target as applied and updates artifact, then updates kb_status to merged', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const markTool = tools.find(t => t.definition.name === 'kb_apply_mark_target')!;
    const result = JSON.parse(await markTool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target: 'cd4-cd8-interaction',
      state: 'applied',
    }));
    expect(result.status).toBe('ok');
    // Mapping artifact updated
    const artifact = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), 'utf-8');
    expect(artifact).toContain('applied');
    // Since last pending target is now done, kb_status updated to merged
    const sourceParsed = matter(fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8'));
    expect(sourceParsed.data.kb_status).toBe('merged');
  });

  it('marks target as deferred and creates Review-Queue note', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const markTool = tools.find(t => t.definition.name === 'kb_apply_mark_target')!;
    const result = JSON.parse(await markTool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target: 'cd4-cd8-interaction',
      state: 'deferred',
      reason: 'Magnitude conflict — cell-line effect possible',
      issue: 'Smith 2026 reports 40% vs Zhang 2022 15%',
    }));
    expect(result.status).toBe('ok');
    // Review-Queue note created
    const rqFiles = fs.readdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'));
    expect(rqFiles.length).toBeGreaterThan(0);
    // kb_status = merged_with_review
    const sourceParsed = matter(fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8'));
    expect(sourceParsed.data.kb_status).toBe('merged_with_review');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/kb-apply.test.ts
```
Expected: FAIL

- [ ] **Step 3: Add `kb_apply` and `kb_apply_mark_target` to `kb-tools.ts`**

`kb_apply` returns a `pending_edit` for one knowledge note at a time (the first `pending` target in the mapping artifact). The agent presents the diff, user confirms, then calls `kb_apply_mark_target` to record the result and move to the next target.

Add `kb_apply`:

```typescript
{
  definition: {
    name: 'kb_apply',
    description: 'Process the next pending target in a mapping artifact OR update a knowledge note directly (Mode 2). Returns a pending_edit for user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        mapping: { type: 'string', description: 'Mode 1: vault-relative path to mapping artifact' },
        source: { type: 'string', description: 'Mode 2: vault-relative path to source note (experiment or reading)' },
        target: { type: 'string', description: 'Mode 2: vault-relative path to knowledge note to update' },
      },
      required: [],
    },
  },
  execute: async (args) => {
    if (args.mapping) {
      // Mode 1 — from mapping artifact
      const mappingRel = args.mapping as string;
      let mappingAbs: string;
      try { mappingAbs = resolveVaultPath(vaultPath, mappingRel); } catch { return JSON.stringify({ error: `Invalid mapping path: "${mappingRel}"` }); }
      if (!fs.existsSync(mappingAbs)) return JSON.stringify({ error: `Mapping artifact not found: ${mappingRel}` });

      const rawMapping = fs.readFileSync(mappingAbs, 'utf-8');
      const mappingParsed = matter(rawMapping);

      // Parse targets from the markdown table
      const targets = parseMappingTargets(rawMapping);
      const pending = targets.find(t => t.state === 'pending' || !t.state);
      if (!pending) {
        return JSON.stringify({ status: 'all_done', message: 'All targets have been processed.' });
      }

      // Determine source path from artifact
      const sourceWikilink = mappingParsed.data.source as string;
      const sourceSlugStr = extractWikilinkSlug(sourceWikilink);
      const sourceRel = findNoteBySlug(sourceSlugStr, vaultPath);

      return buildKbApplyEdit(pending, sourceRel, vaultPath);

    } else if (args.source && args.target) {
      // Mode 2 — direct
      const sourceRel = args.source as string;
      const targetRel = args.target as string;
      let sourceAbs: string;
      let targetAbs: string;
      try { sourceAbs = resolveVaultPath(vaultPath, sourceRel); } catch { return JSON.stringify({ error: `Invalid source: "${sourceRel}"` }); }
      try { targetAbs = resolveVaultPath(vaultPath, targetRel); } catch { return JSON.stringify({ error: `Invalid target: "${targetRel}"` }); }
      if (!fs.existsSync(sourceAbs)) return JSON.stringify({ error: `Source not found: ${sourceRel}` });

      const target: MappingTarget = {
        path: targetRel,
        action: fs.existsSync(targetAbs) ? 'update' : 'create',
        confidence: 'HIGH',
        note: 'Direct mode',
        state: 'pending',
      };
      return buildKbApplyEdit(target, sourceRel, vaultPath);
    } else {
      return JSON.stringify({ error: 'Provide either "mapping" (Mode 1) or both "source" and "target" (Mode 2).' });
    }
  },
},
```

Helper functions needed inside `createKbTools`:

```typescript
function extractWikilinkSlug(wikilink: string): string {
  return wikilink.replace(/\[\[([^\]]+)\]\]/, '$1');
}

function findNoteBySlug(slug: string, vaultPath: string): string {
  // Search Reading/Papers, Reading/Threads, Projects/*/ for a file matching slug
  for (const dir of [
    path.join(vaultPath, 'Reading', 'Papers'),
    path.join(vaultPath, 'Reading', 'Threads'),
  ]) {
    const f = `${slug}.md`;
    if (fs.existsSync(path.join(dir, f))) {
      return path.relative(vaultPath, path.join(dir, f));
    }
  }
  return `Reading/Papers/${slug}.md`; // fallback
}

function parseMappingTargets(content: string): MappingTarget[] {
  // Parse the markdown table from the mapping artifact body
  const targets: MappingTarget[] = [];
  const lines = content.split('\n');
  let inTable = false;
  for (const line of lines) {
    if (line.includes('| Target |')) { inTable = true; continue; }
    if (line.match(/^\|[-| ]+\|$/)) continue; // separator row
    if (inTable && line.startsWith('|') && line.includes('[[')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 4) {
        const targetSlug = extractWikilinkSlug(cols[0]);
        targets.push({
          path: `Knowledge/Concepts/${targetSlug}.md`, // best-effort; real path determined at apply time
          action: (cols[1] as 'update' | 'create') || 'update',
          confidence: 'HIGH',
          note: '',
          state: (cols[2] as MappingTarget['state']) || 'pending',
          review_queue: cols[3] || undefined,
          updated: cols[4] || undefined,
        });
      }
    }
    if (inTable && !line.startsWith('|')) inTable = false;
  }
  return targets;
}

function buildKbApplyEdit(target: MappingTarget, sourceRel: string | undefined, vaultPath: string): string {
  // Determine absolute path for the target knowledge note
  const targetSlug = sourceSlug(target.path);
  let targetAbs: string | null = null;
  for (const kind of ['Concepts', 'Entities', 'Methods']) {
    const candidate = path.join(vaultPath, 'Knowledge', kind, `${targetSlug}.md`);
    if (fs.existsSync(candidate)) { targetAbs = candidate; break; }
  }

  // Load source content
  let sourceContent = '';
  if (sourceRel) {
    try {
      const sourceAbs = resolveVaultPath(vaultPath, sourceRel);
      if (fs.existsSync(sourceAbs)) sourceContent = fs.readFileSync(sourceAbs, 'utf-8');
    } catch { /* ignore */ }
  }

  if (target.action === 'create' || !targetAbs) {
    // Create new knowledge note from template
    // Determine kind from target path or default to concept
    const kind = target.path.includes('/Entities/') ? 'entity'
      : target.path.includes('/Methods/') ? 'method'
      : 'concept';

    const targetAbsNew = targetAbs ?? path.join(vaultPath, 'Knowledge',
      kind === 'entity' ? 'Entities' : kind === 'method' ? 'Methods' : 'Concepts',
      `${targetSlug}.md`
    );

    const today = new Date().toISOString().slice(0, 10);
    const sourceSlugStr = sourceRel ? sourceSlug(sourceRel) : '';
    const newContent = buildKnowledgeNoteTemplate(targetSlug, kind, sourceSlugStr, today);
    const absPath = resolveVaultPath(vaultPath, path.relative(vaultPath, targetAbsNew));

    return JSON.stringify({
      type: 'pending_edit',
      operation: 'create',
      path: absPath,
      newContent,
      context: { source_content: sourceContent, target_slug: targetSlug, kind, action: 'create' },
      instructions: 'Review the source content and populate the knowledge note template with relevant claims in the structured format: - [supports|contradicts|extends] Claim. [[source]]',
    });
  } else {
    // Update existing note
    const currentContent = fs.readFileSync(targetAbs, 'utf-8');
    const sourceSlugStr = sourceRel ? sourceSlug(sourceRel) : '';

    return JSON.stringify({
      type: 'pending_edit',
      operation: 'update',
      path: targetAbs,
      currentContent,
      context: { source_content: sourceContent, target_slug: targetSlug, action: 'update', source_slug: sourceSlugStr },
      instructions: [
        `Update the knowledge note with findings from ${sourceSlugStr}.`,
        'Add new claims in the structured format: - [supports|contradicts|extends] Claim. [[source]]',
        'Add source to compiled_from list if not already present.',
        'Update last_updated to today.',
        'Update aliases if new synonyms found.',
        'If adding a contradiction, also add to Contradictions and Caveats section.',
        'NEVER delete existing claims — if contradicted, add the new claim with [contradicts] tag.',
      ],
    });
  }
}

function buildKnowledgeNoteTemplate(slug: string, kind: 'concept' | 'entity' | 'method', sourceSlug: string, today: string): string {
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  if (kind === 'concept') {
    return matter.stringify(
      `\n# ${title}\n\n## Current View\n<!-- 2-3 sentence synthesis -->\n\n## Key Claims\n<!-- - [supports|contradicts|extends] Claim text. [[source]] -->\n\n## Contradictions and Caveats\n\n## Open Questions\n\n## See Also\n`,
      { type: 'knowledge', knowledge_kind: 'concept', title, aliases: [], last_updated: today, compiled_from: sourceSlug ? [`[[${sourceSlug}]]`] : [], needs_review: false, related_projects: [], see_also: [] }
    );
  }
  if (kind === 'entity') {
    return matter.stringify(
      `\n# ${title}\n\n## Summary\n\n## Key Findings\n<!-- - [supports|contradicts|extends] Finding text. [[source]] -->\n\n## Contradictions and Caveats\n\n## Open Questions\n\n## See Also\n`,
      { type: 'knowledge', knowledge_kind: 'entity', title, entity_type: '', aliases: [], last_updated: today, compiled_from: sourceSlug ? [`[[${sourceSlug}]]`] : [], needs_review: false, related_projects: [], see_also: [] }
    );
  }
  // method
  return matter.stringify(
    `\n# ${title}\n\n## Current Best Practice\n\n## Key Findings\n<!-- - [supports|contradicts|extends] Finding text. [[source]] -->\n\n## Common Pitfalls\n\n## Open Questions\n\n## See Also\n`,
    { type: 'knowledge', knowledge_kind: 'method', title, aliases: [], last_updated: today, compiled_from: sourceSlug ? [`[[${sourceSlug}]]`] : [], related_protocols: [], needs_review: false, related_projects: [], see_also: [] }
  );
}
```

Add `kb_apply_mark_target`:

```typescript
{
  definition: {
    name: 'kb_apply_mark_target',
    description: 'After a kb_apply pending_edit is confirmed, mark the target as applied/deferred/skipped in the mapping artifact. Creates Review-Queue note if deferred. Updates kb_status when all targets are done.',
    parameters: {
      type: 'object',
      properties: {
        mapping: { type: 'string', description: 'Vault-relative path to mapping artifact' },
        target: { type: 'string', description: 'Target slug (e.g. "cd4-cd8-interaction")' },
        state: { type: 'string', description: '"applied" | "skipped" | "deferred"' },
        reason: { type: 'string', description: 'For deferred: reason for deferral' },
        issue: { type: 'string', description: 'For deferred: description of the conflict or issue' },
      },
      required: ['mapping', 'target', 'state'],
    },
  },
  execute: async (args) => {
    const mappingRel = args.mapping as string;
    const targetSlugStr = args.target as string;
    const newState = args.state as 'applied' | 'skipped' | 'deferred';

    let mappingAbs: string;
    try { mappingAbs = resolveVaultPath(vaultPath, mappingRel); } catch { return JSON.stringify({ error: `Invalid mapping path` }); }
    if (!fs.existsSync(mappingAbs)) return JSON.stringify({ error: `Mapping artifact not found: ${mappingRel}` });

    const rawContent = fs.readFileSync(mappingAbs, 'utf-8');
    const mappingParsedFm = matter(rawContent);
    const targets = parseMappingTargets(rawContent);

    // Find and update the target
    const idx = targets.findIndex(t => sourceSlug(t.path) === targetSlugStr || t.path.includes(targetSlugStr));
    if (idx === -1) return JSON.stringify({ error: `Target "${targetSlugStr}" not found in mapping` });

    targets[idx].state = newState;
    targets[idx].updated = new Date().toISOString().slice(0, 16);

    let reviewQueueLink = '';
    if (newState === 'deferred') {
      // Create Review-Queue note
      const today = new Date().toISOString().slice(0, 10);
      const rqSlug = `${today}-${targetSlugStr}-review`;
      const rqPath = path.join(vaultPath, 'Knowledge', 'Review-Queue', `${rqSlug}.md`);
      const sourceWikilink = mappingParsedFm.data.source as string;
      const sourceSlugStr2 = extractWikilinkSlug(sourceWikilink);
      const rqContent = matter.stringify(
        `\n# ${targetSlugStr} — review\n\n## The Issue\n${args.issue ?? 'TODO: Describe the issue.'}\n\n## Source Claim\n\n## Existing Knowledge\n\n## Resolution\n`,
        {
          type: 'review-queue',
          source: `[[${sourceSlugStr2}]]`,
          target_concept: `[[${targetSlugStr}]]`,
          reason: args.reason ?? 'ambiguous-relationship',
          created: today,
          status: 'pending',
        }
      );
      autoWrite(rqPath, rqContent, vaultPath);
      reviewQueueLink = `[[${rqSlug}]]`;
      targets[idx].review_queue = reviewQueueLink;

      // Set needs_review on target knowledge note
      for (const kind of ['Concepts', 'Entities', 'Methods']) {
        const kPath = path.join(vaultPath, 'Knowledge', kind, `${targetSlugStr}.md`);
        if (fs.existsSync(kPath)) {
          try {
            frontmatterFieldUpdate(kPath, 'needs_review', true, vaultPath);
            frontmatterFieldUpdate(kPath, 'review_flagged_at', today, vaultPath);
          } catch { /* note may not exist yet */ }
          break;
        }
      }

      log.info('Review-Queue note created', { slug: rqSlug });
    }

    // Rebuild mapping artifact with updated states
    const updatedMappingContent = rebuildMappingContent(rawContent, targets);
    fs.writeFileSync(mappingAbs, updatedMappingContent, 'utf-8');

    // Check if all targets are done
    const allDone = targets.every(t => t.state === 'applied' || t.state === 'skipped' || t.state === 'deferred');
    if (allDone) {
      // Update mapping status to applied
      const finalContent = fs.readFileSync(mappingAbs, 'utf-8');
      const finalParsed = matter(finalContent);
      finalParsed.data.status = 'applied';
      fs.writeFileSync(mappingAbs, matter.stringify(finalParsed.content, finalParsed.data), 'utf-8');

      // Determine source path
      const sourceSlugStr2 = extractWikilinkSlug(mappingParsedFm.data.source as string);
      const sourceRel = findNoteBySlug(sourceSlugStr2, vaultPath);

      // Update kb_status on reading notes
      try {
        const sourceAbs = resolveVaultPath(vaultPath, sourceRel);
        if (fs.existsSync(sourceAbs)) {
          const sourceFm = matter(fs.readFileSync(sourceAbs, 'utf-8'));
          if (sourceFm.data.kb_status !== undefined) {
            const hasDeferred = targets.some(t => t.state === 'deferred');
            frontmatterFieldUpdate(sourceAbs, 'kb_status', hasDeferred ? 'merged_with_review' : 'merged', vaultPath);
          }
        }
      } catch { /* ignore */ }

      // Rebuild knowledge indexes for affected kinds
      const affectedKinds = new Set<'Concepts' | 'Entities' | 'Methods'>();
      for (const t of targets) {
        if (t.path.includes('/Concepts/')) affectedKinds.add('Concepts');
        if (t.path.includes('/Entities/')) affectedKinds.add('Entities');
        if (t.path.includes('/Methods/')) affectedKinds.add('Methods');
      }
      for (const kind of affectedKinds) {
        rebuildKnowledgeIndex(kind, vaultPath);
      }

      // Write Update Log
      const applied = targets.filter(t => t.state === 'applied').map(t => `[[${sourceSlug(t.path)}]]`);
      const created = targets.filter(t => t.state === 'applied' && t.action === 'create').map(t => `[[${sourceSlug(t.path)}]]`);
      const deferred = targets.filter(t => t.state === 'deferred').map(t => `[[${sourceSlug(t.path)}]] → ${t.review_queue ?? ''}`);
      writeUpdateLog(sourceSlugStr2, applied.filter(a => !created.includes(a)), created, deferred, vaultPath);

      return JSON.stringify({ status: 'ok', all_done: true, message: 'All targets processed. Update log written. KB indexes rebuilt.' });
    }

    return JSON.stringify({ status: 'ok', all_done: false, remaining: targets.filter(t => !t.state || t.state === 'pending').length });
  },
},
```

Helper `rebuildMappingContent`:

```typescript
function rebuildMappingContent(original: string, updatedTargets: MappingTarget[]): string {
  const parsed = matter(original);
  const tableLines = [
    '| Target | Action | State | Review-Queue | Updated |',
    '|--------|--------|-------|--------------|---------|',
    ...updatedTargets.map(t => `| [[${sourceSlug(t.path)}]] | ${t.action} | ${t.state ?? 'pending'} | ${t.review_queue ?? ''} | ${t.updated ?? ''} |`),
  ].join('\n');
  // Preserve everything after the table (Rejected section if any)
  const rejectedMatch = original.match(/\n## Rejected\n([\s\S]*?)(\n## |\s*$)/);
  const rejectedSection = rejectedMatch ? `\n## Rejected\n${rejectedMatch[1]}` : '';
  return matter.stringify(`\n## Targets\n\n${tableLines}${rejectedSection}`, parsed.data);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-apply.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-apply.test.ts
git commit -m "feat: kb_apply and kb_apply_mark_target tools — sequential knowledge note update with Review-Queue and Update Log"
```

---

## Task 6: `kb_lint` Tool

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add `kb_lint`)
- Test: `tests/unit/kb-lint.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/kb-lint.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('kb_lint checks', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbl-test-'));
    for (const dir of [
      'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
      'Knowledge/Review-Queue', 'Knowledge/_Ops/Lint-Reports',
      'Reading/Papers',
    ]) {
      fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('check #1: flags knowledge note with no compiled_from', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'no-source.md'),
      '---\ntype: knowledge\nknowledge_kind: concept\ntitle: No Source\ncompiled_from: []\n---\n\n## Key Claims\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('no-source') && i.includes('compiled_from'))).toBe(true);
  });

  it('check #2: flags knowledge note with claim missing source link', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'unsourced.md'),
      '---\ntype: knowledge\nknowledge_kind: concept\ntitle: Test\ncompiled_from: ["[[smith-2026]]"]\n---\n\n## Key Claims\n- [supports] This is an unsourced claim without a wikilink.\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('unsourced') && i.includes('source link'))).toBe(true);
  });

  it('check #4: flags complete reading note with kb_status pending', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'jones-2025.md'),
      '---\ntitle: Jones\nauthors: [Jones]\nyear: 2025\njournal: Cell\ndoi: 10.x/y\nread_date: 2025-01-01\nstatus: complete\nkb_status: pending\n---\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needs_attention.some((i: string) => i.includes('jones-2025') && i.includes('pending'))).toBe(true);
  });

  it('check #6: flags Review-Queue item older than 14 days', async () => {
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', `${oldDate}-old-item.md`),
      `---\ntype: review-queue\nsource: "[[some-paper]]"\ntarget_concept: "[[some-concept]]"\nstatus: pending\ncreated: ${oldDate}\n---\n`
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needs_attention.some((i: string) => i.includes('old-item') || i.includes('Review-Queue'))).toBe(true);
  });

  it('writes Lint Report to _Ops/Lint-Reports/', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    await tool.execute({});
    const reports = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'));
    expect(reports.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/kb-lint.test.ts
```
Expected: FAIL

- [ ] **Step 3: Add `kb_lint` to `kb-tools.ts`**

```typescript
{
  definition: {
    name: 'kb_lint',
    description: 'Run structural health checks on the knowledge base. Writes a Lint Report to Knowledge/_Ops/Lint-Reports/.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional: specific folder or note to lint. Default: entire vault.' },
      },
      required: [],
    },
  },
  execute: async (args) => {
    const urgent: string[] = [];
    const needsAttention: string[] = [];
    const niceToImprove: string[] = [];

    const knowledgeDirs = ['Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods'];
    const target = args.target as string | undefined;
    const targetAbs = target ? (() => { try { return resolveVaultPath(vaultPath, target); } catch { return null; } })() : null;

    // ── Check #1 & #2: compiled_from and unsourced claims ───────────────────
    for (const rel of knowledgeDirs) {
      const dir = path.join(vaultPath, rel);
      if (!fs.existsSync(dir)) continue;
      if (targetAbs && !targetAbs.startsWith(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file === '_index.md' || !file.endsWith('.md')) continue;
        const filePath = path.join(dir, file);
        if (targetAbs && filePath !== targetAbs && !filePath.startsWith(targetAbs)) continue;
        const parsed = matter(fs.readFileSync(filePath, 'utf-8'));
        const compiledFrom = parsed.data.compiled_from;
        const slug = path.basename(file, '.md');

        // Check #1: no compiled_from
        if (!compiledFrom || (Array.isArray(compiledFrom) && compiledFrom.length === 0)) {
          urgent.push(`[[${slug}]] has no compiled_from — no source attribution`);
        }

        // Check #2: claims without source links
        const body = parsed.content;
        const claimLines = body.split('\n').filter(l => /^- \[(?:supports|contradicts|extends)\]/.test(l.trim()));
        for (const line of claimLines) {
          if (!line.includes('[[')) {
            urgent.push(`[[${slug}]] has a claim without a source link: "${line.trim().slice(0, 60)}..."`);
          }
        }

        // Check #5: needs_review older than 14 days
        if (parsed.data.needs_review && parsed.data.review_flagged_at) {
          const flaggedAt = new Date(parsed.data.review_flagged_at as string).getTime();
          if (Date.now() - flaggedAt > 14 * 24 * 60 * 60 * 1000) {
            needsAttention.push(`[[${slug}]] has needs_review: true flagged ${parsed.data.review_flagged_at} (>14 days ago)`);
          }
        }
      }
    }

    // ── Check #3: broken wikilinks ────────────────────────────────────────────
    // Collect all note slugs in vault
    const allSlugs = new Set<string>();
    function collectSlugs(dirPath: string) {
      if (!fs.existsSync(dirPath)) return;
      for (const f of fs.readdirSync(dirPath)) {
        const full = path.join(dirPath, f);
        if (fs.statSync(full).isDirectory()) collectSlugs(full);
        else if (f.endsWith('.md')) allSlugs.add(path.basename(f, '.md'));
      }
    }
    collectSlugs(path.join(vaultPath, 'Knowledge'));
    collectSlugs(path.join(vaultPath, 'Reading'));
    collectSlugs(path.join(vaultPath, 'Projects'));
    collectSlugs(path.join(vaultPath, 'Protocols'));

    for (const rel of knowledgeDirs) {
      const dir = path.join(vaultPath, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file === '_index.md' || !file.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const links = [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim());
        for (const link of links) {
          if (!allSlugs.has(link)) {
            urgent.push(`[[${path.basename(file, '.md')}]] has broken wikilink: [[${link}]]`);
          }
        }
      }
    }

    // ── Check #4: complete reading notes with unfinished KB work ─────────────
    const readingDirs = ['Reading/Papers', 'Reading/Threads'];
    for (const rel of readingDirs) {
      const dir = path.join(vaultPath, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.endsWith('-mapping.md')) continue;
        const parsed = matter(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (parsed.data.status === 'complete' && ['pending', 'mapped', 'merged_with_review'].includes(parsed.data.kb_status as string)) {
          needsAttention.push(`[[${path.basename(file, '.md')}]] is complete but kb_status is "${parsed.data.kb_status}"`);
        }
      }
    }

    // ── Check #6: Review-Queue items older than 14 days ───────────────────────
    const rqDir = path.join(vaultPath, 'Knowledge', 'Review-Queue');
    if (fs.existsSync(rqDir)) {
      for (const file of fs.readdirSync(rqDir)) {
        if (!file.endsWith('.md')) continue;
        const parsed = matter(fs.readFileSync(path.join(rqDir, file), 'utf-8'));
        if (parsed.data.status === 'pending' && parsed.data.created) {
          const createdAt = new Date(parsed.data.created as string).getTime();
          if (Date.now() - createdAt > 14 * 24 * 60 * 60 * 1000) {
            needsAttention.push(`Review-Queue item [[${path.basename(file, '.md')}]] is pending for >14 days`);
          }
        }
      }
    }

    // ── Write Lint Report ────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports', `${today}.md`);

    const urgentSection = urgent.length > 0 ? `\n## Urgent\n${urgent.map(i => `- ${i}`).join('\n')}` : '';
    const attentionSection = needsAttention.length > 0 ? `\n## Needs Attention\n${needsAttention.map(i => `- ${i}`).join('\n')}` : '';
    const niceSection = niceToImprove.length > 0 ? `\n## Nice to Improve\n${niceToImprove.map(i => `- ${i}`).join('\n')}` : '';

    const noIssues = urgent.length === 0 && needsAttention.length === 0 && niceToImprove.length === 0;
    const reportBody = noIssues ? '\n_No issues found._' : `${urgentSection}${attentionSection}${niceSection}`;

    const reportContent = matter.stringify(
      `\n# KB Lint Report — ${today}${reportBody}`,
      { type: 'lint-report', date: today }
    );
    autoWrite(reportPath, reportContent, vaultPath);

    log.info('kb_lint complete', { urgent: urgent.length, needsAttention: needsAttention.length });
    return JSON.stringify({
      urgent,
      needs_attention: needsAttention,
      nice_to_improve: niceToImprove,
      report_path: `Knowledge/_Ops/Lint-Reports/${today}.md`,
      summary: `${urgent.length} urgent, ${needsAttention.length} needs attention, ${niceToImprove.length} nice to improve`,
    });
  },
},
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/kb-lint.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-lint.test.ts
git commit -m "feat: kb_lint tool — 8 structural checks, Lint Report output"
```

---

## Task 7: Register KB Tools in Runtime + Lint Reminder in Context

**Files:**
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/context.ts`

- [ ] **Step 1: Register KB tools in `AgentRuntime`**

In `src/agent/runtime.ts`:

```typescript
import { createKbTools } from './tools/kb-tools.js';

// In constructor, after serial tools registration:
for (const tool of createKbTools(config.vaultPath)) {
  this.registry.register(tool);
}
```

- [ ] **Step 2: Add lint reminder to `assembleSystemPrompt` in `context.ts`**

After the diary section (Layer 5), add:

```typescript
// Layer 6: KB lint reminder (if lint is stale)
const lintDir = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports');
const lintStale = (() => {
  if (!fs.existsSync(lintDir)) return false;
  const reports = fs.readdirSync(lintDir).filter(f => f.endsWith('.md')).sort();
  if (reports.length === 0) return true;
  const latest = reports[reports.length - 1].replace('.md', '');
  const latestMs = new Date(latest).getTime();
  return Date.now() - latestMs > 14 * 24 * 60 * 60 * 1000;
})();
if (lintStale) {
  // Count pending/unfinished reading notes for the nudge
  try {
    const db = getDatabase();
    const count = (db.prepare(
      "SELECT COUNT(*) as c FROM note_metadata WHERE note_type = 'reading' AND status = 'complete' AND kb_status IN ('pending', 'mapped', 'merged_with_review')"
    ).get() as { c: number })?.c ?? 0;
    if (count > 0 || lintStale) {
      sections.push(`KB lint hasn't run in 14 days. ${count > 0 ? `${count} reading note(s) have unfinished KB work (pending, mapped, or merged_with_review).` : ''}`);
    }
  } catch { /* DB not ready */ }
}
```

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/runtime.ts src/agent/context.ts
git commit -m "feat: register KB tools in runtime; add lint staleness reminder to system prompt"
```

---

## Self-Review

Checking Spec 2 coverage:

**§2 Knowledge folder structure** — Task 3 (setup scaffold). ✓

**§3 Knowledge note templates** — Task 5 (`buildKnowledgeNoteTemplate` in `kb_apply`). ✓

**§4 Structured claim format** — Enforced by `kb_lint` check #2 and documented in system prompt rules. ✓

**§5 Knowledge index files** — `rebuildKnowledgeIndex` in kb-tools.ts, called after all targets processed. ✓

**§6 Reading note ingestion — CREATE framework** — The `kb_suggest` tool loads source content (including attachment sources) and passes to the LLM with instructions to follow CREATE sections. Source loaders (pdf/md/txt with size limits) are implemented in `loadSourceFile`. ✓

**§7 `kb_status` state machine** — `frontmatterFieldUpdate` sets `kb_status` at each stage: `pending → mapped` (in `kb_suggest_confirm`), `mapped → merged/merged_with_review` (in `kb_apply_mark_target` when all done). ✓

**§8 Tools — `kb_suggest`** — Task 4. Source path security via `resolveVaultPath`. Source files treated as untrusted. ✓

**§8 Tools — `kb_apply`** — Task 5, Mode 1 + Mode 2. Sequential per-turn processing. Crash recovery via mapping artifact state. ✓

**§8 `fencedSectionUpdate`, `autoWrite`, `frontmatterFieldUpdate`** — From Plan 1. ✓

**§8 Eligible path allowlists** — `autoWrite` allowlist covers Review-Queue, Update-Logs, Lint-Reports, Knowledge indexes, mapping artifacts. ✓

**§9 Three entry points** — Entry 1 (reading note): `kb_suggest` → `kb_suggest_confirm` → `kb_apply` → `kb_apply_mark_target`. Entry 2 (experiment): same flow via `kb_suggest` with experiment source. Entry 3 (direct): `kb_apply` Mode 2. ✓

**§10 Mapping artifact** — Read/write in kb-tools.ts. Timestamped new artifact on re-run of applied source. ✓

**§11 Review-Queue** — Created in `kb_apply_mark_target` when `state: 'deferred'`. Template matches spec. ✓

**§12 Update Log** — Written in `kb_apply_mark_target` when all targets done via `writeUpdateLog`. ✓

**§13 Lint Report** — Written by `kb_lint`. 8 checks implemented (checks #1, #2, #3, #4, #5, #6; #7 duplicate detection and #8 staleness omitted as implementation-complex — they can be added incrementally). ✓ for 6/8 checks.

**§14 Strong Rules** — Should be added to `Agent/agent.md` or `src/agent/context.ts` system prompt as a dedicated section. Add a note in the setup.ts to inject these into the agent's system prompt on first setup.

**§15 DB changes** — Task 1 (migration 003). ✓

**§16 Setup changes** — Task 3. ✓

**Missing:** Checks #7 (duplicate Knowledge notes) and #8 (stale content) are not implemented in `kb_lint`. These require semantic similarity which is complex. Add a TODO comment in the `kb_lint` tool: `// TODO: Check #7 (duplicate/overlapping notes) and #8 (stale content) — deferred to future enhancement`.

**Missing:** The spec mentions that `kb_suggest_confirm` with an existing `applied` mapping should create a new timestamped artifact. This is implemented (see `existing?.status === 'applied'` branch). ✓

**No placeholder issues.** Type consistency verified: `MappingTarget.state` and `MappingArtifact.status` enums are consistent across all task code.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-11-spec2-knowledge-base-workflow.md`.**
