# CrickNote Template System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow scientists to customize note body layout and frontmatter fields by editing Markdown template files in `Agent/templates/`, while CrickNote protects automation-critical fields and structural markers.

**Architecture:** A new `src/templates/template-loader.ts` module implements a four-step pipeline (Load → Validate → Merge → Substitute) that every note-creation tool calls instead of building note bodies inline. Template files define scientist-owned fields and body sections; a `PROTECTED_FIELDS` map ensures CrickNote-owned frontmatter always wins. Warnings from template problems flow through `pending_edit` JSON → `runtime.ts` → `websocket.ts` → Obsidian plugin UI.

**Tech Stack:** TypeScript, Node.js `fs` (sync), `gray-matter` for YAML frontmatter parsing, `vitest` for tests.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/templates/template-loader.ts` | Core template pipeline module |
| Modify | `src/knowledge/reading-note.ts` | Fix `hasMeaningfulReadingBody` |
| Modify | `src/agent/tools/serial-tools.ts` | Wire `create_experiment`, `create_protocol`, `create_project`, `create_series` |
| Modify | `src/agent/tools/templates.ts` | Wire `create_reading_note` |
| Modify | `src/agent/tools/reading-intake.ts` | Wire `ingest_reading_bundle` |
| Modify | `src/agent/runtime.ts` | Parse and store `warnings` from tool responses |
| Modify | `src/server/websocket.ts` | Forward `warnings` to Obsidian plugin |
| Modify | `obsidian-plugin/chat-view.ts` | Render warnings as amber notices |
| Modify | `src/cli/setup.ts` | Scaffold `Agent/templates/` on setup |
| Create | `tests/unit/template-loader.test.ts` | Unit tests for entire template pipeline |
| Modify | `tests/unit/reading-note.test.ts` | Add cases for updated `hasMeaningfulReadingBody` |
| Modify | `tests/unit/serial-tools.test.ts` | Assert `warnings` in `pending_edit` result |
| Modify | `tests/unit/template-tools.test.ts` | Assert `warnings` in `create_reading_note` result |
| Modify | `tests/unit/reading-intake.test.ts` | Assert `warnings` + kind selection |
| Modify | `tests/unit/setup.test.ts` | Assert template files created; not overwritten on rerun |

---

## Task 1: Fix `hasMeaningfulReadingBody`

**Files:**
- Modify: `src/knowledge/reading-note.ts:109-118`
- Modify: `tests/unit/reading-note.test.ts`

The current implementation only strips the 6 hardcoded CREATE heading names. A blank custom template section (e.g. `## Methods Notes` with no content) is not stripped, causing `hasMeaningfulReadingBody` to return `true` for an empty note that has a custom template applied. Fix: split on any `## heading` and check whether any section has content.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/reading-note.test.ts`, append a new `describe` block after the existing tests:

```typescript
describe('hasMeaningfulReadingBody — custom template sections', () => {
  it('returns false for a note with only the 6 CREATE headings and no content', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });

  it('returns false for a note with custom headings and no content below them', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n## Methods Notes\n## Lab Protocol\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });

  it('returns true when any section has content', () => {
    const body = `\n# Some Paper\n\n## Claims\nThis paper claims IL-42 suppresses inflammation.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(true);
  });

  it('returns true for a custom heading with content', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n## Methods Notes\nWestern blot protocol used.\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(true);
  });

  it('ignores HTML comments when evaluating content', () => {
    const body = `\n# Some Paper\n\n## Claims\n<!-- placeholder -->\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/reading-note.test.ts
```

Expected: the new `custom template sections` tests fail (the current implementation returns `true` for bodies with only custom headings).

- [ ] **Step 3: Implement the fix**

In `src/knowledge/reading-note.ts`, replace lines 109-118:

```typescript
// OLD:
export function hasMeaningfulReadingBody(body: string): boolean {
  const escapedHeadings = CREATE_SECTION_HEADINGS.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const placeholderOnly = body
    .replace(/^# .+$/gm, '')
    .replace(new RegExp(`^## (${escapedHeadings.join('|')})\\s*$`, 'gm'), '')
    .replace(/^<!--[\s\S]*?-->$/gm, '')
    .trim();

  return placeholderOnly.length > 0;
}
```

```typescript
// NEW:
export function hasMeaningfulReadingBody(body: string): boolean {
  const stripped = body
    .replace(/^# .+$/gm, '')
    .replace(/<!--[\s\S]*?-->/gm, '');
  return stripped.split(/^## .+$/gm).some(section => section.trim().length > 0);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/unit/reading-note.test.ts
```

Expected: all tests pass including the new `custom template sections` describe block.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "fix: hasMeaningfulReadingBody now treats any empty heading as non-meaningful

Custom template sections (e.g. ## Methods Notes with no content) previously
caused false positives. Split on any ## heading and check per-section content."
```

---

## Task 2: Bootstrap `template-loader.ts` — types, constants, Load step

**Files:**
- Create: `src/templates/template-loader.ts`
- Create: `tests/unit/template-loader.test.ts`

- [ ] **Step 1: Create the test file with Load-step tests**

Create `tests/unit/template-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

describe('renderNoteTemplate — Load step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function load() {
    // Dynamic import so each test gets a fresh module evaluation with the current filesystem state
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    return renderNoteTemplate;
  }

  it('uses builtin renderer when Agent/templates/ folder is absent', async () => {
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'Test Exp' },
      context: { title: 'Test Exp', date: '2026-04-22' },
    });
    expect(result.templateUsed).toBe('builtin');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Editable templates are missing');
    expect(result.body).toContain('# Test Exp');
    expect(result.body).toContain('## 2026-04-22 - Initial Setup');
  });

  it('uses builtin renderer when template file is absent from existing templates folder', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'protocol',
      protectedFrontmatter: { note_kind: 'protocol', id: 'PR001', title: 'Western Blot' },
      context: { title: 'Western Blot' },
    });
    expect(result.templateUsed).toBe('builtin');
    expect(result.body).toContain('## Materials');
    expect(result.body).toContain('## Procedure');
  });

  it('loads a valid template file', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n\n## Materials\n`
    );
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T' },
      context: { title: 'My Experiment', date: '2026-04-22' },
    });
    expect(result.templateUsed).toBe('file');
    expect(result.warnings).toHaveLength(0);
  });

  it('throws when template file has invalid YAML frontmatter', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\nkey: [unclosed bracket\n---\n\n# body`
    );
    const renderNoteTemplate = await load();
    await expect(
      renderNoteTemplate({
        vaultPath,
        kind: 'experiment',
        protectedFrontmatter: {},
        context: {},
      })
    ).rejects.toThrow(/invalid YAML/i);
  });

  it('falls back reading-thread to reading-paper.md when reading-thread.md is absent', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'reading-thread',
      protectedFrontmatter: { title: 'T', authors: [], year: 2026, journal: 'J' },
      context: { title: 'Thread Title' },
    });
    expect(result.templateUsed).toBe('file');
    expect(result.body).toContain('## Claims');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (module not found)**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: fails with `Cannot find module '../../src/templates/template-loader.js'`.

- [ ] **Step 3: Create the module with types, constants, and the Load step**

