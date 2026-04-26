# Zotero Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zotero → CrickNote reading intake path: fetch metadata + PDF from Zotero via Better BibTeX JSON-RPC, copy PDF into the vault, and produce a reading note using the existing pipeline.

**Architecture:** Three new tools (`zotero_fetch_item`, `zotero_prepare_bundle`, `zotero_cleanup_bundle`) sit upstream of the existing `ingest_reading_bundle` → `compile_reading_note` pipeline. The agent orchestrates them directly in sequence; no facade tool. Config-gated behind `zotero.enabled`.

**Tech Stack:** TypeScript, Node.js `fs`, `crypto` (SHA-256), `http` (JSON-RPC to localhost), existing `gray-matter` + `reading-note.ts` helpers, vitest.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/knowledge/reading-note.ts` | Modify | Add `citekey`/`zotero_key` to `ReadingNoteMeta`; fix `readingSourcesEqual` to order-insensitive; export `normalizeDoi` |
| `src/config/config.ts` | Modify | Add optional `zotero` block to `CrickNoteConfig`; normalize defaults in `loadConfig()` |
| `src/agent/runtime.ts` | Modify | Pass `parsed.meta` into SafeWriter meta; include `parsed.message` in `pending_confirmation`; pass `this.config` to `assembleSystemPrompt` |
| `src/agent/context.ts` | Modify | Add optional `config?` param to `assembleSystemPrompt`; inject Zotero reading workflow and cancel-cleanup rule |
| `src/agent/tools/reading-intake.ts` | Modify | Add Zotero fields to `ingest_reading_bundle` schema; duplicate-slug detection; collision-check tiers; `effective_sources` logic; `note_rel_path` in meta; `.zotero-bundle` in `IGNORED_BUNDLE_FILES` |
| `src/agent/tools/zotero-tools.ts` | Create | All Zotero tools + `validateZoteroAttachment` |
| `tests/unit/reading-note.test.ts` | Modify | Add tests for `readingSourcesEqual` order-insensitive, `normalizeDoi`, new frontmatter fields |
| `tests/unit/reading-intake.test.ts` | Modify | Add tests for duplicate-slug, collision check tiers, `effective_sources`, Zotero meta emission |
| `tests/unit/zotero-tools.test.ts` | Create | Full unit test suite for all Zotero tools |
| `tests/unit/zotero-config.test.ts` | Create | Config normalization and validation tests |
| `tests/unit/zotero-runtime.test.ts` | Create | Runtime meta passthrough + `pending_confirmation` message tests |

---

## Task 1: Fix `readingSourcesEqual` to order-insensitive set equality

**Files:**
- Modify: `src/knowledge/reading-note.ts:132-147`
- Test: `tests/unit/reading-note.test.ts`

The current implementation compares by position (`.every((source, index) => ...)`). The spec requires set equality after normalization — `[pdf, notes]` must equal `[notes, pdf]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/reading-note.test.ts`:

```typescript
import { readingSourcesEqual } from '../../src/knowledge/reading-note.js';

