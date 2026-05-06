# Periodic Notes Write Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full read/write support for daily, weekly, and monthly periodic notes — safe-edit flow, conflict-detector integration, append/replace modes, predictable frontmatter, and routing coverage.

**Architecture:** Four new tools (`get_month_plan`, `write_diary`, `write_week_plan`, `write_month_plan`) added to `src/agent/tools/context.ts` alongside existing read tools; date helpers centralized in `src/utils/date.ts`; `createContextTools` receives the conflict detector from `runtime.ts`; routing bundles extended to include write tools; system prompt gains a monthly context layer.

**Tech Stack:** TypeScript, Node.js, gray-matter (frontmatter parse/stringify), Vitest, Obsidian vault filesystem

---

## File Map

| File | Change |
|------|--------|
| `src/utils/date.ts` | Add `getISOWeekInfo` (moved from `src/agent/context.ts`) + `localMonthString` |
| `src/agent/context.ts` | Import `getISOWeekInfo` / `localMonthString` from utils; re-export `getISOWeekInfo`; add monthly context layer |
| `src/agent/tools/context.ts` | Update signature to accept `conflictDetector?`; add snapshot recording to read tools; add `get_month_plan`, `write_diary`, `write_week_plan`, `write_month_plan` |
| `src/agent/tool-router.ts` | Add `write_diary` / `write_week_plan` to their bundles; add `monthplan` bundle; add monthly routing pattern |
| `src/agent/runtime.ts` | Pass `conflictDetector` to `createContextTools` |
| `tests/unit/date-utils.test.ts` | Update `getISOWeekInfo` import to `src/utils/date.ts`; add `localMonthString` tests |
| `tests/unit/context-tools.test.ts` | **New** — unit tests for all six context tools |
| `tests/unit/context-prompt.test.ts` | Add monthly context injection test; update `getISOWeekInfo` import |
| `tests/unit/tool-router.test.ts` | Add routing tests for periodic write messages and false-positives |

---

## Task 1 — Centralize date helpers in `src/utils/date.ts`

**Files:**
- Modify: `src/utils/date.ts`
- Modify: `tests/unit/date-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

Add at the bottom of `tests/unit/date-utils.test.ts` (also change the existing `getISOWeekInfo` import at line 3 from `../../src/agent/context.js` to `../../src/utils/date.js`):

```typescript
// Change existing import (line 3):
import { localDateString, utcDateString, getISOWeekInfo, localMonthString } from '../../src/utils/date.js';

// Remove the old import line:
// import { getISOWeekInfo } from '../../src/agent/context.js';