Create `src/templates/template-loader.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { buildCreateReadingBody } from '../knowledge/reading-note.js';

// Public types

export type TemplateKind =
  | 'experiment'
  | 'project-index'
  | 'series'
  | 'protocol'
  | 'reading-paper'
  | 'reading-thread';

export interface RenderResult {
  frontmatter: Record<string, unknown>;
  body: string;
  warnings: string[];
  templateUsed: 'file' | 'builtin';
}

// Internal constants

const TEMPLATE_FILE_BY_KIND: Record<TemplateKind, string> = {
  'experiment':     'experiment.md',
  'project-index':  'project-index.md',
  'series':         'series.md',
  'protocol':       'protocol.md',
  'reading-paper':  'reading-paper.md',
  'reading-thread': 'reading-thread.md',
};

const PROTECTED_FIELDS: Record<TemplateKind, string[]> = {
  'experiment':     ['note_kind', 'id', 'project_id', 'title', 'experiment_type', 'samples', 'reagents', 'status', 'created', 'attachments', 'protocol', 'series'],
  'project-index':  ['note_kind', 'id', 'prefix', 'title', 'status', 'created', 'description'],
  'series':         ['note_kind', 'id', 'project_id', 'title', 'objective', 'status', 'created'],
  'protocol':       ['note_kind', 'id', 'title', 'version', 'category', 'created', 'last_updated', 'derived_from'],
  'reading-paper':  ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
  'reading-thread': ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
};

interface TemplateContract {
  requiredBodyMarkers?: string[];
  requiredHeadings?: string[];
}

const TEMPLATE_CONTRACTS: Record<TemplateKind, TemplateContract> = {
  'experiment':     {},
  'project-index':  {
    requiredBodyMarkers: [
      '<!-- AUTO-GENERATED: experiment-log -->',
      '<!-- END AUTO-GENERATED: experiment-log -->',
      '<!-- AUTO-GENERATED: project-summary -->',
      '<!-- END AUTO-GENERATED: project-summary -->',
    ],
  },
  'series':         {
    requiredBodyMarkers: [
      '<!-- AUTO-GENERATED: experiment-list -->',
      '<!-- END AUTO-GENERATED: experiment-list -->',
    ],
  },
  'protocol':       {},
  'reading-paper':  {
    requiredHeadings: ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions'],
  },
  'reading-thread': {
    requiredHeadings: ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions'],
  },
};

const CURRENT_CONTRACT_VERSION = 1;

const DEFAULT_BODY_RENDERERS: Record<TemplateKind, (ctx: Record<string, string>) => string> = {
  'experiment': (ctx) => {
    const today = ctx.date ?? new Date().toISOString().slice(0, 10);
    const title = ctx.title ?? '';
    return `\n# ${title}\n\n## ${today} - Initial Setup\n\nTODO: Record experiment here.\n`;
  },
  'project-index': (_ctx) =>
    '\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n',
  'series': (ctx) => {
    const title = ctx.title ?? '';
    const objective = ctx.objective ?? 'TODO';
    return `\n# ${title}\n\n## Objective\n${objective}\n\n<!-- AUTO-GENERATED: experiment-list -->\n## Experiments\n| ID | Name | Status | Created |\n|----|------|--------|----------|\n\n<!-- END AUTO-GENERATED: experiment-list -->\n\n## Summary\n`;
  },
  'protocol': (ctx) => {
    const title = ctx.title ?? '';
    return `\n# ${title}\n\n## Materials\n\n## Procedure\n\n## Notes\n`;
  },
  // Delegate to the canonical scaffold builder — single source of truth for the 6-heading structure
  'reading-paper':  (ctx) => buildCreateReadingBody({ title: ctx.title ?? '' }),
  'reading-thread': (ctx) => buildCreateReadingBody({ title: ctx.title ?? '' }),
};

// Step 1: Load

const MISSING_TEMPLATES_WARNING =
  "Editable templates are missing; built-in template used. Re-run setup or wait for 'cricknote templates init' in a later release.";

interface LoadResult {
  templateFrontmatter: Record<string, unknown>;
  templateBody: string;
  templateUsed: 'file' | 'builtin';
  warnings: string[];
}

function loadTemplate(
  vaultPath: string,
  kind: TemplateKind,
  context: Record<string, string>,
): LoadResult | Error {
  const templatesDir = path.join(vaultPath, 'Agent', 'templates');

  if (!fs.existsSync(templatesDir)) {
    const builtinKind = kind === 'reading-thread' ? 'reading-paper' : kind;
    return {
      templateFrontmatter: {},
      templateBody: DEFAULT_BODY_RENDERERS[builtinKind](context),
      templateUsed: 'builtin',
      warnings: [MISSING_TEMPLATES_WARNING],
    };
  }

  // Build candidate list — reading-thread falls back to reading-paper.md
  const candidates: string[] = [TEMPLATE_FILE_BY_KIND[kind]];
  if (kind === 'reading-thread') {
    candidates.push(TEMPLATE_FILE_BY_KIND['reading-paper']);
  }

  let chosenPath: string | null = null;
  for (const candidate of candidates) {
    const p = path.join(templatesDir, candidate);
    if (fs.existsSync(p)) {
      chosenPath = p;
      break;
    }
  }

  if (!chosenPath) {
    const builtinKind = kind === 'reading-thread' ? 'reading-paper' : kind;
    return {
      templateFrontmatter: {},
      templateBody: DEFAULT_BODY_RENDERERS[builtinKind](context),
      templateUsed: 'builtin',
      warnings: [MISSING_TEMPLATES_WARNING],
    };
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(chosenPath, 'utf-8');
  } catch (err) {
    return new Error(
      `Failed to read template ${path.basename(chosenPath)}: ${(err as Error).message}`,
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawContent);
  } catch (err) {
    return new Error(
      `Template ${path.basename(chosenPath)} has invalid YAML frontmatter: ${(err as Error).message}`,
    );
  }

  return {
    templateFrontmatter: parsed.data as Record<string, unknown>,
    templateBody: parsed.content,
    templateUsed: 'file',
    warnings: [],
  };
}

// Public API (Validate/Merge/Substitute added in later tasks)

