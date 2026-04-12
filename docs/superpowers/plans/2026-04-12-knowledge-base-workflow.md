# Knowledge Base Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kb_suggest`, `kb_apply`, `kb_lint`, and `compile_reading_note` tools to CrickNote so scientists can turn reading notes and experiment results into a living knowledge base.

**Architecture:** Each KB tool loads a small context window (source note + Knowledge indexes or one target at a time), proposes changes via the existing safe-writer / autoWrite pattern, and uses a mapping artifact file for crash-safe multi-turn workflows. Agent-managed writes (mapping artifacts, index files, Update Logs, `kb_status` field) bypass safe-writer via `autoWrite()` / `frontmatterFieldUpdate()`, which are already implemented. Only knowledge note diffs require user confirmation.

**Tech Stack:** TypeScript, better-sqlite3, gray-matter, pdf-parse (new), Node.js fs, existing auto-writer / safe-writer primitives, Vitest.

---

## File Map

**Create:**
- `src/storage/migrations/003-knowledge-base.ts` — DB columns + indexes
- `src/knowledge/source-loader.ts` — load source files for compile step
- `src/knowledge/index-builder.ts` — rebuild `Knowledge/{kind}/_index.md`
- `src/agent/tools/kb-tools.ts` — all 8 KB tools

**Modify:**
- `src/storage/migrations/001-initial.ts` — call migration 003
- `src/ingestion/parser.ts` — add `knowledge` / `review-queue` NoteType + 7 new fields
- `src/agent/runtime.ts` — register `createKbTools()`
- `src/cli/setup.ts` — create initial `_index.md` files

**Tests:**
- `tests/integration/migration-003.test.ts`
- `tests/unit/parser-kb.test.ts`
- `tests/unit/source-loader.test.ts`
- `tests/unit/index-builder.test.ts`
- `tests/unit/kb-tools-suggest.test.ts`
- `tests/unit/kb-tools-apply.test.ts`
- `tests/unit/kb-tools-lint.test.ts`

---

## Task 1: DB Migration 003 — Knowledge Base Columns

**Files:**
- Create: `src/storage/migrations/003-knowledge-base.ts`
- Modify: `src/storage/migrations/001-initial.ts:4-23`
- Test: `tests/integration/migration-003.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/migration-003.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('migration 003 — knowledge base columns', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('adds 7 new columns to note_metadata', () => {
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(note_metadata)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const col of ['kb_status', 'knowledge_kind', 'needs_review', 'review_flagged_at', 'aliases', 'rq_source', 'rq_target']) {
      expect(names).toContain(col);
    }
  });

  it('creates kb_status and needs_review indexes', () => {
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_note_metadata_kb_status');
    expect(names).toContain('idx_note_metadata_needs_review');
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/integration/migration-003.test.ts
```
Expected: FAIL — columns not found.

- [ ] **Step 3: Create migration file**

```typescript
// src/storage/migrations/003-knowledge-base.ts
import type Database from 'better-sqlite3';

export function applyMigration003(db: Database.Database): void {
  // ALTER TABLE must run outside transaction in SQLite
  for (const [col, type] of [
    ['kb_status', 'TEXT'],
    ['knowledge_kind', 'TEXT'],
    ['needs_review', 'INTEGER DEFAULT 0'],
    ['review_flagged_at', 'TEXT'],
    ['aliases', 'TEXT'],
    ['rq_source', 'TEXT'],
    ['rq_target', 'TEXT'],
  ] as Array<[string, string]>) {
    try { db.exec(`ALTER TABLE note_metadata ADD COLUMN ${col} ${type};`); }
    catch (e) { if (!(e as Error).message.includes('duplicate column name')) throw e; }
  }

  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_note_metadata_kb_status
        ON note_metadata(kb_status);
      CREATE INDEX IF NOT EXISTS idx_note_metadata_needs_review
        ON note_metadata(needs_review);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(3, Date.now());
  })();
}
```

- [ ] **Step 4: Wire migration into `runMigrations`**

In `src/storage/migrations/001-initial.ts`, add after the existing import:

```typescript
import { applyMigration003 } from './003-knowledge-base.js';
```

And add after the `currentVersion < 2` block:

```typescript
  if (currentVersion < 3) {
    applyMigration003(db);
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/integration/migration-003.test.ts
```
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/003-knowledge-base.ts src/storage/migrations/001-initial.ts tests/integration/migration-003.test.ts
git commit -m "feat: migration 003 — knowledge base columns on note_metadata"
```

---

## Task 2: Parser — Knowledge and Review-Queue Note Types

**Files:**
- Modify: `src/ingestion/parser.ts`
- Test: `tests/unit/parser-kb.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/parser-kb.test.ts
import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/ingestion/parser.js';

const CONCEPT_NOTE = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk, helper-cytotoxic interaction]
last_updated: 2026-04-08
compiled_from:
  - "[[smith-2026-il42-signalling]]"
needs_review: false
---

# CD4-CD8 Interaction

## Current View
Some synthesis.
`;

const REVIEW_QUEUE_NOTE = `---
type: review-queue
source: "[[smith-2026-il42-signalling]]"
target_concept: "[[cd4-cd8-interaction]]"
reason: ambiguous-relationship
created: 2026-04-08
status: pending
rq_source: smith-2026-il42-signalling
rq_target: cd4-cd8-interaction
---

# IL-42 suppression magnitude — context conflict
`;

const READING_NOTE = `---
title: IL-42 mediated suppression
authors: [Smith]
year: 2026
journal: Nature Immunology
read_date: 2026-04-06
status: complete
kb_status: pending
---

# IL-42 mediated suppression
`;

describe('parseNote — knowledge notes', () => {
  it('classifies Knowledge/Concepts note as knowledge noteType', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.noteType).toBe('knowledge');
    expect(parsed.folder).toBe('Knowledge');
  });

  it('extracts knowledge_kind, aliases, needs_review', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.knowledgeKind).toBe('concept');
    expect(parsed.aliases).toEqual(['cd4 cd8 crosstalk', 'helper-cytotoxic interaction']);
    expect(parsed.needsReview).toBe(false);
  });

  it('classifies Knowledge/Review-Queue note as review-queue noteType', () => {
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', REVIEW_QUEUE_NOTE);
    expect(parsed.noteType).toBe('review-queue');
    expect(parsed.rqSource).toBe('smith-2026-il42-signalling');
    expect(parsed.rqTarget).toBe('cd4-cd8-interaction');
  });

  it('extracts kb_status from reading notes', () => {
    const parsed = parseNote('Reading/Papers/smith-2026-il42-signalling.md', READING_NOTE);
    expect(parsed.noteType).toBe('reading');
    expect(parsed.kbStatus).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/parser-kb.test.ts
```
Expected: FAIL — `knowledge` not in NoteType, properties undefined.

- [ ] **Step 3: Update `NoteType` union and `ParsedNote` interface in `src/ingestion/parser.ts`**

Replace the `NoteType` line:
```typescript
export type NoteType = 'experiment' | 'protocol' | 'reading' | 'diary' | 'agent' | 'series' | 'project-index' | 'knowledge' | 'review-queue' | 'unknown';
```

Add new fields to `ParsedNote` (after the `noteKind?: string` line):
```typescript
  // Knowledge base fields
  kbStatus?: string;
  knowledgeKind?: string;
  needsReview?: boolean;
  reviewFlaggedAt?: string;
  aliases?: string[];
  rqSource?: string;
  rqTarget?: string;
```

- [ ] **Step 3b: Update `REQUIRED_FIELDS` map and status validation for KB note types**

In `src/ingestion/parser.ts`, update `REQUIRED_FIELDS` to include the two new note types:
```typescript
const REQUIRED_FIELDS: Record<NoteType, string[]> = {
  experiment: [],
  series: [],
  'project-index': [],
  protocol: ['title', 'version', 'last_updated', 'category'],
  reading: ['title', 'authors', 'year', 'journal', 'read_date'],
  diary: ['date', 'type'],
  agent: [],
  knowledge: [],
  'review-queue': [],
  unknown: [],
};
```

Also update `validateFrontmatter` status check to accept review-queue statuses:
```typescript
  if (frontmatter['status'] && typeof frontmatter['status'] === 'string') {
    const validStatuses = ['draft', 'in-progress', 'complete'];
    const reviewQueueStatuses = ['pending', 'resolved', 'dismissed'];
    const allValid = noteType === 'review-queue'
      ? reviewQueueStatuses
      : validStatuses;
    if (!allValid.includes(frontmatter['status'])) {
      warnings.push({
        field: 'status',
        message: `Field "status" should be one of: ${allValid.join(', ')}. Got "${frontmatter['status']}".`,
      });
    }
  }
```

- [ ] **Step 3c: Update `src/ingestion/indexer.ts` to persist the 7 KB fields**

Add the 7 new columns to the INSERT/UPDATE in `indexNote()` in `src/ingestion/indexer.ts`:

In the INSERT statement, extend the column list:
```typescript
    database.prepare(`
      INSERT INTO note_metadata (path, folder, note_type, date, project, project_id, note_id, series,
        last_session, experiment_type, protocol_ref, status, tags, result_summary, content_hash, mtime, last_indexed,
        kb_status, knowledge_kind, needs_review, review_flagged_at, aliases, rq_source, rq_target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        ...existing fields...,
        kb_status = excluded.kb_status,
        knowledge_kind = excluded.knowledge_kind,
        needs_review = excluded.needs_review,
        review_flagged_at = excluded.review_flagged_at,
        aliases = excluded.aliases,
        rq_source = excluded.rq_source,
        rq_target = excluded.rq_target
    `).run(
      ...existing args...,
      note.kbStatus ?? null,
      note.knowledgeKind ?? null,
      note.needsReview != null ? (note.needsReview ? 1 : 0) : null,
      note.reviewFlaggedAt ?? null,
      note.aliases ? JSON.stringify(note.aliases) : null,
      note.rqSource ?? null,
      note.rqTarget ?? null
    );
```

Add to `tests/unit/parser-kb.test.ts` validation tests:
```typescript
  it('isValid is true for a well-formed knowledge note', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.isValid).toBe(true);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('review-queue note with status:pending is valid (not flagged as bad status)', () => {
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', REVIEW_QUEUE_NOTE);
    expect(parsed.isValid).toBe(true);
    expect(parsed.warnings.every(w => !w.message.includes('status'))).toBe(true);
  });
```

Add a new integration test `tests/integration/indexer-kb.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexNote } from '../../src/ingestion/indexer.js';

describe('indexer — KB fields', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('persists all 7 KB fields to note_metadata', () => {
    indexNote({
      note: {
        filePath: 'Knowledge/Concepts/test.md',
        folder: 'Knowledge', noteType: 'knowledge', isValid: true, warnings: [],
        kbStatus: 'pending', knowledgeKind: 'concept', needsReview: false,
        reviewFlaggedAt: undefined, aliases: ['test alias'], rqSource: undefined, rqTarget: undefined,
      },
      contentHash: 'abc', mtime: Date.now(), chunks: [], embeddings: [],
    }, db);
    const row = db.prepare('SELECT kb_status, knowledge_kind, needs_review, aliases FROM note_metadata WHERE path = ?')
      .get('Knowledge/Concepts/test.md') as Record<string, unknown>;
    expect(row.kb_status).toBe('pending');
    expect(row.knowledge_kind).toBe('concept');
    expect(row.needs_review).toBe(0);
    expect(JSON.parse(row.aliases as string)).toEqual(['test alias']);
  });
});
```

Also update git add/commit in Task 2 Step 8 to include `src/ingestion/indexer.ts tests/integration/indexer-kb.test.ts`.

- [ ] **Step 4: Update `classifyNote` to handle `Knowledge/` folder**

In the `switch (firstSegment)` block in `classifyNote`, add before `default`:

```typescript
    case 'Knowledge': {
      const segments = normalized.split('/');
      if (segments[1] === 'Review-Queue') return { folder: 'Knowledge', noteType: 'review-queue' };
      if (segments[1] === '_Ops') return { folder: 'Knowledge', noteType: 'unknown' };
      return { folder: 'Knowledge', noteType: 'knowledge' };
    }
```

- [ ] **Step 5: Extract new fields in `parseNote`**

In `parseNote`, after the `noteKind` extraction block, add:

```typescript
  // Knowledge base fields
  const kbStatus = normalizeString(frontmatter['kb_status']) || undefined;
  const knowledgeKind = normalizeString(frontmatter['knowledge_kind']) || undefined;
  const needsReviewRaw = frontmatter['needs_review'];
  const needsReview = needsReviewRaw !== undefined && needsReviewRaw !== null
    ? Boolean(needsReviewRaw) : undefined;
  const reviewFlaggedAt = normalizeString(frontmatter['review_flagged_at']) || undefined;

  const aliasesRaw = frontmatter['aliases'];
  const aliases: string[] | undefined = Array.isArray(aliasesRaw)
    ? aliasesRaw.map(String)
    : typeof aliasesRaw === 'string' && aliasesRaw.trim()
      ? [aliasesRaw.trim()]
      : undefined;

  const rqSource = normalizeString(frontmatter['rq_source']) || undefined;
  const rqTarget = normalizeString(frontmatter['rq_target']) || undefined;
```

Then add these fields to the returned object:
```typescript
    kbStatus,
    knowledgeKind,
    needsReview,
    reviewFlaggedAt,
    aliases,
    rqSource,
    rqTarget,
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/parser-kb.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 7: Make sure existing parser tests still pass**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/parser-serial.test.ts tests/unit/frontmatter-parser.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ingestion/parser.ts tests/unit/parser-kb.test.ts
git commit -m "feat: parser — knowledge/review-queue NoteType + 7 KB metadata fields"
```

---

## Task 3: Source Loader + `compile_reading_note` Tool

**Files:**
- Create: `src/knowledge/source-loader.ts`
- Create: `src/agent/tools/kb-tools.ts` (initial file with compile tool only)
- Test: `tests/unit/source-loader.test.ts`

- [ ] **Step 1: Add pdf-parse dependency**

```bash
cd /Users/le211/crickNote && npm install pdf-parse && npm install --save-dev @types/pdf-parse
```
Expected: package.json updated with `"pdf-parse": "^1.x.x"`.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/source-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSources } from '../../src/knowledge/source-loader.js';

describe('loadSources', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      'IL-42 suppresses CD8 by 40%.'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'large.md'),
      'x'.repeat(42000) // > 10 000 tokens at ~4 chars/token
    );
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('loads a markdown source file', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'notes.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toContain('IL-42 suppresses');
    expect(result.warnings).toHaveLength(0);
  });

  it('truncates a source that exceeds 10 000 tokens', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'large.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources[0].truncated).toBe(true);
    expect(result.warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  it('warns and skips missing source files', async () => {
    const result = await loadSources(
      [{ type: 'pdf', path: 'missing.pdf' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('missing.pdf'))).toBe(true);
  });

  it('warns for unsupported types (xlsx, images)', async () => {
    const result = await loadSources(
      [{ type: 'other', path: 'data.xlsx' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.warnings.some(w => w.includes('Cannot read'))).toBe(true);
  });

  it('respects the 30 000 token session cap', async () => {
    // Write 4 large files each ~8 000 tokens
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(
        path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', `part${i}.md`),
        'y'.repeat(32000)
      );
    }
    const result = await loadSources(
      [1,2,3,4].map(i => ({ type: 'notes', path: `part${i}.md` })),
      'smith-2026-il42',
      vaultPath
    );
    expect(result.totalTokens).toBeLessThanOrEqual(30000);
    expect(result.warnings.some(w => w.includes('session cap'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/source-loader.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3b: Add source priority sort to `loadSources` input**

Before the main loop, sort the `sources` array by priority type:
```typescript
const TYPE_PRIORITY: Record<string, number> = {
  notes: 0,        // main .md/.txt notes — highest priority
  pdf: 1,          // PDF attachments
  notebooklm: 2,   // NotebookLM summary exports
  web: 3,          // web content
  other: 4,        // personal notes, misc — lowest priority
};

// Sort by priority before loading (stable sort preserves original order within same priority)
const sortedSources = [...sources].sort(
  (a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)
);
```

Use `sortedSources` in the main loop instead of `sources`.

Add a test:
```typescript
  it('loads sources in priority order (notes > pdf > notebooklm > web > other)', async () => {
    // Write test files in priority order
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'), 'MD notes content');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'summary.md'), 'NotebookLM summary content');
    const result = await loadSources(
      [
        { type: 'other', path: 'other.md' },        // priority 4 — but file doesn't exist, skip
        { type: 'notebooklm', path: 'summary.md' }, // priority 2
        { type: 'notes', path: 'notes.md' },         // priority 0 — highest
      ],
      'smith-2026-il42',
      vaultPath
    );
    // notes.md should be loaded first despite being last in input array
    expect(result.sources[0].path).toBe('notes.md');
    expect(result.sources[1].path).toBe('summary.md');
  });
```

- [ ] **Step 4: Create `src/knowledge/source-loader.ts`**

```typescript
// src/knowledge/source-loader.ts
import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const log = logger.child('source-loader');

const PER_SOURCE_TOKEN_CAP = 10_000;
const SESSION_TOKEN_CAP = 30_000;
const CHARS_PER_TOKEN = 4; // approximation

const UNSUPPORTED_EXTS = new Set(['.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface LoadedSource {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SourceLoadResult {
  sources: LoadedSource[];
  warnings: string[];
  totalTokens: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function extractPdf(absPath: string): Promise<string> {
  // Dynamic import so servers without pdf-parse installed still start
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = fs.readFileSync(absPath);
  const data = await pdfParse(buffer, { max: 20 });
  return data.text;
}

const TYPE_PRIORITY: Record<string, number> = {
  notes: 0,        // main .md/.txt notes — highest priority
  pdf: 1,          // PDF attachments
  notebooklm: 2,   // NotebookLM summary exports
  web: 3,          // web content
  other: 4,        // personal notes, misc — lowest priority
};

export async function loadSources(
  sources: Array<{ type: string; path: string }>,
  sourceSlug: string,
  vaultPath: string
): Promise<SourceLoadResult> {
  const attachmentRoot = path.join(vaultPath, 'Reading', 'attachments', sourceSlug);
  const loaded: LoadedSource[] = [];
  const warnings: string[] = [];
  let totalTokens = 0;

  // Sort by priority (notes first, then pdf, web, other)
  const sortedSources = [...sources].sort(
    (a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)
  );

  for (const src of sortedSources) {
    if (totalTokens >= SESSION_TOKEN_CAP) {
      warnings.push(`Session cap (${SESSION_TOKEN_CAP} tokens) reached — remaining sources skipped. Consolidate key points into fewer source files.`);
      break;
    }

    const ext = path.extname(src.path).toLowerCase();

    // Unsupported types
    if (UNSUPPORTED_EXTS.has(ext)) {
      const kind = ext === '.xlsx' || ext === '.csv' ? 'spreadsheet' : 'image';
      warnings.push(`Cannot read ${kind} "${src.path}" — paste key data into a .md source file.`);
      continue;
    }

    // Resolve absolute path
    let absPath: string;
    try {
      absPath = resolveVaultPath(vaultPath, path.join('Reading', 'attachments', sourceSlug, src.path));
    } catch {
      warnings.push(`Skipping "${src.path}" — path resolves outside vault.`);
      continue;
    }

    if (!fs.existsSync(absPath)) {
      warnings.push(`Source file not found: "${src.path}" (expected at ${path.relative(vaultPath, absPath)}).`);
      continue;
    }

    try {
      let rawText: string;
      if (ext === '.pdf') {
        rawText = await extractPdf(absPath);
      } else {
        rawText = fs.readFileSync(absPath, 'utf-8');
      }

      const remaining = SESSION_TOKEN_CAP - totalTokens;
      const perSourceCap = Math.min(PER_SOURCE_TOKEN_CAP, remaining);
      const { text, truncated } = truncateToTokens(rawText, perSourceCap);

      if (truncated) {
        warnings.push(`Source "${src.path}" truncated to ${perSourceCap} tokens (original: ${estimateTokens(rawText)} tokens).`);
      }

      const tokens = estimateTokens(text);
      totalTokens += tokens;
      loaded.push({ path: src.path, content: text, truncated });
      log.info('loaded source', { path: src.path, tokens, truncated });
    } catch (err) {
      warnings.push(`Failed to read "${src.path}": ${(err as Error).message}.`);
    }
  }

  return { sources: loaded, warnings, totalTokens };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/source-loader.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 6: Create `src/agent/tools/kb-tools.ts` with `compile_reading_note`**

```typescript
// src/agent/tools/kb-tools.ts
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler } from './registry.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { loadSources } from '../../knowledge/source-loader.js';
import { logger } from '../../utils/logger.js';

const log = logger.child('kb-tools');

export function createKbTools(
  vaultPath: string,
  injectedDb?: Database.Database,
): ToolHandler[] {
  return [
    // -----------------------------------------------------------------------
    // compile_reading_note
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'compile_reading_note',
        description:
          'Load all source files attached to a reading note and return their content so you can draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions, Takeaways, Extensions). After calling this tool, draft the filled-in reading note body and call vault_write to propose it.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative vault path to the reading note (e.g. "Reading/Papers/smith-2026-il42-signalling.md")',
            },
          },
          required: ['path'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.path as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.path}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.path}` });
        }

        const raw = fs.readFileSync(notePath, 'utf-8');
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;

        const sources = fm['sources'];
        if (!Array.isArray(sources) || sources.length === 0) {
          return JSON.stringify({
            note: { frontmatter: fm, body: parsed.content },
            sources: [],
            warnings: ['No sources listed in frontmatter. Add a "sources:" array and re-run.'],
            instruction: 'No sources to load. Draft CREATE sections from any content already in the note body, or ask the user to add source files first.',
          });
        }

        // Derive sourceSlug from note filename
        const sourceSlug = path.basename(notePath, '.md');
        const result = await loadSources(
          sources as Array<{ type: string; path: string }>,
          sourceSlug,
          vaultPath
        );

        return JSON.stringify({
          note: { path: args.path, frontmatter: fm, body: parsed.content },
          sources: result.sources,
          warnings: result.warnings,
          totalTokens: result.totalTokens,
          instruction: `Draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions, Takeaways, Extensions) based on the source content above. Then call vault_write with the complete reading note including filled-in sections. Preserve all existing frontmatter fields. Do NOT mark status: complete — the user will do that after reviewing.`,
        });
      },
    },
  ];
}
```

- [ ] **Step 7: Register `createKbTools` in `src/agent/runtime.ts`**

Add import:
```typescript
import { createKbTools } from './tools/kb-tools.js';
```

Add after the `createSerialTools` loop:
```typescript
    for (const tool of createKbTools(config.vaultPath)) {
      this.registry.register(tool);
    }
```

- [ ] **Step 8: Commit**

```bash
git add src/knowledge/source-loader.ts src/agent/tools/kb-tools.ts src/agent/runtime.ts tests/unit/source-loader.test.ts package.json package-lock.json
git commit -m "feat: source loader + compile_reading_note tool (KB spec §6)"
```

---

## Task 4: Knowledge Index Builder

**Files:**
- Create: `src/knowledge/index-builder.ts`
- Test: `tests/unit/index-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/index-builder.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildKnowledgeIndex } from '../../src/knowledge/index-builder.js';

const CONCEPT_A = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk]
last_updated: 2026-04-08
compiled_from:
  - "[[smith-2026]]"
  - "[[CM003]]"
---
`;

const CONCEPT_B = `---
type: knowledge
knowledge_kind: concept
title: T-cell Suppression
aliases: [T cell inhibition]
last_updated: 2026-04-05
compiled_from:
  - "[[jones-2025]]"
---
`;

describe('rebuildKnowledgeIndex', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_A);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 't-cell-suppression.md'), CONCEPT_B);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('creates _index.md with correct frontmatter', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    expect(idx).toContain('type: index');
    expect(idx).toContain('folder: Knowledge/Concepts');
  });

  it('includes all concept notes sorted by title (case-insensitive)', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    const cdPos = idx.indexOf('cd4-cd8-interaction');
    const tPos = idx.indexOf('t-cell-suppression');
    expect(cdPos).toBeLessThan(tPos); // C before T alphabetically
  });

  it('includes alias and source count columns', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    expect(idx).toContain('cd4 cd8 crosstalk');
    expect(idx).toContain('| 2 |'); // 2 compiled_from entries
  });

  it('excludes _index.md itself from the table', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    const occurrences = (idx.match(/_index/g) || []).length;
    // _index.md appears once in frontmatter path, not as a table row
    expect(occurrences).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/index-builder.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/knowledge/index-builder.ts`**

```typescript
// src/knowledge/index-builder.ts
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { autoWrite } from '../editing/auto-writer.js';
import { utcDateString } from '../utils/date.js';

type KnowledgeKind = 'Concepts' | 'Entities' | 'Methods';

interface KnowledgeEntry {
  slug: string;
  title: string;
  aliases: string;
  lastUpdated: string;
  sourceCount: number;
}

function parseKnowledgeNote(absPath: string): KnowledgeEntry | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const slug = path.basename(absPath, '.md');
    const title = typeof fm['title'] === 'string' ? fm['title'] : slug;
    const aliasesRaw = fm['aliases'];
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.join(', ') : '';
    const lastUpdated = typeof fm['last_updated'] === 'string'
      ? fm['last_updated']
      : fm['last_updated'] instanceof Date
        ? utcDateString(fm['last_updated'] as Date)
        : '';
    const compiledFrom = fm['compiled_from'];
    const sourceCount = Array.isArray(compiledFrom) ? compiledFrom.length : 0;
    return { slug, title, aliases, lastUpdated, sourceCount };
  } catch {
    return null;
  }
}