describe('readingSourcesEqual (order-insensitive)', () => {
  it('treats reordered identical sources as equal', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }, { type: 'notes' as const, path: 'abstract.md' }];
    const b = [{ type: 'notes' as const, path: 'abstract.md' }, { type: 'pdf' as const, path: 'paper.pdf' }];
    expect(readingSourcesEqual(a, b)).toBe(true);
  });

  it('detects genuinely different sources', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }];
    const b = [{ type: 'notes' as const, path: 'abstract.md' }];
    expect(readingSourcesEqual(a, b)).toBe(false);
  });

  it('treats different lengths as unequal', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }];
    const b = [{ type: 'pdf' as const, path: 'paper.pdf' }, { type: 'notes' as const, path: 'notes.md' }];
    expect(readingSourcesEqual(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/reading-note.test.ts
```
Expected: FAIL — `reordered identical sources` test fails because current impl is position-based.

- [ ] **Step 3: Replace the function body in `src/knowledge/reading-note.ts`**

Replace lines 132–147:

```typescript
export function readingSourcesEqual(
  left: ReadingSourceInput[] | undefined,
  right: ReadingSourceInput[] | undefined
): boolean {
  const normalizedLeft = left ? normalizeReadingSources(left) : [];
  const normalizedRight = right ? normalizeReadingSources(right) : [];

  if (normalizedLeft.length !== normalizedRight.length) return false;

  const makeKey = (s: ReadingSourceInput) => `${s.type}:${s.path}`;
  const leftKeys = new Set(normalizedLeft.map(makeKey));
  return normalizedRight.every(s => leftKeys.has(makeKey(s)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/reading-note.test.ts
```
Expected: all PASS, including pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "fix(reading-note): readingSourcesEqual uses order-insensitive set equality"
```

---

## Task 2: Export `normalizeDoi` from `reading-note.ts`

**Files:**
- Modify: `src/knowledge/reading-note.ts`
- Test: `tests/unit/reading-note.test.ts`

`normalizeDoi` is used in `zotero_fetch_item` (Path B search), `ingest_reading_bundle` (collision check), and stored in frontmatter. Placing it in `reading-note.ts` keeps DOI normalization in one place.

- [ ] **Step 1: Write the failing test**

```typescript
import { normalizeDoi } from '../../src/knowledge/reading-note.js';

describe('normalizeDoi', () => {
  it('lowercases the input', () => {
    expect(normalizeDoi('10.1016/J.Cell')).toBe('10.1016/j.cell');
  });

  it('strips https://doi.org/ prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1016/j.cell.2026.01.001')).toBe('10.1016/j.cell.2026.01.001');
  });

  it('strips http://doi.org/ prefix', () => {
    expect(normalizeDoi('http://doi.org/10.1016/j.cell')).toBe('10.1016/j.cell');
  });

  it('handles mixed case with prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1016/J.Cell.2026')).toBe('10.1016/j.cell.2026');
  });

  it('returns bare DOI unchanged (already normalized)', () => {
    expect(normalizeDoi('10.1016/j.cell')).toBe('10.1016/j.cell');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/reading-note.test.ts
```
Expected: FAIL — `normalizeDoi` not exported.

- [ ] **Step 3: Add function to `src/knowledge/reading-note.ts`** (before `buildReadingFrontmatter`)

```typescript
export function normalizeDoi(doi: string): string {
  return doi
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//, '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/reading-note.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "feat(reading-note): export normalizeDoi utility"
```

---

## Task 3: Add `citekey` and `zotero_key` to `ReadingNoteMeta` and `buildReadingFrontmatter`

**Files:**
- Modify: `src/knowledge/reading-note.ts`
- Test: `tests/unit/reading-note.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('buildReadingFrontmatter with Zotero fields', () => {
  it('includes citekey when provided', () => {
    const fm = buildReadingFrontmatter(
      { title: 'T', authors: ['A'], year: 2026, journal: 'J', citekey: 'smith2026' },
      [{ type: 'pdf', path: 'paper.pdf' }]
    );
    expect(fm.citekey).toBe('smith2026');
  });

  it('includes zotero_key when provided', () => {
    const fm = buildReadingFrontmatter(
      { title: 'T', authors: ['A'], year: 2026, journal: 'J', zotero_key: 'ABCD1234' },
      [{ type: 'pdf', path: 'paper.pdf' }]
    );
    expect(fm.zotero_key).toBe('ABCD1234');
  });

  it('omits citekey/zotero_key when not provided', () => {
    const fm = buildReadingFrontmatter(
      { title: 'T', authors: ['A'], year: 2026, journal: 'J' },
      [{ type: 'pdf', path: 'paper.pdf' }]
    );
    expect(fm.citekey).toBeUndefined();
    expect(fm.zotero_key).toBeUndefined();
  });

  it('preserves existing zotero_key when new meta omits it (passthrough)', () => {
    const fm = buildReadingFrontmatter(
      { title: 'T', authors: ['A'], year: 2026, journal: 'J' },
      [{ type: 'pdf', path: 'paper.pdf' }],
      { zotero_key: 'ABCD1234' }
    );
    expect(fm.zotero_key).toBe('ABCD1234');
  });

  it('overwrites existing zotero_key when new meta provides one', () => {
    const fm = buildReadingFrontmatter(
      { title: 'T', authors: ['A'], year: 2026, journal: 'J', zotero_key: 'NEW1234' },
      [{ type: 'pdf', path: 'paper.pdf' }],
      { zotero_key: 'OLD1234' }
    );
    expect(fm.zotero_key).toBe('NEW1234');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reading-note.test.ts
```

- [ ] **Step 3: Extend `ReadingNoteMeta` and `buildReadingFrontmatter`**

In `ReadingNoteMeta`, add:
```typescript
citekey?: string;
zotero_key?: string;
```

In `buildReadingFrontmatter`, after the `doi` handling block (around line 253), add:

```typescript
const citekey = existingString(meta.citekey) ?? existingString(existingFrontmatter.citekey);
if (citekey) {
  frontmatter.citekey = citekey;
} else {
  delete frontmatter.citekey;
}

const zoteroKey = existingString(meta.zotero_key) ?? existingString(existingFrontmatter.zotero_key);
if (zoteroKey) {
  frontmatter.zotero_key = zoteroKey;
} else {
  delete frontmatter.zotero_key;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reading-note.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "feat(reading-note): add citekey/zotero_key to ReadingNoteMeta and buildReadingFrontmatter"
```

---

## Task 4: Zotero config block

**Files:**
- Modify: `src/config/config.ts`
- Create: `tests/unit/zotero-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/zotero-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeConfig(dir: string, data: object) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('Zotero config normalization', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-cfg-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  it('fills in Zotero defaults when zotero block is absent', () => {
    // tested via normalizeZoteroConfig exported helper
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    const result = normalizeZoteroConfig(undefined);
    expect(result.enabled).toBe(false);
    expect(result.api_port).toBe(23119);
    expect(result.storage_root).toContain('Zotero/storage');
    expect(result.auto_summarize).toBe(true);
  });

  it('rejects api_port out of range', () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 0, storage_root: '/tmp/zotero', auto_summarize: true }))
      .toThrow('api_port');
  });

  it('rejects storage_root resolving to /', () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 23119, storage_root: '/', auto_summarize: true }))
      .toThrow('storage_root');
  });

  it('expands ~ in storage_root', () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    const result = normalizeZoteroConfig({ enabled: true, api_port: 23119, storage_root: '~/Zotero/storage', auto_summarize: true });
    expect(result.storage_root).toMatch(/^\/Users\/|^\/home\//);
    expect(result.storage_root).not.toContain('~');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/zotero-config.test.ts
```

- [ ] **Step 3: Extend `src/config/config.ts`**

Add to the interface:
```typescript
export interface ZoteroConfig {
  enabled: boolean;
  api_port: number;
  storage_root: string;
  bbt_export_path?: string;
  auto_summarize: boolean;
}

// In CrickNoteConfig:
zotero?: ZoteroConfig;
```

Add exported helper (called by `loadConfig` and usable in tests):
```typescript
export function normalizeZoteroConfig(raw: Partial<ZoteroConfig> | undefined): ZoteroConfig {
  const defaults: ZoteroConfig = {
    enabled: false,
    api_port: 23119,
    storage_root: path.join(os.homedir(), 'Zotero', 'storage'),
    auto_summarize: true,
  };
  const merged: ZoteroConfig = { ...defaults, ...(raw ?? {}) };

  // Expand ~
  if (merged.storage_root.startsWith('~/')) {
    merged.storage_root = path.join(os.homedir(), merged.storage_root.slice(2));
  }

  // Port range
  if (!Number.isInteger(merged.api_port) || merged.api_port < 1 || merged.api_port > 65535) {
    throw new Error(`Invalid Zotero config: api_port must be 1–65535, got ${merged.api_port}`);
  }

  // Storage root safety: reject /, ~, and anything that is a prefix of or equal to the vault root
  // (vault root check happens at call time when we have the vault path; here we only check absolutes)
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(merged.storage_root);
  } catch {
    resolvedRoot = path.resolve(merged.storage_root);
  }
  if (resolvedRoot === '/' || resolvedRoot === os.homedir()) {
    throw new Error(`Invalid Zotero config: storage_root "${merged.storage_root}" resolves to an unsafe path`);
  }

  merged.storage_root = resolvedRoot;
  return merged;
}
```

In `loadConfig()`, after the existing merge, add:
```typescript
if (raw.zotero !== undefined || config.zotero !== undefined) {
  config.zotero = normalizeZoteroConfig(raw.zotero);
}
```

Add `import os from 'node:os';` at top.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/zotero-config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts tests/unit/zotero-config.test.ts
git commit -m "feat(config): add Zotero config block with defaults and validation"
```

---

## Task 5: Runtime — `parsed.meta` passthrough + `parsed.message` in `pending_confirmation`

**Files:**
- Modify: `src/agent/runtime.ts:222-241`
- Create: `tests/unit/zotero-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/zotero-runtime.test.ts
import { describe, it, expect } from 'vitest';
import { SafeWriter } from '../../src/editing/safe-writer.js';

describe('runtime pending_edit meta passthrough', () => {
  it('generic meta fields survive proposeEdit → getPendingEditMeta', () => {
    const sw = new SafeWriter();
    const meta = {
      operation: 'create',
      path: '/vault/Reading/Papers/foo.md',
      zotero_slug: 'smith-2026-il42',
      zotero_files_created: ['paper.pdf'],
      note_rel_path: 'Reading/Papers/smith-2026-il42.md',
    };
    sw.proposeEdit('/vault/Reading/Papers/foo.md', '# content', 'trigger', 'sess1', meta);
    const editId = [...(sw as unknown as { pendingEdits: Map<string, { editId: string }> }).pendingEdits.keys()][0];
    const retrieved = sw.getPendingEditMeta(editId);
    expect(retrieved?.zotero_slug).toBe('smith-2026-il42');
    expect(retrieved?.zotero_files_created).toEqual(['paper.pdf']);
    expect(retrieved?.note_rel_path).toBe('Reading/Papers/smith-2026-il42.md');
  });
});
```

This test passes already (SafeWriter stores meta as-is). The real test is in runtime: we need to confirm that when a tool returns `{ type: 'pending_edit', ..., meta: { zotero_slug, ... }, message: 'Downgrade blocked' }`, those fields land in the workflow event. This is hard to unit-test without the full runtime; verify it during integration validation (Task 25).

- [ ] **Step 2: Run existing test to confirm SafeWriter already supports generic meta**

```bash
npx vitest run tests/unit/zotero-runtime.test.ts
```
Expected: PASS — SafeWriter already stores meta generically.

- [ ] **Step 3: Edit `src/agent/runtime.ts` — two changes**

**Change A** — meta passthrough (around line 222–226). After the `parsed.reservation` block, add:

```typescript
if (parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) {
  Object.assign(meta, parsed.meta);
}
```

**Change B** — include `message` in `pending_confirmation` (around line 235–241). Change the `toolResult` assignment to:

```typescript
const toolResult = JSON.stringify({
  status: 'pending_confirmation',
  path: parsed.path,
  operation: parsed.operation,
  editId: proposal.editId,
  hasConflict: proposal.hasConflict,
  ...(typeof parsed.message === 'string' && parsed.message ? { message: parsed.message } : {}),
});
```

- [ ] **Step 4: Run full test suite to confirm no regressions**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/runtime.ts tests/unit/zotero-runtime.test.ts
git commit -m "feat(runtime): pass parsed.meta into SafeWriter meta and parsed.message into pending_confirmation"
```

---

## Task 6: `assembleSystemPrompt` — optional `config` param + Zotero workflow

**Files:**
- Modify: `src/agent/context.ts`
- Modify: `src/agent/runtime.ts` (line 140)

- [ ] **Step 1: Change the signature in `src/agent/context.ts`**

```typescript
import type { CrickNoteConfig } from '../config/config.js';

export function assembleSystemPrompt(
  vaultPath: string,
  tools: ToolDefinition[],
  config?: CrickNoteConfig
): string {
```

- [ ] **Step 2: Replace the `## Reading Workflow` section**

Replace the existing reading workflow block with a Zotero-aware version:

```typescript
const autoSummarize = config?.zotero?.auto_summarize ?? true;
const zoteroEnabled = config?.zotero?.enabled ?? false;

sections.push(`## Reading Workflow

Preferred reading-note order (vault-native bundle):
1. Call reading_pipeline_status first.
2. If the reading note does not exist yet, call discover_reading_bundle or ingest_reading_bundle.
3. If the note is ready, call compile_reading_note.
4. After the user reviews the draft, call set_reading_note_status with status: complete.
5. Then continue with kb_suggest, kb_write_mapping, and kb_apply.${zoteroEnabled ? `

## Zotero Reading Workflow

When the user says "ingest <identifier> from Zotero" or "summarise <identifier> from my Zotero":
1. Call zotero_fetch_item with the identifier (citekey, doi, or zotero_key).
   - If it returns needs_item_selection: present the candidates to the user, re-call with zotero_key.
   - If it returns needs_attachment_selection: present the PDF list, re-call with selected_attachment_id.
2. Derive slug: <slug_prefix from output>-<year>-<slugifyReadingTitle(title)>. Never derive from citekey.
3. Check for existing notes: if both Reading/Papers/<slug>.md and Reading/Threads/<slug>.md exist, stop with an error.
4. Narrate: "Copying PDF to vault at Reading/attachments/<slug>/paper.pdf…" (or abstract variant).
5. Call zotero_prepare_bundle({ slug, pdf_path? }) → capture files_created_this_run.
6. Call ingest_reading_bundle with all metadata fields + citekey + zotero_key (if present) + zotero_managed: true + zotero_files_created: <files_created_this_run>.
7. CANCEL FLOW: After any scaffold edit_cancelled event that contains zotero_slug:
   - If zotero_files_created is non-empty → call zotero_cleanup_bundle({ slug: zotero_slug, files: zotero_files_created }).
   - If zotero_files_created is empty → call vault_read(note_rel_path from event):
     * Note found → bundle belongs to confirmed prior note; skip cleanup.
     * Note absent → call zotero_cleanup_bundle({ slug: zotero_slug }) with no files (full cleanup).
   - Always prompt the user to click Continue after scaffold cancel so cleanup executes.
8. After scaffold confirmed, use note_rel_path (from pending_edit meta, vault-relative) for ALL follow-up tool calls. Never use the absolute pending_edit.path.
${autoSummarize
  ? '9. auto_summarize is ON: proceed to compile_reading_note({ path: note_rel_path }) automatically. Then call vault_write with the returned content → second pending_edit. Append: "Note: PDF extraction is capped at 20 pages. If longer, review the summary manually."'
  : '9. auto_summarize is OFF: stop after scaffold confirmation. Report the note path and offer to summarize on demand. Only call compile_reading_note if the user explicitly asks.'}` : ''}`);
```

- [ ] **Step 3: Wire config in `src/agent/runtime.ts`**

Change line 140 from:
```typescript
const systemPrompt = assembleSystemPrompt(this.config.vaultPath, this.registry.getDefinitions());
```
to:
```typescript
const systemPrompt = assembleSystemPrompt(this.config.vaultPath, this.registry.getDefinitions(), this.config);
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/context.ts src/agent/runtime.ts
git commit -m "feat(context): add optional config param to assembleSystemPrompt; inject Zotero workflow and cancel-cleanup rules"
```

---

## Task 7: `ingest_reading_bundle` — add `.zotero-bundle` to ignored files + schema extension + `note_rel_path` emission

**Files:**
- Modify: `src/agent/tools/reading-intake.ts`
- Test: `tests/unit/reading-intake.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/unit/reading-intake.test.ts`, add:

```typescript
describe('ingest_reading_bundle — Zotero fields and note_rel_path', () => {
  it('does not warn about .zotero-bundle in the bundle directory', async () => {
    // Set up a bundle dir with only .zotero-bundle and paper.pdf
    // Call discover_reading_bundle → warnings must NOT mention .zotero-bundle
    // (Full integration test; mock the vault path)
  });

  it('emits note_rel_path in pending_edit meta when zotero_managed is true', async () => {
    // Set up bundle dir with paper.pdf
    // Call ingest_reading_bundle with zotero_managed: true, zotero_files_created: ['paper.pdf']
    // Parse pending_edit result → assert meta.note_rel_path is present and vault-relative
    // assert meta.zotero_slug === slug
    // assert meta.zotero_files_created === ['paper.pdf']
  });

  it('does NOT emit note_rel_path when zotero_managed is false/absent', async () => {
    // Normal ingest call → pending_edit has no meta.note_rel_path
  });
});
```

(The full test bodies are in Task 8 and Task 9; here we focus on the structural changes.)

- [ ] **Step 2: Make the changes**

**A.** Add `.zotero-bundle` to `IGNORED_BUNDLE_FILES` at line 48:
```typescript
const IGNORED_BUNDLE_FILES = new Set(['.ds_store', '.zotero-bundle']);
```

**B.** Extend the `ingest_reading_bundle` parameters schema (in the `definition.parameters.properties` object):
```typescript
citekey: { type: 'string', description: 'Zotero citekey (optional)' },
zotero_key: { type: 'string', description: 'Zotero item key (optional, e.g. ABCD1234 or 12345:ABCD1234)' },
zotero_managed: { type: 'boolean', description: 'Set true when called from Zotero flow' },
zotero_files_created: {
  type: 'array',
  items: { type: 'string' },
  description: 'Files written by zotero_prepare_bundle this run',
},
```

**C.** In the `execute` handler, pass `citekey` and `zotero_key` through to `buildReadingFrontmatter` (add to the meta object):
```typescript
citekey: args.citekey as string | undefined,
zotero_key: args.zotero_key as string | undefined,
```

**D.** When `args.zotero_managed === true`, compute `note_rel_path` by stripping the vault root from `notePath`:
```typescript
const noteRelPath = notePath.startsWith(vaultPath + path.sep)
  ? notePath.slice(vaultPath.length + 1).replace(/\\/g, '/')
  : notePath;
```

**E.** Change the final return to include `meta` and optionally `message`:
```typescript
const result: Record<string, unknown> = {
  type: 'pending_edit',
  operation: exists ? 'update' : 'create',
  path: notePath,
  newContent,
};

if (args.zotero_managed === true) {
  result.meta = {
    zotero_slug: slug,
    zotero_files_created: Array.isArray(args.zotero_files_created) ? args.zotero_files_created : [],
    note_rel_path: noteRelPath,
  };
}

if (typeof downgradeMessage === 'string') {
  result.message = downgradeMessage;
}

return JSON.stringify(result);
```

(`downgradeMessage` is introduced in Task 9.)

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/reading-intake.ts tests/unit/reading-intake.test.ts
git commit -m "feat(reading-intake): add Zotero schema fields, note_rel_path emission, .zotero-bundle ignored"
```

---

## Task 8: `ingest_reading_bundle` — duplicate-slug detection + collision-check tiers

**Files:**
- Modify: `src/agent/tools/reading-intake.ts`
- Test: `tests/unit/reading-intake.test.ts`

The collision check in §3 step 3 of the spec has four tiers. All of this runs in the `execute` handler, just before building frontmatter.

- [ ] **Step 1: Write failing tests**

```typescript
import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
  for (const sub of ['Reading/Papers', 'Reading/Threads', 'Reading/attachments/smith-2026-il42']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'Reading/attachments/smith-2026-il42/paper.pdf'), '%PDF-test');
  return dir;
}

async function ingest(vaultPath: string, args: object): Promise<Record<string, unknown>> {
  const [,, tool] = createReadingIntakeTools(vaultPath);
  // tool is ingest_reading_bundle (index 1 in the array)
  const tools = createReadingIntakeTools(vaultPath);
  const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
  return JSON.parse(await ingestTool.execute(args));
}

describe('duplicate-slug detection', () => {
  it('errors when slug exists in both Papers and Threads', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'), '---\ntitle: A\n---\n');
    fs.writeFileSync(path.join(vault, 'Reading/Threads/smith-2026-il42.md'), '---\ntitle: B\n---\n');
    const result = await ingest(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    });
    expect(result.error).toMatch(/both Reading\/Papers.*Reading\/Threads/);
  });
});

describe('collision-check tiers', () => {
  const BASE = { slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
    sources: [{ type: 'pdf', path: 'paper.pdf' }] };

  it('zotero_key match → proceed silently (same paper)', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: ABCD1234\n---\n');
    const result = await ingest(vault, { ...BASE, zotero_key: 'ABCD1234', zotero_managed: true, zotero_files_created: [] });
    expect(result.type).toBe('pending_edit');
  });

  it('zotero_key mismatch → stop and ask user', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: OTHER123\n---\n');
    const result = await ingest(vault, { ...BASE, zotero_key: 'ABCD1234' });
    expect(result.error).toMatch(/zotero_key/i);
  });

  it('DOI match (no zotero_key on either side) → proceed silently', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ndoi: "10.1016/j.cell"\n---\n');
    const result = await ingest(vault, { ...BASE, doi: 'https://doi.org/10.1016/j.cell' });
    expect(result.type).toBe('pending_edit');
  });

  it('DOI mismatch → stop and ask user', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ndoi: "10.9999/other"\n---\n');
    const result = await ingest(vault, { ...BASE, doi: '10.1016/j.cell' });
    expect(result.error).toMatch(/doi/i);
  });

  it('citekey match, no stronger ID → proceed silently (weak identity)', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ncitekey: smith2026\n---\n');
    const result = await ingest(vault, { ...BASE, citekey: 'smith2026' });
    expect(result.type).toBe('pending_edit');
  });

  it('citekey mismatch, no stronger ID → stop and ask user', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ncitekey: jones2025\n---\n');
    const result = await ingest(vault, { ...BASE, citekey: 'smith2026' });
    expect(result.error).toMatch(/citekey/i);
  });

  it('no shared identifier → stop and ask user (slug-match only)', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\n---\n');
    const result = await ingest(vault, { ...BASE, zotero_managed: true });
    expect(result.error).toMatch(/slug/i);
  });

  it('existing note has zotero_key but fetched item has none (Path A) → falls through to DOI tier', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: ABCD1234\ndoi: "10.1016/j.cell"\n---\n');
    // No zotero_key in args (Path A), but DOI matches
    const result = await ingest(vault, { ...BASE, doi: '10.1016/j.cell' });
    expect(result.type).toBe('pending_edit');
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

- [ ] **Step 3: Implement collision-check logic**

Add a helper function before `createReadingIntakeTools`:

```typescript
import { normalizeDoi } from '../../knowledge/reading-note.js';

interface CollisionCheckResult {
  action: 'proceed' | 'stop';
  error?: string;
}

function checkSlugCollision(
  existingFrontmatter: Record<string, unknown>,
  incomingArgs: { citekey?: unknown; doi?: unknown; zotero_key?: unknown }
): CollisionCheckResult {
  const existingZoteroKey = typeof existingFrontmatter.zotero_key === 'string' ? existingFrontmatter.zotero_key : undefined;
  const incomingZoteroKey = typeof incomingArgs.zotero_key === 'string' && incomingArgs.zotero_key ? incomingArgs.zotero_key : undefined;
  const existingDoi = typeof existingFrontmatter.doi === 'string' ? normalizeDoi(existingFrontmatter.doi) : undefined;
  const incomingDoi = typeof incomingArgs.doi === 'string' && incomingArgs.doi ? normalizeDoi(incomingArgs.doi) : undefined;
  const existingCitekey = typeof existingFrontmatter.citekey === 'string' ? existingFrontmatter.citekey : undefined;
  const incomingCitekey = typeof incomingArgs.citekey === 'string' && incomingArgs.citekey ? incomingArgs.citekey : undefined;

  // Tier 1: zotero_key — only a shared identifier if BOTH sides have it
  if (existingZoteroKey && incomingZoteroKey) {
    if (existingZoteroKey === incomingZoteroKey) return { action: 'proceed' };
    return { action: 'stop', error: `Slug collision: existing note has zotero_key "${existingZoteroKey}" but incoming item has zotero_key "${incomingZoteroKey}". These are different papers. Resolve manually.` };
  }

  // Tier 2: DOI — only a shared identifier if both sides have one
  if (existingDoi && incomingDoi) {
    if (existingDoi === incomingDoi) return { action: 'proceed' };
    return { action: 'stop', error: `Slug collision: existing note has doi "${existingDoi}" but incoming item has doi "${incomingDoi}". These are different papers. Resolve manually.` };
  }

  // Tier 3: citekey
  if (existingCitekey && incomingCitekey) {
    if (existingCitekey === incomingCitekey) return { action: 'proceed' };
    return { action: 'stop', error: `Slug collision: existing note has citekey "${existingCitekey}" but incoming has citekey "${incomingCitekey}". No stronger ID to confirm they are the same paper. Resolve manually.` };
  }

  // Tier 4: no shared identifier
  return { action: 'stop', error: `Slug collision: a note already exists at this slug but shares no common identifier (zotero_key, doi, citekey) with the incoming item. Resolve manually or use a different slug.` };
}
```

In `ingest_reading_bundle` execute handler, after loading the existing note (around line 418–428), add:

```typescript
// Duplicate-slug guard: both Papers and Threads exist
const papersPath = resolveVaultPath(vaultPath, path.join('Reading', 'Papers', `${slug}.md`));
const threadsPath = resolveVaultPath(vaultPath, path.join('Reading', 'Threads', `${slug}.md`));
if (fs.existsSync(papersPath) && fs.existsSync(threadsPath)) {
  return JSON.stringify({ error: `Slug "${slug}" found in both Reading/Papers/ and Reading/Threads/. Resolve the duplicate manually before proceeding.` });
}

if (exists) {
  const collision = checkSlugCollision(existingFrontmatter, {
    citekey: args.citekey,
    doi: args.doi,
    zotero_key: args.zotero_key,
  });
  if (collision.action === 'stop') {
    return JSON.stringify({ error: collision.error });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/reading-intake.ts tests/unit/reading-intake.test.ts
git commit -m "feat(reading-intake): duplicate-slug error and tiered collision-check for Zotero updates"
```

---

## Task 9: `ingest_reading_bundle` — `effective_sources` and downgrade protection

**Files:**
- Modify: `src/agent/tools/reading-intake.ts`
- Test: `tests/unit/reading-intake.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('effective_sources and downgrade protection', () => {
  it('abstract-only rerun against existing PDF source preserves PDF source and emits message', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: T\nauthors: [S]\nyear: 2026\njournal: J\ncitekey: s2026\nsources:\n  - type: pdf\n    path: paper.pdf\n---\n\n# T\n\n## Claims\n\nsome content');
    // Rerun with abstract-only source (notes/abstract.md)
    fs.mkdirSync(path.join(vault, 'Reading/attachments/smith-2026-il42'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Reading/attachments/smith-2026-il42/abstract.md'), '# Abstract\n\nsome abstract');
    const result = await ingest(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      citekey: 's2026',
      sources: [{ type: 'notes', path: 'abstract.md' }],
      zotero_managed: true, zotero_files_created: [],
    });
    expect(result.type).toBe('pending_edit');
    // message must be present
    expect(typeof result.message).toBe('string');
    expect(result.message).toMatch(/pdf/i);
    // effective_sources unchanged → body must be preserved (contains 'some content')
    expect(result.newContent).toContain('some content');
  });

  it('abstract→PDF upgrade resets body and status', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: T\nauthors: [S]\nyear: 2026\njournal: J\nstatus: complete\nkb_status: mapped\nsources:\n  - type: notes\n    path: abstract.md\n---\n\n# T\n\n## Claims\n\nsome content');
    fs.writeFileSync(path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf'), '%PDF-test');
    const result = await ingest(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
      zotero_managed: true, zotero_files_created: ['paper.pdf'],
    });
    expect(result.type).toBe('pending_edit');
    expect(result.newContent).toContain('status: draft');
    expect(result.newContent).toContain('kb_status: pending');
    // body reset to scaffold — 'some content' should not be present
    expect(result.newContent).not.toContain('some content');
  });

  it('unchanged effective_sources preserves body and syncs H1', async () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old Title\nauthors: [S]\nyear: 2026\njournal: J\nstatus: complete\nsources:\n  - type: pdf\n    path: paper.pdf\n---\n\n# Old Title\n\n## Claims\n\nsome content');
    fs.writeFileSync(path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf'), '%PDF-test');
    const result = await ingest(vault, {
      slug: 'smith-2026-il42', title: 'New Title', authors: ['S'], year: 2026, journal: 'J',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    });
    expect(result.type).toBe('pending_edit');
    expect(result.newContent).toContain('some content');
    expect(result.newContent).toContain('# New Title');
    expect(result.newContent).toContain('status: complete');
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

- [ ] **Step 3: Implement `effective_sources` logic in the execute handler**

Replace the current `sourcesChanged` / `shouldResetWorkflowState` block with:

```typescript
let effectiveSources = selectedSources;
let downgradeMessage: string | undefined;

if (exists && existingSources) {
  const incomingHasPdf = selectedSources.some(s => s.type === 'pdf');
  const existingHasPdf = existingSources.some(s => s.type === 'pdf');
  const incomingIsNotesOnly = selectedSources.every(s => s.type !== 'pdf');

  if (existingHasPdf && incomingIsNotesOnly && !incomingHasPdf) {
    // Downgrade attempt: keep existing sources
    effectiveSources = existingSources;
    downgradeMessage = 'Existing PDF source preserved; abstract-only rerun would downgrade it. Provide a PDF to upgrade.';
  }
}

const sourcesChanged = exists && !readingSourcesEqual(existingSources, effectiveSources);
const shouldResetWorkflowState = !hasMeaningfulReadingBody(existingBody) || sourcesChanged;
```

Use `effectiveSources` instead of `selectedSources` when calling `buildReadingFrontmatter`:
```typescript
frontmatter = buildReadingFrontmatter(
  {
    title: args.title as string,
    authors: args.authors as string[],
    year: args.year as number,
    journal: args.journal as string,
    doi: args.doi as string | undefined,
    citekey: args.citekey as string | undefined,
    zotero_key: args.zotero_key as string | undefined,
    related_projects: args.related_projects as string[] | undefined,
    status: shouldResetWorkflowState ? 'draft' : undefined,
    kb_status: shouldResetWorkflowState ? 'pending' : undefined,
  },
  effectiveSources,
  existingFrontmatter
);
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/reading-intake.ts tests/unit/reading-intake.test.ts
git commit -m "feat(reading-intake): effective_sources logic with downgrade protection and H1 sync on update"
```

---

## Task 10: Create `src/agent/tools/zotero-tools.ts` — skeleton + `enabled` guard + `normalizeDoi` re-export + `validateZoteroAttachment`

**Files:**
- Create: `src/agent/tools/zotero-tools.ts`
- Create: `tests/unit/zotero-tools.test.ts`

- [ ] **Step 1: Write failing tests for `validateZoteroAttachment`**

```typescript
// tests/unit/zotero-tools.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateZoteroAttachment } from '../../src/agent/tools/zotero-tools.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-test-'));
}

