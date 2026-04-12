# Serial Numbering System — Implementation Plan (Revised R7 — Final)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the serial numbering system (Spec 1) — new DB tables, serial allocation, fenced-section editing utilities, 9 new tools + 3 updated tools, runtime workflow-event integration, and updated parser/indexer.

**Architecture:**
- All serial state lives in SQLite (`serial_counters`, `prefix_reservations`, `workflow_events`)
- `checkPrefixCollision` checks both `serial_counters` AND `prefix_reservations` for parent/child conflicts
- `validatePrefix` enforces `/^[A-Z]{2,3}$/` at every entry point
- `resolveProject` uses `resolveVaultPath` before any file read to prevent symlink escapes
- `register_project_counters` verifies both `prefix` and `prefix-S` counters atomically
- Wikilink resolution extended inside existing `resolveWikilinkPath` to cover Knowledge/ subfolders; ambiguity returns null + logs warning (never silently picks)
- Parser: classification runs AFTER frontmatter parse; uses `note_kind` as primary discriminant; `created` fallback for `date`
- `create_reading_note` targets `Reading/Papers/`; `create_series` does not assign existing experiments at creation time

**Tech Stack:** Node 22+, TypeScript, better-sqlite3, vitest, gray-matter, existing `resolveVaultPath`, existing `SafeWriter`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/cli/setup.ts` | Create Knowledge/, Reading/ subfolders |
| Modify | `src/retrieval/context-assembler.ts` | Extend `resolveWikilinkPath` to search Knowledge/ subfolders; handle ambiguity safely |
| Create | `src/storage/migrations/002-serial-numbering.ts` | New tables + columns |
| Modify | `src/storage/migrations/001-initial.ts` | Call migration 002 |
| Create | `src/storage/serial.ts` | `getNextSerial`, `formatSerial`, `validatePrefix` |
| Modify | `src/agent/tools/registry.ts` | Add `ToolContext`; update `ToolHandler.execute` signature |
| Modify | `src/agent/runtime.ts` | Import `ToolContext`; inject context; workflow_events; reservation cleanup; expiry |
| Modify | `src/editing/safe-writer.ts` | Reject confirmEdit for edits > 30 min old |
| Create | `src/editing/auto-writer.ts` | `autoWrite`, `fencedSectionUpdate`, `frontmatterFieldUpdate` |
| Modify | `src/server/websocket.ts` | Pass `client.sessionId` to `runtime.confirmEdit` |
| Create | `src/agent/tools/serial-tools.ts` | All 9 serial tools |
| Modify | `src/agent/tools/templates.ts` | Remove old `create_experiment`; update `create_reading_note` → `Reading/Papers/` |
| Modify | `src/agent/tools/vault.ts` | `vault_list`: add `project_id`, `series` fields; injectable db |
| Modify | `src/agent/tools/search.ts` | Serial ID fast path; injectable db |
| Modify | `src/ingestion/parser.ts` | Post-frontmatter classification; `note_kind` discriminant; serial fields; `created`→`date` |
| Modify | `src/ingestion/indexer.ts` | Persist new parser fields |
| Modify | `obsidian-plugin/chat-view.ts` | Continue button; store `actionsEl`; use `this.plugin.ws` |

---

## Task 0: Vault Folder Setup + Wikilink Resolver Extension

**Files:**
- Modify: `src/cli/setup.ts`
- Modify: `src/retrieval/context-assembler.ts`

- [ ] **Step 1: Expand vault directory creation in `setup.ts`**

In `src/cli/setup.ts`, replace the existing folder loop (line ~122):
```typescript
for (const dir of ['Projects', 'Protocols', 'Reading', 'Memory/Daily', 'Memory/Weekly', 'Memory/Monthly']) {
```
with:
```typescript
for (const dir of [
  'Projects', 'Protocols',
  'Reading', 'Reading/Papers', 'Reading/Threads', 'Reading/attachments',
  'Memory/Daily', 'Memory/Weekly', 'Memory/Monthly',
  'Knowledge', 'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
  'Knowledge/Review-Queue', 'Knowledge/_Ops', 'Knowledge/_Ops/Update-Logs', 'Knowledge/_Ops/Lint-Reports',
]) {
```

- [ ] **Step 2: Extend `resolveWikilinkPath` in `context-assembler.ts` to search Knowledge/**

Find the private function `resolveWikilinkPath` (currently at ~line 110). Add Knowledge/ subfolder search AFTER the existing Protocols/ and common folder searches, and change ambiguity handling to log and return null. Also add path-safety: reject any ref containing `/`, `\`, or `..` to prevent vault escape:

```typescript
function resolveWikilinkPath(
  ref: string,
  vaultPath: string,
): string | null {
  // Path-safety: reject refs containing traversal or separator characters
  if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) {
    console.warn(`[context-assembler] Wikilink [[${ref}]] contains unsafe path characters — skipping`);
    return null;
  }
  const baseName = ref.replace(/\.md$/, '');

  // Try Protocols/ folder first
  const protocolPath = path.join(vaultPath, 'Protocols', `${baseName}.md`);
  if (fs.existsSync(protocolPath)) return protocolPath;

  // Try Knowledge/ subfolders
  const kbCandidates: string[] = [];
  for (const sub of ['Concepts', 'Entities', 'Methods']) {
    const kbPath = path.join(vaultPath, 'Knowledge', sub, `${baseName}.md`);
    if (fs.existsSync(kbPath)) kbCandidates.push(kbPath);
  }
  if (kbCandidates.length === 1) return kbCandidates[0];
  if (kbCandidates.length > 1) {
    // Ambiguous: log and return null — never silently pick
    console.warn(`[context-assembler] Ambiguous wikilink [[${ref}]] matches ${kbCandidates.length} Knowledge notes — skipping`);
    return null;
  }

  // Try vault root
  const rootPath = path.join(vaultPath, `${baseName}.md`);
  if (fs.existsSync(rootPath)) return rootPath;

  // Try Reading/ subfolders
  for (const sub of ['Papers', 'Threads']) {
    const rPath = path.join(vaultPath, 'Reading', sub, `${baseName}.md`);
    if (fs.existsSync(rPath)) return rPath;
  }

  // Try other common subfolders (one level deep, excluding Knowledge which is already handled)
  for (const folder of ['Projects', 'Memory', 'Agent']) {
    const folderPath = path.join(vaultPath, folder);
    if (!fs.existsSync(folderPath)) continue;
    const directPath = path.join(folderPath, `${baseName}.md`);
    if (fs.existsSync(directPath)) return directPath;
    try {
      for (const sub of fs.readdirSync(folderPath, { withFileTypes: true }).filter(d => d.isDirectory())) {
        const subPath = path.join(folderPath, sub.name, `${baseName}.md`);
        if (fs.existsSync(subPath)) return subPath;
      }
    } catch { /* ignore */ }
  }
  return null;
}
```

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/cli/setup.ts src/retrieval/context-assembler.ts
git commit -m "feat: Knowledge/ and Reading/ subfolders on setup; extend wikilink resolver to Knowledge/"
```

---

## Task 1: DB Migration 002

**Files:**
- Create: `src/storage/migrations/002-serial-numbering.ts`
- Modify: `src/storage/migrations/001-initial.ts`
- Test: `tests/integration/migration-002.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/migration-002.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('migration 002 — serial numbering', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('creates serial_counters with scope, next_val, project_id', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(serial_counters)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('scope');
    expect(names).toContain('next_val');
    expect(names).toContain('project_id');
  });

  it('creates prefix_reservations table', () => {
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain('prefix_reservations');
  });

  it('creates workflow_events table with session index', () => {
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toContain('idx_workflow_events_session');
  });

  it('adds note_id, series, project_id, last_session to note_metadata', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(note_metadata)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    ['note_id', 'series', 'project_id', 'last_session'].forEach(c => expect(names).toContain(c));
  });

  it('seeds project and protocol serial_counters', () => {
    runMigrations(db);
    const rows = db.prepare("SELECT scope FROM serial_counters").all() as Array<{ scope: string }>;
    expect(rows.map(r => r.scope)).toContain('project');
    expect(rows.map(r => r.scope)).toContain('protocol');
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('latest schema_version is 2 after migrations', () => {
    runMigrations(db);
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/integration/migration-002.test.ts
```
Expected: FAIL

- [ ] **Step 3: Create `src/storage/migrations/002-serial-numbering.ts`**

```typescript
import type Database from 'better-sqlite3';

export function applyMigration002(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_session ON workflow_events(session_id, id);
      CREATE TABLE IF NOT EXISTS prefix_reservations (
        prefix     TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        edit_id    TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS serial_counters (
        scope      TEXT PRIMARY KEY,
        next_val   INTEGER NOT NULL DEFAULT 1,
        project_id TEXT
      );
    `);
    db.exec(`INSERT OR IGNORE INTO serial_counters (scope, next_val, project_id) VALUES ('project', 1, NULL), ('protocol', 1, NULL);`);
    for (const [col, type] of [['note_id', 'TEXT'], ['series', 'TEXT'], ['project_id', 'TEXT'], ['last_session', 'TEXT']] as Array<[string, string]>) {
      try { db.exec(`ALTER TABLE note_metadata ADD COLUMN ${col} ${type};`); }
      catch (e) { if (!(e as Error).message.includes('duplicate column name')) throw e; }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_note_metadata_note_id ON note_metadata(note_id) WHERE note_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_note_metadata_series ON note_metadata(series);
      CREATE INDEX IF NOT EXISTS idx_note_metadata_project_id ON note_metadata(project_id);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, Date.now());
  })();
}
```

- [ ] **Step 4: Wire migration 002 into `runMigrations` in `001-initial.ts`**

```typescript
import { applyMigration002 } from './002-serial-numbering.js';