// Add new describe block at bottom:
describe('localMonthString', () => {
  it('returns a YYYY-MM string', () => {
    expect(localMonthString()).toMatch(/^\d{4}-\d{2}$/);
  });

  it('formats a specific local date correctly', () => {
    const d = new Date(2026, 2, 15); // March 15 2026
    expect(localMonthString(d)).toBe('2026-03');
  });

  it('formats December correctly', () => {
    const d = new Date(2026, 11, 1); // December 1 2026
    expect(localMonthString(d)).toBe('2026-12');
  });

  it('does not drift near UTC midnight', () => {
    // Local 00:30 on March 1 (UTC+1) = Feb 28 23:30 UTC — must return 2026-03, not 2026-02
    const d = new Date(2026, 2, 1, 0, 30, 0);
    expect(localMonthString(d)).toBe('2026-03');
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/date-utils.test.ts 2>&1 | tail -20
```

Expected: FAIL — `localMonthString` is not exported from `src/utils/date.ts`.

- [ ] **Step 3: Add `getISOWeekInfo` and `localMonthString` to `src/utils/date.ts`**

Append to `src/utils/date.ts`:

```typescript
/**
 * Return the current month as a YYYY-MM string in the LOCAL timezone.
 */
export function localMonthString(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

/**
 * Return the ISO week number and ISO week-year for a given local date.
 *
 * ISO weeks run Monday–Sunday. Late-December dates that belong to the next
 * year's week 1 (e.g. Dec 29 2025 = ISO week 1 of 2026) return the correct
 * ISO year, not the calendar year.
 */
export function getISOWeekInfo(date: Date): { week: number; isoYear: number } {
  // Use local date components for the UTC Date so the week boundary matches
  // the user's local date, not the UTC date.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, isoYear };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/date-utils.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Update `src/agent/context.ts` to import from utils and re-export**

In `src/agent/context.ts`:

1. Add import at top (after existing imports):
```typescript
import { localDateString, getISOWeekInfo, localMonthString } from '../utils/date.js';
```

2. Remove the local `getISOWeekInfo` function definition (lines 189–201 in the current file).

3. Add a re-export immediately after the imports block so existing test consumers don't break:
```typescript
export { getISOWeekInfo } from '../utils/date.js';
```

- [ ] **Step 6: Verify full test suite still passes**

```bash
cd /Users/le211/crickNote && npx vitest run 2>&1 | tail -20
```

Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
cd /Users/le211/crickNote && git add src/utils/date.ts src/agent/context.ts tests/unit/date-utils.test.ts && git commit -m "refactor: centralize getISOWeekInfo + add localMonthString in utils/date"
```

---

## Task 2 — Add `get_month_plan` and three write tools to `src/agent/tools/context.ts`

**Files:**
- Modify: `src/agent/tools/context.ts`
- Create: `tests/unit/context-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/context-tools.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextTools } from '../../src/agent/tools/context.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';
import { localDateString, localMonthString, getISOWeekInfo } from '../../src/utils/date.js';

let vaultPath: string;
let detector: ConflictDetector;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-ctx-tools-'));
  detector = new ConflictDetector();
});

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// ── get_today_diary ──────────────────────────────────────────────────────────

describe('get_today_diary', () => {
  it('returns exists:false when no diary file', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_today_diary')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(false);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns content when diary file exists', async () => {
    const today = localDateString();
    const dir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${today}.md`), '# Today\n\nEntry here.');

    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_today_diary')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(true);
    expect(result.content).toContain('Entry here.');
  });

  it('records a conflict-detector snapshot when file exists', async () => {
    const today = localDateString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${today}.md`);
    fs.writeFileSync(filePath, '# Diary');

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'get_today_diary')!;
    await tool.execute({});
    expect(detector.getSnapshot(filePath)).toBeDefined();
  });
});

// ── get_week_plan ────────────────────────────────────────────────────────────

describe('get_week_plan', () => {
  it('returns exists:false when no weekly file', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_week_plan')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(false);
  });

  it('returns content when weekly file exists', async () => {
    const { week, isoYear } = getISOWeekInfo(new Date());
    const filename = `${isoYear}-W${String(week).padStart(2, '0')}.md`;
    const dir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), '# Week Plan\n\nGoals here.');

    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_week_plan')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(true);
    expect(result.content).toContain('Goals here.');
  });
});

// ── get_month_plan ───────────────────────────────────────────────────────────

describe('get_month_plan', () => {
  it('returns exists:false when no monthly file', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_month_plan')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(false);
    expect(result.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('returns content when monthly file exists', async () => {
    const month = localMonthString();
    const dir = path.join(vaultPath, 'Memory', 'Monthly');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${month}.md`), '# Monthly Plan\n\nObjectives here.');

    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'get_month_plan')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.exists).toBe(true);
    expect(result.content).toContain('Objectives here.');
  });

  it('records a conflict-detector snapshot when file exists', async () => {
    const month = localMonthString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Monthly');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${month}.md`);
    fs.writeFileSync(filePath, '# Monthly');

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'get_month_plan')!;
    await tool.execute({});
    expect(detector.getSnapshot(filePath)).toBeDefined();
  });
});

// ── write_diary ──────────────────────────────────────────────────────────────