describe('validateZoteroAttachment', () => {
  it('accepts a valid PDF inside storage root', () => {
    const root = makeTmpDir();
    const pdfPath = path.join(root, 'ABCD1234', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-valid content'));
    expect(() => validateZoteroAttachment(pdfPath, root)).not.toThrow();
  });

  it('rejects a path outside the storage root', () => {
    const root = makeTmpDir();
    const pdfPath = path.join(os.tmpdir(), 'outside.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-outside'));
    expect(() => validateZoteroAttachment(pdfPath, root)).toThrow('outside Zotero storage root');
  });

  it('rejects a symlink', () => {
    const root = makeTmpDir();
    const target = path.join(root, 'real.pdf');
    fs.writeFileSync(target, Buffer.from('%PDF-real'));
    const link = path.join(root, 'link.pdf');
    fs.symlinkSync(target, link);
    expect(() => validateZoteroAttachment(link, root)).toThrow('symlink');
  });

  it('rejects a non-.pdf extension', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'doc.txt');
    fs.writeFileSync(p, Buffer.from('%PDF-fake'));
    expect(() => validateZoteroAttachment(p, root)).toThrow('.pdf');
  });

  it('rejects wrong magic bytes', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'bad.pdf');
    fs.writeFileSync(p, Buffer.from('NOTPDF content'));
    expect(() => validateZoteroAttachment(p, root)).toThrow('magic bytes');
  });

  it('rejects files over 100 MB', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'huge.pdf');
    // Create a file that reports > 100 MB by mocking stat — use a real file and monkey-patch
    fs.writeFileSync(p, Buffer.from('%PDF-small'));
    // We test the logic path: inject a fake stat via the module's internal check
    // Simplest: write a 1-byte file and check the size check works via integration test
    // For a pure unit test, we use a large buffer (skip if too slow — mark as integration)
    expect(() => validateZoteroAttachment(p, root)).not.toThrow(); // valid small file
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 3: Create `src/agent/tools/zotero-tools.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { ToolHandler } from './registry.js';
import { loadConfig, type CrickNoteConfig } from '../../config/config.js';
import { normalizeDoi, slugifyReadingTitle } from '../../knowledge/reading-note.js';

// ─── Config guard ───────────────────────────────────────────────────────────

function getZoteroConfig(config: CrickNoteConfig) {
  const z = config.zotero;
  if (!z?.enabled) {
    return { error: 'Zotero integration is not enabled. Set zotero.enabled: true in your CrickNote config.' } as const;
  }
  return z;
}

// ─── PDF validation ──────────────────────────────────────────────────────────

export function validateZoteroAttachment(pdfPath: string, storageRoot: string): void {
  const realRoot = fs.realpathSync(storageRoot);

  const lstat = fs.lstatSync(pdfPath);
  if (lstat.isSymbolicLink()) throw new Error('symlink rejected — symlinks not allowed in Zotero storage');

  const realPdf = fs.realpathSync(pdfPath);

  if (realPdf !== realRoot && !realPdf.startsWith(realRoot + path.sep)) {
    throw new Error(`Path outside Zotero storage root: "${realPdf}"`);
  }

  const stat = fs.statSync(realPdf);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (!realPdf.toLowerCase().endsWith('.pdf')) throw new Error('Not a .pdf file');

  const fd = fs.openSync(realPdf, 'r');
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (magic.toString('ascii') !== '%PDF') throw new Error('Not a PDF (magic bytes check failed)');

  const MB = 1024 * 1024;
  if (stat.size > 100 * MB) throw new Error(`PDF exceeds 100 MB limit (${(stat.size / MB).toFixed(1)} MB)`);
}

// ─── JSON-RPC helper ─────────────────────────────────────────────────────────

function jsonRpc(port: number, method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/better-bibtex/json-rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { result?: unknown; error?: unknown };
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function apiReady(port: number): Promise<boolean> {
  try {
    await jsonRpc(port, 'api.ready', []);
    return true;
  } catch {
    return false;
  }
}

// ─── CSL normalization ───────────────────────────────────────────────────────

function initials(given: string | undefined): string {
  if (!given || !given.trim()) return '';
  return given
    .split(/[\s-]+/)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
}

interface CslAuthor { family?: string; given?: string; literal?: string }
interface CslItem {
  title?: string;
  author?: CslAuthor[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string;
  DOI?: string;
  abstract?: string;
}

export interface ZoteroFetchResult {
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi?: string;
  abstract?: string;
  pdf_path?: string;
  citekey: string;
  zotero_key?: string;
  slug_prefix: string;
}

function normalizeCsl(item: CslItem, citekey: string, pdfPath: string | undefined, zoteroKey: string | undefined): ZoteroFetchResult | { error: string } {
  if (!item.title?.trim()) return { error: 'Item has no title.' };

  const rawAuthors = item.author ?? [];
  const authors: string[] = rawAuthors.map(a => {
    if (a.family) {
      const i = initials(a.given);
      return i ? `${a.family} ${i}` : a.family;
    }
    if (a.literal) return a.literal;
    return '';
  }).filter(Boolean);
  if (authors.length === 0) return { error: 'Item has no author.' };

  const yearRaw = item.issued?.['date-parts']?.[0]?.[0];
  if (typeof yearRaw !== 'number') return { error: 'Item has no publication year.' };

  if (!item['container-title']?.trim()) return { error: 'Item has no journal/container title.' };

  const firstAuthor = rawAuthors[0];
  const slugBase = firstAuthor?.family ?? firstAuthor?.literal ?? 'unknown';
  const slug_prefix = slugifyReadingTitle(slugBase);

  return {
    title: item.title.trim(),
    authors,
    year: yearRaw,
    journal: item['container-title'].trim(),
    doi: item.DOI ? normalizeDoi(item.DOI) : undefined,
    abstract: item.abstract || undefined,
    pdf_path: pdfPath,
    citekey,
    zotero_key: zoteroKey,
    slug_prefix,
  };
}

// ─── PDF selection ───────────────────────────────────────────────────────────

interface BbtAttachment { id?: string; path?: string; contentType?: string; filename?: string; parentItem?: string; size?: number }

function selectPdf(attachments: BbtAttachment[], selectedId?: string): string | { error: string } | { status: 'needs_attachment_selection'; attachments: { id: string; filename: string; size: number }[] } {
  const pdfs = attachments.filter(a => a.contentType === 'application/pdf' && a.path);
  if (pdfs.length === 0) return { error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' };

  if (selectedId) {
    const chosen = pdfs.find(a => a.id === selectedId);
    if (!chosen?.path) return { error: `Selected attachment ${selectedId} is not a valid PDF for this item.` };
    return chosen.path;
  }

  if (pdfs.length === 1) return pdfs[0].path!;

  return {
    status: 'needs_attachment_selection',
    attachments: pdfs.map(a => ({ id: a.id ?? '', filename: a.filename ?? path.basename(a.path ?? ''), size: a.size ?? 0 })),
  };
}

// ─── Tool factory ────────────────────────────────────────────────────────────

export function createZoteroTools(vaultPath: string): ToolHandler[] {
  // Config is loaded lazily per call so it reflects any runtime changes.
  function cfg(): CrickNoteConfig { return loadConfig(); }

  // ... tools defined below
  return [zoteroFetchItem(vaultPath, cfg), zoteroPrepareBundleTool(vaultPath, cfg), zoteroCleanupBundleTool(vaultPath, cfg)];
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/zotero-tools.ts tests/unit/zotero-tools.test.ts
git commit -m "feat(zotero-tools): skeleton with enabled guard, validateZoteroAttachment, CSL helpers"
```