// After existing migration 001 block:
if (currentVersion < 2) {
  applyMigration002(db);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/integration/migration-002.test.ts
```
Expected: PASS (7 tests)

- [ ] **Step 6: Update existing integration migrations test**

In `tests/integration/migrations.test.ts`, find the 'creates all expected tables' test and add:
```typescript
expect(tableNames).toContain('workflow_events');
expect(tableNames).toContain('prefix_reservations');
expect(tableNames).toContain('serial_counters');
```
Find and update BOTH schema_version assertions in `tests/integration/migrations.test.ts`:

1. In the 'records schema_version correctly' test:
```typescript
// Change:
expect(row.version).toBe(1);
// To (check MAX version instead of single row):
const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
expect(row.v).toBe(2);
expect(row.v).toBeGreaterThan(0);
```

2. In the 'is idempotent' test — replace the length/version assertions:
```typescript
// Change:
const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
expect(rows).toHaveLength(1);
expect(rows[0].version).toBe(1);
// To:
const maxRow = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
expect(maxRow.v).toBe(2);
```

- [ ] **Step 7: Run all migration tests**

```bash
npx vitest run tests/integration/
```
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/storage/migrations/002-serial-numbering.ts src/storage/migrations/001-initial.ts \
        tests/integration/migration-002.test.ts tests/integration/migrations.test.ts
git commit -m "feat: DB migration 002 — serial_counters, prefix_reservations, workflow_events"
```

---

## Task 2: `getNextSerial`, `formatSerial`, `validatePrefix`

**Files:**
- Create: `src/storage/serial.ts`
- Test: `tests/unit/serial.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/serial.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { getNextSerial, formatSerial, validatePrefix } from '../../src/storage/serial.js';

describe('formatSerial', () => {
  it('zero-pads 1-999 to 3 digits', () => {
    expect(formatSerial(1)).toBe('001');
    expect(formatSerial(42)).toBe('042');
    expect(formatSerial(999)).toBe('999');
  });
  it('uses natural string for >= 1000', () => {
    expect(formatSerial(1000)).toBe('1000');
  });
});

describe('validatePrefix', () => {
  it('accepts 2-letter uppercase prefix', () => { expect(() => validatePrefix('CM')).not.toThrow(); });
  it('accepts 3-letter uppercase prefix', () => { expect(() => validatePrefix('WBT')).not.toThrow(); });
  it('rejects lowercase', () => { expect(() => validatePrefix('cm')).toThrow('format'); });
  it('rejects 1-letter prefix', () => { expect(() => validatePrefix('C')).toThrow('format'); });
  it('rejects 4-letter prefix', () => { expect(() => validatePrefix('CELL')).toThrow('format'); });
  it('rejects prefix with digits', () => { expect(() => validatePrefix('C1')).toThrow('format'); });
});

describe('getNextSerial', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('returns 001 for first project serial', () => { expect(getNextSerial('project', db)).toBe('001'); });
  it('increments on each call', () => {
    expect(getNextSerial('project', db)).toBe('001');
    expect(getNextSerial('project', db)).toBe('002');
  });
  it('throws for unknown scope', () => {
    expect(() => getNextSerial('no-such-scope', db)).toThrow('does not exist');
  });
  it('is monotonic — gaps are acceptable (cancelled edits do not rollback)', () => {
    getNextSerial('project', db);
    expect(getNextSerial('project', db)).toBe('002');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/serial.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `src/storage/serial.ts`**

```typescript
import type Database from 'better-sqlite3';
import { getDatabase } from './database.js';

export function formatSerial(n: number): string {
  return n >= 1000 ? String(n) : String(n).padStart(3, '0');
}

/** Validate a prefix string. Throws if not 2–3 uppercase ASCII letters. */
export function validatePrefix(prefix: string): void {
  if (!/^[A-Z]{2,3}$/.test(prefix)) {
    throw new Error(`Prefix "${prefix}" has invalid format — must be 2–3 uppercase letters (A-Z), got "${prefix}"`);
  }
}

export function getNextSerial(scope: string, db?: Database.Database): string {
  const database = db ?? getDatabase();
  const row = database.prepare(
    'UPDATE serial_counters SET next_val = next_val + 1 WHERE scope = ? RETURNING next_val - 1 AS allocated'
  ).get(scope) as { allocated: number } | undefined;
  if (row === undefined) throw new Error(`Serial scope "${scope}" does not exist. Register it before allocating.`);
  return formatSerial(row.allocated);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/serial.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/serial.ts tests/unit/serial.test.ts
git commit -m "feat: getNextSerial, formatSerial, validatePrefix"
```

---

## Task 3: Tool Context Injection + Edit Expiry Enforcement

**Files:**
- Modify: `src/agent/tools/registry.ts`
- Modify: `src/editing/safe-writer.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/server/websocket.ts`

- [ ] **Step 1: Update `registry.ts`**

Replace `src/agent/tools/registry.ts`:

```typescript
import type { ToolDefinition, ToolCall } from '../providers/base.js';

export interface ToolContext {
  sessionId: string;
  vaultPath: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context?: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();
  register(handler: ToolHandler): void { this.tools.set(handler.definition.name, handler); }
  getDefinitions(): ToolDefinition[] { return Array.from(this.tools.values()).map(h => h.definition); }
  has(name: string): boolean { return this.tools.has(name); }

  async execute(toolCall: ToolCall, context?: ToolContext): Promise<string> {
    const handler = this.tools.get(toolCall.name);
    if (!handler) return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
    try {
      return await handler.execute(toolCall.arguments, context);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : 'Tool execution failed' });
    }
  }
}
```

- [ ] **Step 2: Add expiry check to `SafeWriter.confirmEdit`**

In `src/editing/safe-writer.ts`, find `confirmEdit`. The method currently starts with:
```typescript
const pending = this.pendingEdits.get(editId);
if (!pending) {
  return { success: false, editId, action, error: 'Edit proposal not found or already resolved.' };
}
```

**Replace** that existing initial pending-lookup block with this expiry-aware version (do NOT add a second `const pending` — replace the one that's there):

```typescript
const EDIT_TTL_MS = 30 * 60 * 1000;
const pending = this.pendingEdits.get(editId);
if (!pending) {
  return { success: false, editId, action, error: 'Edit proposal not found or already resolved.' };
}
if (Date.now() - pending.createdAt > EDIT_TTL_MS) {
  this.pendingEdits.delete(editId);
  return { success: false, editId, action, error: 'Edit expired — please re-run the tool to generate a fresh edit.' };
}
// ... rest of existing logic unchanged ...
```

Also update `SafeWriter` to support the `meta` field:

1. Update the `pendingEdits` Map type declaration to include `meta`:
```typescript
// Change the Map type (currently):
private pendingEdits: Map<string, EditProposal & { triggerQuery: string; sessionId: string; createdAt: number }> = new Map();
// To:
private pendingEdits: Map<string, EditProposal & { triggerQuery: string; sessionId: string; createdAt: number; meta: Record<string, unknown> }> = new Map();
```

2. Update `proposeEdit` signature and storage to accept and store `meta`:
```typescript
proposeEdit(
  filePath: string,
  newContent: string,
  triggerQuery: string,
  sessionId: string,
  meta: Record<string, unknown> = {},
): EditProposal {
  // ...existing logic unchanged...
  this.pendingEdits.set(editId, { ...proposal, triggerQuery, sessionId, createdAt: Date.now(), meta });
  // ...
}
```

3. Add `getPendingEditMeta` after `confirmEdit`:
```typescript
/**
 * Return metadata from a pending edit without consuming it.
 * Must be called BEFORE confirmEdit (which deletes the entry on success/cancel).
 */
getPendingEditMeta(editId: string): Record<string, unknown> | undefined {
  return this.pendingEdits.get(editId)?.meta;
}
```

In `runtime.ts`, when calling `proposeEdit` for a `pending_edit` result, pass the metadata (use `userMessage` not `query` — that is the runtime variable name):

```typescript
// Replace:
const proposal = this.safeWriter.proposeEdit(parsed.path, parsed.newContent, userMessage, sessionId);
// With:
const meta: Record<string, unknown> = { operation: parsed.operation ?? '', path: parsed.path };
if (parsed.reservation && typeof parsed.reservation === 'object') {
  Object.assign(meta, parsed.reservation); // adds project_id, prefix
}
const proposal = this.safeWriter.proposeEdit(parsed.path, parsed.newContent, userMessage, sessionId, meta);
```

- [ ] **Step 3: Update `runtime.ts`**

Add import at top:
```typescript
import { type ToolContext } from './tools/registry.js';
```

In tool execution loop, change `this.registry.execute(tc)` to:
```typescript
const toolContext: ToolContext = { sessionId, vaultPath: this.config.vaultPath };
const result = await this.registry.execute(tc, toolContext);
```

After `this.safeWriter.proposeEdit(...)`, add reservation tracking:
```typescript
if (parsed.reservation && typeof parsed.reservation === 'object') {
  const { project_id, prefix } = parsed.reservation as { project_id: string; prefix: string };
  const db = getDatabase();
  db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?').run(proposal.editId, project_id);
}
```

Update `confirmEdit` signature:
```typescript
async confirmEdit(editId: string, action: 'apply' | 'force' | 'cancel', sessionId: string): Promise<{ success: boolean; message: string }>
```

Inside `confirmEdit`, before calling `safeWriter.confirmEdit`:
```typescript
const db = getDatabase();
db.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());
```

Before calling `this.safeWriter.confirmEdit(editId, action)`, fetch the metadata FIRST (confirmEdit deletes the entry on success/cancel):
```typescript
// Fetch meta BEFORE confirmEdit deletes the pending entry
const editMeta = this.safeWriter.getPendingEditMeta(editId) ?? {};
const result = this.safeWriter.confirmEdit(editId, action);
```

After `const result = ...`:
```typescript
if (action === 'cancel') {
  db.prepare('DELETE FROM prefix_reservations WHERE edit_id = ?').run(editId);
}
const eventType = (action === 'cancel' || !result.success) ? 'edit_cancelled' : 'edit_confirmed';
// Include full edit metadata (operation, path, project_id, prefix) so agent can
// call register_project_counters and update_project_index after create_project confirmation.
db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)')
  .run(sessionId, eventType, JSON.stringify({ editId, action, success: result.success, ...editMeta }), Date.now());