describe('write_diary', () => {
  it('creates a new diary file with default frontmatter when it does not exist', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'write_diary')!;
    const result = JSON.parse(await tool.execute({ content: 'Today I ran gels.' }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');
    expect(result.path).toMatch(/Memory[/\\]Daily[/\\]\d{4}-\d{2}-\d{2}\.md$/);
    expect(result.newContent).toContain('type: daily-diary');
    expect(result.newContent).toContain('Today I ran gels.');
  });

  it('appends to an existing diary (default mode)', async () => {
    const today = localDateString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${today}.md`);
    fs.writeFileSync(filePath, `---\ndate: ${today}\ntype: daily-diary\n---\n\n# ${today}\n\nExisting entry.`);

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'write_diary')!;
    const result = JSON.parse(await tool.execute({ content: 'New entry.' }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('update');
    expect(result.newContent).toContain('Existing entry.');
    expect(result.newContent).toContain('New entry.');
    expect(detector.getSnapshot(filePath)).toBeDefined();
  });

  it('replace mode preserves frontmatter and replaces body', async () => {
    const today = localDateString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Daily');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${today}.md`);
    fs.writeFileSync(filePath, `---\ndate: ${today}\ntype: daily-diary\n---\n\n# ${today}\n\nOld content.`);

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'write_diary')!;
    const result = JSON.parse(await tool.execute({ content: 'Replaced content.', mode: 'replace' }));

    expect(result.newContent).toContain('type: daily-diary');
    expect(result.newContent).toContain('Replaced content.');
    expect(result.newContent).not.toContain('Old content.');
  });
});

// ── write_week_plan ──────────────────────────────────────────────────────────

describe('write_week_plan', () => {
  it('creates a new weekly file with frontmatter when it does not exist', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'write_week_plan')!;
    const result = JSON.parse(await tool.execute({ content: 'Goals: finish gel protocol.' }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');
    expect(result.path).toMatch(/Memory[/\\]Weekly[/\\]\d{4}-W\d{2}\.md$/);
    expect(result.newContent).toContain('type: weekly-plan');
    expect(result.newContent).toContain('Goals: finish gel protocol.');
  });

  it('appends to an existing weekly file', async () => {
    const { week, isoYear } = getISOWeekInfo(new Date());
    const filename = `${isoYear}-W${String(week).padStart(2, '0')}.md`;
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Weekly');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, `---\nweek: ${isoYear}-W${String(week).padStart(2, '0')}\ntype: weekly-plan\n---\n\n# Week\n\nExisting goals.`);

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'write_week_plan')!;
    const result = JSON.parse(await tool.execute({ content: 'New review.' }));

    expect(result.newContent).toContain('Existing goals.');
    expect(result.newContent).toContain('New review.');
    expect(detector.getSnapshot(filePath)).toBeDefined();
  });
});

// ── write_month_plan ─────────────────────────────────────────────────────────