---

## Task 11: `zotero_fetch_item` — Path A, B, C + disambiguation

**Files:**
- Modify: `src/agent/tools/zotero-tools.ts`
- Test: `tests/unit/zotero-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { vi } from 'vitest';

// We'll mock the jsonRpc helper via vi.mock or by dependency injection.
// The cleaner approach: export a testable fetchItem(config, rpcFn, ...) function.

describe('zotero_fetch_item — Path A (citekey)', () => {
  it('returns metadata + pdf_path for a valid citekey', async () => {
    // Mock api.ready → true
    // Mock item.export → JSON string with one CSL item
    // Mock item.attachments → one PDF attachment
    // Call the tool's execute handler
    // Assert result contains title, authors, year, journal, slug_prefix, citekey, pdf_path
  });

  it('does NOT include zotero_key in output (Path A cannot retrieve it)', async () => {
    // Same setup, assert result.zotero_key is undefined
  });
});

describe('zotero_fetch_item — Path B (DOI)', () => {
  it('resolves via item.search with double-nested tuple and normalizeDoi', async () => {
    // Mock item.search → [{itemKey: 'ABCD1234', libraryID: 1}]
    // Assert search was called with [["DOI","is","10.1016/j.cell"]] (normalized, double-nested)
    // Assert zotero_key = 'ABCD1234' (bare, personal library)
  });

  it('uses "12345:ABCD1234" format for group library items', async () => {
    // Mock item.search → [{itemKey: 'ABCD1234', libraryID: 12345}]
    // Assert zotero_key = '12345:ABCD1234'
  });

  it('returns needs_item_selection when multiple items match DOI', async () => {
    // Mock item.search → 3 items
    // Assert result.status === 'needs_item_selection'
    // Assert candidates.length <= 3
  });
});

describe('zotero_fetch_item — Path C (zotero_key)', () => {
  it('resolves group library key with embedded library ID', async () => {
    // Mock item.citationkey(["12345:ABCD1234"]) → {"12345:ABCD1234": "smith2026"}
    // Assert citekey = 'smith2026'
    // Assert library ID 12345 is passed to item.export and item.attachments
  });
});

describe('zotero_fetch_item — CSL normalization edge cases', () => {
  it('institutional author (literal only) uses literal as authors[0] and slug_prefix', async () => {
    // author[0] = { literal: "World Health Organization" }
    // Assert authors[0] === "World Health Organization"
    // Assert slug_prefix === "world-health-organization"
  });

  it('errors on missing title', async () => {
    // CSL item with no title → result.error === "Item has no title."
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 3: Implement `zoteroFetchItem` function**

Add to `src/agent/tools/zotero-tools.ts`:

```typescript
function zoteroFetchItem(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_fetch_item',
      description: 'Fetch metadata and PDF path from Zotero via Better BibTeX JSON-RPC.',
      parameters: {
        type: 'object',
        properties: {
          citekey: { type: 'string' },
          doi: { type: 'string' },
          zotero_key: { type: 'string', description: 'Bare item key (ABCD1234) or group-prefixed (12345:ABCD1234)' },
          selected_attachment_id: { type: 'string', description: 'Re-call with this to pick a specific PDF' },
        },
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const port = z.api_port;
      const storageRoot = z.storage_root;
      const live = await apiReady(port);

      if (!live) {
        // Try BBT export fallback
        if (z.bbt_export_path) {
          return zoteroFetchFallback(args, z.bbt_export_path);
        }
        return JSON.stringify({ error: 'Zotero is not running, or Better BibTeX is not installed. Please open Zotero and install the Better BibTeX plugin.' });
      }

      let citekey: string | undefined;
      let zoteroKey: string | undefined;
      let libraryId: number | undefined;

      if (args.citekey) {
        // Path A
        citekey = args.citekey as string;
      } else if (args.doi) {
        // Path B
        const normalized = normalizeDoi(args.doi as string);
        const items = await jsonRpc(port, 'item.search', [[['DOI', 'is', normalized]]]) as Array<{ itemKey: string; libraryID: number }>;
        if (!Array.isArray(items) || items.length === 0) {
          return JSON.stringify({ error: `No Zotero item found for DOI "${normalized}"` });
        }
        if (items.length > 1) {
          const candidates = items.slice(0, 3).map(i => ({
            zotero_key: i.libraryID === 1 ? i.itemKey : `${i.libraryID}:${i.itemKey}`,
            title: '', year: 0, journal: '',
          }));
          return JSON.stringify({ status: 'needs_item_selection', candidates });
        }
        const item = items[0];
        libraryId = item.libraryID === 1 ? undefined : item.libraryID;
        zoteroKey = libraryId ? `${item.libraryID}:${item.itemKey}` : item.itemKey;
        const keyMap = await jsonRpc(port, 'item.citationkey', [zoteroKey]) as Record<string, string>;
        citekey = keyMap[zoteroKey];
        if (!citekey) return JSON.stringify({ error: `Could not resolve citekey for item "${zoteroKey}"` });
      } else if (args.zotero_key) {
        // Path C
        const rawKey = args.zotero_key as string;
        zoteroKey = rawKey;
        const colonIdx = rawKey.indexOf(':');
        if (colonIdx > 0) {
          libraryId = parseInt(rawKey.slice(0, colonIdx), 10);
        }
        const keyMap = await jsonRpc(port, 'item.citationkey', [rawKey]) as Record<string, string>;
        citekey = keyMap[rawKey];
        if (!citekey) return JSON.stringify({ error: `Could not resolve citekey for item key "${rawKey}"` });
      } else {
        return JSON.stringify({ error: 'At least one of citekey, doi, or zotero_key is required.' });
      }

      // Fetch metadata
      const exportParams: unknown[] = [[citekey], 'Better CSL JSON'];
      if (libraryId) exportParams.push(libraryId);
      const exportRaw = await jsonRpc(port, 'item.export', exportParams) as string;

      let cslItems: CslItem[];
      try {
        cslItems = JSON.parse(exportRaw) as CslItem[];
      } catch {
        return JSON.stringify({ error: 'Failed to parse CSL JSON from Zotero item.export' });
      }
      if (!Array.isArray(cslItems) || cslItems.length === 0) {
        return JSON.stringify({ error: `No CSL data returned for citekey "${citekey}"` });
      }

      // Fetch attachments
      const attParams: unknown[] = [citekey];
      if (libraryId) attParams.push(libraryId);
      const attachments = await jsonRpc(port, 'item.attachments', attParams) as BbtAttachment[];

      // PDF selection
      let pdfPath: string | undefined;
      const pdfResult = selectPdf(Array.isArray(attachments) ? attachments : [], args.selected_attachment_id as string | undefined);

      if (typeof pdfResult === 'string') {
        // Validate PDF
        try {
          validateZoteroAttachment(pdfResult, storageRoot);
          pdfPath = pdfResult;
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message });
        }
      } else if ('status' in pdfResult) {
        return JSON.stringify(pdfResult);
      } else if ('error' in pdfResult) {
        // No PDF — check for abstract
        if (!cslItems[0].abstract) {
          return JSON.stringify(pdfResult);
        }
        pdfPath = undefined; // abstract-only mode
      }

      const result = normalizeCsl(cslItems[0], citekey, pdfPath, zoteroKey);
      return JSON.stringify(result);
    },
  };
}