```

- [ ] **Step 4: Update `websocket.ts`**

```typescript
// Change:
const result = await runtime.confirmEdit(editId, action);
// To:
const result = await runtime.confirmEdit(editId, action, client.sessionId);
```

- [ ] **Step 5: Add workflow event metadata test**

Append to `tests/unit/safe-writer-expiry.test.ts` (or create `tests/unit/workflow-event-meta.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { SafeWriter } from '../../src/editing/safe-writer.js';

describe('SafeWriter.getPendingEditMeta', () => {
  it('returns meta before confirmEdit deletes the entry', () => {
    const sw = new SafeWriter();
    const meta = { operation: 'create_project', project_id: 'P001', prefix: 'CM' };
    // Use a non-existent path — just testing meta storage, not file writing
    sw.proposeEdit('/tmp/test-meta.md', '# content', 'trigger', 'sess1', meta);
    // pendingEdits has one entry; retrieve the editId
    const editId = [...(sw as unknown as { pendingEdits: Map<string, { editId: string }> }).pendingEdits.keys()][0];
    const retrieved = sw.getPendingEditMeta(editId);
    expect(retrieved).toEqual(meta);
  });

  it('returns undefined after confirmEdit (entry deleted)', () => {
    const sw = new SafeWriter();
    const meta = { operation: 'create_project', project_id: 'P001', prefix: 'CM' };
    sw.proposeEdit('/tmp/test-meta2.md', '# content', 'trigger', 'sess1', meta);
    const editId = [...(sw as unknown as { pendingEdits: Map<string, unknown> }).pendingEdits.keys()][0];
    sw.confirmEdit(editId, 'cancel');
    expect(sw.getPendingEditMeta(editId)).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run existing tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/registry.ts src/editing/safe-writer.ts src/agent/runtime.ts src/server/websocket.ts tests/unit/workflow-event-meta.test.ts
git commit -m "feat: ToolContext injection, edit expiry (30 min), workflow_events on confirm/cancel"
```

---

## Task 4: `autoWrite`, `fencedSectionUpdate`, `frontmatterFieldUpdate`

**Files:**
- Create: `src/editing/auto-writer.ts`
- Test: `tests/unit/auto-writer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/auto-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoWrite, fencedSectionUpdate, frontmatterFieldUpdate } from '../../src/editing/auto-writer.js';

describe('autoWrite', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('writes a file in the allowlist', () => {
    const target = path.join(vaultPath, 'Knowledge', 'Review-Queue', 'test.md');
    autoWrite(target, '# Test', vaultPath);
    expect(fs.readFileSync(target, 'utf-8')).toBe('# Test');
  });

  it('throws for paths outside the allowlist', () => {
    const target = path.join(vaultPath, 'Projects', 'P001', 'CM001.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    expect(() => autoWrite(target, '# x', vaultPath)).toThrow('autoWrite not permitted');
  });
});

describe('fencedSectionUpdate', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fsu-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('replaces only the fenced section, leaving user content untouched', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(filePath, `---\nnote_kind: project\n---\n\n<!-- AUTO-GENERATED: experiment-log -->\nold\n<!-- END AUTO-GENERATED: experiment-log -->\n\nUser content.\n`);
    fencedSectionUpdate(filePath, 'experiment-log', 'new row', vaultPath);
    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('new row');
    expect(result).not.toContain('\nold\n');
    expect(result).toContain('User content.');
  });

  it('throws for ineligible paths', () => {
    const fp = path.join(vaultPath, 'Knowledge', 'foo.md');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'x');
    expect(() => fencedSectionUpdate(fp, 'experiment-log', 'x', vaultPath)).toThrow('not permitted');
  });

  it('throws if open marker not found', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(filePath, '# no fence');
    expect(() => fencedSectionUpdate(filePath, 'experiment-log', 'x', vaultPath)).toThrow("fence 'experiment-log' not found");
  });
});

describe('frontmatterFieldUpdate', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ffu-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates kb_status in a Reading/Papers note', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: Test\nkb_status: pending\n---\n\n# Body');
    frontmatterFieldUpdate(filePath, 'kb_status', 'mapped', vaultPath);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('kb_status: mapped');
    expect(content).not.toContain('kb_status: pending');
    expect(content).toContain('# Body');
  });

  it('throws for ineligible field', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: x\n---\n');
    expect(() => frontmatterFieldUpdate(filePath, 'title', 'new', vaultPath)).toThrow('not permitted');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/auto-writer.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `src/editing/auto-writer.ts`**

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { resolveVaultPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
const log = logger.child('auto-writer');

function isAutoWriteAllowed(rel: string): boolean {
  return (
    rel.startsWith('Knowledge/Review-Queue/') ||
    rel.startsWith('Knowledge/_Ops/Update-Logs/') ||
    rel.startsWith('Knowledge/_Ops/Lint-Reports/') ||
    /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(rel) ||
    /^Reading\/(Papers|Threads)\/.*-mapping\.md$/.test(rel) ||
    /^Projects\/P\d+-[^/]+\/.*-mapping\.md$/.test(rel)
  );
}

function isFencedSectionAllowed(rel: string): boolean {
  return (
    /^Projects\/P\d+-[^/]+\/_index\.md$/.test(rel) ||
    /^Projects\/P\d+-[^/]+\/[A-Z]+S\d+-[^/]+\.md$/.test(rel)
  );
}

function isFrontmatterFieldAllowed(rel: string, field: string): boolean {
  if ((rel.startsWith('Reading/Papers/') || rel.startsWith('Reading/Threads/')) && field === 'kb_status') return true;
  if (/^Knowledge\/(Concepts|Entities|Methods)\/(?!_index\.md)/.test(rel) && ['needs_review', 'review_flagged_at'].includes(field)) return true;
  return false;
}

function sha256(content: string): string { return crypto.createHash('sha256').update(content).digest('hex'); }

function writeFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, absPath);
}

function resolveChecked(filePath: string, vaultPath: string): { abs: string; rel: string } {
  const rel = path.relative(vaultPath, filePath).replace(/\\/g, '/');
  const abs = resolveVaultPath(vaultPath, rel); // throws if outside vault
  return { abs, rel };
}

export function autoWrite(filePath: string, content: string, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isAutoWriteAllowed(rel)) throw new Error(`autoWrite not permitted for ${rel}`);
  writeFile(abs, content);
  log.info('autoWrite', { rel });
}

export function fencedSectionUpdate(filePath: string, sectionName: string, newContent: string, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isFencedSectionAllowed(rel)) throw new Error(`fencedSectionUpdate not permitted for ${rel}`);
  const open = `<!-- AUTO-GENERATED: ${sectionName} -->`;
  const close = `<!-- END AUTO-GENERATED: ${sectionName} -->`;

  function attempt(): boolean {
    const current = fs.readFileSync(abs, 'utf-8');
    const hashBefore = sha256(current);
    const openIdx = current.indexOf(open);
    if (openIdx === -1) throw new Error(`AUTO-GENERATED fence '${sectionName}' not found in ${rel}`);
    const closeIdx = current.indexOf(close, openIdx);
    if (closeIdx === -1) throw new Error(`END AUTO-GENERATED fence '${sectionName}' not found in ${rel}`);
    if (current.indexOf(open, openIdx + 1) !== -1) throw new Error(`Duplicate AUTO-GENERATED fence '${sectionName}' in ${rel}`);
    const updated = current.slice(0, openIdx + open.length) + '\n' + newContent + '\n' + current.slice(closeIdx);
    if (sha256(fs.readFileSync(abs, 'utf-8')) !== hashBefore) return false;
    writeFile(abs, updated);
    return true;
  }
  if (!attempt() && !attempt()) throw new Error(`Conflict persists after retry in ${rel}`);
}

export function frontmatterFieldUpdate(filePath: string, field: string, value: string | boolean | null, vaultPath: string): void {
  const { abs, rel } = resolveChecked(filePath, vaultPath);
  if (!isFrontmatterFieldAllowed(rel, field)) throw new Error(`frontmatterFieldUpdate not permitted: field '${field}' on ${rel}`);

  function attempt(): boolean {
    const current = fs.readFileSync(abs, 'utf-8');
    const hashBefore = sha256(current);
    const parsed = matter(current);
    parsed.data[field] = value;
    const updated = matter.stringify(parsed.content, parsed.data);
    if (sha256(fs.readFileSync(abs, 'utf-8')) !== hashBefore) return false;
    writeFile(abs, updated);
    return true;
  }
  if (!attempt() && !attempt()) throw new Error(`Conflict updating ${field} in ${rel}`);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/auto-writer.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/editing/auto-writer.ts tests/unit/auto-writer.test.ts
git commit -m "feat: autoWrite, fencedSectionUpdate, frontmatterFieldUpdate editing primitives"
```

---

## Task 5: `reserve_prefix` and `register_project_counters`

**Files:**
- Create: `src/agent/tools/serial-tools.ts`
- Test: `tests/unit/serial-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/serial-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import matter from 'gray-matter';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('reserve_prefix', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns reserved:true for valid prefix', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.reserved).toBe(true);
    expect(r.expires_at).toBeGreaterThan(Date.now());
  });

  it('rejects reserved system prefix PR', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'PR', project_id: 'P001' }));
    expect(r.error).toBeDefined();
  });

  it('rejects invalid prefix format (1 char)', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'C', project_id: 'P001' }));
    expect(r.error).toContain('format');
  });

  it('rejects CM if CMS is already registered in serial_counters', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CMS', 'P002');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.error).toContain('collision');
  });

  it('rejects CM if CMS is already reserved in prefix_reservations', async () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CMS', 'P002', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.error).toContain('collision');
  });

  it('is idempotent for same project_id', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    await tool.execute({ prefix: 'CM', project_id: 'P001' });
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.reserved).toBe(true);
  });

  it('rejects if prefix reserved by different project', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    await tool.execute({ prefix: 'CM', project_id: 'P001' });
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P002' }));
    expect(r.error).toContain('reserved by project');
  });
});