export async function renderNoteTemplate({
  vaultPath,
  kind,
  protectedFrontmatter,
  context,
}: {
  vaultPath: string;
  kind: TemplateKind;
  protectedFrontmatter: Record<string, unknown>;
  context: Record<string, string>;
}): Promise<RenderResult> {
  // Step 1: Load
  const loadResult = loadTemplate(vaultPath, kind, context);
  if (loadResult instanceof Error) throw loadResult;

  const { templateBody, templateUsed, warnings } = loadResult;

  // Steps 2-4 (Validate, Merge, Substitute) wired in Tasks 3 and 4
  return {
    frontmatter: { ...protectedFrontmatter },
    body: templateBody,
    warnings,
    templateUsed,
  };
}
```

- [ ] **Step 4: Run Load-step tests**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: all Load-step tests pass. `renderNoteTemplate` now calls `loadTemplate` and returns a real result.

> **Note:** The tests use dynamic import (`await import(...)`) inside each test. vitest's module cache means repeated imports in the same process may return a cached module. If tests start sharing state, add `vi.resetModules()` in `beforeEach`. For now the tests are written to not require this.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass. This task introduces an import from `reading-note.ts` — running the full suite catches any module resolution issues before committing.

- [ ] **Step 6: Commit**

```bash
git add src/templates/template-loader.ts tests/unit/template-loader.test.ts
git commit -m "feat: template-loader Load step — types, constants, file/builtin resolution"
```

---

## Task 3: Validate step

**Files:**
- Modify: `src/templates/template-loader.ts`
- Modify: `tests/unit/template-loader.test.ts`

- [ ] **Step 1: Add Validate tests**

Append to `tests/unit/template-loader.test.ts` (before the final closing brace — or add as a new top-level `describe` block after the existing ones):

```typescript
describe('renderNoteTemplate — Validate step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-val-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function render(kind: string, templateContent: string, pf: Record<string, unknown> = {}) {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', `${kind === 'project-index' ? 'project-index' : kind}.md`),
      templateContent
    );
    return renderNoteTemplate({
      vaultPath,
      kind: kind as import('../../src/templates/template-loader.js').TemplateKind,
      protectedFrontmatter: pf,
      context: { title: 'T', date: '2026-01-01' },
    });
  }

  it('warns when template defines a protected field', async () => {
    const result = await render(
      'experiment',
      `---\ntemplate_version: 1\nid: BAD\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes("'id'") && w.includes('ignored'))).toBe(true);
  });

  it('warns when template_version is missing', async () => {
    const result = await render(
      'experiment',
      `---\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes('no version'))).toBe(true);
  });

  it('warns when template_version is older than current contract', async () => {
    const result = await render(
      'experiment',
      `---\ntemplate_version: 0\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes('version 0'))).toBe(true);
  });

  it('throws when project-index template is missing AUTO-GENERATED markers', async () => {
    await expect(
      render(
        'project-index',
        `---\ntemplate_version: 1\n---\n\n## Experiment Log\n## Project Summary\n`
      )
    ).rejects.toThrow(/missing required marker/i);
  });

  it('throws when series template is missing AUTO-GENERATED experiment-list marker', async () => {
    await expect(
      render(
        'series',
        `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## Objective\n{{objective}}\n\n## Summary\n`
      )
    ).rejects.toThrow(/missing required marker/i);
  });

  it('throws when reading-paper template is missing a required heading', async () => {
    await expect(
      render(
        'reading-paper',
        `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n`
        // Missing ## Extensions
      )
    ).rejects.toThrow(/missing required heading.*Extensions/i);
  });

  it('reading-paper validates successfully with all 6 headings', async () => {
    const result = await render(
      'reading-paper',
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    expect(result.warnings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: Validate tests fail because the validation step is not yet wired in — no warnings are produced for protected fields or missing `template_version`, and no errors are thrown for missing required markers or headings.

- [ ] **Step 3: Implement the Validate step and wire it into `renderNoteTemplate`**

Add `validateTemplate` to `src/templates/template-loader.ts` before `renderNoteTemplate`, then update `renderNoteTemplate`:

```typescript
// Step 2: Validate

function validateTemplate(
  kind: TemplateKind,
  templateFrontmatter: Record<string, unknown>,
  templateBody: string,
  warnings: string[],
): Error | null {
  const contract = TEMPLATE_CONTRACTS[kind];
  const protectedFields = PROTECTED_FIELDS[kind];

  // template_version checks
  if (templateFrontmatter.template_version === undefined || templateFrontmatter.template_version === null) {
    warnings.push('Template has no version; may be outdated');
  } else if (
    typeof templateFrontmatter.template_version === 'number'
    && templateFrontmatter.template_version < CURRENT_CONTRACT_VERSION
  ) {
    warnings.push(`Template version ${templateFrontmatter.template_version} may be missing required sections`);
  }

  // Protected field collision warnings
  for (const field of protectedFields) {
    if (field in templateFrontmatter) {
      warnings.push(`Template field '${field}' was ignored - CrickNote owns it.`);
    }
  }

  // Required AUTO-GENERATED markers
  if (contract.requiredBodyMarkers) {
    for (const marker of contract.requiredBodyMarkers) {
      if (!templateBody.includes(marker)) {
        return new Error(`Template for '${kind}' is missing required marker: ${marker}`);
      }
    }
  }

  // Required headings
  if (contract.requiredHeadings) {
    for (const heading of contract.requiredHeadings) {
      if (!new RegExp(`^## ${heading}\\s*$`, 'm').test(templateBody)) {
        return new Error(`Template for '${kind}' is missing required heading: ## ${heading}`);
      }
    }
  }

  return null;
}
```

Replace the stub `renderNoteTemplate` with a partially-wired version:

```typescript
export async function renderNoteTemplate({
  vaultPath,
  kind,
  protectedFrontmatter,
  context,
}: {
  vaultPath: string;
  kind: TemplateKind;
  protectedFrontmatter: Record<string, unknown>;
  context: Record<string, string>;
}): Promise<RenderResult> {
  // Step 1: Load
  const loadResult = loadTemplate(vaultPath, kind, context);
  if (loadResult instanceof Error) throw loadResult;

  const { templateFrontmatter, templateBody, templateUsed, warnings } = loadResult;

  // Step 2: Validate (only for file templates)
  if (templateUsed === 'file') {
    const err = validateTemplate(kind, templateFrontmatter, templateBody, warnings);
    if (err) throw err;
  }

  // Steps 3 & 4 stubbed — Merge and Substitute added in Task 4
  return {
    frontmatter: { ...protectedFrontmatter },
    body: templateBody,
    warnings,
    templateUsed,
  };
}
```

- [ ] **Step 4: Run tests to confirm Validate tests pass**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: all Load tests and all Validate tests pass. Merge/Substitute tests added in Task 4 will fail until that task is complete.

- [ ] **Step 5: Commit**

```bash
git add src/templates/template-loader.ts tests/unit/template-loader.test.ts
git commit -m "feat: template-loader Validate step — contract checks, version warnings, protected field warnings"
```

---

## Task 4: Merge + Substitute steps — complete `renderNoteTemplate`

**Files:**
- Modify: `src/templates/template-loader.ts`
- Modify: `tests/unit/template-loader.test.ts`

- [ ] **Step 1: Add Merge and Substitute tests**

Append to `tests/unit/template-loader.test.ts`:

```typescript
describe('renderNoteTemplate — Merge step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-merge-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('custom template fields appear in merged frontmatter', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: HEK293\npassage_number:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T', status: 'draft' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.cell_line).toBe('HEK293');
    expect(result.frontmatter.passage_number).toBeNull(); // empty YAML value
  });

  it('protected fields always win over template fields', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\nid: SHOULD-BE-IGNORED\ncell_line: HEK293\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.id).toBe('CM001');
    expect(result.frontmatter.cell_line).toBe('HEK293');
  });

  it('template_version is stripped from created note frontmatter', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.template_version).toBeUndefined();
  });

  it('cricknote_template injected for reading-paper and reading-thread only', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');

    // No templates folder — uses builtin, but cricknote_template should still be injected
    const paperResult = await renderNoteTemplate({
      vaultPath,
      kind: 'reading-paper',
      protectedFrontmatter: { title: 'T' },
      context: { title: 'T' },
    });
    expect(paperResult.frontmatter.cricknote_template).toBe('reading-paper');

    const expResult = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(expResult.frontmatter.cricknote_template).toBeUndefined();
  });
});