describe('write_month_plan', () => {
  it('creates a new monthly file with frontmatter when it does not exist', async () => {
    const tool = createContextTools(vaultPath).find(t => t.definition.name === 'write_month_plan')!;
    const result = JSON.parse(await tool.execute({ content: 'Monthly objective: submit paper.' }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');
    expect(result.path).toMatch(/Memory[/\\]Monthly[/\\]\d{4}-\d{2}\.md$/);
    expect(result.newContent).toContain('type: monthly-plan');
    expect(result.newContent).toContain('Monthly objective: submit paper.');
  });

  it('appends to an existing monthly file', async () => {
    const month = localMonthString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Monthly');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${month}.md`);
    fs.writeFileSync(filePath, `---\nmonth: ${month}\ntype: monthly-plan\n---\n\n# ${month}\n\nExisting objectives.`);

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'write_month_plan')!;
    const result = JSON.parse(await tool.execute({ content: 'Monthly review.' }));

    expect(result.newContent).toContain('Existing objectives.');
    expect(result.newContent).toContain('Monthly review.');
    expect(detector.getSnapshot(filePath)).toBeDefined();
  });

  it('replace mode preserves frontmatter and replaces body', async () => {
    const month = localMonthString();
    const realVault = fs.realpathSync(vaultPath);
    const dir = path.join(realVault, 'Memory', 'Monthly');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${month}.md`);
    fs.writeFileSync(filePath, `---\nmonth: ${month}\ntype: monthly-plan\n---\n\n# ${month}\n\nOld objectives.`);

    const tool = createContextTools(vaultPath, detector).find(t => t.definition.name === 'write_month_plan')!;
    const result = JSON.parse(await tool.execute({ content: 'New objectives.', mode: 'replace' }));

    expect(result.newContent).toContain('type: monthly-plan');
    expect(result.newContent).toContain('New objectives.');
    expect(result.newContent).not.toContain('Old objectives.');
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/context-tools.test.ts 2>&1 | tail -20
```

Expected: FAIL — `get_month_plan`, `write_diary`, `write_week_plan`, `write_month_plan` do not exist yet; `createContextTools` does not accept a `conflictDetector` argument.

- [ ] **Step 3: Rewrite `src/agent/tools/context.ts`**

Replace the entire file with:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolHandler } from './registry.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import { localDateString, localMonthString, getISOWeekInfo } from '../../utils/date.js';
import { resolveVaultPath } from '../../utils/paths.js';

export function createContextTools(vaultPath: string, conflictDetector?: ConflictDetector): ToolHandler[] {
  function weekFilename(): { filename: string; label: string } {
    const { week, isoYear } = getISOWeekInfo(new Date());
    const label = `${isoYear}-W${String(week).padStart(2, '0')}`;
    return { filename: `${label}.md`, label };
  }

  return [
    // ── Read tools ──────────────────────────────────────────────────────────

    {
      definition: {
        name: 'get_today_diary',
        description: "Read today's daily diary note from Memory/Daily/.",
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        const today = localDateString();
        const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);

        if (!fs.existsSync(diaryPath)) {
          return JSON.stringify({ exists: false, date: today, message: 'No diary entry for today yet.' });
        }

        const content = fs.readFileSync(diaryPath, 'utf-8');
        conflictDetector?.recordFileRead(diaryPath, content);
        return JSON.stringify({ exists: true, date: today, content });
      },
    },

    {
      definition: {
        name: 'get_week_plan',
        description: "Read this week's planning note from Memory/Weekly/.",
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        const { filename, label } = weekFilename();
        const weekPath = path.join(vaultPath, 'Memory', 'Weekly', filename);

        if (!fs.existsSync(weekPath)) {
          return JSON.stringify({ exists: false, week: label, message: 'No weekly plan for this week yet.' });
        }

        const content = fs.readFileSync(weekPath, 'utf-8');
        conflictDetector?.recordFileRead(weekPath, content);
        return JSON.stringify({ exists: true, week: label, content });
      },
    },

    {
      definition: {
        name: 'get_month_plan',
        description: "Read this month's planning note from Memory/Monthly/.",
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        const month = localMonthString();
        const monthPath = path.join(vaultPath, 'Memory', 'Monthly', `${month}.md`);

        if (!fs.existsSync(monthPath)) {
          return JSON.stringify({ exists: false, month, message: 'No monthly plan for this month yet.' });
        }

        const content = fs.readFileSync(monthPath, 'utf-8');
        conflictDetector?.recordFileRead(monthPath, content);
        return JSON.stringify({ exists: true, month, content });
      },
    },

    // ── Write tools ─────────────────────────────────────────────────────────

    {
      definition: {
        name: 'write_diary',
        description: [
          "Write to today's daily diary note in Memory/Daily/.",
          "mode='append' (default) adds content to the end of the file.",
          "mode='replace' rewrites the body, preserving the existing frontmatter.",
          "Creates the file with default frontmatter if it does not exist.",
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to write' },
            mode: {
              type: 'string',
              enum: ['append', 'replace'],
              description: "Write mode — 'append' adds to end (default), 'replace' rewrites body",
            },
          },
          required: ['content'],
        },
      },
      execute: async (args) => {
        const today = localDateString();
        const relPath = `Memory/Daily/${today}.md`;
        const fullPath = resolveVaultPath(vaultPath, relPath);
        const defaultFm = `---\ndate: ${today}\ntype: daily-diary\n---\n\n# ${today}\n\n`;
        return buildPeriodicEdit(fullPath, args.content as string, (args.mode as string) ?? 'append', defaultFm, conflictDetector);
      },
    },

    {
      definition: {
        name: 'write_week_plan',
        description: [
          "Write to this week's planning note in Memory/Weekly/.",
          "mode='append' (default) adds content to the end of the file.",
          "mode='replace' rewrites the body, preserving the existing frontmatter.",
          "Creates the file with default frontmatter if it does not exist.",
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to write' },
            mode: {
              type: 'string',
              enum: ['append', 'replace'],
              description: "Write mode — 'append' adds to end (default), 'replace' rewrites body",
            },
          },
          required: ['content'],
        },
      },
      execute: async (args) => {
        const { filename, label } = weekFilename();
        const relPath = `Memory/Weekly/${filename}`;
        const fullPath = resolveVaultPath(vaultPath, relPath);
        const defaultFm = `---\nweek: ${label}\ntype: weekly-plan\n---\n\n# ${label}\n\n`;
        return buildPeriodicEdit(fullPath, args.content as string, (args.mode as string) ?? 'append', defaultFm, conflictDetector);
      },
    },

    {
      definition: {
        name: 'write_month_plan',
        description: [
          "Write to this month's planning note in Memory/Monthly/.",
          "mode='append' (default) adds content to the end of the file.",
          "mode='replace' rewrites the body, preserving the existing frontmatter.",
          "Creates the file with default frontmatter if it does not exist.",
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to write' },
            mode: {
              type: 'string',
              enum: ['append', 'replace'],
              description: "Write mode — 'append' adds to end (default), 'replace' rewrites body",
            },
          },
          required: ['content'],
        },
      },
      execute: async (args) => {
        const month = localMonthString();
        const relPath = `Memory/Monthly/${month}.md`;
        const fullPath = resolveVaultPath(vaultPath, relPath);
        const defaultFm = `---\nmonth: ${month}\ntype: monthly-plan\n---\n\n# ${month}\n\n`;
        return buildPeriodicEdit(fullPath, args.content as string, (args.mode as string) ?? 'append', defaultFm, conflictDetector);
      },
    },
  ];
}