describe('register_project_counters', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('registers both counters and removes reservation when _index.md confirmed', async () => {
    // Must have a confirmed _index.md on disk — reservation only verifies ownership
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
    expect(r.counters).toContain('CM');
    expect(r.counters).toContain('CM-S');
    expect(db.prepare('SELECT * FROM prefix_reservations WHERE prefix = ?').get('CM')).toBeUndefined();
  });

  it('errors when no _index.md exists even with active reservation', async () => {
    // Reservation alone is NOT sufficient — file must be confirmed on disk
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toMatch(/Apply the pending project edit/);
  });

  it('is idempotent — both counters already exist for same project (no file check needed)', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    // No _index.md created — should still succeed (idempotent path)
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
  });

  it('errors on partial state (only one counter) when no _index.md exists', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    // CM-S missing — partial state, no _index.md
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toMatch(/Apply the pending project edit/);
  });

  it('repairs partial state when _index.md exists', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    // CM-S missing but _index.md is confirmed
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
    expect(r.repaired).toBe(true);
    const cmS = db.prepare('SELECT * FROM serial_counters WHERE scope = ?').get('CM-S') as { project_id: string } | undefined;
    expect(cmS?.project_id).toBe('P001');
  });

  it('errors if prefix counter registered by different project', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P002');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toContain('already registered');
  });

  it('errors if only one counter exists (partial state)', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    // CM-S intentionally missing
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    // Should either repair (add CM-S) or error — both are valid; check it doesn't silently succeed with incomplete state
    if (r.registered) {
      const cmS = db.prepare('SELECT * FROM serial_counters WHERE scope = ?').get('CM-S') as { project_id: string } | undefined;
      expect(cmS?.project_id).toBe('P001'); // auto-repaired
    } else {
      expect(r.error).toBeDefined();
    }
  });

  it('auto-heals from _index.md when no reservation exists', async () => {
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
  });

  it('errors on duplicate project folders during auto-heal', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-OtherName'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-OtherName', '_index.md'), matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toContain('Duplicate');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```
Expected: FAIL

- [ ] **Step 3: Create `src/agent/tools/serial-tools.ts` (initial — reserve_prefix + register_project_counters)**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler, ToolContext } from './registry.js';
import { getDatabase } from '../../storage/database.js';
import { getNextSerial, validatePrefix } from '../../storage/serial.js';
import { fencedSectionUpdate } from '../../editing/auto-writer.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

const log = logger.child('serial-tools');
const RESERVED_PREFIXES = new Set(['PR', 'P']);
const RESERVATION_TTL_MS = 30 * 60 * 1000;

/**
 * Check for prefix conflicts in both serial_counters AND prefix_reservations.
 * Checks: permanently reserved names, prefix+S collision, parent prefix collision.
 * Returns an error string or undefined.
 */
function checkPrefixCollision(prefix: string, excludeProjectId: string | null, db: Database.Database): string | undefined {
  if (RESERVED_PREFIXES.has(prefix)) return `Prefix "${prefix}" is permanently reserved.`;

  const now = Date.now();
  const excl = excludeProjectId ?? '__none__';

  // Check prefix+S collision in counters
  const cntSuffix = db.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(prefix + 'S') as { project_id: string | null } | undefined;
  if (cntSuffix && cntSuffix.project_id !== excludeProjectId) return `Prefix "${prefix}" collides with registered series prefix "${prefix}S".`;

  // Check prefix+S collision in reservations
  const resSuffix = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(prefix + 'S', now) as { project_id: string } | undefined;
  if (resSuffix && resSuffix.project_id !== excl) return `Prefix "${prefix}" collides with reserved series prefix "${prefix}S".`;

  // Check parent prefix collision (if prefix ends with S)
  if (prefix.length > 2 && prefix.endsWith('S')) {
    const parent = prefix.slice(0, -1);
    const cntParent = db.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(parent) as { project_id: string | null } | undefined;
    if (cntParent && cntParent.project_id !== excludeProjectId) return `Prefix "${prefix}" collides with registered prefix "${parent}".`;
    const resParent = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(parent, now) as { project_id: string } | undefined;
    if (resParent && resParent.project_id !== excl) return `Prefix "${prefix}" collides with reserved prefix "${parent}".`;
  }

  return undefined;
}

export function createSerialTools(vaultPath: string, injectedDb?: Database.Database): ToolHandler[] {
  const db = () => injectedDb ?? getDatabase();

  /** Find a project folder safely (uses resolveVaultPath to prevent symlink escape) */
  function resolveProject(projectId: string, database: Database.Database): { prefix: string; folderPath: string } | { error: string } {
    const projectsDir = path.join(vaultPath, 'Projects');
    let matches: string[] = [];
    try {
      matches = fs.readdirSync(projectsDir).filter(e => e.startsWith(projectId + '-'));
    } catch { return { error: `Project ${projectId} does not exist (Projects/ dir unreadable).` }; }
    if (matches.length === 0) return { error: `Project ${projectId} does not exist.` };
    if (matches.length > 1) return { error: `Duplicate project folders for ${projectId}: [${matches.join(', ')}]. Fix vault structure before continuing.` };

    const folderPath = path.join(projectsDir, matches[0]);
    let indexPath: string;
    try {
      // Use resolveVaultPath to prevent symlink escape
      indexPath = resolveVaultPath(vaultPath, path.join('Projects', matches[0], '_index.md'));
    } catch { return { error: `Project ${projectId} _index.md path is invalid.` }; }

    if (!fs.existsSync(indexPath)) return { error: `Project ${projectId} has no _index.md.` };
    const parsed = matter(fs.readFileSync(indexPath, 'utf-8'));
    const prefix = parsed.data.prefix as string | undefined;
    if (!prefix) return { error: `Project ${projectId} _index.md is missing the prefix field.` };

    const counter = database.prepare('SELECT scope FROM serial_counters WHERE scope = ?').get(prefix) as { scope: string } | undefined;
    if (!counter) return { error: `Project ${projectId} counters not registered. Call register_project_counters(project_id="${projectId}", prefix="${prefix}") first.` };

    return { prefix, folderPath };
  }

  return [
    // ── reserve_prefix ──────────────────────────────────────────────────────
    {
      definition: {
        name: 'reserve_prefix',
        description: 'Temporarily reserve a project prefix (2–3 uppercase letters). Call before create_project to lock the prefix.',
        parameters: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: '2–3 uppercase letters (e.g. "CM")' },
            project_id: { type: 'string', description: 'Project ID that will own this prefix (e.g. "P001")' },
          },
          required: ['prefix', 'project_id'],
        },
      },
      execute: async (args) => {
        const rawPrefix = (args.prefix as string).toUpperCase();
        const projectId = args.project_id as string;
        try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
        const database = db();
        database.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());

        const existing = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
        if (existing) {
          if (existing.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is permanently registered to another project.` });
          return JSON.stringify({ reserved: true, expires_at: Date.now() + RESERVATION_TTL_MS });
        }

        const collision = checkPrefixCollision(rawPrefix, projectId, database);
        if (collision) return JSON.stringify({ error: collision });

        const existingRes = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get(rawPrefix) as { project_id: string } | undefined;
        if (existingRes && existingRes.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is temporarily reserved by project ${existingRes.project_id}.` });

        const expiresAt = Date.now() + RESERVATION_TTL_MS;
        database.prepare(
          'INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(prefix) DO UPDATE SET expires_at = excluded.expires_at WHERE project_id = excluded.project_id'
        ).run(rawPrefix, projectId, expiresAt);
        return JSON.stringify({ reserved: true, expires_at: expiresAt });
      },
    },

    // ── register_project_counters ────────────────────────────────────────────
    {
      definition: {
        name: 'register_project_counters',
        description: 'Finalize a project by registering prefix counters in serial_counters. Call after user confirms project _index.md.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            prefix: { type: 'string' },
          },
          required: ['project_id', 'prefix'],
        },
      },
      execute: async (args) => {
        const projectId = args.project_id as string;
        const rawPrefix = (args.prefix as string).toUpperCase();
        try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
        const database = db();

        // Check both counters
        const cnt = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
        const cntS = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(`${rawPrefix}-S`) as { project_id: string | null } | undefined;

        // Ownership conflict checks — return error immediately regardless of file state
        if (cnt && cnt.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is already registered to project ${cnt.project_id}.` });
        if (cntS && cntS.project_id !== projectId) return JSON.stringify({ error: `Series prefix "${rawPrefix}-S" is already registered to project ${cntS.project_id}.` });

        // ONLY the fully idempotent case (both counters exist for same project) skips the file check
        if (cnt && cntS) {
          return JSON.stringify({ registered: true, counters: [rawPrefix, `${rawPrefix}-S`] });
        }

        // ALL other paths (partial state or fresh registration) REQUIRE confirmed _index.md on disk.
        // Use reservation only to verify ownership, not as a substitute for the file.
        const projectsDir = path.join(vaultPath, 'Projects');
        const matches: string[] = [];
        try {
          for (const entry of fs.readdirSync(projectsDir)) {
            if (!entry.startsWith(projectId + '-')) continue;
            try {
              const indexPath = resolveVaultPath(vaultPath, path.join('Projects', entry, '_index.md'));
              if (fs.existsSync(indexPath)) {
                const p = matter(fs.readFileSync(indexPath, 'utf-8'));
                if (p.data.id === projectId && p.data.prefix === rawPrefix) matches.push(entry);
              }
            } catch { /* skip invalid paths */ }
          }
        } catch { return JSON.stringify({ error: `Projects/ directory unreadable.` }); }
        if (matches.length > 1) return JSON.stringify({ error: `Duplicate project folders for ${projectId}: [${matches.join(', ')}]. Fix vault structure first.` });
        if (matches.length === 0) return JSON.stringify({ error: `No confirmed _index.md found for project ${projectId} with prefix "${rawPrefix}". Apply the pending project edit before calling register_project_counters.` });

        // If there's a reservation, verify ownership
        const res = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(rawPrefix, Date.now()) as { project_id: string } | undefined;
        if (res && res.project_id !== projectId) {
          return JSON.stringify({ error: `Reservation for "${rawPrefix}" is owned by project ${res.project_id}.` });
        }

        const collision = checkPrefixCollision(rawPrefix, projectId, database);
        if (collision) return JSON.stringify({ error: collision });

        // Repair partial state or register fresh — _index.md confirmed above
        database.transaction(() => {
          if (!cnt) database.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(rawPrefix, projectId);
          if (!cntS) database.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(`${rawPrefix}-S`, projectId);
          database.prepare('DELETE FROM prefix_reservations WHERE prefix = ?').run(rawPrefix);
        })();
        const repaired = (cnt && !cntS) || (!cnt && cntS);
        return JSON.stringify({ registered: true, counters: [rawPrefix, `${rawPrefix}-S`], ...(repaired ? { repaired: true } : {}) });
      },
    },
  ];
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/serial-tools.ts tests/unit/serial-tools.test.ts
git commit -m "feat: reserve_prefix + register_project_counters with full collision/idempotency/auto-heal"
```

---

## Task 6: `create_project` Tool

**Files:**
- Modify: `src/agent/tools/serial-tools.ts`
- Test: `tests/unit/serial-tools.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/serial-tools.test.ts`:

```typescript
describe('create_project', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns pending_edit with correct path and reservation', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Cell Migration', prefix: 'CM' }));
    expect(r.type).toBe('pending_edit');
    expect(r.path).toMatch(/P001-CellMigration\/_index\.md$/);
    expect(r.reservation).toEqual({ project_id: 'P001', prefix: 'CM' });
  });

  it('frontmatter built via gray-matter — injection not possible', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Cell:\nmalicious: injected', prefix: 'CM' }));
    const parsed = matter(r.newContent);
    expect(parsed.data.malicious).toBeUndefined();
    expect(parsed.data.note_kind).toBe('project');
  });

  it('rejects invalid prefix format before consuming serial', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'TOOLONG' }));
    expect(r.error).toBeDefined();
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number }).next_val).toBe(1);
  });

  it('rejects prefix already permanently registered to another project', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P999');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'CM' }));
    expect(r.error).toMatch(/already permanently registered/);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number }).next_val).toBe(1);
  });

  it('rejects prefix reserved by different project', async () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P999', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'CM' }));
    expect(r.error).toBeDefined();
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number }).next_val).toBe(1);
  });

  it('stores reservation after allocating serial', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    await tool.execute({ title: 'Cell Migration', prefix: 'CM' });
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number }).next_val).toBe(2);
    const res = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get('CM') as { project_id: string } | undefined;
    expect(res?.project_id).toBe('P001');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/serial-tools.test.ts -t "create_project"