describe('renderNoteTemplate — Substitute step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-sub-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('substitutes known placeholders in body', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## {{date}} - Start\n\n## ID: {{id}}\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'My Exp', date: '2026-04-22', id: 'CM001' },
    });
    expect(result.body).toContain('# My Exp');
    expect(result.body).toContain('## 2026-04-22 - Start');
    expect(result.body).toContain('## ID: CM001');
  });

  it('warns and leaves unknown placeholders unchanged in body', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## {{cell_line}} protocol\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: {},
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.body).toContain('{{cell_line}}');
    expect(result.warnings.some(w => w.includes('{{cell_line}}'))).toBe(true);
  });

  it('does not substitute placeholders inside frontmatter values', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: "{{cell_line}}"\n---\n\n# {{title}}\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: {},
      context: { title: 'T', date: '2026-01-01', cell_line: 'HEK293' },
    });
    // frontmatter.cell_line should still be the raw string from YAML (gray-matter parses it before substitution)
    // The body placeholder {{title}} should be substituted
    expect(result.body).toContain('# T');
    // cell_line in frontmatter came from the parsed YAML — it is the literal string "{{cell_line}}"
    expect(result.frontmatter.cell_line).toBe('{{cell_line}}');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: Merge and Substitute tests fail; Load and Validate tests still pass.

- [ ] **Step 3: Implement Merge and Substitute, complete `renderNoteTemplate`**

Add these two functions to `src/templates/template-loader.ts`, before `renderNoteTemplate`:

```typescript
// Step 3: Merge

function mergeTemplate(
  kind: TemplateKind,
  templateFrontmatter: Record<string, unknown>,
  protectedFrontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const protectedFields = PROTECTED_FIELDS[kind];

  // Custom fields: everything in the template that is not protected and not template metadata
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(templateFrontmatter)) {
    if (key === 'template_version') continue;
    if (!protectedFields.includes(key)) {
      customFields[key] = value;
    }
  }

  // Protected fields overwrite custom fields
  const merged: Record<string, unknown> = { ...customFields, ...protectedFrontmatter };

  // Loader-injected diagnostic fields
  if (kind === 'reading-paper' || kind === 'reading-thread') {
    merged.cricknote_template = kind;
  }

  return merged;
}

// Step 4: Substitute

function substituteBody(
  body: string,
  context: Record<string, string>,
  warnings: string[],
): string {
  const warned = new Set<string>();
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in context) return context[key];
    if (!warned.has(key)) {
      warned.add(key);
      warnings.push(`Template contains unknown placeholder {{${key}}} - left unchanged.`);
    }
    return match;
  });
}
```

Replace the `renderNoteTemplate` implementation:

```typescript
export async function renderNoteTemplate({
  vaultPath,
  kind,
  protectedFrontmatter,
  context,
}: {
  vaultPath: string;
  kind: TemplateKind;
  protectedFrontmatter: Record<string, unknown>;
  context: Record<string, string>;
}): Promise<RenderResult> {
  // Step 1: Load
  const loadResult = loadTemplate(vaultPath, kind, context);
  if (loadResult instanceof Error) throw loadResult;

  const { templateFrontmatter, templateBody, templateUsed, warnings } = loadResult;

  // Step 2: Validate (only for file templates)
  if (templateUsed === 'file') {
    const err = validateTemplate(kind, templateFrontmatter, templateBody, warnings);
    if (err) throw err;
  }

  // Step 3: Merge
  const frontmatter = mergeTemplate(kind, templateFrontmatter, protectedFrontmatter);

  // Step 4: Substitute (body only — never inside frontmatter values)
  const body = substituteBody(templateBody, context, warnings);

  return { frontmatter, body, warnings, templateUsed };
}
```