export function rebuildKnowledgeIndex(kind: KnowledgeKind, vaultPath: string): void {
  const dirPath = path.join(vaultPath, 'Knowledge', kind);
  fs.mkdirSync(dirPath, { recursive: true });

  const entries: KnowledgeEntry[] = [];
  for (const fname of fs.readdirSync(dirPath)) {
    if (!fname.endsWith('.md') || fname === '_index.md') continue;
    const entry = parseKnowledgeNote(path.join(dirPath, fname));
    if (entry) entries.push(entry);
  }

  // Sort by title case-insensitively
  entries.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const today = utcDateString(new Date());
  const rows = entries.map(e =>
    `| [[${e.slug}]] | ${e.aliases} | ${e.lastUpdated} | ${e.sourceCount} |`
  ).join('\n');

  const content = `---
type: index
folder: Knowledge/${kind}
last_updated: ${today}
---

# ${kind}

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
${rows}
`;

  const indexPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
  autoWrite(indexPath, content, vaultPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/index-builder.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/index-builder.ts tests/unit/index-builder.test.ts
git commit -m "feat: knowledge index builder — scans subfolder, writes _index.md via autoWrite"
```

---

## Task 5: `kb_suggest` + `kb_write_mapping` Tools

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add 2 tools)
- Test: `tests/unit/kb-tools-suggest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/kb-tools-suggest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

const READING_NOTE = `---
title: IL-42 mediated suppression
authors: [Smith]
year: 2026
journal: Nature Immunology
read_date: 2026-04-06
status: complete
kb_status: pending
---

## Claims
IL-42 suppresses CD8 T-cells by 40% in Jurkat cells.

## Reasoning
Western blot assay used.
`;

const CONCEPT_INDEX = `---
type: index
folder: Knowledge/Concepts
last_updated: 2026-04-08
---

# Concepts

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
| [[cd4-cd8-interaction]] | cd4 cd8 crosstalk | 2026-04-08 | 2 |
`;

describe('kb_suggest tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), READING_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), CONCEPT_INDEX);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Entities', '_index.md'), '---\ntype: index\n---\n\n# Entities\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|');
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Methods', '_index.md'), '---\ntype: index\n---\n\n# Methods\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|');
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_suggest returns source content and all three indexes', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.indexes.Concepts).toContain('cd4-cd8-interaction');
    expect(result.instruction).toContain('PROPOSED KNOWLEDGE UPDATES');
  });

  it('kb_suggest errors on missing file', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/missing.md' }));
    expect(result.error).toBeDefined();
  });

  it('kb_suggest instruction requires vault_search as STEP 1', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.instruction).toContain('vault_search');
    expect(result.instruction).toContain('STEP 1');
  });
});

describe('kb_write_mapping tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwm-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), READING_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('writes confirmed mapping artifact alongside source note', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const artifact = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    expect(fs.existsSync(artifact)).toBe(true);
    const content = fs.readFileSync(artifact, 'utf-8');
    expect(content).toContain('status: confirmed');
    expect(content).toContain('cd4-cd8-interaction');
  });

  it('sets kb_status to mapped on source reading note', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const updated = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(updated).toContain('kb_status: mapped');
  });

  it('sets kb_status to skipped when no targets confirmed', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [],
      rejected_targets: [{ slug: 'cd4-cd8-interaction', reason: 'no new insight' }],
    });
    const updated = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(updated).toContain('kb_status: skipped');
    const artifact = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    expect(fs.existsSync(artifact)).toBe(false);
  });
});