```
Expected: FAIL

- [ ] **Step 3: Add `create_project` to `createSerialTools`**

```typescript
{
  definition: {
    name: 'create_project',
    description: 'Create a new project. Returns pending_edit for user confirmation. Allocates a serial P-ID and temporarily reserves the prefix.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prefix: { type: 'string', description: '2–3 uppercase letters. Omit to get a suggestion.' },
        description: { type: 'string' },
      },
      required: ['title'],
    },
  },
  execute: async (args) => {
    const title = args.title as string;
    const database = db();

    if (!args.prefix) {
      const suggested = title.split(/\s+/).map(w => w[0]?.toUpperCase() ?? '').join('').replace(/[^A-Z]/g, '').slice(0, 3);
      return JSON.stringify({ type: 'prefix_suggestion', suggested_prefix: suggested || 'XX', message: `Suggested prefix: "${suggested || 'XX'}". Confirm or provide different prefix.` });
    }

    const rawPrefix = (args.prefix as string).toUpperCase();
    try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }

    database.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());

    // Reject if prefix is already permanently registered to any project
    const existingCounter = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
    if (existingCounter) return JSON.stringify({ error: `Prefix "${rawPrefix}" is already permanently registered to project ${existingCounter.project_id ?? 'unknown'}.` });

    const collision = checkPrefixCollision(rawPrefix, null, database);
    if (collision) return JSON.stringify({ error: collision });

    // Reject if prefix already reserved by any project
    const existingRes = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get(rawPrefix) as { project_id: string } | undefined;
    if (existingRes) return JSON.stringify({ error: `Prefix "${rawPrefix}" is temporarily reserved by project ${existingRes.project_id}.` });

    // Allocate serial + reserve in one transaction (TOCTOU safe)
    let projectId = '';
    database.transaction(() => {
      const serial = getNextSerial('project', database);
      projectId = `P${serial}`;
      database.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run(rawPrefix, projectId, Date.now() + RESERVATION_TTL_MS);
    })();

    const folderName = `${projectId}-${title.replace(/[^a-zA-Z0-9]+/g, '')}`;
    const today = new Date().toISOString().slice(0, 10);
    const fmData: Record<string, unknown> = { note_kind: 'project', id: projectId, prefix: rawPrefix, title, status: 'active', created: today };
    if (args.description) fmData.description = args.description as string;
    const body = `\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n`;
    const newContent = matter.stringify(body, fmData);
    const absPath = resolveVaultPath(vaultPath, path.join('Projects', folderName, '_index.md'));
    return JSON.stringify({ type: 'pending_edit', operation: 'create_project', path: absPath, newContent, reservation: { project_id: projectId, prefix: rawPrefix } });
  },
},
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/serial-tools.ts tests/unit/serial-tools.test.ts
git commit -m "feat: create_project — transactional serial+reservation, gray-matter safety, format validation"
```

---

## Task 7: `create_experiment`, `create_series`, `create_protocol` Tools

**Files:**
- Modify: `src/agent/tools/serial-tools.ts`
- Modify: `src/agent/tools/templates.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/serial-tools.test.ts`:

```typescript
describe('create_experiment', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'),
      matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM', title: 'CM', status: 'active', created: '2026-04-11' }));
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns pending_edit with CM001 filename', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'Western Blot', experiment_type: 'western-blot' }));
    expect(r.type).toBe('pending_edit');
    expect(r.path).toMatch(/CM001-western-blot\.md$/);
    const fm = matter(r.newContent).data;
    expect(fm.note_kind).toBe('experiment');
    expect(fm.id).toBe('CM001');
    expect(fm.project_id).toBe('P001');
  });

  it('validates protocol file exists if provided', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'WB', experiment_type: 'wb', protocol: 'PR999-nonexistent' }));
    expect(r.error).toContain('PR999-nonexistent');
  });

  it('errors if project counters not registered', async () => {
    db.prepare('DELETE FROM serial_counters WHERE scope = ?').run('CM');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'Test', experiment_type: 'pcr' }));
    expect(r.error).toBeDefined();
  });
});

describe('create_protocol', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'prot-'));
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns PR001 filename with correct frontmatter', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_protocol')!;
    const r = JSON.parse(await tool.execute({ title: 'Western Blot', category: 'protein-analysis' }));
    expect(r.path).toMatch(/PR001-western-blot\.md$/);
    const fm = matter(r.newContent).data;
    expect(fm.id).toBe('PR001');
    expect(fm.category).toBe('protein-analysis');
    expect(fm.malicious).toBeUndefined(); // gray-matter safety
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/serial-tools.test.ts -t "create_experiment|create_protocol"
```
Expected: FAIL

- [ ] **Step 3: Add `create_experiment`, `create_series`, `create_protocol` to `serial-tools.ts`**

Note: `create_series` does NOT accept an `experiments` list at creation time. Assigning experiments to a series is done via `update_series_table` after the series is confirmed.

```typescript
// create_experiment
{
  definition: {
    name: 'create_experiment',
    description: 'Create a new experiment note in a project using serial numbering. Validates protocol and series existence.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        experiment_type: { type: 'string' },
        protocol: { type: 'string', description: 'Protocol filename stem (e.g. "PR001-western-blot"). Must exist in Protocols/.' },
        samples: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' } } } },
        reagents: { type: 'array', items: { type: 'string' } },
        series: { type: 'string', description: 'Series ID to add experiment to (e.g. "CMS001"). Must exist in same project.' },
      },
      required: ['project_id', 'title', 'experiment_type'],
    },
  },
  execute: async (args) => {
    const database = db();
    const projectId = args.project_id as string;
    const resolved = resolveProject(projectId, database);
    if ('error' in resolved) return JSON.stringify({ error: resolved.error });
    const { prefix, folderPath } = resolved;

    // Validate protocol file exists (if provided)
    if (args.protocol) {
      const protocolStem = args.protocol as string;
      // Reject stems with path traversal or separator characters
      if (protocolStem.includes('/') || protocolStem.includes('\\') || protocolStem.includes('..')) {
        return JSON.stringify({ error: `Protocol stem "${protocolStem}" contains invalid characters.` });
      }
      let protocolPath: string;
      try {
        protocolPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protocolStem}.md`));
      } catch {
        return JSON.stringify({ error: `Protocol path is invalid.` });
      }
      if (!fs.existsSync(protocolPath)) {
        return JSON.stringify({ error: `Protocol "${protocolStem}" not found in Protocols/. Create it first with create_protocol.` });
      }
    }

    // Validate series exists in same project (if provided)
    if (args.series) {
      const seriesId = args.series as string;
      // Validate series_id format — prevents path traversal via malformed IDs
      if (!/^[A-Z]{2,3}S\d{3,4}$/.test(seriesId)) {
        return JSON.stringify({ error: `Series ID "${seriesId}" has invalid format. Expected pattern: CM S001 (2–3 uppercase letters + "S" + 3–4 digits).` });
      }
      const seriesFile = fs.readdirSync(folderPath).find(f => f.startsWith(seriesId + '-'));
      if (!seriesFile) return JSON.stringify({ error: `Series ${seriesId} not found in project ${projectId}.` });
      // Use resolveVaultPath to prevent symlink escape when reading series file
      let seriesPath: string;
      try {
        seriesPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), seriesFile));
      } catch {
        return JSON.stringify({ error: `Series file path is invalid.` });
      }
      const seriesFm = matter(fs.readFileSync(seriesPath, 'utf-8'));
      if (seriesFm.data.project_id !== projectId) return JSON.stringify({ error: `Series ${seriesId} belongs to project ${seriesFm.data.project_id}, not ${projectId}.` });
    }

    const serial = getNextSerial(prefix, database);
    const expId = `${prefix}${serial}`;
    const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const today = new Date().toISOString().slice(0, 10);
    const samples = (args.samples as Array<{ name: string; condition: string }> | undefined) ?? [];
    const reagents = (args.reagents as string[] | undefined) ?? [];

    const fmData: Record<string, unknown> = {
      note_kind: 'experiment', id: expId, project_id: projectId,
      title: args.title as string, experiment_type: args.experiment_type as string,
      samples, reagents, status: 'draft', created: today, attachments: [],
    };
    if (args.protocol) fmData.protocol = `[[${args.protocol as string}]]`;
    if (args.series) fmData.series = args.series as string;

    const body = `\n# ${args.title as string}\n\n## ${today} - Initial Setup\n\nTODO: Record experiment here.\n`;
    const newContent = matter.stringify(body, fmData);
    const fileName = `${expId}-${slug}.md`;
    const absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
    return JSON.stringify({ type: 'pending_edit', operation: 'create_experiment', path: absPath, newContent });
  },
},

