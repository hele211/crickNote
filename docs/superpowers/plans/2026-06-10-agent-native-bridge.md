# Agent-Native Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CrickNote's 35 existing lab tools callable by Claude Code and Codex through a single generic CLI dispatcher (`cricknote tool <name> '<json>'`), with the Obsidian vault as the only user surface and the internal chat runtime retired.

**Architecture:** A thin CLI layer reuses the existing `ToolRegistry` and tools unchanged. Write-path tools return `pending_edit` JSON; a shared `applyPendingEdit()` (extracted from the runtime's confirm path) performs atomic write + audit log + changelog + reservation finalize + incremental index. The agent's own bash-permission prompt replaces the old in-app confirmation step. Search drops query-time embedding so each short-lived CLI process stays fast.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node.js, better-sqlite3, commander, vitest. Existing dependencies only — no new ones; `node-cron` removed.

**Reference spec:** `docs/superpowers/specs/2026-06-10-agent-native-bridge-design.md`

---

## File Structure

**Phase 1 — new files:**
- `src/ingestion/ignore.ts` — pure `shouldIgnoreIngestionPath()` (extracted from worker so the CLI doesn't import chokidar)
- `src/ingestion/index-file.ts` — `indexFileSync()` + `listMarkdownFiles()`: single-file and full BM25/metadata indexing with no embeddings
- `src/agent/build-registry.ts` — `buildToolRegistry()`: the tool-registration block, shared by runtime and CLI
- `src/cli/apply-edit.ts` — `applyPendingEdit()` + payload/result types
- `src/cli/tool-dispatch.ts` — `dispatchTool()` and `listToolCatalog()`
- `tests/unit/ignore.test.ts`, `tests/unit/index-file.test.ts`, `tests/unit/build-registry.test.ts`, `tests/unit/apply-edit.test.ts`, `tests/unit/tool-dispatch.test.ts`
- `tests/integration/cli-bridge.test.ts` — full create-project → experiment → append cycle through the dispatcher

**Phase 1 — modified files:**
- `src/agent/tools/search.ts` — remove query-time semantic rank + `embedText` import
- `src/agent/tools/tasks.ts` — `task_list` `days` param (default 90); `task_add` chrono-normalized deadline
- `src/cli/reindex.ts` — rewrite as standalone full index
- `src/cli.ts` — register `tool` and `tools` commands
- `src/agent/runtime.ts` — call `buildToolRegistry()` instead of inline registration (DRY)
- `package.json` — remove `node-cron`

**Phase 2 — new files (skills + vault docs):**
- `skills/cricknote-record-experiment/SKILL.md`, `skills/cricknote-reading-intake/SKILL.md`, `skills/cricknote-kb-update/SKILL.md`, `skills/cricknote-daily-review/SKILL.md`, `skills/cricknote-reminders/SKILL.md`
- `templates/agent-docs/CLAUDE.md`, `templates/agent-docs/AGENTS.md` (installed into the vault by setup)
- `src/cli/install-agent-assets.ts` — copies skills + agent docs into the vault
- modify `src/cli/setup.ts` — call the installer

**Phase 3 — deletions** (see Phase 3 task list).

---

## PHASE 1 — The Bridge

### Task 1: Extract `shouldIgnoreIngestionPath` into a dependency-free module

**Why:** The CLI dispatcher and the new indexer need this regex helper, but it currently lives in `worker.ts`, which statically imports `watcher.ts` (chokidar) and `embedder.ts`. Importing it from there would pull heavy deps into every CLI invocation.

**Files:**
- Create: `src/ingestion/ignore.ts`
- Test: `tests/unit/ignore.test.ts`
- Modify: `src/ingestion/worker.ts` (re-export for back-compat)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ignore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldIgnoreIngestionPath } from '../../src/ingestion/ignore.js';

describe('shouldIgnoreIngestionPath', () => {
  it('ignores attachments', () => {
    expect(shouldIgnoreIngestionPath('Reading/attachments/smith-2026/paper.md')).toBe(true);
  });
  it('ignores mapping artifacts', () => {
    expect(shouldIgnoreIngestionPath('Reading/foo/foo-mapping.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001/P001-mapping-20260101T120000.md')).toBe(true);
  });
  it('ignores Knowledge ops and index files and changelogs', () => {
    expect(shouldIgnoreIngestionPath('Knowledge/_Ops/state.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_index.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001/_changelog.md')).toBe(true);
  });
  it('does not ignore a normal experiment note', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-il42/IL001-dose.md')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ignore.test.ts`
Expected: FAIL — cannot find module `../../src/ingestion/ignore.js`

- [ ] **Step 3: Create the module**

Create `src/ingestion/ignore.ts` (move the exact regex from `worker.ts`):

```typescript
/**
 * Paths that must never be indexed: binary/attachment trees, transient
 * mapping artifacts, Knowledge housekeeping/index files, and folder changelogs.
 */
export function shouldIgnoreIngestionPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    /(^|\/)attachments\//.test(normalized) ||
    /^(Reading\/[^/]+|Projects\/[^/]+)\/[^/]+-mapping(?:-\d{8}T\d{6})?\.md$/.test(normalized) ||
    normalized.startsWith('Knowledge/_Ops/') ||
    /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(normalized) ||
    /(^|\/)_changelog\.md$/.test(normalized)
  );
}
```

- [ ] **Step 4: Re-export from worker.ts to preserve existing imports**

In `src/ingestion/worker.ts`, delete the local `export function shouldIgnoreIngestionPath(...)` definition (lines 285–294) and add this import near the top (after the existing imports, around line 19):

```typescript
import { shouldIgnoreIngestionPath } from './ignore.js';
```

Then at the bottom of the file add:

```typescript
export { shouldIgnoreIngestionPath };
```

- [ ] **Step 5: Run tests to verify both new and existing pass**

Run: `npx vitest run tests/unit/ignore.test.ts tests/unit/worker.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/ignore.ts src/ingestion/worker.ts tests/unit/ignore.test.ts
git commit -m "refactor(ingestion): extract shouldIgnoreIngestionPath to dependency-free module"
```

---

### Task 2: Single-file indexer with no embeddings

**Why:** The dispatcher must keep BM25/metadata fresh after each write, and the rewritten `reindex` needs a full scan — both without loading the embedding model. `indexNote()` already inserts BM25 rows for every chunk and only inserts an embedding when one is present, so passing `embeddings: []` yields a complete BM25/metadata index with no model.

**Files:**
- Create: `src/ingestion/index-file.ts`
- Test: `tests/unit/index-file.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/index-file.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexFileSync, listMarkdownFiles } from '../../src/ingestion/index-file.js';

describe('indexFileSync', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'idxf-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('indexes a note into note_metadata and bm25 with no embeddings', () => {
    const rel = 'Projects/P001-il42/IL001-dose.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel),
      '---\nnote_kind: experiment\nid: IL001\nproject_id: P001\n---\n\nWestern blot dose response pSTAT3.');

    const outcome = indexFileSync(rel, vault, db);
    expect(outcome).toBe('indexed');

    const meta = db.prepare('SELECT note_id FROM note_metadata WHERE path = ?').get(rel) as { note_id: string } | undefined;
    expect(meta?.note_id).toBe('IL001');

    const bm25 = db.prepare(
      `SELECT COUNT(*) AS n FROM bm25_index bi JOIN note_chunks nc ON nc.id = CAST(bi.chunk_id AS INTEGER) WHERE nc.path = ?`
    ).get(rel) as { n: number };
    expect(bm25.n).toBeGreaterThan(0);

    const emb = db.prepare(
      `SELECT COUNT(*) AS n FROM chunk_embeddings ce JOIN note_chunks nc ON nc.id = ce.chunk_id WHERE nc.path = ?`
    ).get(rel) as { n: number };
    expect(emb.n).toBe(0);
  });

  it('skips ignored paths', () => {
    const rel = 'Reading/attachments/smith/paper.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), 'x');
    expect(indexFileSync(rel, vault, db)).toBe('skipped');
  });

  it('returns unchanged on second call with same content', () => {
    const rel = 'Projects/P001-il42/IL002-x.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\nid: IL002\n---\n\nbody');
    expect(indexFileSync(rel, vault, db)).toBe('indexed');
    expect(indexFileSync(rel, vault, db)).toBe('unchanged');
  });

  it('removes metadata when the file is gone', () => {
    const rel = 'Projects/P001-il42/IL003-x.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\nid: IL003\n---\n\nbody');
    indexFileSync(rel, vault, db);
    fs.rmSync(path.join(vault, rel));
    expect(indexFileSync(rel, vault, db)).toBe('gone');
    const meta = db.prepare('SELECT path FROM note_metadata WHERE path = ?').get(rel);
    expect(meta).toBeUndefined();
  });

  it('listMarkdownFiles returns relative md paths and skips dot dirs', () => {
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'a.md'), 'a');
    fs.writeFileSync(path.join(vault, '.obsidian', 'b.md'), 'b');
    fs.writeFileSync(path.join(vault, 'Projects', 'c.txt'), 'c');
    const files = listMarkdownFiles(vault).sort();
    expect(files).toEqual(['Projects/a.md']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/index-file.test.ts`
Expected: FAIL — cannot find module `../../src/ingestion/index-file.js`

- [ ] **Step 3: Create the module**

Create `src/ingestion/index-file.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseNote } from './parser.js';
import { chunkText } from './chunker.js';
import { indexNote, deleteNote, needsReindex } from './indexer.js';
import { shouldIgnoreIngestionPath } from './ignore.js';
import { resolveVaultPath } from '../utils/paths.js';

export type IndexOutcome = 'indexed' | 'skipped' | 'unchanged' | 'gone';

/**
 * Index a single note by its vault-relative path, writing BM25 + metadata only
 * (no embeddings — empty embeddings array means indexNote skips the embedding
 * insert while still populating chunks and BM25). Safe to call in a short-lived
 * CLI process: no model load, no watcher.
 */
export function indexFileSync(relativePath: string, vaultRoot: string, db?: Database.Database): IndexOutcome {
  if (shouldIgnoreIngestionPath(relativePath)) return 'skipped';

  let absolutePath: string;
  try {
    absolutePath = resolveVaultPath(vaultRoot, relativePath);
  } catch {
    return 'skipped';
  }

  let content: string;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return 'skipped';
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    deleteNote(relativePath, db);
    return 'gone';
  }

  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  if (!needsReindex(relativePath, contentHash, db)) return 'unchanged';

  const parsed = parseNote(relativePath, content);
  const chunks = chunkText(parsed.body);
  indexNote({ note: parsed, contentHash, mtime: stat.mtimeMs, chunks, embeddings: [] }, db);
  return 'indexed';
}

/**
 * Recursively list markdown files under vaultRoot, returning vault-relative
 * POSIX paths. Skips dot-directories (e.g. .obsidian, .git) and non-.md files.
 */
export function listMarkdownFiles(vaultRoot: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relPath);
      }
    }
  };
  walk(vaultRoot, '');
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/index-file.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index-file.ts tests/unit/index-file.test.ts
git commit -m "feat(ingestion): add embedding-free single-file indexer and markdown walker"
```

---

### Task 3: Shared tool-registry factory

**Why:** Tool registration currently lives inline in the `AgentRuntime` constructor. The CLI needs the same registry without constructing an LLM provider (which requires an API key). Extract one factory used by both.

**Files:**
- Create: `src/agent/build-registry.ts`
- Test: `tests/unit/build-registry.test.ts`
- Modify: `src/agent/runtime.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/build-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { buildToolRegistry } from '../../src/agent/build-registry.js';

describe('buildToolRegistry', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('registers the full tool surface', () => {
    const reg = buildToolRegistry(vault, undefined, db);
    const names = reg.getDefinitions().map(d => d.name);
    for (const expected of [
      'vault_read', 'vault_search', 'create_project', 'create_experiment',
      'task_add', 'task_list', 'compile_reading_note', 'kb_suggest', 'zotero_fetch_item',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('has no duplicate tool names', () => {
    const reg = buildToolRegistry(vault, undefined, db);
    const names = reg.getDefinitions().map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/build-registry.test.ts`
Expected: FAIL — cannot find module `../../src/agent/build-registry.js`

- [ ] **Step 3: Create the factory**

Create `src/agent/build-registry.ts`:

```typescript
import type Database from 'better-sqlite3';
import { ToolRegistry } from './tools/registry.js';
import type { ConflictDetector } from '../editing/conflict-detector.js';
import { createVaultTools } from './tools/vault.js';
import { createSearchTools } from './tools/search.js';
import { createTaskTools } from './tools/tasks.js';
import { createTemplateTools } from './tools/templates.js';
import { createReadingIntakeTools } from './tools/reading-intake.js';
import { createContextTools } from './tools/context.js';
import { createSerialTools } from './tools/serial-tools.js';
import { createKbTools } from './tools/kb-tools.js';
import { createZoteroTools } from './tools/zotero-tools.js';

/**
 * Build the complete CrickNote tool registry. Shared by the Obsidian runtime
 * and the CLI dispatcher so both expose an identical tool surface.
 *
 * @param vaultPath   Vault root (unresolved config path is fine).
 * @param conflictDetector Optional; passed to tools that record read snapshots.
 *                    The CLI passes a throwaway detector (no snapshots → no
 *                    spurious conflicts in a fresh process).
 * @param db          Optional injected database (tests / explicit handle).
 */
export function buildToolRegistry(
  vaultPath: string,
  conflictDetector?: ConflictDetector,
  db?: Database.Database,
): ToolRegistry {
  const registry = new ToolRegistry();
  const add = (handlers: { definition: { name: string } }[]) => {
    for (const h of handlers) registry.register(h as never);
  };

  add(createVaultTools(vaultPath, conflictDetector, db));
  add(createSearchTools(vaultPath, db));
  add(createTaskTools(vaultPath, conflictDetector));
  add(createTemplateTools(vaultPath, conflictDetector));
  add(createReadingIntakeTools(vaultPath, conflictDetector));
  add(createContextTools(vaultPath));
  add(createSerialTools(vaultPath, db));
  add(createKbTools(vaultPath));
  add(createZoteroTools(vaultPath));

  return registry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/build-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor the runtime to use the factory**

In `src/agent/runtime.ts`, replace the inline registration block (the nine `for (const tool of createXxx(...))` loops, lines 136–163) with:

```typescript
    // Register tools — shared with the CLI dispatcher via buildToolRegistry.
    this.registry = buildToolRegistry(config.vaultPath, conflictDetector);
```

Add the import near the other tool imports (top of file):

```typescript
import { buildToolRegistry } from './build-registry.js';
```

Then delete the now-unused individual `createXxx` imports from `runtime.ts` (lines 8–16: `createVaultTools` … `createZoteroTools`) — leave `ToolRegistry`/`ToolContext` and everything else. Run `npx tsc --noEmit` to confirm no unused-import or type errors.

- [ ] **Step 6: Run tests to verify the runtime still works**

Run: `npx tsc --noEmit && npx vitest run tests/unit/runtime-routing.test.ts tests/unit/build-registry.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/build-registry.ts src/agent/runtime.ts tests/unit/build-registry.test.ts
git commit -m "refactor(agent): extract buildToolRegistry, shared by runtime and CLI"
```

---

### Task 4: `applyPendingEdit` — the shared write/apply path

**Why:** Write tools return a `pending_edit` describing the file to write; the actual write + audit log + changelog + reservation bookkeeping + incremental index must happen exactly as the runtime did it. This is the single most important correctness constraint in the project. It reuses `SafeWriter.proposeEdit` + `confirmEdit('apply')` (in a fresh CLI process there is no read snapshot, so conflict detection passes), then layers reservation + changelog + index around it.

**Files:**
- Create: `src/cli/apply-edit.ts`
- Test: `tests/unit/apply-edit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/apply-edit.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { SafeWriter } from '../../src/editing/safe-writer.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { applyPendingEdit } from '../../src/cli/apply-edit.js';

describe('applyPendingEdit', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db); // audit log + indexer use getDatabase() internally
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-')));
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  const ctx = () => ({ vaultRoot: vault, sessionId: 's1', triggerQuery: 'test', safeWriter: new SafeWriter(), db });

  it('writes a new file and records an audit row', () => {
    const abs = path.join(vault, 'Projects/P001-il42/IL001-dose.md');
    const res = applyPendingEdit(
      { path: abs, newContent: '---\nnote_kind: experiment\nid: IL001\n---\n\nbody', operation: 'create_experiment' },
      ctx(),
    );
    expect(res.applied).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toContain('IL001');
    const audit = db.prepare('SELECT COUNT(*) AS n FROM edit_audit_log WHERE file_path = ?').get(abs) as { n: number };
    expect(audit.n).toBe(1);
  });

  it('incrementally indexes the written file', () => {
    const abs = path.join(vault, 'Projects/P001-il42/IL002-x.md');
    applyPendingEdit({ path: abs, newContent: '---\nnote_kind: experiment\nid: IL002\n---\n\nbody', operation: 'create_experiment' }, ctx());
    const meta = db.prepare('SELECT note_id FROM note_metadata WHERE path = ?').get('Projects/P001-il42/IL002-x.md') as { note_id: string } | undefined;
    expect(meta?.note_id).toBe('IL002');
  });

  it('rejects a path outside the vault without writing', () => {
    const res = applyPendingEdit({ path: '/etc/evil.md', newContent: 'x', operation: 'create' }, ctx());
    expect(res.applied).toBe(false);
    expect(res.error).toMatch(/escapes vault/i);
    expect(fs.existsSync('/etc/evil.md')).toBe(false);
  });

  it('finalizes a prefix reservation on success', () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)')
      .run('IL', 'P001', Date.now() + 600000);
    const abs = path.join(vault, 'Projects/P001-il42/_index.md');
    const res = applyPendingEdit(
      { path: abs, newContent: '---\nnote_kind: project\nid: P001\n---\n\nbody', operation: 'create_project', reservation: { project_id: 'P001', prefix: 'IL' } },
      ctx(),
    );
    expect(res.applied).toBe(true);
    const row = db.prepare('SELECT edit_id FROM prefix_reservations WHERE project_id = ?').get('P001') as { edit_id: string | null };
    expect(row.edit_id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/apply-edit.test.ts`
Expected: FAIL — cannot find module `../../src/cli/apply-edit.js`

- [ ] **Step 3: Create the module**

Create `src/cli/apply-edit.ts`:

```typescript
import path from 'node:path';
import type Database from 'better-sqlite3';
import { SafeWriter } from '../editing/safe-writer.js';
import { appendFolderChangelog } from '../editing/changelog.js';
import { indexFileSync } from '../ingestion/index-file.js';

export interface PendingEditPayload {
  /** Absolute path emitted by the tool (already vault-resolved). */
  path: string;
  newContent: string;
  operation?: string;
  reservation?: { project_id: string; prefix?: string };
  meta?: Record<string, unknown>;
  warnings?: string[];
}

export interface AppliedEdit {
  path: string;
  operation: string;
  applied: boolean;
  error?: string;
  warnings?: string[];
}

export interface ApplyContext {
  vaultRoot: string;
  sessionId: string;
  triggerQuery: string;
  safeWriter: SafeWriter;
  db: Database.Database;
}

function withinVault(absPath: string, vaultRoot: string): boolean {
  const normalized = path.normalize(absPath);
  return path.isAbsolute(normalized) &&
    (normalized === vaultRoot || normalized.startsWith(vaultRoot + path.sep));
}

/**
 * Apply one pending_edit: atomic write + audit log (via SafeWriter),
 * then reservation finalize, folder changelog, and incremental index —
 * mirroring exactly what AgentRuntime.confirmEdit did for the Obsidian UI.
 */
export function applyPendingEdit(edit: PendingEditPayload, ctx: ApplyContext): AppliedEdit {
  const { vaultRoot, sessionId, triggerQuery, safeWriter, db } = ctx;
  const operation = edit.operation ?? 'edit';
  const absPath = path.normalize(edit.path);

  if (!withinVault(absPath, vaultRoot)) {
    return { path: edit.path, operation, applied: false, error: 'Path escapes vault boundary' };
  }

  const meta: Record<string, unknown> = { operation, path: edit.path };
  if (edit.reservation) Object.assign(meta, edit.reservation);
  if (edit.meta) Object.assign(meta, edit.meta);

  const proposal = safeWriter.proposeEdit(absPath, edit.newContent, triggerQuery, sessionId, meta);
  const result = safeWriter.confirmEdit(proposal.editId, 'apply');

  if (!result.success) {
    if (edit.reservation) {
      db.prepare('DELETE FROM prefix_reservations WHERE project_id = ?').run(edit.reservation.project_id);
    }
    return { path: edit.path, operation, applied: false, error: result.error ?? 'write failed', warnings: edit.warnings };
  }

  if (edit.reservation) {
    db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?')
      .run(proposal.editId, edit.reservation.project_id);
  }

  const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');
  try {
    appendFolderChangelog({ vaultPath: vaultRoot, targetPath: relPath, operation, description: `${relPath} written` });
  } catch {
    // changelog failure must not fail the apply
  }
  try {
    indexFileSync(relPath, vaultRoot, db);
  } catch {
    // index failure must not fail the apply; a later reindex will recover
  }

  return { path: edit.path, operation, applied: true, warnings: edit.warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/apply-edit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/apply-edit.ts tests/unit/apply-edit.test.ts
git commit -m "feat(cli): add applyPendingEdit — shared atomic write/audit/index/reservation path"
```

---

### Task 5: The tool dispatcher

**Why:** This is the bridge entry point. It executes any registered tool from JSON args, and — unless `--no-apply` is passed — applies any `pending_edit`/`pending_edits` the tool returns. Batch edits get a pre-flight boundary check on all members before any write (mirrors the runtime's all-or-nothing intent for the common failure mode).

**Files:**
- Create: `src/cli/tool-dispatch.ts`
- Test: `tests/unit/tool-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tool-dispatch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { runTool, listToolCatalog } from '../../src/cli/tool-dispatch.js';

describe('runTool', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disp-')));
    fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('returns a structured error for an unknown tool', async () => {
    const out = await runTool('does_not_exist', '{}', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown tool/i);
  });

  it('returns a structured error for malformed JSON', async () => {
    const out = await runTool('vault_read', '{not json', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/json/i);
  });

  it('executes a read tool and returns its JSON result', async () => {
    const rel = 'Projects/note.md';
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\n---\n\nhello');
    const out = await runTool('vault_read', JSON.stringify({ path: rel }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.result)).toContain('hello');
  });

  it('applies a pending_edit from task_add and writes the diary', async () => {
    const out = await runTool('task_add', JSON.stringify({ description: 'order ECL substrate' }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(out.applied?.[0].applied).toBe(true);
    const daily = fs.readdirSync(path.join(vault, 'Memory', 'Daily'));
    expect(daily.length).toBe(1);
    expect(fs.readFileSync(path.join(vault, 'Memory', 'Daily', daily[0]), 'utf-8')).toContain('order ECL substrate');
  });

  it('with apply:false returns the pending edit without writing', async () => {
    const out = await runTool('task_add', JSON.stringify({ description: 'do not write me' }), { vaultPath: vault, sessionId: 's', apply: false, db });
    expect(out.ok).toBe(true);
    expect(out.applied).toBeUndefined();
    expect(fs.existsSync(path.join(vault, 'Memory', 'Daily'))).toBe(true);
    expect(fs.readdirSync(path.join(vault, 'Memory', 'Daily')).length).toBe(0);
  });

  it('listToolCatalog returns name + description for every tool', () => {
    const catalog = listToolCatalog(vault, db);
    expect(catalog.length).toBeGreaterThan(20);
    for (const entry of catalog) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tool-dispatch.test.ts`
Expected: FAIL — cannot find module `../../src/cli/tool-dispatch.js`

- [ ] **Step 3: Create the dispatcher**

Create `src/cli/tool-dispatch.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildToolRegistry } from '../agent/build-registry.js';
import { ConflictDetector } from '../editing/conflict-detector.js';
import { SafeWriter } from '../editing/safe-writer.js';
import { getDatabase } from '../storage/database.js';
import { applyPendingEdit, type PendingEditPayload, type AppliedEdit } from './apply-edit.js';
import type { ToolContext } from '../agent/tools/registry.js';

export interface RunToolOptions {
  vaultPath: string;
  sessionId: string;
  apply: boolean;
  db?: Database.Database;
}

export interface RunToolOutput {
  ok: boolean;
  result?: unknown;       // raw tool result (parsed JSON, or string)
  applied?: AppliedEdit[]; // present when pending edits were applied
  error?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  parameters: unknown;
}

function resolveVaultRoot(vaultPath: string): string {
  try {
    return fs.realpathSync(vaultPath);
  } catch {
    return path.resolve(vaultPath);
  }
}

/** Execute one tool by name with JSON args; apply any pending edits it returns. */
export async function runTool(name: string, argsJson: string, opts: RunToolOptions): Promise<RunToolOutput> {
  const db = opts.db ?? getDatabase();
  const registry = buildToolRegistry(opts.vaultPath, new ConflictDetector(), db);

  if (!registry.has(name)) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    return { ok: false, error: `Invalid JSON arguments: ${(err as Error).message}` };
  }

  const context: ToolContext = { sessionId: opts.sessionId, vaultPath: opts.vaultPath };
  const raw = await registry.execute({ id: crypto.randomUUID(), name, arguments: args }, context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, result: raw };
  }

  const obj = parsed as Record<string, unknown>;

  // Tool returned an explicit error object
  if (obj && typeof obj === 'object' && typeof obj.error === 'string') {
    return { ok: false, error: obj.error, result: parsed };
  }

  if (!opts.apply) {
    return { ok: true, result: parsed };
  }

  const edits: PendingEditPayload[] = [];
  if (obj?.type === 'pending_edit') {
    edits.push(obj as unknown as PendingEditPayload);
  } else if (obj?.type === 'pending_edits' && Array.isArray(obj.edits)) {
    for (const e of obj.edits as PendingEditPayload[]) edits.push(e);
  }

  if (edits.length === 0) {
    return { ok: true, result: parsed };
  }

  const vaultRoot = resolveVaultRoot(opts.vaultPath);

  // Pre-flight: reject the whole batch if any member escapes the vault,
  // before writing any file.
  for (const e of edits) {
    const abs = path.normalize(e.path);
    if (!path.isAbsolute(abs) || (abs !== vaultRoot && !abs.startsWith(vaultRoot + path.sep))) {
      return { ok: false, error: `Path escapes vault boundary: ${e.path}` };
    }
  }

  const safeWriter = new SafeWriter();
  const applied: AppliedEdit[] = [];
  for (const e of edits) {
    applied.push(applyPendingEdit(e, { vaultRoot, sessionId: opts.sessionId, triggerQuery: `cli:${name}`, safeWriter, db }));
  }

  const allApplied = applied.every(a => a.applied);
  return { ok: allApplied, applied, result: parsed, error: allApplied ? undefined : 'one or more edits failed' };
}

/** Return the full tool catalog (name, description, JSON-schema parameters). */
export function listToolCatalog(vaultPath: string, db?: Database.Database): ToolCatalogEntry[] {
  const registry = buildToolRegistry(vaultPath, new ConflictDetector(), db ?? getDatabase());
  return registry.getDefinitions().map(d => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/tool-dispatch.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/tool-dispatch.ts tests/unit/tool-dispatch.test.ts
git commit -m "feat(cli): add tool dispatcher with pending-edit apply and batch preflight"
```

---

### Task 6: Wire `tool` and `tools` commands into the CLI

**Why:** Expose the dispatcher as `cricknote tool <name> '<json>'` and `cricknote tools` (catalog). These are what the agent invokes via bash.

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/integration/cli-bridge.test.ts` (added in Task 7; this task is manual-verified)

- [ ] **Step 1: Add the commands**

In `src/cli.ts`, add these imports at the top (after the existing imports):

```typescript
import crypto from 'node:crypto';
import { loadConfig } from './config/config.js';
import { runTool, listToolCatalog } from './cli/tool-dispatch.js';
```

Then add these two commands before `program.parse();`:

```typescript
program
  .command('tool <name> [argsJson]')
  .description('Execute a CrickNote tool with JSON arguments (for AI agents)')
  .option('--session <id>', 'Session id for audit attribution')
  .option('--no-apply', 'Return pending edits without writing them')
  .action(async (name: string, argsJson: string | undefined, options: { session?: string; apply: boolean }) => {
    const config = loadConfig();
    const out = await runTool(name, argsJson ?? '{}', {
      vaultPath: config.vaultPath,
      sessionId: options.session ?? `cli-${crypto.randomUUID().slice(0, 8)}`,
      apply: options.apply,
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(out.ok ? 0 : 1);
  });

program
  .command('tools')
  .description('List the CrickNote tool catalog (name, description, parameters)')
  .action(() => {
    const config = loadConfig();
    process.stdout.write(JSON.stringify(listToolCatalog(config.vaultPath), null, 2) + '\n');
  });
```

- [ ] **Step 2: Build and smoke-test against the real vault**

Run:
```bash
npx tsc && node dist/cli.js tools | head -20
```
Expected: a JSON array of tool catalog entries (name/description/parameters).

- [ ] **Step 3: Smoke-test a read tool**

Run:
```bash
node dist/cli.js tool vault_search '{"query":"experiment"}'
```
Expected: JSON `{ "ok": true, "result": { ... } }`. (Empty results are fine on a fresh vault.)

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): expose 'tool' and 'tools' commands for agent access"
```

---

### Task 7: Integration test — full lab cycle through the CLI

**Why:** Prove the highest-value workflow end-to-end at the dispatcher boundary: create project → register counters → create experiment → append observation → search finds it.

**Files:**
- Create: `tests/integration/cli-bridge.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/cli-bridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { runTool } from '../../src/cli/tool-dispatch.js';

describe('CLI bridge — full lab cycle', () => {
  let db: Database.Database;
  let vault: string;
  const opts = () => ({ vaultPath: vault, sessionId: 's1', apply: true, db });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-int-')));
    // No template setup needed: when <vault>/Agent/templates/ is absent,
    // loadTemplate falls back to a built-in template (with a warning), so
    // create_project / create_experiment still render and apply.
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('creates a project, experiment, appends an observation, and finds it', async () => {
    // 1. Create project with explicit prefix
    const proj = await runTool('create_project', JSON.stringify({ title: 'IL42 signalling', prefix: 'IL' }), opts());
    expect(proj.ok).toBe(true);
    expect(proj.applied?.some(a => a.operation === 'create_project' && a.applied)).toBe(true);

    // 2. Register counters (finalize project)
    const reg = await runTool('register_project_counters', JSON.stringify({ project_id: 'P001', prefix: 'IL' }), opts());
    expect(reg.ok).toBe(true);

    // 3. Create experiment
    const exp = await runTool('create_experiment', JSON.stringify({
      project_id: 'P001', title: 'dose response', experiment_type: 'western-blot',
    }), opts());
    expect(exp.ok).toBe(true);
    const expEdit = exp.applied?.find(a => a.applied);
    expect(expEdit).toBeDefined();

    // The experiment file exists on disk
    const expRel = expEdit!.path;
    expect(fs.existsSync(expRel)).toBe(true);

    // 4. Append an observation
    const relInVault = path.relative(vault, expRel);
    const appendRes = await runTool('vault_append', JSON.stringify({
      path: relInVault, content: '\n- 14:32 transfer complete, membrane clean',
    }), opts());
    expect(appendRes.ok).toBe(true);
    expect(fs.readFileSync(expRel, 'utf-8')).toContain('transfer complete');

    // 5. Search finds the experiment by serial
    const search = await runTool('vault_search', JSON.stringify({ query: 'IL001' }), opts());
    expect(search.ok).toBe(true);
    expect(JSON.stringify(search.result)).toContain('IL001');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration/cli-bridge.test.ts`
Expected: PASS. Templates resolve via the built-in fallback in `template-loader.ts` (vault templates live at `<vault>/Agent/templates/`; when absent a bundled default is used), so no template fixtures are required. If `create_experiment` instead fails because `register_project_counters` did not persist (e.g. db not threaded), confirm the same `db` is passed through `opts()` to every `runTool` call.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/cli-bridge.test.ts
git commit -m "test(cli): integration cover full project→experiment→append→search cycle"
```

---

### Task 8: Rewrite `reindex` as a standalone full index

**Why:** Today `cricknote reindex` only clears tables and tells the user to restart the (retired) service. The agent needs a real one-shot reindex at session start to catch hand-edits made directly in Obsidian.

**Files:**
- Modify: `src/cli/reindex.ts`
- Test: `tests/unit/reindex.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reindex.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { reindexVault } from '../../src/cli/reindex.js';

describe('reindexVault', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reidx-')));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('indexes all markdown files and reports counts', () => {
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'IL001.md'), '---\nnote_kind: experiment\nid: IL001\n---\n\nbody one');
    fs.writeFileSync(path.join(vault, 'Projects', 'IL002.md'), '---\nnote_kind: experiment\nid: IL002\n---\n\nbody two');

    const summary = reindexVault(vault, db);
    expect(summary.indexed).toBe(2);

    const n = db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('removes stale rows for files no longer present', () => {
    db.prepare('INSERT INTO note_metadata (path, folder, note_type, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Projects/ghost.md', 'Projects', 'experiment', 'h', 1, 1);
    const summary = reindexVault(vault, db);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT path FROM note_metadata WHERE path = ?').get('Projects/ghost.md')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/reindex.test.ts`
Expected: FAIL — `reindexVault` is not exported.

- [ ] **Step 3: Rewrite reindex.ts**

Replace the entire contents of `src/cli/reindex.ts` with:

```typescript
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/config.js';
import { getDatabase } from '../storage/database.js';
import { listMarkdownFiles, indexFileSync } from '../ingestion/index-file.js';
import { deleteStaleNotes } from '../ingestion/indexer.js';

export interface ReindexSummary {
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
}

/**
 * Full standalone reindex: BM25 + metadata for every markdown file in the
 * vault, no embeddings, no watcher. Removes DB rows for files that no longer
 * exist. Pure function over an injected db for testability.
 */
export function reindexVault(vaultRoot: string, db: Database.Database): ReindexSummary {
  const files = listMarkdownFiles(vaultRoot);
  const summary: ReindexSummary = { indexed: 0, unchanged: 0, skipped: 0, removed: 0 };
  const indexablePaths: string[] = [];

  for (const rel of files) {
    const outcome = indexFileSync(rel, vaultRoot, db);
    if (outcome === 'indexed') { summary.indexed++; indexablePaths.push(rel); }
    else if (outcome === 'unchanged') { summary.unchanged++; indexablePaths.push(rel); }
    else if (outcome === 'skipped') { summary.skipped++; }
  }

  const before = (db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number }).n;
  deleteStaleNotes(indexablePaths, db);
  const after = (db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number }).n;
  summary.removed = Math.max(0, before - after);

  return summary;
}

/** CLI entry point. */
export async function reindex(): Promise<void> {
  const config = loadConfig();
  const db = getDatabase();
  const vaultRoot = config.vaultPath;
  console.log(`Reindexing vault at ${vaultRoot} ...`);
  const summary = reindexVault(vaultRoot, db);
  console.log(`Done. indexed=${summary.indexed} unchanged=${summary.unchanged} skipped=${summary.skipped} removed=${summary.removed}`);
}
```

Note: `deleteStaleNotes` accepts vault-relative paths because `note_metadata.path` is stored relative; `indexFileSync` indexes by the same relative path, so the valid-set matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/reindex.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/reindex.ts tests/unit/reindex.test.ts
git commit -m "feat(cli): rewrite reindex as standalone embedding-free full index"
```

---

### Task 9: Remove query-time semantic ranking from `vault_search`

**Why:** Through the CLI, every search is a fresh process. The semantic re-rank step lazy-loads the 80MB embedding model, adding seconds per search. Structured filters + BM25 already cover the lab use cases. Remove the embed/rank step (it is already wrapped in a fall-through try/catch, so removing it just drops the re-ordering, never the results).

**Files:**
- Modify: `src/agent/tools/search.ts`
- Test: `tests/unit/search-no-embed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/search-no-embed.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import * as embedder from '../../src/ingestion/embedder.js';
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_search does not load the embedding model', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sne-'));
    // 6+ candidates would have triggered semantic ranking in the old code.
    for (let i = 1; i <= 8; i++) {
      db.prepare('INSERT INTO note_metadata (path, folder, note_type, experiment_type, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`Projects/wb${i}.md`, 'Projects', 'experiment', 'western-blot', `h${i}`, 1, 1);
    }
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('never calls embedText', async () => {
    const spy = vi.spyOn(embedder, 'embedText');
    const tools = createSearchTools(vault, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const res = JSON.parse(await tool.execute({ query: 'western blot' }));
    expect(res.results.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/search-no-embed.test.ts`
Expected: FAIL — `embedText` is called (semantic ranking still present).

- [ ] **Step 3: Remove the semantic-rank block and its imports**

In `src/agent/tools/search.ts`:

1. Delete the import lines for the semantic stack (lines 4–6):

```typescript
import { semanticRank } from '../../retrieval/semantic-ranker.js';
import { assembleContext } from '../../retrieval/context-assembler.js';
import { embedText } from '../../ingestion/embedder.js';
```

Keep `parseQuery`, `buildNoteQuery`, `parsedQueryToFilterInput`.

2. Delete the entire "Step 3: Semantic ranking" block (lines 135–171, the `if (candidates.length > 5) { ... }`).

3. Replace the "Step 4: Assemble context" tail (lines 175–183) with a context-free return:

```typescript
        return JSON.stringify({
          results: candidates.slice(0, 10),
          totalCandidates: candidates.length,
        });
```

This drops `assembleContext` (the agent reads notes itself via `vault_read`). The duplicate `candidates = filterSearchCandidates(candidates);` line just above the old Step 4 can also be removed since filtering already happened.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/unit/search-no-embed.test.ts tests/unit/vault-serial-search.test.ts`
Expected: PASS. (If `search-housekeeping.test.ts` asserts on the `context` field, update it to the new shape — run the full suite in Task 12 to catch this.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/search.ts tests/unit/search-no-embed.test.ts
git commit -m "perf(search): drop query-time semantic rank so CLI search needs no model"
```

---

### Task 10: `task_list` configurable window + `task_add` chrono deadlines

**Why:** `task_list` scans only 14 days of diary notes, so older unfinished tasks silently disappear. And `task_add` stores deadlines as raw text, which the reminders skill cannot reliably turn into a date. Widen the window (default 90 days) and normalize deadlines with `chrono-node` (already a dependency).

**Files:**
- Modify: `src/agent/tools/tasks.ts`
- Test: `tests/unit/tasks-window-deadline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tasks-window-deadline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskTools } from '../../src/agent/tools/tasks.js';

describe('task tools — window and deadline', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'task-'));
    fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

  function writeDiary(date: string, body: string) {
    fs.writeFileSync(path.join(vault, 'Memory', 'Daily', `${date}.md`), `---\ndate: ${date}\ntype: daily-diary\n---\n\n## Tasks\n${body}\n`);
  }

  it('task_list finds a task 30 days old (beyond the old 14-day window)', async () => {
    const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeDiary(d, '- [ ] old but open task');
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_list')!;
    const res = JSON.parse(await tool.execute({ status: 'pending' }));
    expect(res.some((t: { text: string }) => t.text.includes('old but open task'))).toBe(true);
  });

  it('task_add normalizes a natural-language deadline to ISO', async () => {
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_add')!;
    const out = JSON.parse(await tool.execute({ description: 'order substrate', deadline: '2026-12-12' }));
    expect(out.type).toBe('pending_edit');
    expect(out.newContent).toContain('(due: 2026-12-12)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tasks-window-deadline.test.ts`
Expected: FAIL — 30-day-old task not found (14-day window) / deadline assertion may pass coincidentally for ISO input but the window test fails.

- [ ] **Step 3: Widen the window**

In `src/agent/tools/tasks.ts`, `task_list`: add a `days` parameter to the schema and use it. Change the `definition.parameters.properties` for `task_list` to include:

```typescript
            days: { type: 'number', description: 'How many days of diary history to scan (default 90)' },
```

Then in its `execute`, replace:

```typescript
        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 14);
```

with:

```typescript
        const windowDays = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : 90;
        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, windowDays);
```

- [ ] **Step 4: Normalize the deadline with chrono**

In `src/agent/tools/tasks.ts`, add the import at the top:

```typescript
import * as chrono from 'chrono-node';
```

In `task_add`'s `execute`, replace:

```typescript
        let taskLine = `- [ ] ${args.description}`;
        if (args.deadline) taskLine += ` (due: ${args.deadline})`;
```

with:

```typescript
        let taskLine = `- [ ] ${args.description}`;
        if (args.deadline) {
          const raw = String(args.deadline);
          const parsed = chrono.parseDate(raw, new Date(), { forwardDate: true });
          const iso = parsed
            ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
            : raw;
          taskLine += ` (due: ${iso})`;
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/tasks-window-deadline.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/tasks.ts tests/unit/tasks-window-deadline.test.ts
git commit -m "feat(tasks): configurable task_list window (default 90d) and chrono-normalized deadlines"
```

---

### Task 11: Remove the unused `node-cron` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Confirm it is unused**

Run: `grep -rn "node-cron" src tests`
Expected: no matches.

- [ ] **Step 2: Remove the dependency**

Run: `npm uninstall node-cron`
Expected: `node-cron` removed from `package.json` dependencies and from `package-lock.json`.

- [ ] **Step 3: Verify build still works**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove unused node-cron dependency"
```

---

### Task 12: Phase 1 regression gate

**Why:** Confirm the whole suite is green before moving to skills. Some existing tests may assert on the old `vault_search` `context` field removed in Task 9 — fix them here.

**Files:**
- Possibly modify: `tests/unit/search-housekeeping.test.ts` and any other search-result-shape assertions.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all green. If a search test fails on a missing `context` field, update its assertions to the new result shape (`{ results, totalCandidates }`). Do not re-add `assembleContext`.

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit any test fixups**

```bash
git add tests/
git commit -m "test: align search-result-shape assertions with embedding-free vault_search"
```

---

## PHASE 2 — Skills & Vault Docs

### Task 13: Vault-level CLAUDE.md and AGENTS.md

**Why:** The agent needs the vault conventions (folder layout, serial scheme, frontmatter, the rule to route writes through `cricknote tool`). One source, copied into the vault by setup.

**Files:**
- Create: `templates/agent-docs/CLAUDE.md`
- Create: `templates/agent-docs/AGENTS.md`

- [ ] **Step 1: Write CLAUDE.md**

Create `templates/agent-docs/CLAUDE.md`:

```markdown
# CrickNote Vault — Agent Guide

This is a lab notebook vault managed by CrickNote. You (Claude Code / Codex) are
the lab assistant. The Obsidian vault is the source of truth; a SQLite index at
`~/.cricknote/db.sqlite` provides search and serial numbering.

## The one rule for writes

NEVER create or edit serialized notes (projects, experiments, protocols, series,
reading notes, knowledge notes, tasks) with your own file tools. ALWAYS go
through the CrickNote CLI:

    cricknote tool <name> '<json-args>'

It allocates serial IDs, renders templates, writes atomically, records an audit
log, updates the changelog, and refreshes the search index. Writing files
directly bypasses all of that and corrupts the numbering system.

Freeform notes with no serial (scratch, meeting notes) may be edited directly.

## At the start of a lab session

Run `cricknote reindex` once to pick up any edits you made by hand in Obsidian.

## Discovering tools

`cricknote tools` prints the full catalog (name, description, JSON parameters).

## Folder layout

- `Projects/P###-<slug>/` — project folders; `_index.md` is the project home.
  Experiments live here as `<PREFIX>###-<slug>.md`, series as `<PREFIX>S###`.
- `Protocols/PR###-<slug>.md` — protocols.
- `Reading/Papers/`, `Reading/Threads/` — reading notes; `Reading/attachments/<slug>/` — PDFs/sources.
- `Knowledge/Concepts|Entities|Methods/` — knowledge base notes.
- `Memory/Daily/<date>.md`, `Memory/Weekly/<week>.md` — diary and planning.

## Serial IDs

Projects are `P001`, `P002`… Each project reserves a 2–3 letter prefix; its
experiments use that prefix (`IL001`), its series append S (`ILS001`). Protocols
are `PR001`. Never invent or hand-edit a serial — the tools allocate them.

## Common workflows

See the skills in `.claude/skills/cricknote-*`. Summary:
- Record an experiment → `cricknote-record-experiment`
- Import & analyze a paper → `cricknote-reading-intake`
- Map a source into the knowledge base → `cricknote-kb-update`
- Daily/weekly review → `cricknote-daily-review`
- Push tasks to Apple Reminders → `cricknote-reminders`
```

- [ ] **Step 2: Write AGENTS.md**

Create `templates/agent-docs/AGENTS.md` with the same content (Codex reads `AGENTS.md`; the body is identical so behavior matches across agents):

```markdown
# CrickNote Vault — Agent Guide

(Identical guidance to CLAUDE.md — see that file. Codex reads AGENTS.md.)

This is a lab notebook vault managed by CrickNote. The Obsidian vault is the
source of truth; SQLite at `~/.cricknote/db.sqlite` provides search and serials.

## The one rule for writes

Route ALL serialized-note writes through:

    cricknote tool <name> '<json-args>'

Never write project/experiment/protocol/series/reading/knowledge/task notes with
raw file tools — that bypasses serial allocation, audit log, and indexing.

## Start of session

Run `cricknote reindex` to absorb manual Obsidian edits.

## Catalog

`cricknote tools` lists every tool with parameters.

## Layout & serials

Projects `Projects/P###-<slug>/`, experiments `<PREFIX>###`, series `<PREFIX>S###`,
protocols `PR###`, reading `Reading/Papers|Threads/`, knowledge
`Knowledge/Concepts|Entities|Methods/`, diary `Memory/Daily/<date>.md`.

Skills live in `.agents/skills/cricknote-*`.
```

- [ ] **Step 3: Commit**

```bash
git add templates/agent-docs/CLAUDE.md templates/agent-docs/AGENTS.md
git commit -m "docs(agent): vault-level CLAUDE.md and AGENTS.md guides"
```

---

### Task 14: The five skill files

**Why:** Skills are the workflow instructions that make the tools usable safely. They are markdown, not code; each tells the agent the exact `cricknote tool` sequence and the confirmation gates.

**Files:**
- Create: `skills/cricknote-record-experiment/SKILL.md`
- Create: `skills/cricknote-reading-intake/SKILL.md`
- Create: `skills/cricknote-kb-update/SKILL.md`
- Create: `skills/cricknote-daily-review/SKILL.md`
- Create: `skills/cricknote-reminders/SKILL.md`

- [ ] **Step 1: Write `cricknote-record-experiment/SKILL.md`**

```markdown
---
name: cricknote-record-experiment
description: Use when the user wants to start a project, create or update an experiment, log bench steps, record results, group experiments into a series, or save a protocol in their CrickNote lab vault.
---

# Recording experiments in CrickNote

All writes go through `cricknote tool <name> '<json>'`. Never write note files
directly — the tools allocate serial IDs and keep the index/audit log correct.

## Start a project
1. `cricknote tool create_project '{"title":"<title>","prefix":"<2-3 LETTERS>"}'`
   - Omit `prefix` to get a suggestion, then re-call with the chosen prefix.
2. After it applies, finalize counters:
   `cricknote tool register_project_counters '{"project_id":"P###","prefix":"<PREFIX>"}'`

## Create an experiment
1. Check the protocol exists: `cricknote tool vault_list '{"folder":"Protocols"}'`.
2. `cricknote tool create_experiment '{"project_id":"P###","title":"<t>","experiment_type":"<type>","protocol":"PR###-<slug>","samples":[{"name":"ctrl","condition":"untreated"}]}'`
   - `protocol`, `samples`, `series` are optional.

## Log steps during the day
1. Read first: `cricknote tool vault_read '{"path":"<rel path>"}'`.
2. Append a timestamped line:
   `cricknote tool vault_append '{"path":"<rel path>","content":"\n- 14:32 transfer complete"}'`

## Record results and close out
1. Append results/analysis with `vault_append`.
2. When done, the experiment's `status` should be `complete` — use `vault_append`
   or the appropriate tool to set it, then offer to map findings into the
   knowledge base (skill: cricknote-kb-update).

## Series and protocols
- Series: `cricknote tool create_series '{"project_id":"P###","title":"<t>"}'`
  then `cricknote tool update_series_table '{...}'`.
- Protocol: `cricknote tool create_protocol '{"title":"<t>","category":"<cat>","derived_from":"PR###"}'`.

## After a batch of manual edits
Run `cricknote reindex` so search reflects the changes.
```

- [ ] **Step 2: Write `cricknote-reading-intake/SKILL.md`**

```markdown
---
name: cricknote-reading-intake
description: Use when the user wants to import a paper (from Zotero or files), create a reading note, or analyze a paper into structured CREATE sections in their CrickNote vault.
---

# Reading intake in CrickNote

One paper at a time. All writes go through `cricknote tool`.

## From Zotero
1. `cricknote tool zotero_fetch_item '{"citekey":"<key>"}'` (or `{"doi":"..."}`).
2. `cricknote tool zotero_prepare_bundle '{...}'` to copy the PDF into
   `Reading/attachments/<slug>/`.
3. `cricknote tool create_reading_note '{"slug":"<slug>","title":"<t>","authors":["..."],"year":2026,"journal":"<j>","doi":"<doi>"}'`.

## From local files (no Zotero)
1. Put files under `Reading/attachments/<slug>/`.
2. `cricknote tool discover_reading_bundle '{"slug":"<slug>"}'`.
3. `cricknote tool create_reading_note '{...}'`.

## Analyze the paper
1. `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md"}'`
   — returns source text.
2. Draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions,
   Takeaways, Extensions). Show the draft to the user.
3. Write it: `cricknote tool vault_write '{"path":"Reading/Papers/<slug>.md","content":"<full note>"}'`.

## Check status
`cricknote tool reading_pipeline_status '{"path":"Reading/Papers/<slug>.md"}'`
reports the deterministic next step. When compiled, offer KB mapping
(skill: cricknote-kb-update).
```

- [ ] **Step 3: Write `cricknote-kb-update/SKILL.md`**

```markdown
---
name: cricknote-kb-update
description: Use when the user wants to map a reading note, experiment, or series into the CrickNote knowledge base (suggest, confirm, and apply knowledge note updates).
---

# Knowledge-base mapping in CrickNote

A three-stage pipeline with a confirmation gate. Never skip the gate.

## 1. Suggest
`cricknote tool kb_suggest '{"source":"<rel path to source note>"}'`
Returns proposed targets (UPDATE existing / CREATE new Knowledge notes).
Present them to the user and WAIT for confirmation.

## 2. Write the mapping (only after the user confirms)
`cricknote tool kb_write_mapping '{"source":"<src>","confirmed_targets":[{"slug":"<s>","action":"update"}]}'`
If the user confirmed nothing, pass `"confirmed_targets":[]` — this marks the
source `kb_status: skipped`.

## 3. Apply each target
Loop until done:
1. `cricknote tool kb_apply '{"mapping":"<rel path to *-mapping.md>"}'`
   — returns the next pending target + source content.
2. Draft the Knowledge note edit; show it; write with `vault_write`.
3. `cricknote tool kb_apply_advance '{...}'` to record the target as done.

## Housekeeping
- `cricknote tool kb_lint '{...}'` checks for inconsistencies.
- `cricknote tool kb_resolve_review '{...}'` handles review-flagged targets.

The mapping artifact persists progress: if you stop halfway, resume from step 3
later — `kb_apply` returns the next still-pending target.
```

- [ ] **Step 4: Write `cricknote-daily-review/SKILL.md`**

```markdown
---
name: cricknote-daily-review
description: Use when the user wants a review of open lab work — unfinished experiments, stuck reading notes, pending tasks — or a daily/weekly planning summary in CrickNote.
---

# Daily / weekly review in CrickNote

## Refresh first
Run `cricknote reindex` to absorb manual Obsidian edits.

## Gather state
- `cricknote tool get_today_diary '{}'` and `cricknote tool get_week_plan '{}'`.
- `cricknote tool task_list '{"status":"pending","days":90}'` — open tasks.
- `cricknote tool vault_list '{"folder":"Projects","status":"in-progress"}'` —
  experiments still open.
- `cricknote tool reading_pipeline_status '{}'` for stuck reading bundles.
- `cricknote tool get_workflow_events '{}'` for recent history.

## Present
Summarize: open experiments, stuck reading notes, pending KB targets, due tasks.
Lead with what is overdue or blocking.

## Reminder reconciliation
If the user uses Apple Reminders (skill: cricknote-reminders), ask whether any
reminders were completed on their phone and, for each, mark the matching diary
task done with `cricknote tool task_complete '{"task_description":"<text>"}'`.
```

- [ ] **Step 5: Write `cricknote-reminders/SKILL.md`**

```markdown
---
name: cricknote-reminders
description: Use when the user wants a CrickNote task or planned experiment pushed to Apple Reminders or Calendar on macOS, or wants reminders kept in sync with their diary tasks.
---

# Reminders & calendar push (macOS)

One-way push from the vault to Apple Reminders/Calendar. The vault stays the
source of truth; there is no automatic sync back.

## Push a task to Reminders
1. Add the task in the vault first:
   `cricknote tool task_add '{"description":"order ECL substrate","deadline":"2026-12-12","project":"P003"}'`
   (the deadline is normalized to ISO).
2. Check for an existing reminder to avoid duplicates:
   ```bash
   osascript -e 'tell application "Reminders" to return name of every reminder whose name contains "order ECL substrate"'
   ```
3. If none, create one with a locale-safe date (build the date object, do not
   parse a locale string):
   ```bash
   osascript <<'EOF'
   set dueDate to current date
   set year of dueDate to 2026
   set month of dueDate to 12
   set day of dueDate to 12
   set time of dueDate to 9 * hours
   tell application "Reminders"
     make new reminder with properties {name:"order ECL substrate [P003]", due date:dueDate}
   end tell
   EOF
   ```
4. Mark the vault task as pushed by appending a ⏰ marker (re-write the task line
   via `vault_append` is not idempotent — instead note to the user it is pushed).

## Push a planned experiment to Calendar
Use the same locale-safe date construction with `make new event` in the target
calendar. Include the project/serial in the event title.

## Reconciliation
Completing a reminder on the phone does NOT check the vault box. During daily
review, ask which reminders were completed and call
`cricknote tool task_complete '{"task_description":"<text>"}'` for each.
```

- [ ] **Step 6: Commit**

```bash
git add skills/
git commit -m "docs(skills): add five CrickNote workflow skills"
```

---

### Task 15: Install skills + agent docs into the vault on setup

**Why:** Skills live in the repo (version-controlled) but must be copied into the vault so the agent finds them when run from the vault directory. Copies (not symlinks) survive vault sync tools and are refreshed on re-run.

**Files:**
- Create: `src/cli/install-agent-assets.ts`
- Test: `tests/unit/install-agent-assets.test.ts`
- Modify: `src/cli/setup.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/install-agent-assets.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgentAssets } from '../../src/cli/install-agent-assets.js';

describe('installAgentAssets', () => {
  let vault: string;
  let repo: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(repo, 'skills', 'cricknote-record-experiment'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', 'cricknote-record-experiment', 'SKILL.md'), '# skill');
    fs.mkdirSync(path.join(repo, 'templates', 'agent-docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'CLAUDE.md'), '# claude');
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'AGENTS.md'), '# agents');
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('copies skills into both .claude and .agents skill dirs and writes the doc files', () => {
    installAgentAssets(vault, repo);
    expect(fs.existsSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.agents', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe('# claude');
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf-8')).toBe('# agents');
  });

  it('is idempotent — re-running refreshes without error', () => {
    installAgentAssets(vault, repo);
    fs.writeFileSync(path.join(repo, 'skills', 'cricknote-record-experiment', 'SKILL.md'), '# skill v2');
    installAgentAssets(vault, repo);
    expect(fs.readFileSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'), 'utf-8')).toBe('# skill v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/install-agent-assets.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create the installer**

Create `src/cli/install-agent-assets.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy CrickNote skills and agent guide docs from the repo into the vault.
 * Skills go to both `.claude/skills/` (Claude Code) and `.agents/skills/`
 * (Codex). Copies, not symlinks — robust to vault sync tools; re-running
 * refreshes. Idempotent.
 */
export function installAgentAssets(vaultPath: string, repoRoot: string): void {
  const skillsSrc = path.join(repoRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dest of ['.claude', '.agents']) {
      const target = path.join(vaultPath, dest, 'skills');
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(skillsSrc, target, { recursive: true });
    }
  }

  const docsSrc = path.join(repoRoot, 'templates', 'agent-docs');
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    const src = path.join(docsSrc, doc);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(vaultPath, doc));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/install-agent-assets.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Call the installer from setup**

In `src/cli/setup.ts`, import and invoke `installAgentAssets` after the vault path is known. `setup.ts` already imports `path`; add only these two imports near the top:

```typescript
import { fileURLToPath } from 'node:url';
import { installAgentAssets } from './install-agent-assets.js';
```

In `setup.ts` the resolved vault path is the local `resolvedVaultPath` (line ~100), and the config is persisted via `saveConfig(config)` (line ~172). Immediately after that `saveConfig(config)` call, add:

```typescript
  // Repo root is two levels up from dist/cli/ (or src/cli/ in dev).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    installAgentAssets(resolvedVaultPath, repoRoot);
    console.log('Installed CrickNote skills and agent guides into the vault.');
  } catch (err) {
    console.warn(`Could not install agent assets: ${(err as Error).message}`);
  }
```

(`setup.ts` already imports `path`; add only the `fileURLToPath` and `installAgentAssets` imports.)

- [ ] **Step 6: Verify build and the setup wiring typechecks**

Run: `npx tsc --noEmit && npx vitest run tests/unit/install-agent-assets.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/install-agent-assets.ts src/cli/setup.ts tests/unit/install-agent-assets.test.ts
git commit -m "feat(setup): install skills and agent guides into the vault"
```

---

### Task 16: Manual end-to-end validation from the vault directory

**Why:** Phase 2's real test is using it. This is a manual checklist, not automated.

- [ ] **Step 1: Build and run setup**

```bash
npx tsc
node dist/cli.js setup   # point at a test vault
```
Verify `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `.agents/skills/` appear in the vault.

- [ ] **Step 2: From the vault directory, drive a real workflow with Claude Code**

Open Claude Code in the vault and try: "Start a project on autophagy, prefix AP. Then create a western blot experiment in it and log that I started the lysis step." Confirm the agent uses `cricknote tool` calls and the files appear with correct serials.

- [ ] **Step 3: Repeat with Codex** (if installed) to confirm `AGENTS.md` + `.agents/skills/` are picked up.

- [ ] **Step 4: Note any friction** in `docs/superpowers/specs/` as a follow-up; do not block phase 3 on polish.

---

## PHASE 3 — Prune the Retired Runtime

> Do this only after Phase 2 has driven real lab work for a week or two and you trust the bridge. Each deletion step ends with `npx tsc --noEmit && npm test` as the gate.

### Task 17: Delete the LLM runtime and providers

**Files:**
- Delete: `src/agent/runtime.ts`, `src/agent/providers/anthropic.ts`, `src/agent/providers/openai.ts`, `src/agent/providers/base.ts`, `src/agent/context.ts`, `src/agent/tool-router.ts`
- Delete corresponding tests: `tests/unit/runtime-routing.test.ts`, `tests/unit/context-prompt.test.ts`, `tests/unit/provider-config.test.ts`, `tests/unit/action-validation.test.ts` (verify each only covers deleted code first)

- [ ] **Step 1: Find importers**

Run: `grep -rn "agent/runtime\|agent/providers\|agent/context\|tool-router" src tests`
Expected: only the WebSocket server (`src/server/websocket.ts`) and the listed tests. If anything else imports them, stop and reassess.

- [ ] **Step 2: Delete the files** (runtime + providers + context + router).

- [ ] **Step 3: Delete the WebSocket server** (it is the only remaining runtime consumer):
`src/server/websocket.ts`, `src/server/auth.ts`, `src/server/rate-limiter.ts`, and their tests `tests/unit/auth-validation.test.ts`, `tests/unit/rate-limiter.test.ts`.

- [ ] **Step 4: Rewrite `src/service.ts`** to no longer start the WebSocket server or the embedding worker. Either delete `src/service.ts` and the `start` command, or reduce `start` to a no-op that prints guidance. Recommended: delete `src/cli/start.ts`, `src/service.ts`, and remove the `start` command from `src/cli.ts`.

- [ ] **Step 5: Gate**

Run: `npx tsc --noEmit && npm test`
Expected: green. Fix dangling imports until it is.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(prune): remove LLM runtime, providers, websocket server, and start command"
```

---

### Task 18: Delete the embedding stack and watcher daemon

**Files:**
- Delete: `src/ingestion/embedder.ts`, `src/ingestion/watcher.ts`, `src/ingestion/worker.ts`
- Delete tests covering them: `tests/unit/worker.test.ts` and any embedder/watcher tests
- Modify: `src/ingestion/indexer.ts` — drop the `embeddings` parameter and the `chunk_embeddings` insert; drop `embeddingToBuffer` usage
- Modify: `src/ingestion/index-file.ts` — drop `embeddings: []` from the `indexNote` call

- [ ] **Step 1: Confirm `shouldIgnoreIngestionPath` no longer comes from worker**

It was extracted to `ignore.ts` in Task 1, and `index-file.ts` imports it from there. Confirm: `grep -rn "from './worker.js'\|from '../ingestion/worker" src tests`. Update any remaining importer to `ignore.js`.

- [ ] **Step 2: Simplify `indexNote`** — remove the `embeddings` field from `IndexNoteInput`, delete the `insertEmbedding` prepare and its loop body, and remove the `embeddingToBuffer` import. The BM25 + metadata inserts stay.

- [ ] **Step 3: Update callers** — `index-file.ts` `indexNote({ note, contentHash, mtime, chunks })` (no `embeddings`).

- [ ] **Step 4: Delete `chunk_embeddings` references** — `src/retrieval/semantic-ranker.ts` (delete the file) and any reindex/embedder imports. Leave the `chunk_embeddings` table in migrations (harmless; no migration churn).

- [ ] **Step 5: Drop the heavy dependency**

Run: `npm uninstall @xenova/transformers ws @anthropic-ai/sdk openai`
(Confirm none are still imported first: `grep -rn "@xenova/transformers\|from 'ws'\|@anthropic-ai/sdk\|from 'openai'" src`.)

- [ ] **Step 6: Gate**

Run: `npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(prune): remove embedding stack, watcher, worker; index BM25+metadata only"
```

---

### Task 19: Remove the Obsidian chat plugin and final cleanup

**Files:**
- Delete: `obsidian-plugin/` chat UI (keep only if it has non-chat vault features worth retaining — inspect first)
- Modify: `package.json` scripts — drop `build:plugin` / plugin build steps that reference the deleted UI
- Modify: `README.md` — document the new agent-native workflow

- [ ] **Step 1: Inspect the plugin** — `ls obsidian-plugin/` and confirm it is purely the chat client. If so, delete it. If it has vault-viewer value, keep that and delete only the chat parts.

- [ ] **Step 2: Clean `package.json`** — remove `build:plugin` from `build`, and the `build:plugin` script, if the plugin is gone. Remove `node dist/cli.js start` references.

- [ ] **Step 3: Update README** — replace the "run the service + open Obsidian chat" instructions with: install, `cricknote setup`, then run Claude Code / Codex from the vault directory; mention `cricknote tool`, `cricknote tools`, `cricknote reindex`.

- [ ] **Step 4: Gate**

Run: `npx tsc --noEmit && npm test && npx tsc`
Expected: green, and `dist/` builds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(prune): remove Obsidian chat plugin; document agent-native workflow"
```

---

## Self-Review Notes

- **Spec coverage:** §5 dispatcher → Tasks 4–6; §5 incremental index → Tasks 2,4; §5 session id → Task 6; §6 use cases → Task 7 (cycle) + Phase 2 skills (Task 14); §7 skills → Task 14; §8 reminders → Task 14 (cricknote-reminders); §9 fixes → Tasks 9,10,11; §10 pruning → Tasks 17–19; §11 testing → Tasks 7,12; corrections (semantic rank, reindex, reservation) → Tasks 9,8,4.
- **Reservation finalize:** verified `create_project` inserts the reservation in `execute()` with a TTL; `applyPendingEdit` stamps `edit_id` on success and deletes on failure (Task 4). `register_project_counters` upgrades it to permanent independently.
- **Conflict detection in CLI:** `ConflictDetector.checkConflict` returns no-conflict when no snapshot exists (fresh process), so `confirmEdit('apply')` always writes — no `force` needed.
- **Batch atomicity:** dispatcher pre-flights boundary checks on all batch members before writing any (Task 5); mid-batch disk failure leaving a partial project is a documented edge, acceptable for single-user.
- **DRY:** `buildToolRegistry` (Task 3) is the single registration site; `indexFileSync` (Task 2) backs both the dispatcher and reindex.
```