describe('kb_write_mapping — experiment note paths (no kb_status)', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;
  const EXPERIMENT_NOTE = `---
title: CM003-qpcr results
id: CM003
---

## Results
IL-42 suppresses CD8 by 40%.
`;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwm-exp-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'),
      EXPERIMENT_NOTE
    );
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('experiment source with confirmed targets writes mapping artifact but NOT kb_status', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    // kb_status must NOT be written at all — experiment notes don't use kb_status
    expect(updated).not.toContain('kb_status:');
    // Mapping artifact should still be created
    expect(fs.existsSync(path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'))).toBe(true);
  });

  it('experiment source with zero targets does not throw and does not write kb_status', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [],
      rejected_targets: [],
    }));
    expect(result.status).toBe('skipped');
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    expect(updated).not.toContain('kb_status:');
  });

  it('applied collision returns needs_confirmation without rerun_confirmed', async () => {
    // Write a pre-existing applied mapping artifact
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      '---
status: applied
---

## Targets
'
    );
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    }));
    expect(result.status).toBe('needs_confirmation');
  });

  it('rerun_confirmed creates timestamped artifact without touching experiment frontmatter', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      '---
status: applied
---

## Targets
'
    );
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
      rerun_confirmed: true,
    }));
    expect(result.status).toBe('mapped');
    expect(result.artifactPath).toMatch(/CM003-qpcr-mapping-\d+/);
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    expect(updated).not.toContain('kb_status: mapped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-suggest.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `kb_suggest` and `kb_write_mapping` to `src/agent/tools/kb-tools.ts`**

Add these two tools to the `return [...]` array in `createKbTools`:

```typescript
    // -----------------------------------------------------------------------
    // kb_suggest
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_suggest',
        description:
          'Given a source note (reading, experiment, or series), load it along with the three Knowledge index files and propose which Knowledge notes to update or create. Present the proposal to the user and wait for their confirmation before calling kb_write_mapping.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Relative vault path to the source note',
            },
          },
          required: ['source'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.source as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.source}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.source}` });
        }

        const sourceContent = fs.readFileSync(notePath, 'utf-8');

        // Load all three indexes (missing index is not an error — just means empty KB)
        const indexes: Record<string, string> = {};
        for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
          const idxPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
          indexes[kind] = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf-8') : '(empty)';
        }

        return JSON.stringify({
          sourceContent,
          sourcePath: args.source,
          indexes,
          instruction: [
            'STEP 1 (required): Call vault_search with query: key terms from the source content, search_path: "Knowledge/". This finds semantic matches in existing knowledge notes that the index may miss.',
            'STEP 2: Based on the source content, the Knowledge indexes above, AND the vault_search results, propose a knowledge mapping.',
            'Format your proposal as:',
            '',
            'PROPOSED KNOWLEDGE UPDATES:',
            '',
            'HIGH confidence:',
            '  [[note-slug]] — reason (include if found via index or semantic search)',
            '',
            'MEDIUM confidence:',
            '  [[note-slug]] — reason',
            '',
            'NEW (not yet in knowledge base):',
            '  Suggest creating: Knowledge/Entities/slug (entity_type: protein, kind: Entities)',
            '',
            'REJECTED (no KB value):',
            '  [[note-slug]] — reason',
            '',
            'STEP 3: After the user confirms/edits this mapping, call kb_write_mapping with the confirmed and rejected targets.',
          ].join('\n'),
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_write_mapping
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_write_mapping',
        description:
          'Write the confirmed mapping artifact and update kb_status on the source note. Call this ONLY after the user has confirmed the kb_suggest proposal. If zero targets are confirmed, pass an empty confirmed_targets array — kb_status will be set to skipped and no artifact is written.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Relative vault path to the source note',
            },
            confirmed_targets: {
              type: 'array',
              description: 'Targets the user confirmed — each has slug and action (update|create)',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  action: { type: 'string', enum: ['update', 'create'] },
                  kind: { type: 'string', description: 'Concepts|Entities|Methods (required for create)' },
                },
                required: ['slug', 'action'],
              },
            },
            rejected_targets: {
              type: 'array',
              description: 'Targets the user explicitly rejected',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['slug'],
              },
            },
            rerun_confirmed: {
              type: 'boolean',
              description: 'Set to true to confirm creating a new mapping when a completed artifact already exists',
            },
          },
          required: ['source', 'confirmed_targets', 'rejected_targets'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.source as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.source}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.source}` });
        }

        const confirmedTargets = (args.confirmed_targets as Array<{ slug: string; action: string; kind?: string }>) || [];
        const rejectedTargets = (args.rejected_targets as Array<{ slug: string; reason?: string }>) || [];
        // Determine source type once — only Reading notes use kb_status
        const isReadingNote = (args.source as string).startsWith('Reading/');

        // Case B: no confirmed targets → skipped
        if (confirmedTargets.length === 0) {
          if (isReadingNote) {
            frontmatterFieldUpdate(notePath, 'kb_status', 'skipped', vaultPath);
          }
          return JSON.stringify({ status: 'skipped', message: 'No targets confirmed. No mapping artifact written.' + (isReadingNote ? ' kb_status set to skipped.' : '') });
        }

        // Build mapping artifact content
        const sourceSlug = path.basename(notePath, '.md');
        const today = new Date().toISOString().slice(0, 10);
        const targetRows = confirmedTargets.map(t =>
          `| [[${t.slug}]] | ${t.action} | pending | | |`
        ).join('\n');
        const rejectedLines = rejectedTargets.map(t =>
          `- [[${t.slug}]]${t.reason ? ` — "${t.reason}"` : ''}`
        ).join('\n');

        const artifactContent = `---
type: kb-mapping
source: [[${sourceSlug}]]
created: ${today}
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
${targetRows}

## Rejected
${rejectedLines || '(none)'}
`;

        // Determine artifact path (alongside source note)
        const dir = path.dirname(notePath);
        const artifactRel = path.relative(vaultPath, path.join(dir, `${sourceSlug}-mapping.md`)).replace(/\\/g, '/');

        // Check collision (spec §10)
        const artifactAbs = path.join(dir, `${sourceSlug}-mapping.md`);
        if (fs.existsSync(artifactAbs)) {
          const existing = fs.readFileSync(artifactAbs, 'utf-8');
          if (existing.includes('status: applied')) {
            if (!args.rerun_confirmed) {
              return JSON.stringify({
                status: 'needs_confirmation',
                message: `A completed mapping artifact already exists at "${artifactRel}". Call kb_write_mapping again with rerun_confirmed: true to create a new timestamped mapping.`,
              });
            }
            const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15);
            const newRel = path.relative(vaultPath, path.join(dir, `${sourceSlug}-mapping-${ts}.md`)).replace(/\\/g, '/');
            autoWrite(path.join(vaultPath, newRel), artifactContent, vaultPath);
            if (isReadingNote) {
              frontmatterFieldUpdate(notePath, 'kb_status', 'mapped', vaultPath);
            }
            return JSON.stringify({ status: 'mapped', artifactPath: newRel, targetCount: confirmedTargets.length, note: 'Previous applied artifact preserved; new timestamped artifact created.' });
          } else if (existing.includes('status: confirmed')) {
            return JSON.stringify({ status: 'already_in_progress', message: 'A mapping is already in progress. Run kb_apply to continue.' });
          }
          // status: draft → overwrite
        }

        autoWrite(path.join(vaultPath, artifactRel), artifactContent, vaultPath);
        if (isReadingNote) {
          frontmatterFieldUpdate(notePath, 'kb_status', 'mapped', vaultPath);
        }

        return JSON.stringify({
          status: 'mapped',
          artifactPath: artifactRel,
          targetCount: confirmedTargets.length,
          message: `Mapping artifact written. Run kb_apply with mapping: "${artifactRel}" to start applying updates.`,
        });
      },
    },
```

Also add these imports at the top of `src/agent/tools/kb-tools.ts`:
```typescript
import { autoWrite, frontmatterFieldUpdate } from '../../editing/auto-writer.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-suggest.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-tools-suggest.test.ts
git commit -m "feat: kb_suggest and kb_write_mapping tools (KB spec §8)"
```

---

## Task 6: `kb_apply` Mode 1 + `kb_apply_advance` + Review-Queue

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add 2 tools)
- Test: `tests/unit/kb-tools-apply.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/kb-tools-apply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

const SOURCE_NOTE = `---
title: IL-42 mediated suppression
kb_status: mapped
status: complete
---

## Claims
IL-42 suppresses CD8 by 40%.
`;

const CONCEPT_NOTE = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk]
last_updated: 2026-04-01
compiled_from: []
needs_review: false
---

## Current View
Some prior synthesis.

## Key Claims

## Contradictions and Caveats
`;

const MAPPING = (targetState = 'pending') => `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | ${targetState} | | |

## Rejected
(none)
`;

describe('kb_apply tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kba-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), SOURCE_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), MAPPING());
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_apply returns source content + first pending target', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
    expect(result.targetSlug).toBe('cd4-cd8-interaction');
  });

  it('kb_apply reports all_done when no pending targets remain', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), MAPPING('applied'));
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.status).toBe('all_done');
  });

  it('kb_apply finds experiment source note in Projects/ subdirectory', async () => {
    // Set up experiment note in project subfolder
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'),
      SOURCE_NOTE
    );
    // Write mapping artifact alongside experiment note (in same Projects subdirectory)
    const expMapping = `---
type: kb-mapping
source: [[CM003-qpcr]]
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
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      expMapping
    );
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({
      mapping: 'Projects/P001-CellMigration/CM003-qpcr-mapping.md',
    }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetSlug).toBe('cd4-cd8-interaction');
  });

  it('kb_apply_advance marks target applied in mapping artifact', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: false,
    });
    const updated = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), 'utf-8');
    expect(updated).toContain('| [[cd4-cd8-interaction]] | update | applied |');
  });

  it('kb_apply_advance sets kb_status=merged when all targets done', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: false,
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
    });
    const source = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(source).toContain('kb_status: merged');
  });

  it('kb_apply_advance creates Review-Queue note on deferred state', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'deferred',
      contradiction_added: false,
      review_queue_title: 'IL-42 suppression conflict',
      review_queue_reason: 'ambiguous-relationship',
      review_queue_body: 'Smith 2026 reports 40% suppression...',
    });
    const rqFiles = fs.readdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'));
    expect(rqFiles.length).toBe(1);
    expect(rqFiles[0]).toContain('cd4-cd8-interaction');
  });

  it('kb_apply_advance sets needs_review=true when contradiction_added', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: true,
    });
    const concept = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), 'utf-8');
    expect(concept).toContain('needs_review: true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `kb_apply` and `kb_apply_advance` tools to `src/agent/tools/kb-tools.ts`**

Add these two tools to the return array. Key helper functions go above `createKbTools`:

```typescript
// Helper: parse the Targets table from a mapping artifact body
interface MappingTarget {
  slug: string;
  action: string;
  state: string;
  reviewQueue: string;
  updated: string;
}

function parseMappingTargets(body: string): MappingTarget[] {
  const targets: MappingTarget[] = [];
  const tableRegex = /\|\s*\[\[([^\]]+)\]\]\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([^|]*)\|\s*([^|]*)\|/g;
  let m: RegExpExecArray | null;
  while ((m = tableRegex.exec(body)) !== null) {
    targets.push({
      slug: m[1].trim(),
      action: m[2].trim(),
      state: m[3].trim(),
      reviewQueue: m[4].trim(),
      updated: m[5].trim(),
    });
  }
  return targets;
}