function buildPeriodicEdit(
  fullPath: string,
  content: string,
  mode: string,
  defaultFm: string,
  conflictDetector?: ConflictDetector,
): string {
  if (!fs.existsSync(fullPath)) {
    return JSON.stringify({
      type: 'pending_edit',
      path: fullPath,
      newContent: defaultFm + content,
      operation: 'create',
    });
  }

  const existing = fs.readFileSync(fullPath, 'utf-8');
  conflictDetector?.recordFileRead(fullPath, existing);

  let newContent: string;
  if (mode === 'replace') {
    const parsed = matter(existing);
    if (Object.keys(parsed.data).length > 0) {
      // matter.stringify(body, data) → ---\n{yaml}\n---\n{body}
      // Prefix body with \n so there is a blank line after the closing ---.
      newContent = matter.stringify('\n' + content, parsed.data);
    } else {
      newContent = content;
    }
  } else {
    newContent = existing.trimEnd() + '\n\n' + content;
  }

  return JSON.stringify({ type: 'pending_edit', path: fullPath, newContent, operation: 'update' });
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/context-tools.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite — no regressions**

```bash
cd /Users/le211/crickNote && npx vitest run 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
cd /Users/le211/crickNote && git add src/agent/tools/context.ts tests/unit/context-tools.test.ts && git commit -m "feat: add get_month_plan, write_diary, write_week_plan, write_month_plan context tools"
```

---

## Task 3 — Pass conflict detector to `createContextTools` in `src/agent/runtime.ts`

**Files:**
- Modify: `src/agent/runtime.ts:151`

This is a one-line change — no new tests needed (context-tools.test.ts already covers the detector logic; runtime-routing.test.ts already verifies the runtime constructs without errors).

- [ ] **Step 1: Update `src/agent/runtime.ts` line 151**

Change:
```typescript
    for (const tool of createContextTools(config.vaultPath)) {
```

To:
```typescript
    for (const tool of createContextTools(config.vaultPath, conflictDetector)) {
```

- [ ] **Step 2: Confirm full suite passes**

```bash
cd /Users/le211/crickNote && npx vitest run 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/le211/crickNote && git add src/agent/runtime.ts && git commit -m "fix: pass conflictDetector into createContextTools so periodic writes are protected"
```

---

## Task 4 — Add monthly context layer to `src/agent/context.ts`

**Files:**
- Modify: `src/agent/context.ts`
- Modify: `tests/unit/context-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/context-prompt.test.ts`, after the existing `describe('assembleSystemPrompt — week tool only', ...)` block:

Also update the import at line 5 to add `localMonthString`:
```typescript
import { assembleSystemPrompt, getISOWeekInfo } from '../../src/agent/context.js';
import { localDateString, localMonthString } from '../../src/utils/date.js';
```

Add the new describe block:

```typescript
describe('assembleSystemPrompt — month tool only', () => {
  it("includes This Month's Plan when monthly file exists", () => {
    const monthlyDir = path.join(vaultPath, 'Memory', 'Monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    const month = localMonthString();
    fs.writeFileSync(path.join(monthlyDir, `${month}.md`), '# Monthly Plan Content');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_month_plan')]);
    expect(prompt).toContain("This Month's Plan");
    expect(prompt).toContain('Monthly Plan Content');
  });

  it("does NOT include This Month's Plan when monthly file is absent", () => {
    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_month_plan')]);
    expect(prompt).not.toContain("This Month's Plan");
  });

  it("does NOT include This Month's Plan when only diary tool is active", () => {
    const monthlyDir = path.join(vaultPath, 'Memory', 'Monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    const month = localMonthString();
    fs.writeFileSync(path.join(monthlyDir, `${month}.md`), '# Monthly Plan Content');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_today_diary')]);
    expect(prompt).not.toContain("This Month's Plan");
  });

  it("does NOT include This Month's Plan even if monthly file exists with zero tools", () => {
    const monthlyDir = path.join(vaultPath, 'Memory', 'Monthly');
    fs.mkdirSync(monthlyDir, { recursive: true });
    const month = localMonthString();
    fs.writeFileSync(path.join(monthlyDir, `${month}.md`), '# Monthly');

    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain("This Month's Plan");
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/context-prompt.test.ts 2>&1 | tail -20
```

Expected: FAIL — monthly context is not injected yet.

- [ ] **Step 3: Add `hasMonthTool` check and monthly context layer to `src/agent/context.ts`**

In `assembleSystemPrompt`, after:
```typescript
  const hasWeekTool = activeToolNames.has('get_week_plan');
```
Add:
```typescript
  const hasMonthTool = activeToolNames.has('get_month_plan');
```

After the existing week-plan injection block (Layer 8, starting at `if (hasWeekTool) {`), add Layer 9:

```typescript
  // Layer 9: Current month's plan — only when month-plan tool is active
  if (hasMonthTool) {
    const month = localMonthString();
    const monthPath = path.join(vaultPath, 'Memory', 'Monthly', `${month}.md`);
    const monthPlan = cachedReadFile(monthPath);
    if (monthPlan !== null) {
      sections.push(`## This Month's Plan\n\n${monthPlan}`);
    }
  }
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/context-prompt.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite — no regressions**