- [ ] **Step 4: Run all template-loader tests**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/templates/template-loader.ts tests/unit/template-loader.test.ts
git commit -m "feat: complete renderNoteTemplate pipeline — Merge, Substitute, cricknote_template injection"
```

---

## Task 5: `DEFAULT_TEMPLATE_FILES` export for setup scaffolding

**Files:**
- Modify: `src/templates/template-loader.ts`
- Modify: `tests/unit/template-loader.test.ts`

`DEFAULT_TEMPLATE_FILES` is a `Record<string, string>` mapping filename to content. It is exported from `template-loader.ts` and consumed by `setup.ts` (Task 11).

- [ ] **Step 1: Add export test**

Append to `tests/unit/template-loader.test.ts`:

```typescript
describe('DEFAULT_TEMPLATE_FILES', () => {
  it('exports a file for every TemplateKind plus README', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const expected = [
      'experiment.md',
      'project-index.md',
      'series.md',
      'protocol.md',
      'reading-paper.md',
      'reading-thread.md',
      'README.md',
    ];
    for (const filename of expected) {
      expect(DEFAULT_TEMPLATE_FILES[filename], `missing ${filename}`).toBeTruthy();
    }
  });

  it('experiment.md default template has template_version and custom field stubs', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['experiment.md'];
    expect(content).toContain('template_version: 1');
    expect(content).toContain('cell_line:');
    expect(content).toContain('{{title}}');
    expect(content).toContain('{{date}}');
  });

  it('reading-paper.md default template has all 6 required headings', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['reading-paper.md'];
    for (const heading of ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions']) {
      expect(content).toContain(`## ${heading}`);
    }
  });

  it('project-index.md default template has all AUTO-GENERATED markers', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['project-index.md'];
    expect(content).toContain('<!-- AUTO-GENERATED: experiment-log -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: experiment-log -->');
    expect(content).toContain('<!-- AUTO-GENERATED: project-summary -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: project-summary -->');
  });

  it('series.md default template has AUTO-GENERATED experiment-list markers', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['series.md'];
    expect(content).toContain('<!-- AUTO-GENERATED: experiment-list -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: DEFAULT_TEMPLATE_FILES tests fail with export not found.

- [ ] **Step 3: Add `DEFAULT_TEMPLATE_FILES` to `src/templates/template-loader.ts`**

Add this export at the bottom of the file (after `renderNoteTemplate`):

```typescript
// Default template content (used by setup scaffolding)

export const DEFAULT_TEMPLATE_FILES: Record<string, string> = {
  'experiment.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, project_id, title, experiment_type,
# samples, reagents, status, created, attachments,
# protocol (if provided), series (if provided)

# Add your own fields below:
cell_line:
passage_number:
linked_paper:
---

# {{title}}

## {{date}} - Initial Setup

## Hypothesis

## Materials

## Protocol Steps

## Observations

## Results

## Next Steps
`,

  'project-index.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, prefix, title, status, created,
# description (if provided)

# Add your own fields below:
pi_name:
grant_id:
---

<!-- AUTO-GENERATED: experiment-log -->
## Experiment Log
| Series | ID | Name | Status | Created |
|--------|-----|------|--------|---------|
<!-- END AUTO-GENERATED: experiment-log -->

<!-- AUTO-GENERATED: project-summary -->
## Project Summary
(auto-updated)
<!-- END AUTO-GENERATED: project-summary -->

## Related Knowledge Concepts

## Related Reading

## Related Protocols

## Open Questions
`,

  'series.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, project_id, title, objective, status, created

# Add your own fields below:
---

# {{title}}

## Objective
{{objective}}

<!-- AUTO-GENERATED: experiment-list -->
## Experiments
| ID | Name | Status | Created |
|----|------|--------|---------|
<!-- END AUTO-GENERATED: experiment-list -->

## Summary
`,

  'protocol.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, title, version, category, created, last_updated,
# derived_from (if provided)

# Add your own fields below:
equipment:
safety_notes:
---

# {{title}}

## Materials

## Procedure

## Notes

## Troubleshooting
`,

  'reading-paper.md': `---
template_version: 1

# CrickNote automatically adds:
# title, authors, year, journal, read_date,
# status, kb_status, tags, doi, sources,
# cricknote_template

# Add your own fields below:
lab_relevance:
---

# {{title}}

## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
`,

  'reading-thread.md': `---
template_version: 1

# CrickNote automatically adds:
# title, authors, year, journal, read_date,
# status, kb_status, tags, doi, sources,
# cricknote_template

# Add your own fields below:
thread_topic:
---

# {{title}}

## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
`,

  'README.md': `# CrickNote Templates

Edit these files to customize note layout for your lab.

## What you control

- **Body:** Add, rename, or reorder sections. Keep the sections CrickNote requires (see below).
- **Custom frontmatter fields:** Add any YAML fields below the comment line in each template. They appear in every note of that type.

## What CrickNote controls

Each template has a comment block listing fields CrickNote writes automatically.
Do not add these as YAML keys - they will be ignored.

## Required sections (do not remove)

### \`project-index.md\` and \`series.md\`
These comment markers must stay in the body - CrickNote uses them for automated updates:
- \`<!-- AUTO-GENERATED: experiment-log -->\` / \`<!-- END AUTO-GENERATED: experiment-log -->\`
- \`<!-- AUTO-GENERATED: project-summary -->\` / \`<!-- END AUTO-GENERATED: project-summary -->\`
- \`<!-- AUTO-GENERATED: experiment-list -->\` / \`<!-- END AUTO-GENERATED: experiment-list -->\`

### \`reading-paper.md\` and \`reading-thread.md\`
These six headings must stay - they drive the KB pipeline:
\`\`\`
## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
\`\`\`

## Placeholders

| Placeholder | Available in |
|-------------|-------------|
| \`{{title}}\` | All kinds |
| \`{{date}}\` | experiment, project-index |
| \`{{id}}\` | All kinds (pass in context) |
| \`{{project_id}}\` | experiment, series |
| \`{{objective}}\` | series |

## What happens when templates have problems

| Situation | Behaviour |
|-----------|-----------|
| \`Agent/templates/\` folder missing | Built-in template used; warning shown |
| Template file absent | Built-in template used; warning shown |
| Template file has invalid YAML | Note creation stops; error reported |
| Template defines a CrickNote-owned field | Field ignored; warning shown |
| Required section missing | Note creation stops; error reported |
| Unknown placeholder \`{{xyz}}\` | Left as-is; warning shown |
`,
};
```

- [ ] **Step 4: Run all template-loader tests**

```bash
npx vitest run tests/unit/template-loader.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to confirm nothing is broken**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/templates/template-loader.ts tests/unit/template-loader.test.ts
git commit -m "feat: DEFAULT_TEMPLATE_FILES export — default content for all 6 kinds + README"
```

---

## Task 6: Wire `create_experiment` and `create_protocol`

**Files:**
- Modify: `src/agent/tools/serial-tools.ts`
- Modify: `tests/unit/serial-tools.test.ts`

- [ ] **Step 1: Add tests for warnings in `create_experiment` and `create_protocol`**

Append a new `describe` block to `tests/unit/serial-tools.test.ts`:

```typescript
describe('create_experiment and create_protocol — template integration', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tpl-'));
    // Project folder must start with projectId- so resolveProject('P001') can find it
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'),
      matter.stringify('\n', { note_kind: 'project', id: 'P001', prefix: 'CM', title: 'CM Project', status: 'active', created: '2026-01-01' })
    );
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, ?, ?)').run('CM', 1, 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, ?, ?)').run('CM-S', 1, 'P001');
    // Permanent reservation (far-future expiry) so resolveProject does not auto-heal against a foreign reservation
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', 9999999999999);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('create_experiment returns warnings:[] when no template file is present', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    // No templates folder — builtin used, warning about missing templates
    expect(r.warnings.some((w: string) => w.includes('Editable templates are missing'))).toBe(true);
  });

  it('create_experiment applies custom template fields and warns on protected field', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: HEK293\nid: BAD\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(r.type).toBe('pending_edit');
    const parsed = matter(r.newContent);
    expect(parsed.data.cell_line).toBe('HEK293');
    expect(parsed.data.id).toBe('CM001'); // protected field wins
    expect(r.warnings.some((w: string) => w.includes("'id'") && w.includes('ignored'))).toBe(true);
  });

  it('create_protocol returns warnings:[] and uses builtin body when no templates', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_protocol')!;
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
    const r = JSON.parse(await tool.execute({ title: 'Western Blot', category: 'gel' }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('## Materials');
    expect(parsed.content).toContain('## Procedure');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```

Expected: new `template integration` tests fail because the current code doesn't return `warnings` in the result JSON.

- [ ] **Step 3: Add the import to `serial-tools.ts`**

At the top of `src/agent/tools/serial-tools.ts`, add after the existing imports:

```typescript
import { renderNoteTemplate, type RenderResult } from '../../templates/template-loader.js';
```

- [ ] **Step 4: Replace `create_experiment` body generation (line ~337–354)**

Find this block in `create_experiment`:

```typescript
        const body = `\n# ${args.title as string}\n\n## ${today} - Initial Setup\n\nTODO: Record experiment here.\n`;
        const newContent = matter.stringify(body, fmData);
        const fileName = `${expId}-${slug}.md`;
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
        } catch {
          return JSON.stringify({ error: 'Resolved experiment path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_experiment', path: absPath, newContent });
```

Replace with:

```typescript
        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'experiment',
            protectedFrontmatter: fmData,
            context: { title: args.title as string, date: today },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        const newContent = matter.stringify(renderResult.body, renderResult.frontmatter);
        const fileName = `${expId}-${slug}.md`;
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
        } catch {
          return JSON.stringify({ error: 'Resolved experiment path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_experiment', path: absPath, newContent, warnings: renderResult.warnings });
```

- [ ] **Step 5: Replace `create_protocol` body generation (line ~465–480)**

Find this block in `create_protocol`:

```typescript
        const body = `\n# ${args.title as string}\n\n## Materials\n\n## Procedure\n\n## Notes\n`;
        const newContent = matter.stringify(body, fmData);
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protId}-${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved protocol path is outside the vault.' });
        }
```

Replace with:

```typescript
        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'protocol',
            protectedFrontmatter: fmData,
            context: { title: args.title as string },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        const newContent = matter.stringify(renderResult.body, renderResult.frontmatter);
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protId}-${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved protocol path is outside the vault.' });
        }
```

Also find the `return JSON.stringify` at the end of `create_protocol` execute and add `warnings`:

```typescript
        // OLD:
        return JSON.stringify({ type: 'pending_edit', operation: 'create_protocol', path: absPath, newContent });
        // NEW:
        return JSON.stringify({ type: 'pending_edit', operation: 'create_protocol', path: absPath, newContent, warnings: renderResult.warnings });
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```

Expected: all tests pass including new `template integration` describe block.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools/serial-tools.ts tests/unit/serial-tools.test.ts
git commit -m "feat: wire renderNoteTemplate into create_experiment and create_protocol"
```

---

## Task 7: Wire `create_project` and `create_series`

**Files:**
- Modify: `src/agent/tools/serial-tools.ts`
- Modify: `tests/unit/serial-tools.test.ts`

- [ ] **Step 1: Add tests**

Append to the `template integration` describe block in `tests/unit/serial-tools.test.ts`:

```typescript
  it('create_project returns warnings array and body has AUTO-GENERATED markers', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    // create_project allocates its own reservation — do NOT pre-insert one or the tool will reject it as a collision
    const r = JSON.parse(await tool.execute({ title: 'My Project', prefix: 'XY' }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: experiment-log -->');
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: project-summary -->');
  });

  it('create_series returns warnings array and body has AUTO-GENERATED experiment-list', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_series')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Series',
      objective: 'Test objective',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: experiment-list -->');
    expect(parsed.content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
  });

  it('create_series injects experiment rows into AUTO-GENERATED block when experiments provided', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    // Create an experiment file so validation passes
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CM', 'CM001-my-exp.md'),
      matter.stringify('\n# My Exp\n', { note_kind: 'experiment', id: 'CM001', project_id: 'P001' })
    );
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_series')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Series',
      objective: 'Test',
      experiments: ['CM001'],
    }));
    expect(r.type).toBe('pending_edit');
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('| CM001 |');
    expect(parsed.content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
    // Rows must appear BEFORE the END marker
    const endIdx = parsed.content.indexOf('<!-- END AUTO-GENERATED: experiment-list -->');
    const rowIdx = parsed.content.indexOf('| CM001 |');
    expect(rowIdx).toBeLessThan(endIdx);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```

Expected: new `create_project` and `create_series` tests fail.

- [ ] **Step 3: Replace `create_project` body generation (line ~251)**

Find in `create_project` execute:

```typescript
        const body = `\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n`;
        const newContent = matter.stringify(body, fmData);
        // ...
        return JSON.stringify({ type: 'pending_edit', operation: 'create_project', path: absPath, newContent, reservation: { project_id: projectId, prefix: rawPrefix } });
```

Replace body generation and return (keep everything else — prefix validation, path resolution etc.):

```typescript
        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'project-index',
            protectedFrontmatter: fmData,
            context: { title, date: today },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        const newContent = matter.stringify(renderResult.body, renderResult.frontmatter);
        // ... (path resolution unchanged)
        return JSON.stringify({ type: 'pending_edit', operation: 'create_project', path: absPath, newContent, reservation: { project_id: projectId, prefix: rawPrefix }, warnings: renderResult.warnings });
```

- [ ] **Step 4: Replace `create_series` body generation (lines ~429–446)**

In `create_series` execute, find:

```typescript
        const fmData: Record<string, unknown> = {
          note_kind: 'series', id: seriesId, project_id: projectId,
          title: args.title as string, objective: (args.objective as string | undefined) ?? '',
          status: 'in-progress', created: today,
        };
        const experimentListRows = validatedExperimentIds.length > 0
          ? validatedExperimentIds.map(id => `| ${id} | (see note) | draft | ${today} |`).join('\n')
          : '';
        const body = `\n# ${args.title as string}\n\n## Objective\n${(args.objective as string | undefined) ?? 'TODO'}\n\n<!-- AUTO-GENERATED: experiment-list -->\n## Experiments\n| ID | Name | Status | Created |\n|----|------|--------|----------|\n${experimentListRows}\n<!-- END AUTO-GENERATED: experiment-list -->\n\n## Summary\n<!-- User-owned synthesis -->\n`;
        const newContent = matter.stringify(body, fmData);
        // ...
        return JSON.stringify({ type: 'pending_edit', operation: 'create_series', path: absPath, newContent, series_id: seriesId });
```

Replace with:

```typescript
        const fmData: Record<string, unknown> = {
          note_kind: 'series', id: seriesId, project_id: projectId,
          title: args.title as string, objective: (args.objective as string | undefined) ?? '',
          status: 'in-progress', created: today,
        };
        const experimentListRows = validatedExperimentIds.length > 0
          ? validatedExperimentIds.map(id => `| ${id} | (see note) | draft | ${today} |`).join('\n')
          : '';
        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'series',
            protectedFrontmatter: fmData,
            context: { title: args.title as string, objective: (args.objective as string | undefined) ?? 'TODO' },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        let body = renderResult.body;
        if (experimentListRows.length > 0) {
          body = body.replace(
            '<!-- END AUTO-GENERATED: experiment-list -->',
            `${experimentListRows}\n<!-- END AUTO-GENERATED: experiment-list -->`
          );
        }
        const newContent = matter.stringify(body, renderResult.frontmatter);
        // ...
        return JSON.stringify({ type: 'pending_edit', operation: 'create_series', path: absPath, newContent, series_id: seriesId, warnings: renderResult.warnings });
```

- [ ] **Step 5: Run all serial-tools tests**

```bash
npx vitest run tests/unit/serial-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/serial-tools.ts tests/unit/serial-tools.test.ts
git commit -m "feat: wire renderNoteTemplate into create_project and create_series"
```

---

## Task 8: Wire `create_reading_note` in `templates.ts`

**Files:**
- Modify: `src/agent/tools/templates.ts`
- Modify: `tests/unit/template-tools.test.ts`

- [ ] **Step 1: Add tests**

Append to `tests/unit/template-tools.test.ts`:

```typescript
describe('create_reading_note — template integration', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-reading-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns warnings array (builtin warning when no templates folder)', async () => {
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('applies custom template field when template file present', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    const parsed = matter(r.newContent);
    expect(parsed.data.lab_relevance).toBeNull();
    expect(parsed.data.cricknote_template).toBe('reading-paper');
  });

  it('preserves meaningful existing body without applying template', async () => {
    const existingPath = path.join(vaultPath, 'Reading', 'Papers', 'il-42-review.md');
    fs.writeFileSync(
      existingPath,
      matter.stringify(
        '\n# IL-42 Review\n\n## Claims\nThis paper claims stuff.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n',
        { title: 'IL-42 Review', authors: ['Smith'], year: 2026, journal: 'Nature' }
      )
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    const parsed = matter(r.newContent);
    // Body was preserved — should still contain existing content
    expect(parsed.content).toContain('This paper claims stuff.');
    // Template was NOT applied (body was meaningful) — lab_relevance should not appear
    expect(parsed.data.lab_relevance).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/template-tools.test.ts
```

Expected: new `template integration` tests fail.

- [ ] **Step 3: Update `templates.ts`**

At the top, add import after existing imports:

```typescript
import { renderNoteTemplate, type RenderResult } from '../../templates/template-loader.js';
```

In the `execute` function, find:

```typescript
        const body = (exists && hasMeaningfulReadingBody(existingBody))
          ? syncReadingBodyTitle(existingBody, args.title as string)
          : buildCreateReadingBody({ title: args.title as string });
        const newContent = matter.stringify(body, fmData);

        return JSON.stringify({ type: 'pending_edit', operation: exists ? 'update' : 'create', path: notePath, newContent });
```

Replace with:

```typescript
        let body: string;
        let warnings: string[] = [];
        if (exists && hasMeaningfulReadingBody(existingBody)) {
          body = syncReadingBodyTitle(existingBody, args.title as string);
        } else {
          let renderResult: RenderResult;
          try {
            renderResult = await renderNoteTemplate({
              vaultPath,
              kind: 'reading-paper',
              protectedFrontmatter: fmData,
              context: { title: args.title as string },
            });
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }
          fmData = renderResult.frontmatter;
          body = renderResult.body;
          warnings = renderResult.warnings;
        }
        const newContent = matter.stringify(body, fmData);

        return JSON.stringify({ type: 'pending_edit', operation: exists ? 'update' : 'create', path: notePath, newContent, warnings });
```

- [ ] **Step 4: Run all template-tools tests**

```bash
npx vitest run tests/unit/template-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/templates.ts tests/unit/template-tools.test.ts
git commit -m "feat: wire renderNoteTemplate into create_reading_note"
```

---

## Task 9: Wire `ingest_reading_bundle` in `reading-intake.ts`

**Files:**
- Modify: `src/agent/tools/reading-intake.ts`
- Modify: `tests/unit/reading-intake.test.ts`

- [ ] **Step 1: Add tests**

Append to `tests/unit/reading-intake.test.ts`:

```typescript
describe('ingest_reading_bundle — template integration', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-intake-tpl-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      '# notes'
    );
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function ingest(overrides: Record<string, unknown> = {}) {
    const { createReadingIntakeTools } = await import('../../src/agent/tools/reading-intake.js');
    const tool = createReadingIntakeTools(vaultPath, detector)
      .find(t => t.definition.name === 'ingest_reading_bundle')!;
    return JSON.parse(await tool.execute({
      slug: 'smith-2026-il42',
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
      sources: [{ type: 'notes', path: 'notes.md' }],
      ...overrides,
    }));
  }

  it('returns warnings array when no templates folder exists', async () => {
    const r = await ingest();
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('applies custom template field from reading-paper.md template', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.data.lab_relevance).toBeNull();
    expect(parsed.data.cricknote_template).toBe('reading-paper');
    expect(r.warnings).toHaveLength(0);
  });

  it('uses reading-thread kind when note is in Reading/Threads/', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    // Place an existing thread note so findReadingNoteBySlug returns the Threads path
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md'),
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-thread.md'),
      `---\ntemplate_version: 1\nthread_topic:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.data.cricknote_template).toBe('reading-thread');
    expect(parsed.data.thread_topic).toBeNull();
  });

  it('falls back reading-thread to reading-paper.md when reading-thread.md absent', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md'),
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Only reading-paper.md present, no reading-thread.md
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    // Still kind=reading-thread from loader's perspective, cricknote_template is 'reading-thread'
    expect(parsed.data.cricknote_template).toBe('reading-thread');
    // Custom field from reading-paper.md fallback is present
    expect(parsed.data.lab_relevance).toBeNull();
  });

  it('preserves meaningful existing body without re-applying template', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      matter.stringify(
        '\n# IL-42 Review\n\n## Claims\nThis paper claims stuff.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n',
        { title: 'IL-42 Review', sources: [] }
      )
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('This paper claims stuff.');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

Expected: new `template integration` tests fail.

- [ ] **Step 3: Update `reading-intake.ts`**

At the top, add import after existing imports:

```typescript
import { renderNoteTemplate, type RenderResult, type TemplateKind } from '../../templates/template-loader.js';
```

Find the `preserveExistingBody` call in `ingest_reading_bundle` execute (~line 462):

```typescript
        const body = preserveExistingBody(args.title as string, existingBody);
        const newContent = matter.stringify(body, frontmatter);

        return JSON.stringify({
          type: 'pending_edit',
          operation: exists ? 'update' : 'create',
          path: notePath,
          newContent,
        });
```

Replace with:

```typescript
        let body: string;
        let templateWarnings: string[] = [];
        if (exists && hasMeaningfulReadingBody(existingBody)) {
          body = syncReadingBodyTitle(existingBody, args.title as string);
        } else {
          const folderName = path.basename(path.dirname(notePath));
          const noteKind: TemplateKind = folderName === 'Threads' ? 'reading-thread' : 'reading-paper';
          let renderResult: RenderResult;
          try {
            renderResult = await renderNoteTemplate({
              vaultPath,
              kind: noteKind,
              protectedFrontmatter: frontmatter,
              context: { title: args.title as string },
            });
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }
          frontmatter = renderResult.frontmatter;
          body = renderResult.body;
          templateWarnings = renderResult.warnings;
        }
        const newContent = matter.stringify(body, frontmatter);

        return JSON.stringify({
          type: 'pending_edit',
          operation: exists ? 'update' : 'create',
          path: notePath,
          newContent,
          warnings: templateWarnings,
        });
```

- [ ] **Step 4: Run all reading-intake tests**

```bash
npx vitest run tests/unit/reading-intake.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/reading-intake.ts tests/unit/reading-intake.test.ts
git commit -m "feat: wire renderNoteTemplate into ingest_reading_bundle with kind selection for Threads"
```

---

## Task 10: Warnings pipeline — `runtime.ts` → `websocket.ts` → `chat-view.ts`

**Files:**
- Modify: `src/agent/runtime.ts`
- Modify: `src/server/websocket.ts`
- Modify: `obsidian-plugin/chat-view.ts`

There are no automated tests for websocket/plugin UI (deferred). This task wires types and forwarding. Verify manually using the checklist at the end.

- [ ] **Step 1: Update `PendingEdit` interface in `src/agent/runtime.ts`**

Find lines 23-26:

```typescript
interface PendingEdit {
  editId: string;
  proposal: EditProposal;
}
```

Replace with:

```typescript
interface PendingEdit {
  editId: string;
  proposal: EditProposal;
  warnings: string[];
}
```

- [ ] **Step 2: Update `RuntimeResponse` to expose warnings**

`RuntimeResponse` uses `PendingEdit[]` already — no change needed to the interface. The warnings travel in each `PendingEdit`.

- [ ] **Step 3: Parse warnings from tool response and store in `pendingEdits`**

Find line ~227 in `src/agent/runtime.ts`:

```typescript
            const proposal = this.safeWriter.proposeEdit(absolutePath, parsed.newContent, userMessage, sessionId, meta);
            pendingEdits.push({ editId: proposal.editId, proposal });
```

Replace with:

```typescript
            const proposal = this.safeWriter.proposeEdit(absolutePath, parsed.newContent, userMessage, sessionId, meta);
            const toolWarnings = Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [];
            pendingEdits.push({ editId: proposal.editId, proposal, warnings: toolWarnings });
```

- [ ] **Step 4: Forward `warnings` in `src/server/websocket.ts`**

Find lines 141-146:

```typescript
          const pendingEdits = response.pendingEdits.map(pe => ({
            editId: pe.editId,
            path: path.relative(realVaultPath, pe.proposal.filePath),
            diff: pe.proposal.diff,
            hasConflict: pe.proposal.hasConflict,
          }));
```

Replace with:

```typescript
          const pendingEdits = response.pendingEdits.map(pe => ({
            editId: pe.editId,
            path: path.relative(realVaultPath, pe.proposal.filePath),
            diff: pe.proposal.diff,
            hasConflict: pe.proposal.hasConflict,
            warnings: pe.warnings,
          }));
```

- [ ] **Step 5: Update `ChatMessage` type in `obsidian-plugin/chat-view.ts`**

Find line 10:

```typescript
  pendingEdits?: Array<{ editId: string; path: string; diff: string; hasConflict: boolean }>;
```

Replace with:

```typescript
  pendingEdits?: Array<{ editId: string; path: string; diff: string; hasConflict: boolean; warnings: string[] }>;
```

- [ ] **Step 6: Render warnings in `appendPendingEdits`**

Find in `appendPendingEdits` (~line 270):

```typescript
      editEl.createDiv({ cls: 'cricknote-edit-path', text: edit.path });

      if (edit.hasConflict) {
```

Insert after `editEl.createDiv({ cls: 'cricknote-edit-path', text: edit.path });`:

```typescript
      if (edit.warnings && edit.warnings.length > 0) {
        const warningsEl = editEl.createDiv({ cls: 'cricknote-template-warnings' });
        for (const warning of edit.warnings) {
          warningsEl.createDiv({ cls: 'cricknote-template-warning', text: `Warning: ${warning}` });
        }
      }
```

- [ ] **Step 7: Run full test suite**

```bash
npm test
```

Expected: all tests pass (websocket/plugin changes are type-only, no test regressions).

- [ ] **Step 8: Commit**

```bash
git add src/agent/runtime.ts src/server/websocket.ts obsidian-plugin/chat-view.ts
git commit -m "feat: forward template warnings through runtime → websocket → plugin UI"
```

---

## Task 11: Setup scaffolding — `setup.ts` and `setup.test.ts`

**Files:**
- Modify: `src/cli/setup.ts`
- Modify: `tests/unit/setup.test.ts`

`ensureVaultScaffold` must create `Agent/templates/` and all default template files on first run, and must never overwrite existing files on reruns.

- [ ] **Step 1: Add failing tests to `tests/unit/setup.test.ts`**

Append after the existing tests in `tests/unit/setup.test.ts`:

```typescript
describe('ensureVaultScaffold — template scaffolding', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-tpl-test-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  const EXPECTED_TEMPLATES = [
    'experiment.md',
    'project-index.md',
    'series.md',
    'protocol.md',
    'reading-paper.md',
    'reading-thread.md',
    'README.md',
  ];

  it('creates Agent/templates/ and all default template files on first run', () => {
    ensureVaultScaffold(vaultPath);
    const templatesDir = path.join(vaultPath, 'Agent', 'templates');
    expect(fs.existsSync(templatesDir)).toBe(true);
    for (const filename of EXPECTED_TEMPLATES) {
      const filePath = path.join(templatesDir, filename);
      expect(fs.existsSync(filePath), `missing ${filename}`).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8').length).toBeGreaterThan(0);
    }
  });

  it('does NOT overwrite existing template files on rerun (scientist-edited templates survive)', () => {
    ensureVaultScaffold(vaultPath);
    // Simulate scientist editing experiment.md
    const expPath = path.join(vaultPath, 'Agent', 'templates', 'experiment.md');
    fs.writeFileSync(expPath, '# scientist edited this');
    // Rerun setup
    ensureVaultScaffold(vaultPath);
    // Scientist content must survive
    expect(fs.readFileSync(expPath, 'utf-8')).toBe('# scientist edited this');
  });

  it('creates missing template files without touching existing ones on rerun', () => {
    // First run creates all files
    ensureVaultScaffold(vaultPath);
    // Delete one file to simulate a new template being added in a CrickNote update
    const seriesPath = path.join(vaultPath, 'Agent', 'templates', 'series.md');
    fs.unlinkSync(seriesPath);
    // Edit another file to simulate scientist customization
    const expPath = path.join(vaultPath, 'Agent', 'templates', 'experiment.md');
    fs.writeFileSync(expPath, '# my custom experiment template');
    // Rerun setup
    ensureVaultScaffold(vaultPath);
    // Missing file restored
    expect(fs.existsSync(seriesPath)).toBe(true);
    // Existing file preserved
    expect(fs.readFileSync(expPath, 'utf-8')).toBe('# my custom experiment template');
  });

  it('experiment.md default content contains template_version and required placeholders', () => {
    ensureVaultScaffold(vaultPath);
    const content = fs.readFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      'utf-8'
    );
    expect(content).toContain('template_version: 1');
    expect(content).toContain('{{title}}');
    expect(content).toContain('{{date}}');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/unit/setup.test.ts
```

Expected: new `template scaffolding` tests fail because `ensureVaultScaffold` doesn't create templates yet.

- [ ] **Step 3: Update `src/cli/setup.ts`**

Add import after existing imports:

```typescript
import { DEFAULT_TEMPLATE_FILES } from '../templates/template-loader.js';
```

In `ensureVaultScaffold`, after the `rebuildKnowledgeIndex` loop, add:

```typescript
  // Scaffold Agent/templates/ with default files — never overwrite existing files
  const templatesDir = path.join(vaultPath, 'Agent', 'templates');
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }
  for (const [filename, content] of Object.entries(DEFAULT_TEMPLATE_FILES)) {
    const filePath = path.join(templatesDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
```

- [ ] **Step 4: Run all setup tests**

```bash
npx vitest run tests/unit/setup.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/setup.ts tests/unit/setup.test.ts
git commit -m "feat: scaffold Agent/templates/ on setup — create missing files, never overwrite scientist edits"
```

---

## Manual verification checklist

After all tasks are committed, build the project and test end-to-end in Obsidian:

```bash
npm run build
```

- [ ] Create a note with a template that defines a protected field (e.g. add `id: BAD` to `experiment.md`) — confirm amber warning appears in plugin above diff
- [ ] Create a note with a template containing `{{unknown_placeholder}}` — confirm warning appears and placeholder is visible verbatim in note body
- [ ] Remove `Agent/templates/` folder and create a note — confirm built-in body is used and the setup warning appears above diff
- [ ] Edit `reading-paper.md` to add a custom field (e.g. `funding_source:`) — confirm it appears in all new reading notes
- [ ] Break a series template by removing `<!-- AUTO-GENERATED: experiment-list -->` — confirm note creation stops with a clear error (not a silent fallback)
- [ ] Run `cricknote setup` with existing scientist-edited templates — confirm they are not overwritten

---

## Implementation phases (reference)

| Phase | Tasks | Estimate |
|-------|-------|----------|
| 1a | Tasks 1–5 (`template-loader.ts` complete with all steps + unit tests) | 1–2 days |
| 1b | Tasks 6–9 (wire into all tools) | 1 day |
| 1c | Task 10 (warnings pipeline) | 0.5 days |
| 1d | Task 11 (setup scaffolding) | 0.5 days |
| **Total** | | **3–4 days** |