function updateMappingTargetState(
  artifactContent: string,
  slug: string,
  newState: string,
  reviewQueueLink: string,
): string {
  // Replace the row for this target in the table
  const rowRegex = new RegExp(
    `(\\|\\s*\\[\\[${slug}\\]\\]\\s*\\|\\s*\\S+\\s*\\|)\\s*\\S+\\s*(\\|[^|]*\\|)[^|]*(\\|)`,
  );
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', 'T');
  return artifactContent.replace(rowRegex, `$1 ${newState} | ${reviewQueueLink} | ${timestamp} |`);
}
```

Then the two tools:

```typescript
    // -----------------------------------------------------------------------
    // kb_apply (Mode 1 — from mapping artifact)
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply',
        description:
          'Load the next pending target from a mapping artifact alongside the source note. Returns their content so you can propose an update via vault_write. After the user confirms vault_write, call kb_apply_advance to record the state change.',
        parameters: {
          type: 'object',
          properties: {
            mapping: {
              type: 'string',
              description: 'Relative vault path to the mapping artifact (*-mapping.md)',
            },
          },
          required: ['mapping'],
        },
      },
      execute: async (args) => {
        let artifactPath: string;
        try {
          artifactPath = resolveVaultPath(vaultPath, args.mapping as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.mapping}"` });
        }
        if (!fs.existsSync(artifactPath)) {
          return JSON.stringify({ error: `Mapping artifact not found: ${args.mapping}` });
        }

        const raw = fs.readFileSync(artifactPath, 'utf-8');
        const parsed = matter(raw);
        const targets = parseMappingTargets(parsed.content);

        const pending = targets.find(t => t.state === 'pending');
        if (!pending) {
          return JSON.stringify({ status: 'all_done', message: 'No pending targets remain. Call kb_apply_advance with the final update_log to complete the workflow.' });
        }

        // Resolve source from mapping frontmatter
        const sourceWikilink = String(parsed.data['source'] || '');
        const sourceSlug = sourceWikilink.replace(/^\[\[|\]\]$/g, '');

        // Find source note — first try mapping artifact directory (supports experiment notes
        // in project subdirs like Projects/P001-*/CM003-qpcr.md), then fall back to common locations
        let sourceContent = '(source note not found)';
        const artifactDir = path.dirname(artifactPath);
        const candidatePaths = [
          path.join(artifactDir, `${sourceSlug}.md`),  // same dir as mapping (covers Projects/P001-*/slug.md)
          path.join(vaultPath, 'Reading', 'Papers', `${sourceSlug}.md`),
          path.join(vaultPath, 'Reading', 'Threads', `${sourceSlug}.md`),
        ];
        for (const candidatePath of candidatePaths) {
          if (fs.existsSync(candidatePath)) {
            sourceContent = fs.readFileSync(candidatePath, 'utf-8');
            break;
          }
        }
        // If still not found, search recursively under Projects/
        if (sourceContent === '(source note not found)') {
          const projectsDir = path.join(vaultPath, 'Projects');
          if (fs.existsSync(projectsDir)) {
            function findInDir(dir: string): string | null {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) { const r = findInDir(path.join(dir, entry.name)); if (r) return r; }
                else if (entry.name === `${sourceSlug}.md`) return path.join(dir, entry.name);
              }
              return null;
            }
            const found = findInDir(projectsDir);
            if (found) sourceContent = fs.readFileSync(found, 'utf-8');
          }
        }

        // Find target knowledge note (try all three kinds)
        let targetContent = '(target note not found — will be created)';
        let targetPath = '';
        for (const kind of ['Concepts', 'Entities', 'Methods']) {
          const candidate = path.join(vaultPath, 'Knowledge', kind, `${pending.slug}.md`);
          if (fs.existsSync(candidate)) {
            targetContent = fs.readFileSync(candidate, 'utf-8');
            targetPath = `Knowledge/${kind}/${pending.slug}.md`;
            break;
          }
        }

        // Crash-recovery dedup: if source already in compiled_from, skip
        if (targetContent !== '(target note not found — will be created)') {
          const targetFm = matter(targetContent).data as Record<string, unknown>;
          const compiledFrom = Array.isArray(targetFm['compiled_from']) ? targetFm['compiled_from'] : [];
          if (compiledFrom.some((cf: unknown) => String(cf).includes(sourceSlug))) {
            return JSON.stringify({
              status: 'already_applied',
              message: `Source [[${sourceSlug}]] is already in compiled_from of [[${pending.slug}}]]. Skipping — call kb_apply_advance with state: "applied" to advance.`,
              target_slug: pending.slug,
            });
          }
        }

        return JSON.stringify({
          sourceContent,
          targetContent,
          targetSlug: pending.slug,
          targetAction: pending.action,
          targetPath: targetPath || `(determine correct Kind folder before creating)`,
          mappingPath: args.mapping,
          remainingPending: targets.filter(t => t.state === 'pending').length,
          instruction: [
            `Update [[${pending.slug}]] (action: ${pending.action}) using the source content above.`,
            'Rules:',
            '  1. Prefer updating an existing note over creating a new one.',
            '  2. Every Key Claims bullet must use format: - [supports|contradicts|extends] Text. [[source-slug]]',
            '  3. Never silently delete old claims — add contradiction tag instead.',
            '  4. Put disagreements into Contradictions and Caveats section.',
            '  5. Update compiled_from, last_updated, and aliases if new synonyms found.',
            '',
            'Call vault_write with the updated knowledge note content.',
            'After the user confirms, call kb_apply_advance.',
          ].join('\n'),
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_apply_advance
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply_advance',
        description:
          'Record the outcome of one kb_apply step: update the mapping artifact state, create a Review-Queue note if deferred, set needs_review if contradiction was added. When all targets are done, writes the Update Log, rebuilds Knowledge indexes, and updates kb_status.',
        parameters: {
          type: 'object',
          properties: {
            mapping: { type: 'string', description: 'Relative vault path to the mapping artifact' },
            target_slug: { type: 'string', description: 'Slug of the knowledge note just processed' },
            state: { type: 'string', enum: ['applied', 'skipped', 'deferred'], description: 'Outcome for this target' },
            contradiction_added: { type: 'boolean', description: 'True if a contradiction was added to the knowledge note' },
            review_queue_title: { type: 'string', description: 'Title for Review-Queue note (required when state=deferred)' },
            review_queue_reason: { type: 'string', description: 'Reason slug (ambiguous-relationship, source-conflict, etc.)' },
            review_queue_body: { type: 'string', description: 'Full body of the Review-Queue note (required when state=deferred)' },
            update_log: {
              type: 'object',
              description: 'Summary of all changes this session — provide on FINAL advance (last pending target)',
              properties: {
                updated: { type: 'array', items: { type: 'string' } },
                created: { type: 'array', items: { type: 'string' } },
                deferred: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['mapping', 'target_slug', 'state', 'contradiction_added'],
        },
      },
      execute: async (args) => {
        let artifactPath: string;
        try {
          artifactPath = resolveVaultPath(vaultPath, args.mapping as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.mapping}"` });
        }
        if (!fs.existsSync(artifactPath)) {
          return JSON.stringify({ error: `Mapping artifact not found: ${args.mapping}` });
        }

        const slug = args.target_slug as string;
        const state = args.state as string;
        const contradictionAdded = Boolean(args.contradiction_added);

        // 1. Update mapping artifact
        const raw = fs.readFileSync(artifactPath, 'utf-8');
        const parsed = matter(raw);

        let rqLink = '';

        // 2. Create Review-Queue note if deferred
        if (state === 'deferred') {
          const rqTitle = (args.review_queue_title as string) || `${slug}-review`;
          const today = new Date().toISOString().slice(0, 10);
          const rqSlug = `${today}-${slug}`;
          const rqBody = (args.review_queue_body as string) || '';
          const rqContent = `---
type: review-queue
source: ${parsed.data['source'] || ''}
target_concept: [[${slug}]]
reason: ${(args.review_queue_reason as string) || 'ambiguous-relationship'}
created: ${today}
status: pending
rq_source: ${String(parsed.data['source'] || '').replace(/^\[\[|\]\]$/g, '')}
rq_target: ${slug}
---

# ${rqTitle}

## The Issue
${rqBody}

## Source Claim

## Existing Knowledge

## Resolution
`;
          const rqPath = path.join(vaultPath, 'Knowledge', 'Review-Queue', `${rqSlug}.md`);
          autoWrite(rqPath, rqContent, vaultPath);
          rqLink = `[[${rqSlug}]]`;

          // Set needs_review on the target knowledge note
          for (const kind of ['Concepts', 'Entities', 'Methods']) {
            const candidate = path.join(vaultPath, 'Knowledge', kind, `${slug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'needs_review', true, vaultPath);
              frontmatterFieldUpdate(candidate, 'review_flagged_at', new Date().toISOString(), vaultPath);
              break;
            }
          }
        }

        // 3. Set needs_review if contradiction added
        if (contradictionAdded && state !== 'deferred') {
          for (const kind of ['Concepts', 'Entities', 'Methods']) {
            const candidate = path.join(vaultPath, 'Knowledge', kind, `${slug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'needs_review', true, vaultPath);
              frontmatterFieldUpdate(candidate, 'review_flagged_at', new Date().toISOString(), vaultPath);
              break;
            }
          }
        }

        // 4. Update mapping artifact target row
        let newBody = updateMappingTargetState(parsed.content, slug, state, rqLink);
        const allTargets = parseMappingTargets(newBody);
        const anyPending = allTargets.some(t => t.state === 'pending');
        const newStatus = anyPending ? 'confirmed' : 'applied';

        // Rebuild mapping with updated status
        const updatedArtifact = matter.stringify(newBody, { ...parsed.data, status: newStatus });
        autoWrite(artifactPath, updatedArtifact, vaultPath);

        // 5. If all done — write Update Log, rebuild indexes, update kb_status
        if (!anyPending) {
          const sourceSlug = String(parsed.data['source'] || '').replace(/^\[\[|\]\]$/g, '');
          const today = new Date().toISOString().slice(0, 10);
          const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 15);

          // Write Update Log
          const updateLog = (args.update_log as { updated: string[]; created: string[]; deferred: string[] } | undefined);
          if (updateLog) {
            const logContent = `---
type: update-log
source: ${parsed.data['source'] || ''}
date: ${today}
---

# KB Update Log — ${sourceSlug}

## Updated
${updateLog.updated.map(u => `- ${u}`).join('\n') || '(none)'}

## Created
${updateLog.created.map(c => `- ${c}`).join('\n') || '(none)'}

## Deferred to Review
${updateLog.deferred.map(d => `- ${d}`).join('\n') || '(none)'}
`;
            const logPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs', `${today}T${ts.slice(9)}-${sourceSlug}.md`);
            autoWrite(logPath, logContent, vaultPath);
          }

          // Rebuild indexes for affected kinds
          const { rebuildKnowledgeIndex } = await import('../../knowledge/index-builder.js');
          for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
            const kindDir = path.join(vaultPath, 'Knowledge', kind);
            if (fs.existsSync(kindDir)) rebuildKnowledgeIndex(kind, vaultPath);
          }

          // Update kb_status on source reading note (if it is a reading note)
          const anyDeferred = allTargets.some(t => t.state === 'deferred');
          const newKbStatus = anyDeferred ? 'merged_with_review' : 'merged';
          for (const prefix of ['Reading/Papers', 'Reading/Threads']) {
            const candidate = path.join(vaultPath, prefix, `${sourceSlug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'kb_status', newKbStatus, vaultPath);
              break;
            }
          }
        }

        return JSON.stringify({
          status: state,
          target: slug,
          mappingStatus: newStatus,
          remainingPending: anyPending ? allTargets.filter(t => t.state === 'pending').length : 0,
          message: anyPending
            ? `Target [[${slug}]] marked ${state}. Call kb_apply again to process the next pending target.`
            : `All targets processed. Mapping status: ${newStatus}. kb_status updated.`,
        });
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-tools-apply.test.ts
git commit -m "feat: kb_apply + kb_apply_advance tools with Review-Queue and crash recovery (KB spec §8)"
```

---

## Task 7: `kb_apply_direct` (Mode 2) + `kb_resolve_review`

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add 2 tools)
- Extend: `tests/unit/kb-tools-apply.test.ts`

- [ ] **Step 1: Add tests**

Append to `tests/unit/kb-tools-apply.test.ts`:

```typescript
describe('kb_apply_direct tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbad-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), SOURCE_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_apply_direct returns source and target content', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    const result = JSON.parse(await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
    }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
  });

  it('kb_apply_direct does NOT change kb_status on reading notes', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], notes: '' },
    });
    // kb_status must remain 'mapped' (not changed to merged)
    const source = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(source).toContain('kb_status: mapped');
  });

  it('kb_apply_direct writes an Update Log', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], notes: 'added claim' },
    });
    const logs = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'));
    expect(logs.length).toBe(1);
  });
});

describe('kb_resolve_review tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbrr-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      SOURCE_NOTE.replace('kb_status: mapped', 'kb_status: merged_with_review')
    );
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'),
      CONCEPT_NOTE.replace('needs_review: false', 'needs_review: true')
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', '2026-04-08-cd4-cd8-interaction.md'),
      `---
type: review-queue
source: [[smith-2026-il42]]
target_concept: [[cd4-cd8-interaction]]
reason: ambiguous-relationship
created: 2026-04-08
status: pending
rq_source: smith-2026-il42
rq_target: cd4-cd8-interaction
---

# IL-42 conflict
`
    );
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_resolve_review returns the Review-Queue note and target for LLM', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    const result = JSON.parse(await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
    }));
    expect(result.reviewContent).toContain('IL-42 conflict');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
  });

  it('kb_resolve_review returns error if resolution given without confirmed_knowledge_write', async () => {
    // Safety guard: resolution must not be applied before user confirms the vault_write diff
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    const result = JSON.parse(await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
      // confirmed_knowledge_write intentionally omitted — should return error
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain('confirmed_knowledge_write');
  });

  it('kb_resolve_review marks item resolved and clears needs_review when last item', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
    });
    const rq = fs.readFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', '2026-04-08-cd4-cd8-interaction.md'),
      'utf-8'
    );
    expect(rq).toContain('status: resolved');

    const concept = fs.readFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'),
      'utf-8'
    );
    expect(concept).toContain('needs_review: false');
  });

  it('kb_resolve_review updates mapping artifact row from deferred to applied', async () => {
    // Set up a mapping artifact with a deferred row for this target
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | deferred | [[2026-04-08-cd4-cd8-interaction]] | |

## Rejected
(none)
`
    );
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
    });
    const mapping = fs.readFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      'utf-8'
    );
    expect(mapping).toContain('| [[cd4-cd8-interaction]] | update | applied |');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: FAIL — new test blocks fail.

- [ ] **Step 3: Add `kb_apply_direct` and `kb_resolve_review` to `src/agent/tools/kb-tools.ts`**

```typescript
    // -----------------------------------------------------------------------
    // kb_apply_direct (Mode 2)
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply_direct',
        description:
          'Load a single source note and a specific target Knowledge note for a direct (ad-hoc) update. Does NOT change kb_status on reading notes — use the full kb_suggest → kb_apply pipeline for systematic processing. After calling this tool, propose the update via vault_write, then optionally call this tool again with update_log to record the Update Log.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Relative vault path to source note (reading or experiment)' },
            target: { type: 'string', description: 'Relative vault path to target Knowledge note' },
            update_log: {
              type: 'object',
              description: 'If provided, writes an Update Log. Omit to just load content.',
              properties: {
                updated: { type: 'array', items: { type: 'string' } },
                created: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
              },
            },
          },
          required: ['source', 'target'],
        },
      },
      execute: async (args) => {
        let sourcePath: string, targetPath: string;
        try {
          sourcePath = resolveVaultPath(vaultPath, args.source as string);
          targetPath = resolveVaultPath(vaultPath, args.target as string);
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message });
        }
        if (!fs.existsSync(sourcePath)) return JSON.stringify({ error: `Source not found: ${args.source}` });
        if (!fs.existsSync(targetPath)) return JSON.stringify({ error: `Target not found: ${args.target}` });

        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
        const targetContent = fs.readFileSync(targetPath, 'utf-8');

        // Write Update Log if provided
        const updateLog = args.update_log as { updated: string[]; created: string[]; notes: string } | undefined;
        let logPath = '';
        if (updateLog) {
          const sourceSlug = path.basename(sourcePath, '.md');
          const today = new Date().toISOString().slice(0, 10);
          const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
          const logContent = `---
type: update-log
source: [[${sourceSlug}]]
date: ${today}
mode: direct
---

# KB Update Log (direct) — ${sourceSlug}

## Updated
${(updateLog.updated || []).map(u => `- ${u}`).join('\n') || '(none)'}

## Created
${(updateLog.created || []).map(c => `- ${c}`).join('\n') || '(none)'}

## Notes
${updateLog.notes || ''}
`;
          logPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs', `${today}T${ts.slice(9)}-${sourceSlug}.md`);
          autoWrite(logPath, logContent, vaultPath);
        }

        return JSON.stringify({
          sourceContent,
          targetContent,
          logWritten: logPath ? path.relative(vaultPath, logPath) : null,
          instruction: [
            `Update the target knowledge note using the source content.`,
            'Rules (same as kb_apply):',
            '  1. Every Key Claims bullet: - [supports|contradicts|extends] Text. [[source-slug]]',
            '  2. Never delete old claims — add contradiction tag instead.',
            '  3. Update compiled_from, last_updated, aliases.',
            '  4. kb_status on the source note is NOT changed by direct mode.',
            '',
            'Call vault_write with the updated target content.',
          ].join('\n'),
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_resolve_review
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_resolve_review',
        description:
          'Load a Review-Queue item and its target Knowledge note. If resolution and resolution_summary are provided, marks the item resolved, clears needs_review on the target (if no other pending items target it), and updates kb_status on the source note if this was the last unresolved item.',
        parameters: {
          type: 'object',
          properties: {
            review_item: { type: 'string', description: 'Relative vault path to the Review-Queue note' },
            resolution: { type: 'string', enum: ['resolved', 'dismissed'], description: 'Outcome — provide after the user has decided' },
            resolution_summary: { type: 'string', description: 'One-line summary of the resolution decision' },
            confirmed_knowledge_write: {
              type: 'boolean',
              description: 'Set to true ONLY after the user has confirmed the vault_write diff for the Knowledge note update. Required when passing resolution.',
            },
          },
          required: ['review_item'],
        },
      },
      execute: async (args) => {
        let rqPath: string;
        try {
          rqPath = resolveVaultPath(vaultPath, args.review_item as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.review_item}"` });
        }
        if (!fs.existsSync(rqPath)) {
          return JSON.stringify({ error: `Review-Queue note not found: ${args.review_item}` });
        }

        const raw = fs.readFileSync(rqPath, 'utf-8');
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;

        const rqTarget = String(fm['rq_target'] || '').replace(/^\[\[|\]\]$/g, '');
        const rqSource = String(fm['rq_source'] || '').replace(/^\[\[|\]\]$/g, '');

        // Find target knowledge note
        let targetContent = '(not found)';
        let targetAbsPath = '';
        for (const kind of ['Concepts', 'Entities', 'Methods']) {
          const candidate = path.join(vaultPath, 'Knowledge', kind, `${rqTarget}.md`);
          if (fs.existsSync(candidate)) {
            targetContent = fs.readFileSync(candidate, 'utf-8');
            targetAbsPath = candidate;
            break;
          }
        }

        const resolution = args.resolution as string | undefined;

        const confirmedWrite = Boolean(args.confirmed_knowledge_write);
        if (resolution && !confirmedWrite) {
          return JSON.stringify({
            error: 'Safety guard: confirmed_knowledge_write must be true before resolving a Review-Queue item. Call vault_write to update the Knowledge note first, then call kb_resolve_review again after the user confirms the diff.',
          });
        }

        if (!resolution) {
          // First call — just load content for LLM review
          return JSON.stringify({
            reviewContent: raw,
            targetContent,
            rqTarget,
            rqSource,
            instruction: [
              `Review the conflict above and decide how to resolve it.`,
              `IMPORTANT: the workflow is:`,
              `  1. Call vault_write to update [[${rqTarget}]] in the Knowledge folder (required first)`,
              `  2. Wait for user confirmation of the diff`,
              `  3. THEN call kb_resolve_review again with resolution: "resolved" and resolution_summary`,
              `Calling kb_resolve_review with a resolution before vault_write confirmation violates the spec.`,
            ].join('\n'),
          });
        }

        // Mark the Review-Queue note resolved/dismissed
        const today = new Date().toISOString().slice(0, 10);
        const summary = (args.resolution_summary as string) || '';
        const newBody = parsed.content.replace(
          /## Resolution\n[\s\S]*/,
          `## Resolution\n${summary}\n`
        );
        const updatedRq = matter.stringify(newBody, { ...fm, status: resolution });
        autoWrite(rqPath, updatedRq, vaultPath);

        // Check if this is the last pending Review-Queue item for this source
        const rqDir = path.join(vaultPath, 'Knowledge', 'Review-Queue');
        const pendingForSource = fs.readdirSync(rqDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            try { return matter(fs.readFileSync(path.join(rqDir, f), 'utf-8')).data as Record<string, unknown>; }
            catch { return null; }
          })
          .filter(d => d && d['rq_source'] === rqSource && d['status'] === 'pending')
          .length;

        // If no more pending items for this target — clear needs_review
        const pendingForTarget = fs.readdirSync(rqDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            try { return matter(fs.readFileSync(path.join(rqDir, f), 'utf-8')).data as Record<string, unknown>; }
            catch { return null; }
          })
          .filter(d => d && d['rq_target'] === rqTarget && d['status'] === 'pending')
          .length;

        if (pendingForTarget === 0 && targetAbsPath) {
          frontmatterFieldUpdate(targetAbsPath, 'needs_review', false, vaultPath);
          frontmatterFieldUpdate(targetAbsPath, 'review_flagged_at', null, vaultPath);
        }

        // If last pending item for this source — advance kb_status merged_with_review → merged
        if (pendingForSource === 0) {
          for (const prefix of ['Reading/Papers', 'Reading/Threads']) {
            const candidate = path.join(vaultPath, prefix, `${rqSource}.md`);
            if (fs.existsSync(candidate)) {
              const srcFm = matter(fs.readFileSync(candidate, 'utf-8')).data as Record<string, unknown>;
              if (srcFm['kb_status'] === 'merged_with_review') {
                frontmatterFieldUpdate(candidate, 'kb_status', 'merged', vaultPath);
              }
              break;
            }
          }
        }

        // Update mapping artifact: change deferred row → applied for this rq_source/rq_target pair
        // Search Reading/ and Projects/ (recursive) to support both reading and experiment note mappings
        const rqSourceSlug = rqSource;
        function findMappingArtifact(rootDir: string): string | null {
          if (!fs.existsSync(rootDir)) return null;
          for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (entry.isDirectory()) { const r = findMappingArtifact(path.join(rootDir, entry.name)); if (r) return r; }
            else if (entry.name === `${rqSourceSlug}-mapping.md`) return path.join(rootDir, entry.name);
          }
          return null;
        }
        const mappingAbs = findMappingArtifact(path.join(vaultPath, 'Reading'))
          || findMappingArtifact(path.join(vaultPath, 'Projects'));
        if (mappingAbs) {
          const mappingRaw = fs.readFileSync(mappingAbs, 'utf-8');
          const mappingParsed = matter(mappingRaw);
          const updatedBody = updateMappingTargetState(mappingParsed.content, rqTarget, 'applied', `[[${path.basename(rqPath, '.md')}]]`);
          const allTargets = parseMappingTargets(updatedBody);
          const anyPending = allTargets.some(t => t.state === 'pending');
          const newMappingStatus = anyPending ? 'confirmed' : 'applied';
          const updatedMapping = matter.stringify(updatedBody, { ...mappingParsed.data, status: newMappingStatus });
          autoWrite(mappingAbs, updatedMapping, vaultPath);
        }

        return JSON.stringify({
          status: resolution,
          rqItem: args.review_item,
          needsReviewCleared: pendingForTarget === 0,
          kbStatusAdvanced: pendingForSource === 0,
          message: `Review-Queue item ${resolution}. Mapping artifact row updated (deferred → applied). ${pendingForTarget === 0 ? `needs_review cleared on [[${rqTarget}]].` : ''} ${pendingForSource === 0 ? `kb_status advanced to merged.` : ''}`,
        });
      },
    },