```bash
cd /Users/le211/crickNote && npx vitest run 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
cd /Users/le211/crickNote && git add src/agent/context.ts tests/unit/context-prompt.test.ts && git commit -m "feat: inject monthly context layer into system prompt when get_month_plan is active"
```

---

## Task 5 — Extend routing bundles and patterns in `src/agent/tool-router.ts`

**Files:**
- Modify: `src/agent/tool-router.ts`
- Modify: `tests/unit/tool-router.test.ts`

- [ ] **Step 1: Write the failing routing tests**

Add to `tests/unit/tool-router.test.ts`, after the existing `describe('routeTools — context bundle ...')` block:

```typescript
describe('routeTools — context bundle (write tools)', () => {
  // diary writes
  it('matches "save my diary" → includes write_diary', () => {
    expect(routeTools('save my diary')).toContain('write_diary');
  });
  it('matches "update my diary" → includes write_diary', () => {
    expect(routeTools('update my diary')).toContain('write_diary');
  });
  it('matches "write in my diary" → includes write_diary', () => {
    expect(routeTools('write in my diary')).toContain('write_diary');
  });
  it('diary bundle includes both read and write tools', () => {
    const t = routeTools('save my diary');
    expect(t).toContain('get_today_diary');
    expect(t).toContain('write_diary');
  });

  // weekly writes
  it('matches "update my weekly plan" → includes write_week_plan', () => {
    expect(routeTools('update my weekly plan')).toContain('write_week_plan');
  });
  it('matches "save my weekly review" → includes write_week_plan', () => {
    expect(routeTools('save my weekly review')).toContain('write_week_plan');
  });
  it('week bundle includes both read and write tools', () => {
    const t = routeTools('update my weekly plan');
    expect(t).toContain('get_week_plan');
    expect(t).toContain('write_week_plan');
  });

  // monthly reads and writes
  it('matches "my monthly plan" → includes get_month_plan', () => {
    expect(routeTools('show me my monthly plan')).toContain('get_month_plan');
  });
  it('matches "write my monthly review" → includes write_month_plan', () => {
    expect(routeTools('write my monthly review')).toContain('write_month_plan');
  });
  it('matches "my monthly summary" → includes both month tools', () => {
    const t = routeTools('save my monthly summary');
    expect(t).toContain('get_month_plan');
    expect(t).toContain('write_month_plan');
  });
  it('matches "monthly plan" → includes month tools', () => {
    expect(routeTools('show me the monthly plan')).toContain('get_month_plan');
  });
  it('matches "monthly review" → includes month tools', () => {
    expect(routeTools('save the monthly review')).toContain('write_month_plan');
  });
});

describe('routeTools — false-positive protection (periodic notes)', () => {
  it('does NOT route monthly tools for "my monthly meeting"', () => {
    const t = routeTools('schedule my monthly meeting');
    expect(t).not.toContain('get_month_plan');
    expect(t).not.toContain('write_month_plan');
  });
  it('does NOT route monthly tools for bare "monthly" (no qualifying noun)', () => {
    expect(routeTools('how do I do monthly backups?')).not.toContain('get_month_plan');
  });
  it("does NOT route diary for someone else's diary", () => {
    expect(routeTools("I read Einstein's diary yesterday")).not.toContain('write_diary');
  });
  it('does NOT route diary for "Anne Frank\'s diary"', () => {
    expect(routeTools("tell me about Anne Frank's diary")).not.toContain('write_diary');
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/tool-router.test.ts 2>&1 | tail -20
```