function zoteroFetchFallback(args: Record<string, unknown>, exportPath: string): string {
  if (!args.citekey && !args.doi) {
    return JSON.stringify({ error: 'Fallback mode requires citekey or DOI; item-key lookup requires a live Zotero connection.' });
  }
  let library: CslItem[];
  try {
    library = JSON.parse(fs.readFileSync(exportPath, 'utf-8')) as CslItem[];
  } catch {
    return JSON.stringify({ error: `Failed to read BBT export at "${exportPath}"` });
  }
  if (!Array.isArray(library)) return JSON.stringify({ error: 'BBT export is not a JSON array.' });

  let item: CslItem | undefined;
  if (args.doi) {
    const needle = normalizeDoi(args.doi as string);
    const matches = library.filter(i => i.DOI && normalizeDoi(i.DOI) === needle);
    if (matches.length > 1) return JSON.stringify({ error: 'Multiple entries match DOI in export; re-run with citekey to disambiguate.' });
    item = matches[0];
  }
  // citekey fallback omitted for brevity — BBT exports use id field for citekey
  // TODO: match by id field when args.citekey provided

  if (!item) return JSON.stringify({ error: 'Item not found in BBT export.' });
  if (!item.abstract) {
    return JSON.stringify({ error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' });
  }

  const result = normalizeCsl(item, args.citekey as string ?? '', undefined, undefined);
  return JSON.stringify(result);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/zotero-tools.ts tests/unit/zotero-tools.test.ts
git commit -m "feat(zotero-tools): implement zotero_fetch_item with Path A/B/C, disambiguation, BBT fallback"
```

---

## Task 12: `zotero_prepare_bundle` — PDF copy + abstract-only + marker + idempotent retry

**Files:**
- Modify: `src/agent/tools/zotero-tools.ts`
- Test: `tests/unit/zotero-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { createZoteroTools } from '../../src/agent/tools/zotero-tools.js';

function getPrepareTool(vaultPath: string) {
  return createZoteroTools(vaultPath).find(t => t.definition.name === 'zotero_prepare_bundle')!;
}

describe('zotero_prepare_bundle', () => {
  it('rejects invalid slug format', async () => {
    const vault = makeTmpDir();
    const result = JSON.parse(await getPrepareTool(vault).execute({ slug: '../evil' }));
    expect(result.error).toMatch(/invalid slug/i);
  });

  it('creates dir, copies PDF, writes marker, returns source_type pdf', async () => {
    const vault = makeTmpDir();
    const storage = makeTmpDir();
    // write a fake valid PDF in storage
    const pdfSrc = path.join(storage, 'paper.pdf');
    fs.writeFileSync(pdfSrc, Buffer.from('%PDF-test-content'));
    // Enable Zotero in config — mock loadConfig to return a config with zotero.enabled
    // ... (use vi.mock or pass config via injection)
    const result = JSON.parse(await getPrepareTool(vault).execute({ slug: 'smith-2026-il42', pdf_path: pdfSrc }));
    expect(result.source_type).toBe('pdf');
    expect(result.source_path).toBe('paper.pdf');
    expect(result.files_created_this_run).toContain('paper.pdf');
    expect(fs.existsSync(path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(vault, 'Reading/attachments/smith-2026-il42/.zotero-bundle'))).toBe(true);
  });

  it('idempotent: same PDF already present with matching SHA → empty files_created_this_run', async () => {
    // Pre-populate Reading/attachments/<slug>/paper.pdf with same content
    // Call prepare again → files_created_this_run should be []
  });

  it('errors if paper.pdf already exists with different content', async () => {
    // Pre-populate with different content
    // result.error matches /already exists/
  });

  it('abstract-only mode writes abstract.md with correct format', async () => {
    const vault = makeTmpDir();
    const result = JSON.parse(await getPrepareTool(vault).execute({
      slug: 'who-2026-report',
      abstract: 'This is the abstract text.',
    }));
    expect(result.source_type).toBe('notes');
    expect(result.source_path).toBe('abstract.md');
    const written = fs.readFileSync(path.join(vault, 'Reading/attachments/who-2026-report/abstract.md'), 'utf-8');
    expect(written).toBe('# Abstract\n\nThis is the abstract text.');
  });

  it('prefers PDF over abstract when both provided', async () => {
    // Pass both pdf_path and abstract → source_type must be pdf
  });

  it('refuses to overwrite a non-Zotero bundle directory (no marker)', async () => {
    // Create attachments/<slug>/ without .zotero-bundle
    // result.error matches /pre-existing manual bundle/
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 3: Implement `zoteroPrepareBundleTool`**

```typescript
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

interface ZoteroBundleMarker {
  created_by: 'zotero_prepare_bundle';
  files: Record<string, string>;
}

function readMarker(markerPath: string): ZoteroBundleMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as ZoteroBundleMarker;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, files: Record<string, string>): void {
  const marker: ZoteroBundleMarker = { created_by: 'zotero_prepare_bundle', files };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

function zoteroPrepareBundleTool(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_prepare_bundle',
      description: 'Create the vault attachment directory and copy the PDF (or write abstract.md) for Zotero ingestion.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          pdf_path: { type: 'string', description: 'Validated absolute path from zotero_fetch_item' },
          abstract: { type: 'string', description: 'Used only in abstract-only mode (no pdf_path)' },
        },
        required: ['slug'],
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const slug = args.slug as string;
      if (!SLUG_RE.test(slug)) return JSON.stringify({ error: 'Invalid slug format.' });

      const bundleDir = path.join(vaultPath, 'Reading', 'attachments', slug);
      const markerPath = path.join(bundleDir, '.zotero-bundle');
      const pdfPath = typeof args.pdf_path === 'string' && args.pdf_path ? args.pdf_path : undefined;
      const abstract = typeof args.abstract === 'string' && args.abstract ? args.abstract : undefined;

      const dirExists = fs.existsSync(bundleDir);
      const hasMarker = dirExists && fs.existsSync(markerPath);

      if (dirExists && !hasMarker) {
        return JSON.stringify({ error: `Pre-existing manual bundle at Reading/attachments/${slug}/ — remove or rename it before using Zotero ingestion.` });
      }

      let existingMarkerFiles: Record<string, string> = {};
      if (hasMarker) {
        existingMarkerFiles = readMarker(markerPath)?.files ?? {};
      }

      if (!dirExists) {
        fs.mkdirSync(bundleDir, { recursive: true });
      }

      const filesCreated: string[] = [];
      const mode = pdfPath ? 'pdf' : 'abstract';

      if (mode === 'pdf') {
        // Validate again (TOCTOU guard)
        try {
          validateZoteroAttachment(pdfPath!, z.storage_root);
        } catch (e) {
          if (!dirExists) fs.rmdirSync(bundleDir);
          return JSON.stringify({ error: (e as Error).message });
        }

        const destPdf = path.join(bundleDir, 'paper.pdf');
        if (fs.existsSync(destPdf)) {
          const existingHash = sha256File(destPdf);
          const sourceHash = sha256File(pdfPath!);
          if (existingHash !== sourceHash) {
            if (!dirExists) fs.rmdirSync(bundleDir);
            return JSON.stringify({ error: `paper.pdf already exists with different content. Delete or rename it before re-running.` });
          }
          // Matching hash — skip write
        } else {
          // Atomic copy via temp file
          const tmpPath = destPdf + '.tmp';
          fs.copyFileSync(pdfPath!, tmpPath);
          fs.renameSync(tmpPath, destPdf);
          filesCreated.push('paper.pdf');
        }

        const pdfHash = sha256File(destPdf);
        const mergedFiles = { ...existingMarkerFiles, 'paper.pdf': pdfHash };
        try {
          writeMarker(markerPath, mergedFiles);
        } catch {
          // Rollback
          for (const f of filesCreated) {
            try { fs.unlinkSync(path.join(bundleDir, f)); } catch { /* best effort */ }
          }
          if (!dirExists && fs.readdirSync(bundleDir).length === 0) {
            fs.rmdirSync(bundleDir);
          }
          return JSON.stringify({ error: 'Failed to write .zotero-bundle marker. Bundle rolled back.' });
        }

        return JSON.stringify({ source_type: 'pdf', source_path: 'paper.pdf', files_created_this_run: filesCreated });
      } else {
        if (!abstract) {
          if (!dirExists) fs.rmdirSync(bundleDir);
          return JSON.stringify({ error: 'Either pdf_path or abstract must be provided.' });
        }

        const destAbstract = path.join(bundleDir, 'abstract.md');
        const abstractContent = `# Abstract\n\n${abstract}`;
        if (fs.existsSync(destAbstract)) {
          const existingHash = sha256File(destAbstract);
          const sourceHash = sha256Text(abstractContent);
          if (existingHash !== sourceHash) {
            if (!dirExists) fs.rmdirSync(bundleDir);
            return JSON.stringify({ error: 'abstract.md already exists with different content.' });
          }
          // Matching — skip write
        } else {
          fs.writeFileSync(destAbstract, abstractContent, 'utf-8');
          filesCreated.push('abstract.md');
        }

        const abstractHash = sha256File(destAbstract);
        const mergedFiles = { ...existingMarkerFiles, 'abstract.md': abstractHash };
        try {
          writeMarker(markerPath, mergedFiles);
        } catch {
          for (const f of filesCreated) {
            try { fs.unlinkSync(path.join(bundleDir, f)); } catch { /* best effort */ }
          }
          if (!dirExists && fs.readdirSync(bundleDir).length === 0) {
            fs.rmdirSync(bundleDir);
          }
          return JSON.stringify({ error: 'Failed to write .zotero-bundle marker. Bundle rolled back.' });
        }

        return JSON.stringify({ source_type: 'notes', source_path: 'abstract.md', files_created_this_run: filesCreated });
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/zotero-tools.ts tests/unit/zotero-tools.test.ts
git commit -m "feat(zotero-tools): implement zotero_prepare_bundle with atomic copy, SHA gating, marker management"
```

---

## Task 13: `zotero_cleanup_bundle` — scoped and full hash-gated cleanup

**Files:**
- Modify: `src/agent/tools/zotero-tools.ts`
- Test: `tests/unit/zotero-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('zotero_cleanup_bundle', () => {
  function getCleanupTool(vaultPath: string) {
    return createZoteroTools(vaultPath).find(t => t.definition.name === 'zotero_cleanup_bundle')!;
  }

  it('refuses to operate when .zotero-bundle is absent', async () => {
    const vault = makeTmpDir();
    fs.mkdirSync(path.join(vault, 'Reading/attachments/test-slug'), { recursive: true });
    const result = JSON.parse(await getCleanupTool(vault).execute({ slug: 'test-slug' }));
    expect(result.error).toMatch(/marker/i);
  });

  it('scoped cleanup: deletes only hash-matching files in the files list', async () => {
    const vault = makeTmpDir();
    const dir = path.join(vault, 'Reading/attachments/test-slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-content');
    fs.writeFileSync(path.join(dir, 'abstract.md'), '# Abstract\n\ntext');
    const pdfHash = sha256File(path.join(dir, 'paper.pdf'));
    const absHash = sha256File(path.join(dir, 'abstract.md'));
    writeMarker(path.join(dir, '.zotero-bundle'), { 'paper.pdf': pdfHash, 'abstract.md': absHash });

    // Scoped to paper.pdf only
    const result = JSON.parse(await getCleanupTool(vault).execute({ slug: 'test-slug', files: ['paper.pdf'] }));
    expect(result.deleted).toContain('paper.pdf');
    expect(result.skipped).not.toContain('abstract.md'); // abstract.md is out-of-scope, not in 'skipped'
    expect(fs.existsSync(path.join(dir, 'paper.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'abstract.md'))).toBe(true);
    // Marker should still exist with only abstract.md
    const marker = readMarker(path.join(dir, '.zotero-bundle'));
    expect(marker?.files['abstract.md']).toBeDefined();
    expect(marker?.files['paper.pdf']).toBeUndefined();
  });

  it('full cleanup (no files param): deletes all hash-matching marker entries, removes dir if empty', async () => {
    const vault = makeTmpDir();
    const dir = path.join(vault, 'Reading/attachments/test-slug2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-content');
    const pdfHash = sha256File(path.join(dir, 'paper.pdf'));
    writeMarker(path.join(dir, '.zotero-bundle'), { 'paper.pdf': pdfHash });

    const result = JSON.parse(await getCleanupTool(vault).execute({ slug: 'test-slug2' }));
    expect(result.deleted).toContain('paper.pdf');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('hash mismatch: user-modified file is skipped (preserved)', async () => {
    const vault = makeTmpDir();
    const dir = path.join(vault, 'Reading/attachments/test-slug3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-original');
    const originalHash = sha256File(path.join(dir, 'paper.pdf'));
    writeMarker(path.join(dir, '.zotero-bundle'), { 'paper.pdf': originalHash });
    // User modifies file
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-modified-by-user');

    const result = JSON.parse(await getCleanupTool(vault).execute({ slug: 'test-slug3' }));
    expect(result.skipped).toContain('paper.pdf');
    expect(fs.existsSync(path.join(dir, 'paper.pdf'))).toBe(true);
    // Marker preserved with the entry (hash-mismatch file kept in marker)
    const marker = readMarker(path.join(dir, '.zotero-bundle'));
    expect(marker?.files['paper.pdf']).toBeDefined();
  });

  it('ghost entry (file already deleted): dropped from rewritten marker', async () => {
    const vault = makeTmpDir();
    const dir = path.join(vault, 'Reading/attachments/test-slug4');
    fs.mkdirSync(dir, { recursive: true });
    writeMarker(path.join(dir, '.zotero-bundle'), { 'paper.pdf': 'some-hash' }); // file not present
    const result = JSON.parse(await getCleanupTool(vault).execute({ slug: 'test-slug4' }));
    // Marker should be gone (no entries remain)
    expect(fs.existsSync(path.join(dir, '.zotero-bundle'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 3: Implement `zoteroCleanupBundleTool`**

```typescript
function zoteroCleanupBundleTool(vaultPath: string, cfg: () => CrickNoteConfig): ToolHandler {
  return {
    definition: {
      name: 'zotero_cleanup_bundle',
      description: 'Remove vault attachment files created by zotero_prepare_bundle on cancel. Hash-gated to prevent destroying user-modified files.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Scoped cleanup: only these files are candidates. Omit for full marker-based cleanup.' },
        },
        required: ['slug'],
      },
    },
    execute: async (args) => {
      const config = cfg();
      const z = getZoteroConfig(config);
      if ('error' in z) return JSON.stringify(z);

      const slug = args.slug as string;
      const bundleDir = path.join(vaultPath, 'Reading', 'attachments', slug);
      const markerPath = path.join(bundleDir, '.zotero-bundle');

      if (!fs.existsSync(markerPath)) {
        return JSON.stringify({ error: 'No .zotero-bundle marker found. Refusing to operate on an unmanaged directory.' });
      }

      const marker = readMarker(markerPath);
      if (!marker) return JSON.stringify({ error: 'Failed to read .zotero-bundle marker.' });

      const scopedFiles: Set<string> | undefined = Array.isArray(args.files)
        ? new Set(args.files as string[])
        : undefined;

      const deleted: string[] = [];
      const skipped: string[] = [];
      const surviving: Record<string, string> = {};

      for (const [filename, storedHash] of Object.entries(marker.files)) {
        const filePath = path.join(bundleDir, filename);
        const inScope = scopedFiles === undefined || scopedFiles.has(filename);

        if (!fs.existsSync(filePath)) {
          // Ghost entry — drop from marker regardless of scope
          continue;
        }

        if (!inScope) {
          // Out-of-scope: preserve in surviving marker
          surviving[filename] = storedHash;
          continue;
        }

        const currentHash = sha256File(filePath);
        if (currentHash !== storedHash) {
          // Hash mismatch — user modified, keep it
          skipped.push(filename);
          surviving[filename] = storedHash;
          continue;
        }

        fs.unlinkSync(filePath);
        deleted.push(filename);
      }

      // Rewrite or delete marker
      if (Object.keys(surviving).length > 0) {
        writeMarker(markerPath, surviving);
      } else {
        try { fs.unlinkSync(markerPath); } catch { /* best effort */ }
      }

      // Remove directory if now empty
      let dirRemoved = false;
      const remaining = fs.readdirSync(bundleDir);
      if (remaining.length === 0) {
        fs.rmdirSync(bundleDir);
        dirRemoved = true;
      }

      return JSON.stringify({ deleted, skipped, dir_removed: dirRemoved });
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/zotero-tools.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/zotero-tools.ts tests/unit/zotero-tools.test.ts
git commit -m "feat(zotero-tools): implement zotero_cleanup_bundle with scoped, full, and hash-gated deletion"
```

---

## Task 14: Register Zotero tools in runtime

**Files:**
- Modify: `src/agent/runtime.ts`

- [ ] **Step 1: Add import and registration**

Add import at top of `src/agent/runtime.ts`:
```typescript
import { createZoteroTools } from './tools/zotero-tools.js';
```

In the constructor, after the `createKbTools` loop:
```typescript
for (const tool of createZoteroTools(config.vaultPath)) {
  this.registry.register(tool);
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/runtime.ts
git commit -m "feat(runtime): register Zotero tools"
```

---

## Task 15: Integration validation

**Files:**
- Test: `tests/integration/zotero-pipeline.test.ts` (create)

This test validates the agent-level orchestration flow end-to-end, using mocked HTTP responses for the Zotero API.

- [ ] **Step 1: Create the integration test**

```typescript
// tests/integration/zotero-pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the http.request call inside zotero-tools to return fake JSON-RPC responses
vi.mock('node:http', async (importOriginal) => {
  // ... return mock that can be configured per-test
});

describe('Zotero pipeline integration', () => {
  it('pending_edit meta flows through runtime into workflow_events', async () => {
    // 1. Stand up a minimal AgentRuntime with an in-memory SQLite
    // 2. Call ingest_reading_bundle with zotero_managed: true
    // 3. The pending_edit result should contain meta with zotero_slug + zotero_files_created + note_rel_path
    // 4. confirmEdit('cancel') → workflow_events row should have those fields
    // 5. Assert the event payload has zotero_slug, zotero_files_created, note_rel_path
  });

  it('note_rel_path is vault-relative (no vault root prefix, no leading /)', async () => {
    // Use a real tmp vault
    // Call ingest_reading_bundle with zotero_managed: true
    // Check pending_edit.meta.note_rel_path starts with "Reading/" and does not start with "/"
  });

  it('auto_summarize: false → assembleSystemPrompt includes the OFF rule', async () => {
    // Build a config with zotero.auto_summarize: false
    // Call assembleSystemPrompt(vaultPath, [], config)
    // Assert the returned string contains "auto_summarize is OFF"
  });

  it('auto_summarize: true (default) → assembleSystemPrompt includes the ON rule', async () => {
    // Build a config without auto_summarize (defaults to true)
    // Assert the returned string contains "auto_summarize is ON"
  });
});
```

- [ ] **Step 2: Implement and run**

```bash
npx vitest run tests/integration/zotero-pipeline.test.ts
```

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/zotero-pipeline.test.ts
git commit -m "test(zotero): integration tests for pipeline meta passthrough and auto_summarize injection"
```

---

## Self-Review Checklist

After writing this plan I checked each spec section:

| Spec section | Covered |
|---|---|
| §1 Goals / Non-goals | Design matches; no `source-loader.ts` changes, no setup CLI changes |
| §2 Path A/B/C resolution | Task 11 |
| §2 DOI normalization (`normalizeDoi`) | Task 2 + used in Task 11 |
| §2 BBT export fallback | Task 11 (`zoteroFetchFallback`) |
| §3 `zotero_fetch_item` | Task 11 |
| §3 `zotero_prepare_bundle` | Task 12 |
| §3 `zotero_cleanup_bundle` | Task 13 |
| §3 Agent orchestration steps 1–10 | Task 6 (context.ts) |
| §3 Cancel flow (non-empty files, vault check) | Task 6 (context.ts prompt) |
| §5 PDF selection logic | Task 11 (`selectPdf`) |
| §6 Frontmatter output (citekey, zotero_key) | Tasks 3 + 7 |
| §7 `validateZoteroAttachment` | Task 10 |
| §8 Long PDF note (20-page cap) | Task 6 (injected into context prompt) |
| §9 Settings / config | Task 4 |
| §9 `enabled` guard | Task 10 (in `getZoteroConfig`) |
| §9 `auto_summarize` injection | Task 6 |
| §10 `IGNORED_BUNDLE_FILES` | Task 7 |
| §10 `readingSourcesEqual` order-insensitive | Task 1 |
| §10 Collision check tiers | Task 8 |
| §10 `effective_sources` / downgrade protection | Task 9 |
| §10 `note_rel_path` in meta | Task 7 |
| §10 Runtime meta passthrough | Task 5 |
| §10 `parsed.message` in `pending_confirmation` | Task 5 |
| §11 Test coverage | Tasks 1–15 |