```

- [ ] **Step 4: Run all apply tests**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-apply.test.ts
```
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/kb-tools.ts tests/unit/kb-tools-apply.test.ts
git commit -m "feat: kb_apply_direct (Mode 2) + kb_resolve_review tools (KB spec §8, §11)"
```

---

## Task 8: `kb_lint` Tool + Periodic Reminder

**Files:**
- Modify: `src/agent/tools/kb-tools.ts` (add 1 tool)
- Modify: `src/agent/context.ts` (add lint reminder)
- Test: `tests/unit/kb-tools-lint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/kb-tools-lint.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

function setup(): { vaultPath: string; tools: ReturnType<typeof createKbTools> } {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbl-test-'));
  for (const d of [
    'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
    'Knowledge/Review-Queue', 'Knowledge/_Ops/Lint-Reports',
    'Reading/Papers',
  ]) {
    fs.mkdirSync(path.join(vaultPath, d), { recursive: true });
  }
  const tools = createKbTools(vaultPath);
  return { vaultPath, tools };
}

describe('kb_lint — check 1: no compiled_from', () => {
  it('flags a knowledge note with no compiled_from', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'orphan.md'), `---
type: knowledge
knowledge_kind: concept
title: Orphan Concept
compiled_from: []
---
# Orphan
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('orphan') && i.includes('compiled_from'))).toBe(true);
  });
});

describe('kb_lint — check 2: unsourced claim bullet', () => {
  it('flags a claim bullet without a source link', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'concept.md'), `---
type: knowledge
knowledge_kind: concept
title: Test Concept
compiled_from: ["[[smith-2026]]"]
---
# Test
## Key Claims
- [supports] IL-42 suppresses CD8. <!-- no wikilink -->
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('concept') && i.includes('claim'))).toBe(true);
  });
});