Expected: FAIL — `write_diary`, `write_week_plan`, `get_month_plan`, `write_month_plan` are not in any bundles yet.

- [ ] **Step 3: Update `src/agent/tool-router.ts`**

**3a — Update `BUNDLES`**: change the `diary`, `weekplan` entries and add `monthplan`:

```typescript
const BUNDLES = {
  search: ['vault_search', 'vault_read', 'vault_list'],
  write:  ['vault_read', 'vault_write', 'vault_append'],
  tasks:  ['task_list', 'task_add', 'task_complete'],
  reading: [
    'create_reading_note', 'discover_reading_bundle', 'ingest_reading_bundle',
    'reading_pipeline_status', 'set_reading_note_status', 'compile_reading_note',
    'vault_read', 'vault_write', 'vault_append',
  ],
  kb: [
    'kb_suggest', 'kb_write_mapping', 'kb_apply', 'kb_apply_advance',
    'kb_apply_direct', 'kb_resolve_review', 'kb_lint',
    'vault_search', 'vault_read', 'vault_write',
  ],
  project: [
    'reserve_prefix', 'register_project_counters', 'create_project',
    'create_experiment', 'create_series', 'create_protocol', 'update_project_index',
    'vault_read', 'vault_write', 'vault_append', 'vault_list',
  ],
  // Diary, week-plan, and month-plan are separate so asking about one does not
  // inject the others. Each bundle includes its read + write tool pair so the
  // agent can read before writing.
  diary:     ['get_today_diary', 'write_diary'],
  weekplan:  ['get_week_plan', 'write_week_plan'],
  monthplan: ['get_month_plan', 'write_month_plan'],
} as const;
```