// create_series
{
  definition: {
    name: 'create_series',
    description: 'Create an experiment series header. After user confirms, use update_series_table to assign experiments.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        objective: { type: 'string' },
      },
      required: ['project_id', 'title'],
    },
  },
  execute: async (args) => {
    const database = db();
    const projectId = args.project_id as string;
    const resolved = resolveProject(projectId, database);
    if ('error' in resolved) return JSON.stringify({ error: resolved.error });
    const { prefix, folderPath } = resolved;

    const serial = getNextSerial(`${prefix}-S`, database);
    const seriesId = `${prefix}S${serial}`;
    const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const today = new Date().toISOString().slice(0, 10);

    const fmData: Record<string, unknown> = {
      note_kind: 'series', id: seriesId, project_id: projectId,
      title: args.title as string, objective: (args.objective as string | undefined) ?? '',
      status: 'in-progress', created: today,
    };
    const body = `\n# ${args.title as string}\n\n## Objective\n${(args.objective as string | undefined) ?? 'TODO'}\n\n<!-- AUTO-GENERATED: experiment-list -->\n## Experiments\n| ID | Name | Status | Created |\n|----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-list -->\n\n## Summary\n<!-- User-owned synthesis -->\n`;
    const newContent = matter.stringify(body, fmData);
    const fileName = `${seriesId}-${slug}.md`;
    const absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
    return JSON.stringify({ type: 'pending_edit', operation: 'create_series', path: absPath, newContent, series_id: seriesId });
  },
},

// create_protocol
{
  definition: {
    name: 'create_protocol',
    description: 'Create a new protocol note with a PR-series serial ID.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string' },
        derived_from: { type: 'string' },
      },
      required: ['title', 'category'],
    },
  },
  execute: async (args) => {
    const database = db();
    const serial = getNextSerial('protocol', database);
    const protId = `PR${serial}`;
    const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const today = new Date().toISOString().slice(0, 10);
    const fmData: Record<string, unknown> = { id: protId, title: args.title as string, version: 1, category: args.category as string, created: today, last_updated: today };
    if (args.derived_from) fmData.derived_from = `[[${args.derived_from as string}]]`;
    const body = `\n# ${args.title as string}\n\n## Materials\n\n## Procedure\n\n## Notes\n`;
    const newContent = matter.stringify(body, fmData);
    const absPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protId}-${slug}.md`));
    return JSON.stringify({ type: 'pending_edit', operation: 'create_protocol', path: absPath, newContent });
  },
},
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```
Expected: PASS

- [ ] **Step 5: Remove old `create_experiment` from `templates.ts` and add gray-matter**

In `src/agent/tools/templates.ts`:
1. Add `import matter from 'gray-matter';` at the top (after existing imports)
2. Remove the old `create_experiment` handler. Keep `create_reading_note`.

Update `create_reading_note`:
- Add `related_projects` parameter
- Make `doi` optional (reading notes for preprints/threads may lack DOI)
- Change output path to `Reading/Papers/${slug}.md` (not `Reading/`)
- Build frontmatter with `matter.stringify` (prevents YAML injection)
- Add `status: 'draft'` and `kb_status: 'pending'` to frontmatter

```typescript
// Add to imports at top of templates.ts:
import matter from 'gray-matter';

// In create_reading_note definition — change doi to optional:
doi: { type: 'string', description: 'DOI (optional — omit for preprints or thread captures)' },

// Change required array from:
required: ['title', 'authors', 'year', 'journal', 'doi']
// To:
required: ['title', 'authors', 'year', 'journal']

// In create_reading_note execute:
const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const today = new Date().toISOString().slice(0, 10);
const relatedProjects = (args.related_projects as string[] | undefined) ?? [];
const fmData: Record<string, unknown> = {
  title: args.title as string,
  authors: args.authors as string[],
  year: args.year as number,
  journal: args.journal as string,
  read_date: today,
  status: 'draft',
  kb_status: 'pending',
  related_projects: relatedProjects,
  tags: ['reading'],
};
if (args.doi) fmData.doi = args.doi as string; // optional
const body = `\n# ${args.title as string}\n\n## Summary\n\n## Key Findings\n\n## Notes\n`;
const newContent = matter.stringify(body, fmData);
// Write to Reading/Papers/
const absPath = resolveVaultPath(vaultPath, path.join('Reading', 'Papers', `${slug}.md`));
return JSON.stringify({ type: 'pending_edit', operation: 'create_reading_note', path: absPath, newContent });
```

- [ ] **Step 6: Run all tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/serial-tools.ts src/agent/tools/templates.ts tests/unit/serial-tools.test.ts tests/unit/template-tools.test.ts
git commit -m "feat: create_experiment/series/protocol + update create_reading_note to Reading/Papers/"
```

---

## Task 8: `get_workflow_events`, `update_project_index`, `update_series_table`

**Files:**
- Modify: `src/agent/tools/serial-tools.ts`
- Test: `tests/unit/serial-tools.test.ts`

(Tests and implementation follow same pattern as Task 5; append to existing files)

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/serial-tools.test.ts`:

```typescript
describe('get_workflow_events', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wfe-'));
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'edit_confirmed', '{"editId":"a"}', Date.now() - 1000);
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'edit_cancelled', '{"editId":"b"}', Date.now());
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s2', 'edit_confirmed', '{"editId":"c"}', Date.now());
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns only events for current session', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'get_workflow_events')!;
    const r = JSON.parse(await tool.execute({}, { sessionId: 's1', vaultPath }));
    expect(r.events).toHaveLength(2);
  });

  it('returns empty for unknown session', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'get_workflow_events')!;
    const r = JSON.parse(await tool.execute({}, { sessionId: 'none', vaultPath }));
    expect(r.events).toHaveLength(0);
    expect(r.cursor).toBeNull();
  });
});

describe('update_project_index', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'upi-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    const indexContent = matter.stringify('<!-- AUTO-GENERATED: experiment-log -->\nold\n<!-- END AUTO-GENERATED: experiment-log -->', { note_kind: 'project', id: 'P001', prefix: 'CM' });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), indexContent);
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates fenced section in _index.md', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_project_index')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', section: 'experiment-log', content: '| new |' }));
    expect(r.updated).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), 'utf-8');
    expect(updated).toContain('| new |');
    expect(updated).not.toContain('\nold\n');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/serial-tools.test.ts -t "get_workflow_events|update_project_index"
```
Expected: FAIL

- [ ] **Step 3: Add tools to `createSerialTools`**

```typescript
// get_workflow_events
{
  definition: {
    name: 'get_workflow_events',
    description: 'Read edit confirmation/cancellation events for the current session. Use after "continue" to see what was applied.',
    parameters: { type: 'object', properties: { after_event_id: { type: 'number' } }, required: [] },
  },
  execute: async (args, context) => {
    const sessionId = context?.sessionId;
    if (!sessionId) return JSON.stringify({ error: 'No session context.' });
    const database = db();
    const afterId = typeof args.after_event_id === 'number' ? args.after_event_id : 0;
    const events = database.prepare(
      'SELECT id, event_type, payload, timestamp FROM workflow_events WHERE session_id = ? AND id > ? ORDER BY id ASC'
    ).all(sessionId, afterId) as Array<{ id: number; event_type: string; payload: string; timestamp: number }>;
    const cursor = events.length > 0 ? events[events.length - 1].id : null;
    return JSON.stringify({ events: events.map(e => ({ id: e.id, event_type: e.event_type, payload: JSON.parse(e.payload), timestamp: e.timestamp })), cursor });
  },
},

// update_project_index
{
  definition: {
    name: 'update_project_index',
    description: 'Update an auto-generated fenced section in a project _index.md. No user confirmation required — agent-owned sections only.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        section: { type: 'string', description: '"experiment-log" or "project-summary"' },
        content: { type: 'string' },
      },
      required: ['project_id', 'section', 'content'],
    },
  },
  execute: async (args) => {
    const database = db();
    // Enforce strict allowlist — this tool bypasses user confirmation
    const ALLOWED_SECTIONS = new Set(['experiment-log', 'project-summary']);
    const section = args.section as string;
    if (!ALLOWED_SECTIONS.has(section)) {
      return JSON.stringify({ error: `Section "${section}" is not allowed. Valid sections: experiment-log, project-summary.` });
    }
    const resolved = resolveProject(args.project_id as string, database);
    if ('error' in resolved) return JSON.stringify({ error: resolved.error });
    const indexPath = path.join(resolved.folderPath, '_index.md');
    try {
      fencedSectionUpdate(indexPath, section, args.content as string, vaultPath);
      return JSON.stringify({ updated: true });
    } catch (err) { return JSON.stringify({ error: (err as Error).message }); }
  },
},