describe('kb_lint — check 4: unfinished kb work', () => {
  it('flags reading note status:complete + kb_status:pending', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'pending-paper.md'), `---
title: Pending Paper
status: complete
kb_status: pending
---
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needsAttention.some((i: string) => i.includes('pending-paper'))).toBe(true);
  });
});

describe('kb_lint — writes report to Lint-Reports/', () => {
  it('creates a dated lint report file', async () => {
    const { vaultPath, tools } = setup();
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    await tool.execute({});
    const reports = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'));
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-lint.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `kb_lint` to `src/agent/tools/kb-tools.ts`**

```typescript
    // -----------------------------------------------------------------------
    // kb_lint
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_lint',
        description:
          'Run structural health checks on the knowledge base (8 checks). Writes a dated report to Knowledge/_Ops/Lint-Reports/ and returns a summary.',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'Optional: specific folder or note to lint (relative vault path). Default: entire vault.',
            },
          },
        },
      },
      execute: async (args) => {
        const urgent: string[] = [];
        const needsAttention: string[] = [];
        const niceToImprove: string[] = [];

        const targetArg = args.target as string | undefined;
        const lintRoot = targetArg
          ? (() => { try { return resolveVaultPath(vaultPath, targetArg); } catch { return vaultPath; } })()
          : vaultPath;

        // Collect all knowledge notes
        function collectMdFiles(dir: string): string[] {
          if (!fs.existsSync(dir)) return [];
          const results: string[] = [];
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...collectMdFiles(full));
            else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
          }
          return results;
        }

        const allFiles = collectMdFiles(lintRoot);

        // Build wikilink existence map using WHOLE VAULT regardless of lint scope
        // (prevents false positives when linting a subfolder that links to other vault notes)
        const allVaultFiles = lintRoot === vaultPath ? allFiles : collectMdFiles(vaultPath);
        const existingSlugs = new Set(allVaultFiles.map(f => path.basename(f, '.md')));

        for (const absPath of allFiles) {
          const rel = path.relative(vaultPath, absPath).replace(/\\/g, '/');
          let raw: string;
          try { raw = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }
          const parsed = matter(raw);
          const fm = parsed.data as Record<string, unknown>;
          const body = parsed.content;
          const slug = path.basename(absPath, '.md');
          const isKnowledge = rel.match(/^Knowledge\/(Concepts|Entities|Methods)\/(?!_index)/);
          const isReading = rel.startsWith('Reading/Papers/') || rel.startsWith('Reading/Threads/');
          const isReviewQueue = rel.startsWith('Knowledge/Review-Queue/');

          // Check 1: knowledge note with no compiled_from
          if (isKnowledge) {
            const cf = fm['compiled_from'];
            if (!cf || (Array.isArray(cf) && cf.length === 0)) {
              urgent.push(`[[${slug}]] has no compiled_from — no source attribution`);
            }
          }

          // Check 2: claim bullet without source link
          if (isKnowledge) {
            const claimBulletRegex = /^- \[(?:supports|contradicts|extends)\]/gm;
            const claimBullets = body.match(claimBulletRegex) || [];
            const sourcedBulletRegex = /^- \[(?:supports|contradicts|extends)\].*\[\[/m;
            for (const line of body.split('\n')) {
              if (/^- \[(?:supports|contradicts|extends)\]/.test(line) && !line.includes('[[')) {
                urgent.push(`[[${slug}]] has a claim bullet without a source link: "${line.slice(0, 80)}"`);
              }
            }
          }

          // Check 3: broken wikilinks
          const wikilinkRegex = /\[\[([^\]|#]+)(?:[|\]#][^\]]*)??\]\]/g;
          let wm: RegExpExecArray | null;
          while ((wm = wikilinkRegex.exec(body)) !== null) {
            const linked = wm[1].trim();
            if (!existingSlugs.has(linked)) {
              urgent.push(`[[${slug}]] has broken link to [[${linked}]]`);
            }
          }

          // Check 4: reading note complete but not merged
          if (isReading && fm['status'] === 'complete') {
            const kbStat = fm['kb_status'] as string | undefined;
            if (!kbStat || ['pending', 'mapped', 'merged_with_review'].includes(kbStat)) {
              needsAttention.push(`[[${slug}]] is complete but kb_status is "${kbStat ?? 'unset'}" — unfinished KB work`);
            }
          }

          // Check 5: stale needs_review flag (>14 days)
          if (isKnowledge && fm['needs_review']) {
            const flaggedAt = fm['review_flagged_at'] as string | undefined;
            if (flaggedAt) {
              const age = (Date.now() - new Date(flaggedAt).getTime()) / 86400000;
              if (age > 14) {
                needsAttention.push(`[[${slug}]] has needs_review=true flagged ${Math.floor(age)} days ago — stale review flag`);
              }
            }
          }

          // Check 6: Review-Queue item pending >14 days
          if (isReviewQueue && fm['status'] === 'pending') {
            const created = fm['created'] as string | undefined;
            if (created) {
              const age = (Date.now() - new Date(created).getTime()) / 86400000;
              if (age > 14) {
                needsAttention.push(`[[${slug}]] has been in Review-Queue for ${Math.floor(age)} days`);
              }
            }
          }
        }

        // Check 7: duplicate/overlapping knowledge notes (title similarity — simple check)
        const knowledgeSlugs = allFiles
          .filter(f => /Knowledge\/(Concepts|Entities|Methods)/.test(f) && !f.endsWith('_index.md'))
          .map(f => path.basename(f, '.md'));
        for (let i = 0; i < knowledgeSlugs.length; i++) {
          for (let j = i + 1; j < knowledgeSlugs.length; j++) {
            const a = knowledgeSlugs[i].replace(/-/g, ' ');
            const b = knowledgeSlugs[j].replace(/-/g, ' ');
            if (a.includes(b) || b.includes(a)) {
              niceToImprove.push(`[[${knowledgeSlugs[i]}]] may overlap with [[${knowledgeSlugs[j]}]] — similar names`);
            }
          }
        }

        // Check 8 (spec §8 check 8): knowledge note not updated despite newer related reading notes
        // For each knowledge note, check if any compiled_from source has a read_date newer than last_updated.
        for (const absPath of allFiles) {
          const rel = path.relative(vaultPath, absPath).replace(/\\/g, '/');
          if (!rel.match(/^Knowledge\/(Concepts|Entities|Methods)\/(?!_index)/)) continue;
          try {
            const fm = matter(fs.readFileSync(absPath, 'utf-8')).data as Record<string, unknown>;
            const slug = path.basename(absPath, '.md');
            const lastUpdated = fm['last_updated'] as string | undefined;
            if (!lastUpdated) continue;
            const compiledFrom = fm['compiled_from'];
            if (!Array.isArray(compiledFrom) || compiledFrom.length === 0) continue;
            const lastUpdatedDate = new Date(lastUpdated);

            for (const sourceRef of compiledFrom as unknown[]) {
              const sourceSlug = String(sourceRef).replace(/^\[\[|\]\]$/g, '');
              for (const prefix of ['Reading/Papers', 'Reading/Threads']) {
                const sourceAbs = path.join(vaultPath, prefix, `${sourceSlug}.md`);
                if (!fs.existsSync(sourceAbs)) continue;
                try {
                  const srcFm = matter(fs.readFileSync(sourceAbs, 'utf-8')).data as Record<string, unknown>;
                  const readDate = srcFm['read_date'] as string | undefined;
                  if (readDate && new Date(readDate) > lastUpdatedDate) {
                    niceToImprove.push(`[[${slug}]] last updated ${lastUpdated} but compiled source [[${sourceSlug}]] was read ${readDate} — may need updating`);
                    break; // one flag per knowledge note is enough
                  }
                } catch { /* skip */ }
                break; // found source in this prefix
              }
            }
          } catch { /* skip */ }
        }

        // Write report
        const today = new Date().toISOString().slice(0, 10);
        const reportContent = `---
type: lint-report
date: ${today}
---

# KB Lint Report — ${today}

## Urgent
${urgent.length ? urgent.map(i => `- ${i}`).join('\n') : '(none)'}

## Needs Attention
${needsAttention.length ? needsAttention.map(i => `- ${i}`).join('\n') : '(none)'}

## Nice to Improve
${niceToImprove.length ? niceToImprove.map(i => `- ${i}`).join('\n') : '(none)'}
`;
        const reportPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports', `${today}.md`);
        autoWrite(reportPath, reportContent, vaultPath);

        return JSON.stringify({
          urgent,
          needsAttention,
          niceToImprove,
          reportPath: `Knowledge/_Ops/Lint-Reports/${today}.md`,
          summary: `Lint complete: ${urgent.length} urgent, ${needsAttention.length} needs attention, ${niceToImprove.length} nice to improve.`,
        });
      },
    },
```

- [ ] **Step 4: Add lint reminder to `src/agent/context.ts`**

In `assembleSystemPrompt`, add after the diary section (after line 62):

```typescript
  // Layer 5b: KB lint reminder + unfinished KB work count
  const lintReportsDir = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports');
  if (fs.existsSync(lintReportsDir)) {
    const reports = fs.readdirSync(lintReportsDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();

    // Count reading notes with unfinished KB work (scan both Papers and Threads)
    let unfinishedKbCount = 0;
    for (const readingSubdir of ['Reading/Papers', 'Reading/Threads']) {
      const readingDir = path.join(vaultPath, readingSubdir);
      if (!fs.existsSync(readingDir)) continue;
      for (const f of fs.readdirSync(readingDir).filter(n => n.endsWith('.md'))) {
        try {
          const fm = matter(fs.readFileSync(path.join(readingDir, f), 'utf-8')).data as Record<string, unknown>;
          if (fm['status'] === 'complete' && ['pending', 'mapped', 'merged_with_review'].includes(fm['kb_status'] as string)) {
            unfinishedKbCount++;
          }
        } catch { /* skip */ }
      }
    }

    if (reports.length === 0) {
      const kbMsg = unfinishedKbCount > 0 ? ` ${unfinishedKbCount} reading note(s) have unfinished KB work.` : '';
      sections.push(`**KB reminder:** KB lint has never run. Run kb_lint to check knowledge base health.${kbMsg}`);
    } else {
      const lastReport = reports[reports.length - 1];
      const lastDate = new Date(lastReport.replace('.md', ''));
      const daysAgo = (Date.now() - lastDate.getTime()) / 86400000;
      const kbMsg = unfinishedKbCount > 0 ? ` ${unfinishedKbCount} reading note(s) have unfinished KB work.` : '';
      if (daysAgo > 14) {
        sections.push(`**KB reminder:** KB lint hasn't run in ${Math.floor(daysAgo)} days. Run kb_lint to check for issues.${kbMsg}`);
      } else if (unfinishedKbCount > 0) {
        sections.push(`**KB reminder:** ${unfinishedKbCount} reading note(s) have unfinished KB work (kb_status: pending/mapped/merged_with_review).`);
      }
    }
  }
```

- [ ] **Step 5: Run all lint tests**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/kb-tools-lint.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/kb-tools.ts src/agent/context.ts tests/unit/kb-tools-lint.test.ts
git commit -m "feat: kb_lint tool (8 checks, dated report) + periodic lint reminder in system prompt"
```

---

## Task 9: Setup — Initial `_index.md` Files + Wire Up

**Files:**
- Modify: `src/cli/setup.ts`
- Modify: `src/agent/runtime.ts` (already has createKbTools — verify it's there from Task 3)

- [ ] **Step 1: Update `src/cli/setup.ts` to create initial `_index.md` files**

After the vault directory creation loop (around line 134), add:

```typescript
  // Create initial Knowledge _index.md files (empty tables)
  const today = new Date().toISOString().slice(0, 10);
  for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
    const indexPath = path.join(resolvedVaultPath, 'Knowledge', kind, '_index.md');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, `---
type: index
folder: Knowledge/${kind}
last_updated: ${today}
---

# ${kind}

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
`);
    }
  }
  console.log('\u2713 Knowledge index files created');

  // Ensure all KB operational folders exist
  for (const opsDir of [
    'Knowledge/Review-Queue',
    'Knowledge/_Ops/Update-Logs',
    'Knowledge/_Ops/Lint-Reports',
    'Reading/Papers',
    'Reading/Threads',
    'Reading/attachments',
  ]) {
    const fullPath = path.join(resolvedVaultPath, opsDir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }
  console.log('\u2713 Knowledge operational folders created');
```

- [ ] **Step 2: Verify `createKbTools` is registered in `src/agent/runtime.ts`**

```bash
cd /Users/le211/crickNote && grep -n 'createKbTools' src/agent/runtime.ts
```
Expected: two lines — the import and the registration loop. If missing from Task 3, add them now.

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

```bash
cd /Users/le211/crickNote && npx vitest run
```
Expected: all tests pass (or any pre-existing failures are unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/cli/setup.ts
git commit -m "feat: setup creates initial Knowledge/_index.md files"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| §2 Knowledge folder structure | Task 9 (setup) |
| §3 Knowledge note templates | Covered by vault_write (existing) — LLM uses templates |
| §4 Structured claim format | Task 8 (kb_lint check 2 enforces format) |
| §5 Knowledge index files | Task 4 (index builder) |
| §6 Reading note ingestion / compile step | Task 3 (source loader + compile_reading_note) |
| §7 `kb_status` state machine | Tasks 5, 6, 7 (write_mapping, advance, resolve_review) |
| §8 `kb_suggest` | Task 5 |
| §8 `kb_apply` Mode 1 | Task 6 |
| §8 `kb_apply` Mode 2 (direct) | Task 7 |
| §8 `kb_apply_advance` crash-recovery dedup | Task 6 (kb_apply tool checks compiled_from) |
| §8 `kb_lint` 8 checks | Task 8 (all 8 checks implemented; check 8 compares compiled_from source read dates vs last_updated) |
| §8 Agent-managed file ownership | Tasks 5-8 use autoWrite / frontmatterFieldUpdate |
| §9 Three entry points | All three supported by the 8 tools |
| §10 Mapping artifact + collision handling | Task 5 (kb_write_mapping) |
| §11 Review-Queue | Task 6 (creation in kb_apply_advance), Task 7 (kb_resolve_review) |
| §12 Update Log | Tasks 6, 7 |
| §13 Lint Report | Task 8 |
| §14 Strong rules for KB tools | Encoded in instruction strings returned by each tool |
| §15 DB changes | Task 1 |
| §16 Setup changes | Task 9 |

**Gap identified:** None — all 8 lint checks are now implemented. Check 8 compares compiled_from source read_date values against the knowledge note last_updated field using file-based parsing.

**Placeholder scan:** No TBD/TODO patterns in code blocks. All tool instruction strings are complete. `update_log` parameter in `kb_apply_advance` is optional — the user can call without it on non-final steps; this is intentional and documented.

**Type consistency:**
- `parseMappingTargets` returns `MappingTarget[]` — used in both `kb_apply` and `kb_apply_advance`
- `updateMappingTargetState` takes `slug: string` — all callers pass `args.target_slug as string`
- `rebuildKnowledgeIndex` takes `'Concepts' | 'Entities' | 'Methods'` — all callers use `as const`
- `frontmatterFieldUpdate` is imported from `../../editing/auto-writer.js` — already has the correct signature `(filePath, field, value, vaultPath)`

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-12-knowledge-base-workflow.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans

**Which approach?**