**3b — Add the monthly routing pattern** in `routeTools`, after the existing `weekplan` routing block:

```typescript
  if (has(text, /\bmy\s+monthly\s+(?:plan|review|summary|notes)\b|\bmonthly\s+(?:plan|review)\b/)) {
    addBundle(selected, 'monthplan');
  }
```

- [ ] **Step 4: Run routing tests — expect PASS**

```bash
cd /Users/le211/crickNote && npx vitest run tests/unit/tool-router.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite — no regressions**

```bash
cd /Users/le211/crickNote && npx vitest run 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
cd /Users/le211/crickNote && git add src/agent/tool-router.ts tests/unit/tool-router.test.ts && git commit -m "feat: extend routing bundles and patterns for periodic note read/write"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|-----------------|-----------|
| `write_diary`, `write_week_plan`, `write_month_plan` return `pending_edit` | Task 2 — `buildPeriodicEdit` always returns `{ type: 'pending_edit', ... }` |
| `get_month_plan` read tool | Task 2 |
| Route read + write together | Task 5 — each bundle contains both |
| Pass conflict detector into context tools | Task 3 |
| Centralize date helpers | Task 1 |
| Default frontmatter (`type: daily-diary`, etc.) | Task 2 — `defaultFm` templates in each write tool |
| `mode: 'append'` and `mode: 'replace'` | Task 2 — `buildPeriodicEdit` |
| Routing tests for write messages | Task 5 |
| False-positive tests | Task 5 |
| Tool tests (paths, pending edits) | Task 2 |
| Prompt tests for monthly context injection | Task 4 |

**Placeholder scan:** No TBDs, no "similar to Task N" shortcuts, no "add error handling" vagueness. Every code block is complete.

**Type consistency:**
- `buildPeriodicEdit` is a module-level function in `context.ts` (tools file) — referenced only within that file.
- `getISOWeekInfo` and `localMonthString` are exported from `src/utils/date.ts` and imported by both `src/agent/context.ts` and `src/agent/tools/context.ts`.
- `createContextTools(vaultPath, conflictDetector?)` — same signature used in `runtime.ts` Task 3 and tests Task 2.
- `get_month_plan`, `write_diary`, `write_week_plan`, `write_month_plan` — exact names used consistently across tools, bundles, routing, and prompt checks.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-periodic-notes-write-support.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, with checkpoints

**Which approach?**