// update_series_table
{
  definition: {
    name: 'update_series_table',
    description: 'Update the auto-generated experiment list in a series header file. No user confirmation required.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        series_id: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['project_id', 'series_id', 'content'],
    },
  },
  execute: async (args) => {
    const database = db();
    const seriesId = args.series_id as string;
    // Validate series_id format — prevents malformed IDs from scanning files
    if (!/^[A-Z]{2,3}S\d{3,4}$/.test(seriesId)) {
      return JSON.stringify({ error: `Series ID "${seriesId}" has invalid format. Expected pattern: CMS001 (2–3 uppercase letters + "S" + 3–4 digits).` });
    }
    const resolved = resolveProject(args.project_id as string, database);
    if ('error' in resolved) return JSON.stringify({ error: resolved.error });
    const entries = fs.readdirSync(resolved.folderPath);
    const seriesFile = entries.find(f => f.startsWith(seriesId + '-'));
    if (!seriesFile) return JSON.stringify({ error: `Series ${seriesId} not found in project ${args.project_id}.` });
    let seriesPath: string;
    try {
      seriesPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(resolved.folderPath), seriesFile));
    } catch {
      return JSON.stringify({ error: `Series file path is invalid.` });
    }
    try {
      fencedSectionUpdate(seriesPath, 'experiment-list', args.content as string, vaultPath);
      return JSON.stringify({ updated: true });
    } catch (err) { return JSON.stringify({ error: (err as Error).message }); }
  },
},
```

- [ ] **Step 4: Add tests for update_project_index and update_series_table**

Append to `tests/unit/serial-tools.test.ts`:

```typescript
describe('update_project_index', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'upi-'));
    // Create a project folder with an _index.md containing the auto-generated section
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    const indexContent = `---\nnote_kind: project\nid: P001\nprefix: CM\n---\n\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| old |\n<!-- END AUTO-GENERATED: experiment-log -->\n`;
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), indexContent);
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates allowed section successfully', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_project_index')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', section: 'experiment-log', content: '| CM001 | new row |' }));
    expect(r.updated).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), 'utf-8');
    expect(updated).toContain('CM001');
  });

  it('rejects non-allowlisted section', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_project_index')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', section: 'arbitrary-section', content: 'malicious' }));
    expect(r.error).toMatch(/not allowed/);
  });
});

describe('update_series_table', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ust-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    const seriesContent = `---\nnote_kind: series\nid: CMS001\nproject_id: P001\n---\n\n<!-- AUTO-GENERATED: experiment-list -->\n| old |\n<!-- END AUTO-GENERATED: experiment-list -->\n`;
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', 'CMS001-series.md'), seriesContent);
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates experiment list in series file', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_series_table')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', series_id: 'CMS001', content: '| CM001 | western blot |' }));
    expect(r.updated).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, 'Projects', 'P001-CM', 'CMS001-series.md'), 'utf-8');
    expect(updated).toContain('CM001');
  });

  it('errors if series not found in project', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_series_table')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', series_id: 'CMS999', content: '...' }));
    expect(r.error).toContain('not found');
  });
});
```

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/serial-tools.ts tests/unit/serial-tools.test.ts
git commit -m "feat: get_workflow_events, update_project_index (allowlist), update_series_table + tests"
```

---

## Task 9: Register Serial Tools in Runtime

- [ ] **Step 1: Import and register**

In `src/agent/runtime.ts`, add:

```typescript
import { createSerialTools } from './tools/serial-tools.js';
// In constructor, after existing registrations:
for (const tool of createSerialTools(config.vaultPath)) {
  this.registry.register(tool);
}
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/agent/runtime.ts
git commit -m "feat: register serial tools in AgentRuntime"
```

---

## Task 10: `vault_search` Fast Path + `vault_list` Project Filter

**Files:**
- Modify: `src/agent/tools/search.ts` (fast path; injectable db)
- Modify: `src/agent/tools/vault.ts` (project_id + series filter; injectable db)
- Test: `tests/unit/vault-serial-search.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/vault-serial-search.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { createVaultTools } from '../../src/agent/tools/vault.js';

describe('vault_list with project_id and series filter (injectable db)', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vlt-'));
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P001-CM/CM001-wb.md', 'Projects', 'experiment', '2026-04-11', 'P001', 'CMS001', 'CM001', 'abc', 1000, 1000);
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P002-PCR/CM001-pcr.md', 'Projects', 'experiment', '2026-04-11', 'P002', null, 'CM001', 'def', 1000, 1000);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('filters by project_id', async () => {
    // Pass db as third argument to createVaultTools
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Projects', project_id: 'P001' }));
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('P001');
  });

  it('includes series in result', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Projects' }));
    const withSeries = result.find((r: Record<string, unknown>) => r.series === 'CMS001');
    expect(withSeries).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/vault-serial-search.test.ts
```
Expected: FAIL

- [ ] **Step 3: Update `vault.ts`**

Add `Database` import:
```typescript
import type Database from 'better-sqlite3';
```

Update `createVaultTools` signature:
```typescript
export function createVaultTools(
  vaultPath: string,
  conflictDetector?: ConflictDetector,
  injectedDb?: Database.Database,
): ToolHandler[] {
```

In `vault_list`:
- Replace `const db = getDatabase();` with `const db = injectedDb ?? getDatabase();`
- Add parameter: `project_id: { type: 'string' }` and `series: { type: 'string' }`
- Add conditions: `if (args.project_id) { conditions.push('project_id = ?'); params.push(args.project_id); }` and same for series
- Update SELECT: `SELECT path, note_type, date, project, project_id, note_id, series, experiment_type, status, result_summary`

- [ ] **Step 4: Add serial ID fast path to `search.ts`**

Add `Database` import at the top of `src/agent/tools/search.ts`:
```typescript
import type Database from 'better-sqlite3';
```

Update `createSearchTools` signature:
```typescript
export function createSearchTools(vaultPath: string, injectedDb?: Database.Database): ToolHandler[] {
```

In `vault_search` execute, replace `const db = getDatabase();` with `const db = injectedDb ?? getDatabase();` (all occurrences).

Then add before the existing query logic:
```typescript
const query = args.query as string;
const serialPattern = /^([A-Z]{1,4}\d{3,4}|P\d{3,4})$/;
if (serialPattern.test(query.trim())) {
  const exact = db.prepare('SELECT path, note_type, date, project_id, note_id, series FROM note_metadata WHERE note_id = ?').get(query.trim()) as Record<string, unknown> | undefined;
  if (exact) {
    return JSON.stringify({ results: [{ ...exact, match_type: 'serial_exact' }], context: '', totalCandidates: 1 });
  }
}
```

- [ ] **Step 4b: Add vault_search fast path test**

Append to `tests/unit/vault-serial-search.test.ts`:
```typescript
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_search serial ID fast path', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-'));
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P001-CM/CM001-wb.md', 'Projects', 'experiment', '2026-04-11', 'P001', 'CMS001', 'CM001', 'abc', 1000, 1000);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns serial_exact match for known note_id', async () => {
    const tools = createSearchTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const result = JSON.parse(await tool.execute({ query: 'CM001' }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].match_type).toBe('serial_exact');
    expect(result.results[0].note_id).toBe('CM001');
    expect(result.totalCandidates).toBe(1);
  });

  it('does not apply serial fast path for non-serial queries', async () => {
    const tools = createSearchTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    // Non-serial query — verify it does NOT return match_type: serial_exact
    const result = JSON.parse(await tool.execute({ query: 'western blot' }));
    expect(result).toHaveProperty('results');
    // If results were returned they should not be serial_exact matches
    if (Array.isArray(result.results)) {
      for (const r of result.results) {
        expect(r.match_type).not.toBe('serial_exact');
      }
    }
  });
});
```

- [ ] **Step 5: Run all tests**

```bash
npx vitest run tests/unit/vault-serial-search.test.ts
npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/vault.ts src/agent/tools/search.ts tests/unit/vault-serial-search.test.ts
git commit -m "feat: vault_list project_id/series filter (injectable db); vault_search serial ID fast path"
```

---

## Task 11: Parser + Indexer Updates

**Files:**
- Modify: `src/ingestion/parser.ts`
- Modify: `src/ingestion/indexer.ts`
- Create: `tests/unit/parser-serial.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/parser-serial.test.ts
import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/ingestion/parser.js';

describe('parseNote — serial fields and note_kind-first classification', () => {
  it('uses note_kind frontmatter as primary classifier, not path', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ntitle: WB\nexperiment_type: western-blot\ncreated: 2026-04-11\nstatus: draft\n---\n\n# WB\n`;
    const r = parseNote('Projects/P001-CM/CM001-western-blot.md', content);
    expect(r.noteKind).toBe('experiment');
    expect(r.noteType).toBe('experiment');
  });

  it('populates date from created when date field absent', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.date).toBe('2026-04-11');
  });

  it('date field takes precedence over created when both present', () => {
    const content = `---\nnote_kind: experiment\ndate: 2026-03-01\ncreated: 2026-04-11\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.date).toBe('2026-03-01');
  });

  it('extracts noteId, projectId, series from frontmatter', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\nseries: CMS001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.noteId).toBe('CM001');
    expect(r.projectId).toBe('P001');
    expect(r.series).toBe('CMS001');
  });

  it('classifies _index.md as project-index via note_kind: project', () => {
    const content = `---\nnote_kind: project\nid: P001\nprefix: CM\ntitle: CM\ncreated: 2026-04-11\n---\n`;
    const r = parseNote('Projects/P001-CM/_index.md', content);
    expect(r.noteKind).toBe('project');
    expect(r.noteType).toBe('project-index');
    expect(r.noteId).toBe('P001');
  });

  it('extracts last_session from latest dated heading', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-08\n---\n\n## 2026-04-08 - Setup\n\n## 2026-04-09 - Run\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.lastSession).toBe('2026-04-09');
  });

  it('defaults last_session to created when no dated headings', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-08\n---\n\n# Notes\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.lastSession).toBe('2026-04-08');
  });

  it('does not set noteId for reading notes', () => {
    const content = `---\ntitle: IL-42\nauthors: [Smith]\nyear: 2026\njournal: Nature\ndoi: 10.x/x\nread_date: 2026-04-06\nstatus: draft\nkb_status: pending\n---\n`;
    const r = parseNote('Reading/Papers/smith-2026-il42.md', content);
    expect(r.noteId).toBeUndefined();
  });

  it('does not emit validation warning for id on new serial experiment', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    const missingId = r.warnings.find((w: { field: string }) => w.field === 'id');
    expect(missingId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/parser-serial.test.ts
```
Expected: FAIL

- [ ] **Step 3: Update `src/ingestion/parser.ts`**

Add new fields to `ParsedNote` interface:
```typescript
noteId?: string;
series?: string;
projectId?: string;
lastSession?: string;
noteKind?: string;
```

Update `NoteType`:
```typescript
export type NoteType = 'experiment' | 'series' | 'project-index' | 'protocol' | 'reading' | 'diary' | 'agent' | 'unknown';
```

Update `REQUIRED_FIELDS`:
```typescript
const REQUIRED_FIELDS: Record<NoteType, string[]> = {
  experiment: [], // validated per note_kind below
  series: [],
  'project-index': [],
  protocol: ['title', 'version', 'last_updated', 'category'],
  reading: ['title', 'authors', 'year', 'journal', 'read_date'],  // doi is optional (preprints/threads may lack one)
  diary: ['date', 'type'],
  agent: [],
  unknown: [],
};
```

Update `classifyNote` to accept optional `noteKind`:
```typescript
export function classifyNote(filePath: string, noteKind?: string): { folder: string; noteType: NoteType } {
  const normalized = filePath.replace(/\\/g, '/');
  const firstSegment = normalized.split('/')[0];

  // note_kind frontmatter takes precedence over path heuristics
  if (noteKind) {
    const kindToType: Record<string, NoteType> = {
      experiment: 'experiment', series: 'series', project: 'project-index',
      protocol: 'protocol', reading: 'reading',
    };
    if (kindToType[noteKind]) return { folder: firstSegment || 'root', noteType: kindToType[noteKind] };
  }

  // Fallback: path-based
  switch (firstSegment) {
    case 'Projects': {
      if (normalized.endsWith('/_index.md')) return { folder: 'Projects', noteType: 'project-index' };
      const basename = normalized.split('/').pop() ?? '';
      if (/^[A-Z]+S\d+/.test(basename)) return { folder: 'Projects', noteType: 'series' };
      return { folder: 'Projects', noteType: 'experiment' };
    }
    case 'Protocols': return { folder: 'Protocols', noteType: 'protocol' };
    case 'Reading': return { folder: 'Reading', noteType: 'reading' };
    case 'Memory': return { folder: 'Memory', noteType: 'diary' };
    case 'Agent': return { folder: 'Agent', noteType: 'agent' };
    default: return { folder: firstSegment || 'root', noteType: 'unknown' };
  }
}
```

In `parseNote`, after `matter(content)`:
0. In the existing Date-normalization block (where `date`, `last_updated`, `read_date` are converted), also add `created`:
```typescript
if (frontmatter['created'] instanceof Date) {
  frontmatter['created'] = utcDateString(frontmatter['created'] as Date);
}
```
This converts `created: 2026-04-11` (parsed as JS Date by gray-matter) to the ISO string `"2026-04-11"` before downstream code reads it.

1. Extract `noteKind` from frontmatter
2. Pass to `classifyNote`
3. Normalize `date`: after normalizing `created` to a string (step 0), compute `const createdDate = normalizeString(frontmatter['created'])` then `rawDate = normalizeString(frontmatter['date']) || createdDate || undefined`. Use `createdDate` (not `utcDateString(frontmatter['created'])`) for both `rawDate` and `lastSession` — by this point `created` is already a plain string, not a `Date`
4. Extract serial fields: `noteId`, `series`, `projectId`, `lastSession`
5. Replace old `validateFrontmatter` call with note_kind-aware validation:

```typescript
// In parseNote — replace the existing validateFrontmatter call:
const noteKind = normalizeString(frontmatter['note_kind']) || undefined;
const { folder, noteType } = classifyNote(filePath, noteKind); // classification AFTER frontmatter parse

// Normalize created once here; use the resulting string for both rawDate and lastSession
const createdDate = normalizeString(frontmatter['created']); // frontmatter['created'] is a string by this point (Date already converted above)
const rawDate = normalizeString(frontmatter['date']) || createdDate || undefined;

const noteId = normalizeString(frontmatter['id']) || undefined;
const seriesField = normalizeString(frontmatter['series']) || undefined;
const projectId = normalizeString(frontmatter['project_id']) || undefined;

// last_session: latest ## YYYY-MM-DD heading or fallback to created
let lastSession: string | undefined;
if (noteType === 'experiment') {
  const headingDates: string[] = [];
  const pat = /^##\s+(\d{4}-\d{2}-\d{2})/gm;
  let m;
  while ((m = pat.exec(body)) !== null) headingDates.push(m[1]);
  lastSession = headingDates.length > 0 ? headingDates.sort().pop()! : createdDate;
}

// Per-note-kind validation (uses ValidationWarning structured type)
const warnings: ValidationWarning[] = [];
if (noteKind === 'experiment' || noteKind === 'series' || noteKind === 'project') {
  if (!frontmatter['id']) warnings.push({ field: 'id', message: 'Missing required field: id' });
  if (!frontmatter['created'] && !frontmatter['date']) warnings.push({ field: 'created', message: 'Missing required field: created (or date)' });
} else if (noteType !== 'experiment') {
  // Legacy path: use REQUIRED_FIELDS
  for (const field of REQUIRED_FIELDS[noteType] ?? []) {
    if (!frontmatter[field]) warnings.push({ field, message: `Missing required field: ${field}` });
  }
}

return {
  filePath, folder, noteType, frontmatter, body, warnings,
  isValid: warnings.length === 0,
  date: rawDate,
  // ... other existing fields ...
  noteId, series: seriesField, projectId, noteKind, lastSession,
};
```

- [ ] **Step 4: Update `src/ingestion/indexer.ts`**

Update INSERT to include new columns:
```typescript
database.prepare(`
  INSERT INTO note_metadata (path, folder, note_type, date, project, project_id, note_id, series,
    last_session, experiment_type, protocol_ref, status, tags, result_summary, content_hash, mtime, last_indexed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    folder = excluded.folder, note_type = excluded.note_type, date = excluded.date,
    project = excluded.project, project_id = excluded.project_id, note_id = excluded.note_id,
    series = excluded.series, last_session = excluded.last_session,
    experiment_type = excluded.experiment_type, protocol_ref = excluded.protocol_ref,
    status = excluded.status, tags = excluded.tags, result_summary = excluded.result_summary,
    content_hash = excluded.content_hash, mtime = excluded.mtime, last_indexed = excluded.last_indexed
`).run(
  note.filePath, note.folder, note.noteType, note.date ?? null, note.project ?? null,
  note.projectId ?? null, note.noteId ?? null, note.series ?? null, note.lastSession ?? null,
  note.experimentType ?? null, note.protocolRef ?? null, note.status ?? null,
  note.tags ? JSON.stringify(note.tags) : null, note.resultSummary ?? null,
  contentHash, mtime, now,
);
```

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/parser.ts src/ingestion/indexer.ts tests/unit/parser-serial.test.ts
git commit -m "feat: parser note_kind-first classification, created→date fallback, serial fields, structured warnings"
```

---

## Task 12: Obsidian Plugin — "Continue" Button

**Files:**
- Modify: `obsidian-plugin/chat-view.ts`

- [ ] **Step 1: Store `actionsEl` in `pendingEditButtons`**

Update the Map type:
```typescript
private pendingEditButtons: Map<string, {
  applyBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  forceBtn?: HTMLButtonElement;
  actionsEl: HTMLElement;
}> = new Map();
```

In `addMessage`, when building `btnEntry`, include `actionsEl`:
```typescript
const btnEntry: { applyBtn: HTMLButtonElement; cancelBtn: HTMLButtonElement; forceBtn?: HTMLButtonElement; actionsEl: HTMLElement } = { applyBtn, cancelBtn, actionsEl };
```

- [ ] **Step 2: Add Continue button in `editResultHandler` after success**

In `editResultHandler` (inside `onOpen`), in the `if (msg.success)` branch, after updating button labels, add:

```typescript
const btns = this.pendingEditButtons.get(editId);
if (btns) {
  const continueBtn = btns.actionsEl.createEl('button', {
    cls: 'cricknote-continue-btn',
    text: 'Continue',
  });
  continueBtn.addEventListener('click', () => {
    continueBtn.remove(); // prevent double-click
    this.sendMessageText('continue');
  });
}
```

- [ ] **Step 3: Add `sendMessageText` helper**

```typescript
private sendMessageText(text: string): void {
  this.addMessage({ role: 'user', content: text, timestamp: Date.now() });
  this.plugin.ws?.sendChat(text); // uses this.plugin.ws, not wsClient
}
```

- [ ] **Step 4: Build TypeScript**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 5: Run tests**

```bash
npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add obsidian-plugin/chat-view.ts
git commit -m "feat: Continue button after edit confirmation (actionsEl stored, uses this.plugin.ws)"
```

---

## Self-Review

**Spec coverage:** All 12 tasks map to spec sections. No placeholders.

**Key fixes from R2 Codex review:**
1. `checkPrefixCollision` checks both `serial_counters` AND `prefix_reservations` for parent/child collisions
2. `validatePrefix` enforces `/^[A-Z]{2,3}$/` — called in `reserve_prefix`, `create_project`, `register_project_counters`
3. `create_experiment` validates protocol file existence; `create_series` removes `experiments` param (assignment via `update_series_table` post-confirm)
4. `register_project_counters` checks both counters; handles partial state with auto-repair; rejects duplicate project folders in auto-heal path
5. `resolveWikilinkPath` extended inline (no new exported function needed); ambiguity → null + warning
6. Parser `warnings` use `ValidationWarning { field, message }` structured type; classification runs after frontmatter parse
7. `import matter from 'gray-matter'` added to serial-tools tests
8. Migration test uses `SELECT MAX(version) as v FROM schema_version` for version check
9. `createSearchTools` and `createVaultTools` both accept injectable db; `vault_list` includes `series` field
10. `create_reading_note` writes to `Reading/Papers/${slug}.md`
11. `resolveProject` uses `resolveVaultPath` before reading `_index.md`
12. `runtime.ts` explicitly imports `ToolContext` from `'./tools/registry.js'`
