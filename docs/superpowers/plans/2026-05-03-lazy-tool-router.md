# Lazy Tool Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded empty tool list in `runtime.ts` with a keyword-based router that sends only the tool bundle(s) relevant to the user's message, defaulting to zero tools for plain chat.

**Architecture:** A pure `routeTools(message)` function maps keyword patterns to named tool bundles; `ToolRegistry.getDefinitionsByName` converts those names to JSON schemas; `assembleSystemPrompt` adapts its instructions and vault-context injections to the active tool set; `processMessage` routes once, runs the agent loop while buffering streaming output, then retries once with the search bundle if the no-tool response signals it needs vault access — the stale DB row is deleted and buffered chunks are discarded before the retry.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, existing `ToolRegistry` / `LLMProvider` / `SafeWriter` infrastructure.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/agent/tool-router.ts` | Create | Pure routing: `routeTools`, `needsVaultAccess`, `SEARCH_BUNDLE` |
| `src/agent/tools/registry.ts` | Modify | Add `getDefinitionsByName(names: string[]): ToolDefinition[]` |
| `src/agent/context.ts` | Modify | Gate tool-instruction prose and vault-context injection on active tools |
| `src/agent/runtime.ts` | Modify | Extract `runAgentLoop`; wire router + buffered one-shot retry in `processMessage` |
| `src/storage/database.ts` | Modify | Export `setDatabase` for test injection |
| `tests/unit/tool-router.test.ts` | Create | Unit tests: correct routing, false-positive protection |
| `tests/unit/tool-registry-by-name.test.ts` | Create | Unit tests for `getDefinitionsByName` |
| `tests/unit/context-prompt.test.ts` | Create | Unit tests: prompt content gated on active tools |
| `tests/unit/runtime-routing.test.ts` | Create | Fake-provider tests: tool selection, retry, DB cleanup, onChunk isolation |

---

## Task 1: Add `getDefinitionsByName` to ToolRegistry

**Files:**
- Modify: `src/agent/tools/registry.ts`
- Create: `tests/unit/tool-registry-by-name.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tool-registry-by-name.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import type { ToolHandler } from '../../src/agent/tools/registry.js';

function makeHandler(name: string): ToolHandler {
  return {
    definition: { name, description: `desc ${name}`, parameters: {} },
    execute: async () => '{}',
  };
}

describe('ToolRegistry.getDefinitionsByName', () => {
  it('returns definitions for known names in registration order', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    reg.register(makeHandler('vault_write'));
    reg.register(makeHandler('vault_search'));

    const defs = reg.getDefinitionsByName(['vault_search', 'vault_read']);
    expect(defs.map(d => d.name)).toEqual(['vault_read', 'vault_search']);
  });

  it('silently ignores unknown names', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));

    const defs = reg.getDefinitionsByName(['vault_read', 'nonexistent']);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('vault_read');
  });

  it('returns empty array for empty names list', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    expect(reg.getDefinitionsByName([])).toEqual([]);
  });

  it('deduplicates if the same name appears twice in the input', () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('vault_read'));
    const defs = reg.getDefinitionsByName(['vault_read', 'vault_read']);
    expect(defs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run tests/unit/tool-registry-by-name.test.ts
```

Expected: FAIL — `reg.getDefinitionsByName is not a function`

- [ ] **Step 3: Add `getDefinitionsByName` to ToolRegistry**

Open `src/agent/tools/registry.ts`. After the `getDefinitions()` line (line 16), insert:

```typescript
getDefinitionsByName(names: string[]): ToolDefinition[] {
  const nameSet = new Set(names);
  return Array.from(this.tools.values())
    .filter(h => nameSet.has(h.definition.name))
    .map(h => h.definition);
}
```

The full file becomes:

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
  getDefinitionsByName(names: string[]): ToolDefinition[] {
    const nameSet = new Set(names);
    return Array.from(this.tools.values())
      .filter(h => nameSet.has(h.definition.name))
      .map(h => h.definition);
  }
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

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/unit/tool-registry-by-name.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/registry.ts tests/unit/tool-registry-by-name.test.ts
git commit -m "feat: add ToolRegistry.getDefinitionsByName for lazy tool selection"
```

---

## Task 2: Create `src/agent/tool-router.ts`

**Files:**
- Create: `src/agent/tool-router.ts`
- Create: `tests/unit/tool-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tool-router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { routeTools, needsVaultAccess, SEARCH_BUNDLE } from '../../src/agent/tool-router.js';

// ── True-positive: correct bundle selection ──────────────────────────────

describe('routeTools — search bundle', () => {
  it('matches "find my notes"', () => {
    const t = routeTools('find my notes on IL-42');
    expect(t).toContain('vault_search');
    expect(t).toContain('vault_read');
    expect(t).toContain('vault_list');
  });
  it('matches "search my vault"', () => {
    expect(routeTools('search my vault for CRISPR')).toContain('vault_search');
  });
  it('matches "search my notes"', () => {
    expect(routeTools('search my notes on LTP')).toContain('vault_search');
  });
  it('matches "look up in my vault"', () => {
    expect(routeTools('look up this in my vault')).toContain('vault_search');
  });
  it('matches "what did I write"', () => {
    expect(routeTools('what did I write about synaptic tagging?')).toContain('vault_search');
  });
  it('matches "my notes on"', () => {
    expect(routeTools('show me my notes on LTP')).toContain('vault_search');
  });
  it('matches "experiment results"', () => {
    expect(routeTools('what were the experiment results for P001?')).toContain('vault_search');
  });
});

describe('routeTools — write bundle', () => {
  it('matches "edit my protocol note"', () => {
    const t = routeTools('edit my protocol note');
    expect(t).toContain('vault_write');
    expect(t).toContain('vault_append');
  });
  it('matches "update my experiment note"', () => {
    expect(routeTools('update my experiment note')).toContain('vault_write');
  });
  it('matches "append to my daily note"', () => {
    expect(routeTools('append to my daily note')).toContain('vault_append');
  });
  it('matches "modify my protocol note"', () => {
    expect(routeTools('modify my protocol note')).toContain('vault_write');
  });
});

describe('routeTools — tasks bundle', () => {
  it('matches "add a task"', () => {
    const t = routeTools('add a task: review Chen 2024');
    expect(t).toContain('task_add');
    expect(t).toContain('task_list');
    expect(t).toContain('task_complete');
  });
  it('matches "show my task list"', () => {
    expect(routeTools('show my task list')).toContain('task_list');
  });
  it('matches "my todo list"', () => {
    expect(routeTools('show me my todo list')).toContain('task_list');
  });
  it('matches "mark done"', () => {
    expect(routeTools('mark done the PCR task')).toContain('task_complete');
  });
});

describe('routeTools — reading bundle', () => {
  it('matches "reading note"', () => {
    const t = routeTools('create a reading note for this paper');
    expect(t).toContain('create_reading_note');
    expect(t).toContain('vault_write');
  });
  it('matches "ingest"', () => {
    expect(routeTools('ingest this paper into my vault')).toContain('ingest_reading_bundle');
  });
  it('matches "compile reading note"', () => {
    expect(routeTools('compile the reading note for Chen 2024')).toContain('compile_reading_note');
  });
  it('matches "source bundle"', () => {
    expect(routeTools('discover the source bundle for this DOI')).toContain('discover_reading_bundle');
  });
  it('matches "my paper" (possessive)', () => {
    expect(routeTools('add my paper on CRISPR to vault')).toContain('create_reading_note');
  });
});

describe('routeTools — kb bundle', () => {
  it('matches "kb lint"', () => {
    const t = routeTools('kb lint my notes');
    expect(t).toContain('kb_lint');
    expect(t).toContain('vault_search');
  });
  it('matches "kb suggest"', () => {
    expect(routeTools('kb suggest for reading note')).toContain('kb_suggest');
  });
  it('matches "knowledge base"', () => {
    expect(routeTools('update my knowledge base')).toContain('kb_suggest');
  });
  it('matches "add a claim to my notes"', () => {
    expect(routeTools('add a claim to my notes')).toContain('kb_suggest');
  });
});

describe('routeTools — project bundle', () => {
  it('matches "new experiment"', () => {
    const t = routeTools('create a new experiment for western blot');
    expect(t).toContain('create_experiment');
    expect(t).toContain('reserve_prefix');
    expect(t).toContain('vault_write');
  });
  it('matches "create project"', () => {
    expect(routeTools('create a new project on memory consolidation')).toContain('create_project');
  });
  it('matches "new series"', () => {
    expect(routeTools('start a new series for my blot experiments')).toContain('create_series');
  });
  it('matches "new protocol"', () => {
    expect(routeTools('new protocol for gel electrophoresis')).toContain('create_protocol');
  });
  it('matches "write a new protocol"', () => {
    expect(routeTools('write a new protocol for gel electrophoresis')).toContain('create_protocol');
  });
});

describe('routeTools — context bundle (diary and week split)', () => {
  it('matches "my diary" → diary tool only, not week plan', () => {
    const t = routeTools('show me my diary');
    expect(t).toContain('get_today_diary');
    expect(t).not.toContain('get_week_plan');
  });
  it('matches "today\'s diary" → diary tool only', () => {
    const t = routeTools("what is today's diary entry?");
    expect(t).toContain('get_today_diary');
    expect(t).not.toContain('get_week_plan');
  });
  it('matches "my week plan" → week tool only, not diary', () => {
    const t = routeTools('show me my week plan');
    expect(t).toContain('get_week_plan');
    expect(t).not.toContain('get_today_diary');
  });
  it('matches both when both are asked', () => {
    const t = routeTools("show me my diary and my week plan");
    expect(t).toContain('get_today_diary');
    expect(t).toContain('get_week_plan');
  });
});

// ── False-positives: plain questions that must NOT get write tools ────────

describe('routeTools — false-positive protection', () => {
  it('returns [] for plain science question', () => {
    expect(routeTools('explain what western blot is')).toEqual([]);
  });
  it('returns [] for "what is today\'s date"', () => {
    expect(routeTools("what is today's date?")).toEqual([]);
  });
  it('returns [] for "Anne Frank\'s diary"', () => {
    expect(routeTools("tell me about Anne Frank's diary")).toEqual([]);
  });
  it('returns [] for "paper chromatography"', () => {
    expect(routeTools('how does paper chromatography work?')).toEqual([]);
  });
  it('returns [] for "compile the code"', () => {
    expect(routeTools('how do I compile the code?')).toEqual([]);
  });
  it('returns [] for bare "I claim this is wrong"', () => {
    expect(routeTools('I claim this approach is wrong')).toEqual([]);
  });
  it('returns [] for "TV series"', () => {
    expect(routeTools('recommend a good TV series')).toEqual([]);
  });
  it('does NOT route write tools for "update the formula" (no "note")', () => {
    expect(routeTools('update the formula for Kd')).not.toContain('vault_write');
  });
  it('does NOT route write tools for "edit the image"', () => {
    expect(routeTools('how do I edit the image in FIJI?')).not.toContain('vault_write');
  });
  it('does NOT route write tools for "edit my data" (no "note")', () => {
    expect(routeTools('edit my data in Excel')).not.toContain('vault_write');
  });
  it('does NOT route diary for bare "today"', () => {
    expect(routeTools("what is today's date?")).not.toContain('get_today_diary');
  });
  it('does NOT route diary for someone else\'s diary', () => {
    expect(routeTools("I read Einstein's diary")).not.toContain('get_today_diary');
  });
  it('does NOT route kb for bare "claim" without "notes" object', () => {
    expect(routeTools('I claim this theory is wrong')).not.toContain('kb_suggest');
  });
});

// ── Multi-bundle and deduplication ───────────────────────────────────────

describe('routeTools — multi-bundle', () => {
  it('combines bundles when multiple categories match', () => {
    const t = routeTools('search my vault and add a task');
    expect(t).toContain('vault_search');
    expect(t).toContain('task_add');
  });
  it('deduplicates tools shared across bundles', () => {
    const t = routeTools('search my notes on LTP and edit my experiment note');
    const vaultRead = t.filter(n => n === 'vault_read');
    expect(vaultRead).toHaveLength(1);
  });
});

// ── needsVaultAccess ─────────────────────────────────────────────────────

describe('needsVaultAccess', () => {
  it('detects "don\'t have access to your vault"', () => {
    expect(needsVaultAccess("I don't have access to your vault")).toBe(true);
  });
  it('detects "cannot search your notes"', () => {
    expect(needsVaultAccess('I cannot search your notes')).toBe(true);
  });
  it('detects "unable to access your vault"', () => {
    expect(needsVaultAccess('I am unable to access your vault')).toBe(true);
  });
  it('detects "without access to your vault"', () => {
    expect(needsVaultAccess('Without access to your vault I cannot answer')).toBe(true);
  });
  it('detects "can\'t read your notes"', () => {
    expect(needsVaultAccess("I can't read your notes")).toBe(true);
  });
  it('returns false for normal scientific replies', () => {
    expect(needsVaultAccess('Western blot is a technique used to detect proteins.')).toBe(false);
  });
  it('returns false for "Here is a summary"', () => {
    expect(needsVaultAccess('Here is a summary of the protocol.')).toBe(false);
  });
  it('returns false for "I cannot read images"', () => {
    expect(needsVaultAccess('I cannot read images.')).toBe(false);
  });
  it('returns false for "I cannot look at attachments"', () => {
    expect(needsVaultAccess('I cannot look at attachments.')).toBe(false);
  });
  it('returns false for "I am unable to access the internet"', () => {
    expect(needsVaultAccess('I am unable to access the internet.')).toBe(false);
  });
});

// ── SEARCH_BUNDLE export ─────────────────────────────────────────────────

describe('SEARCH_BUNDLE', () => {
  it('contains vault_search, vault_read, vault_list', () => {
    expect(SEARCH_BUNDLE).toContain('vault_search');
    expect(SEARCH_BUNDLE).toContain('vault_read');
    expect(SEARCH_BUNDLE).toContain('vault_list');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run tests/unit/tool-router.test.ts
```

Expected: FAIL — `Cannot find module '../../src/agent/tool-router.js'`

- [ ] **Step 3: Create `src/agent/tool-router.ts`**

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
  // Diary and week-plan are separate so asking about one does not inject the other.
  diary:    ['get_today_diary'],
  weekplan: ['get_week_plan'],
} as const;

type BundleKey = keyof typeof BUNDLES;

// Each rule: if pattern matches the user message, add the listed bundles.
// Patterns require vault/possessive framing to avoid false-positives on
// informational questions that happen to share vocabulary.
const RULES: Array<{ pattern: RegExp; bundles: BundleKey[] }> = [
  // Search: vault-specific framing required
  {
    pattern: /\bfind\s+my\b|\bsearch\s+(my\s+)?(vault|notes)\b|\blook\s+up\s.*\bvault\b|\bwhat did i write\b|\bin my vault\b|\bmy notes\s+on\b|\bexperiment results\b/i,
    bundles: ['search'],
  },
  // Write: requires "my/the ... note" as the object of the edit verb
  {
    pattern: /\bedit\s+(my|the)\s+\w+\s+note\b|\bupdate\s+(my|the)\s+\w+\s+note\b|\bappend\s+to\s+(my|the)\b|\bmodify\s+(my|the)\s+\w+\s+note\b/i,
    bundles: ['write'],
  },
  // Tasks: "add a task", "my task/todo", "mark done"
  {
    pattern: /\badd\s+a\s+task\b|\b(show|list|my)\s+(a\s+)?task\b|\btodo\b|\bto-do\b|\bmark\s+done\b/i,
    bundles: ['tasks'],
  },
  // Reading: possessive "my paper", or reading-specific workflow verbs
  {
    pattern: /\bmy paper\b|\breading note\b|\bingest\b|\bcompile\s+(the\s+)?reading\b|\bsource bundle\b/i,
    bundles: ['reading'],
  },
  // KB: explicit "kb <verb>", "knowledge base", or "add a claim to my notes"
  {
    pattern: /\bkb\s+(lint|suggest|apply|write|resolve|mapping)\b|\bknowledge\s+base\b|\badd\s+a\s+claim\s+to\s+my\s+notes\b/i,
    bundles: ['kb'],
  },
  // Project: "new/create experiment/project/series/protocol" or "write a new protocol"
  {
    pattern: /\bnew\s+experiment\b|\bcreate\s+(a\s+)?(new\s+)?(experiment|project|series|protocol)\b|\bnew\s+project\b|\bnew\s+protocol\b|\bnew\s+series\b|\bwrite\s+a\s+new\s+protocol\b/i,
    bundles: ['project'],
  },
  // Diary: possessive only — "my diary" or "today's diary"
  {
    pattern: /\bmy\s+diary\b|\btoday[''']?s\s+diary\b/i,
    bundles: ['diary'],
  },
  // Week plan: possessive only
  {
    pattern: /\bmy\s+week\s*plan\b|\bmy\s+weekly\s+plan\b/i,
    bundles: ['weekplan'],
  },
];

export const SEARCH_BUNDLE: readonly string[] = BUNDLES.search;

export function routeTools(message: string): string[] {
  const selected = new Set<string>();
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      for (const key of rule.bundles) {
        for (const tool of BUNDLES[key]) {
          selected.add(tool);
        }
      }
    }
  }
  return [...selected];
}

export function needsVaultAccess(text: string): boolean {
  const vaultObj = '(vault|notes|files|diary|obsidian)';
  return new RegExp(
    `don['']?t have access to your ${vaultObj}` +
    `|cannot (search|read|look) your ${vaultObj}` +
    `|no access to your ${vaultObj}` +
    `|need vault access` +
    `|unable to (search|read|access) your ${vaultObj}` +
    `|can['']?t (search|read|access) your ${vaultObj}` +
    `|without access to your ${vaultObj}`,
    'i'
  ).test(text);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/unit/tool-router.test.ts
```

Expected: PASS (all tests). If any false-positive test fails, tighten the matching regex before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tool-router.ts tests/unit/tool-router.test.ts
git commit -m "feat: add keyword-based tool router with diary/week-plan split and false-positive protection"
```

---

## Task 3: Make `assembleSystemPrompt` tool-aware

**Files:**
- Modify: `src/agent/context.ts`

`assembleSystemPrompt` currently always tells the model to use vault tools and always injects diary/week plan content, even when no tools are active. In zero-tool mode this creates contradictory instructions and leaks vault context into plain chat.

- [ ] **Step 1: Replace `assembleSystemPrompt` in `src/agent/context.ts`**

Replace the entire `assembleSystemPrompt` function (lines 64–152 in the original file) with:

```typescript
export function assembleSystemPrompt(
  vaultPath: string,
  tools: ToolDefinition[]
): string {
  const { agentMd, soulMd, skills } = loadAgentConfig(vaultPath);
  const activeToolNames = new Set(tools.map(t => t.name));
  const hasTools = tools.length > 0;
  const hasReadingTools = activeToolNames.has('create_reading_note') || activeToolNames.has('ingest_reading_bundle');
  const hasDiaryTool = activeToolNames.has('get_today_diary');
  const hasWeekTool = activeToolNames.has('get_week_plan');

  const sections: string[] = [];

  // Layer 1: Base instructions — adapt to tool availability
  if (hasTools) {
    sections.push(`You are CrickNote, a scientific research assistant for biology/life sciences.
You help researchers record experiments, retrieve data, manage protocols, track literature, and plan their work.
You operate on an Obsidian vault and can read, search, and write notes.

IMPORTANT RULES:
- When writing to the vault, you MUST use the appropriate tool. Never output vault content as plain text.
- Always use structured frontmatter when creating experiment or reading notes.
- When asked about experiments, search the vault first before answering.
- Be precise with scientific data — never fabricate results.
- When uncertain, say so and ask the user to clarify.`);
  } else {
    sections.push(`You are CrickNote, a scientific research assistant for biology/life sciences.
You help researchers think through experiments, explain techniques, and answer scientific questions.
Vault access is not available for this query — answer from your scientific knowledge only.
Be precise with scientific data — never fabricate results.
When uncertain, say so and ask the user to clarify.`);
  }

  // Layer 2: Reading workflow — only when reading tools are active
  if (hasReadingTools) {
    sections.push(`## Reading Workflow

Preferred reading-note order:
1. Call reading_pipeline_status first.
2. If the reading note does not exist yet, call discover_reading_bundle or ingest_reading_bundle.
3. If the note is ready, call compile_reading_note.
4. After the user reviews the draft, call set_reading_note_status with status: complete.
5. Then continue with kb_suggest, kb_write_mapping, and kb_apply.`);
  }

  // Layer 3: Agent config (user's core rules)
  if (agentMd) {
    sections.push(`## User-Defined Agent Rules\n\n${agentMd}`);
  }

  // Layer 4: Soul (personality)
  if (soulMd) {
    sections.push(`## Personality\n\n${soulMd}`);
  }

  // Layer 5: Skills
  for (const skill of skills) {
    sections.push(`## Skill\n\n${skill}`);
  }

  // Layer 6: Today's diary — only when diary tool is active
  if (hasDiaryTool) {
    const today = localDateString();
    const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);
    const diary = cachedReadFile(diaryPath);
    if (diary !== null) {
      sections.push(`## Today's Diary (${today})\n\n${diary}`);
    }
  }

  // Layer 7: KB lint reminder — only when kb_lint is active
  if (activeToolNames.has('kb_lint')) {
    const lintReportsDir = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports');
    if (fs.existsSync(lintReportsDir)) {
      const reports = fs.readdirSync(lintReportsDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort();

      const unfinishedKbCount = getCachedUnfinishedKbCount(vaultPath);

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
  }

  // Layer 8: Current week's plan — only when week-plan tool is active
  if (hasWeekTool) {
    const { week: weekNum, isoYear } = getISOWeekInfo(new Date());
    const weekPath = path.join(vaultPath, 'Memory', 'Weekly', `${isoYear}-W${String(weekNum).padStart(2, '0')}.md`);
    const weekPlan = cachedReadFile(weekPath);
    if (weekPlan !== null) {
      sections.push(`## This Week's Plan\n\n${weekPlan}`);
    }
  }

  return sections.join('\n\n---\n\n');
}
```

- [ ] **Step 2: Run the existing test suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all previously passing tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add src/agent/context.ts
git commit -m "feat: gate system prompt tool instructions and vault context on active tools"
```

---

## Task 4: Add `setDatabase` export to `src/storage/database.ts`

**Files:**
- Modify: `src/storage/database.ts`

This export is test-only infrastructure that lets unit tests inject an in-memory SQLite instance. It mutates the module-level singleton; call it only in `beforeEach` test setup.

- [ ] **Step 1: Open `src/storage/database.ts` and add the export after `closeDatabase`**

The module-level variable is `let db: Database.Database | null = null;` (line 7). After the `closeDatabase` export (line 23), add:

```typescript
export function setDatabase(instance: Database.Database | null): void {
  db = instance;
}
```

- [ ] **Step 2: Run the full test suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all previously passing tests still PASS.

- [ ] **Step 3: Commit**

```bash
git add src/storage/database.ts
git commit -m "test: export setDatabase for in-memory DB injection in unit tests"
```

---

## Task 5: Wire the router into `runtime.ts`

**Files:**
- Modify: `src/agent/runtime.ts`

This task: (a) adds imports, (b) extracts the while-loop into a private `runAgentLoop` method, (c) replaces the entire `processMessage` method with a version that routes tools, buffers streaming chunks on the no-tool first pass, and retries cleanly if needed.

- [ ] **Step 1: Add imports to `src/agent/runtime.ts`**

Find the existing import line (line 7):
```typescript
import type { LLMProvider, Message, ToolCall, StreamChunk } from './providers/base.js';
```

Replace with:
```typescript
import type { LLMProvider, Message, ToolCall, StreamChunk, ToolDefinition } from './providers/base.js';
```

Then after the last existing import line, add:
```typescript
import { routeTools, needsVaultAccess, SEARCH_BUNDLE } from './tool-router.js';
```

- [ ] **Step 2: Add the `runAgentLoop` private method**

Add this private method to `AgentRuntime`, placed between the constructor (which ends at line 92) and `processMessage`. It takes `toolDefs` as a parameter so callers can vary the tool set per call. The `onChunk` parameter is optional — the retry path passes `undefined` for the first (buffered) pass.

```typescript
private async runAgentLoop(
  history: Message[],
  toolDefs: ToolDefinition[],
  userMessage: string,
  sessionId: string,
  onChunk?: (text: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; pendingEdits: PendingEdit[] }> {
  const db = getDatabase();
  const systemPrompt = assembleSystemPrompt(this.config.vaultPath, toolDefs);
  const allToolCalls: ToolCall[] = [];
  const pendingEdits: PendingEdit[] = [];
  let finalContent = '';
  let iterations = 0;
  const maxIterations = 10;

  while (iterations < maxIterations) {
    iterations++;

    let text = '';
    const toolCallsThisTurn: ToolCall[] = [];
    const toolCallAccumulators = new Map<string, { id: string; name: string; args: string }>();

    for await (const chunk of this.provider.chat(history, toolDefs, {
      systemPrompt,
      model: this.config.llm.model,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        text += chunk.text;
        onChunk?.(chunk.text);
      } else if (chunk.type === 'tool_call_start' && chunk.toolCall) {
        toolCallAccumulators.set(chunk.toolCall.id, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: '',
        });
      } else if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
        const acc = toolCallAccumulators.get(chunk.toolCall.id);
        if (acc) acc.args += chunk.toolCall.arguments;
      } else if (chunk.type === 'tool_call_end' && chunk.toolCall) {
        const acc = toolCallAccumulators.get(chunk.toolCall.id);
        if (acc) {
          try {
            const parsedArgs = JSON.parse(acc.args);
            toolCallsThisTurn.push({ id: acc.id, name: acc.name, arguments: parsedArgs });
          } catch {
            toolCallsThisTurn.push({ id: acc.id, name: acc.name, arguments: {} });
          }
        }
      }
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: text,
      toolCalls: toolCallsThisTurn.length > 0 ? toolCallsThisTurn : undefined,
    };
    history.push(assistantMsg);
    db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, 'assistant', text, toolCallsThisTurn.length > 0 ? JSON.stringify(toolCallsThisTurn) : null, Date.now());

    if (toolCallsThisTurn.length === 0) {
      finalContent = text;
      break;
    }

    for (const tc of toolCallsThisTurn) {
      allToolCalls.push(tc);
      log.debug('Executing tool', { name: tc.name, id: tc.id });
      const toolContext: ToolContext = { sessionId, vaultPath: this.config.vaultPath };
      const result = await this.registry.execute(tc, toolContext);

      try {
        const parsed = JSON.parse(result);

        const proposeOne = (edit: Record<string, unknown>, batchId?: string) => {
          const absolutePath = edit.path as string;
          const normalizedPath = path.normalize(absolutePath);
          if (!path.isAbsolute(normalizedPath) || (normalizedPath !== this.realVaultPath && !normalizedPath.startsWith(this.realVaultPath + path.sep))) {
            log.warn('Path escapes vault boundary', { path: absolutePath, tool: tc.name });
            return null;
          }
          const meta: Record<string, unknown> = { operation: edit.operation ?? '', path: edit.path };
          if (batchId) meta.batchId = batchId;
          if (edit.reservation && typeof edit.reservation === 'object') {
            Object.assign(meta, edit.reservation);
          }
          const proposal = this.safeWriter.proposeEdit(absolutePath, edit.newContent as string, userMessage, sessionId, meta);
          const toolWarnings = Array.isArray(edit.warnings) ? (edit.warnings as string[]) : [];
          pendingEdits.push({ editId: proposal.editId, proposal, warnings: toolWarnings, batchId });
          if (edit.reservation && typeof edit.reservation === 'object') {
            const { project_id } = edit.reservation as { project_id: string };
            db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?').run(proposal.editId, project_id);
          }
          return proposal;
        };

        if (parsed.type === 'pending_edits' && Array.isArray(parsed.edits)) {
          const batchId = Math.random().toString(36).slice(2, 10);
          const batchEditIds: string[] = [];
          const confirmations: unknown[] = [];
          for (const edit of parsed.edits as Record<string, unknown>[]) {
            const proposal = proposeOne(edit, batchId);
            if (!proposal) {
              confirmations.push({ error: 'Path escapes vault boundary', path: edit.path });
            } else {
              batchEditIds.push(proposal.editId);
              confirmations.push({ status: 'pending_confirmation', path: edit.path, operation: edit.operation, editId: proposal.editId, hasConflict: proposal.hasConflict });
            }
          }
          if (batchEditIds.length > 1) {
            this.pendingBatches.set(batchId, batchEditIds);
          }
          const toolResult = JSON.stringify({ status: 'pending_confirmation', batchId, edits: confirmations });
          history.push({ role: 'tool', content: toolResult, toolCallId: tc.id });
          db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(sessionId, 'tool', toolResult, tc.id, Date.now());
        } else if (parsed.type === 'pending_edit') {
          const absolutePath = parsed.path as string;
          const normalizedPath = path.normalize(absolutePath);
          if (!path.isAbsolute(normalizedPath) || (normalizedPath !== this.realVaultPath && !normalizedPath.startsWith(this.realVaultPath + path.sep))) {
            log.warn('Path escapes vault boundary', { path: absolutePath, tool: tc.name });
            history.push({ role: 'tool', content: JSON.stringify({ error: 'Path escapes vault boundary' }), toolCallId: tc.id });
            continue;
          }
          const meta: Record<string, unknown> = { operation: parsed.operation ?? '', path: parsed.path };
          if (parsed.reservation && typeof parsed.reservation === 'object') {
            Object.assign(meta, parsed.reservation);
          }
          const proposal = this.safeWriter.proposeEdit(absolutePath, parsed.newContent, userMessage, sessionId, meta);
          const toolWarnings = Array.isArray(parsed.warnings) ? (parsed.warnings as string[]) : [];
          pendingEdits.push({ editId: proposal.editId, proposal, warnings: toolWarnings });
          if (parsed.reservation && typeof parsed.reservation === 'object') {
            const { project_id } = parsed.reservation as { project_id: string };
            db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?').run(proposal.editId, project_id);
          }
          const toolResult = JSON.stringify({
            status: 'pending_confirmation',
            path: parsed.path,
            operation: parsed.operation,
            editId: proposal.editId,
            hasConflict: proposal.hasConflict,
          });
          history.push({ role: 'tool', content: toolResult, toolCallId: tc.id });
          db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(sessionId, 'tool', toolResult, tc.id, Date.now());
        } else {
          history.push({ role: 'tool', content: result, toolCallId: tc.id });
          db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(sessionId, 'tool', result, tc.id, Date.now());
        }
      } catch {
        history.push({ role: 'tool', content: result, toolCallId: tc.id });
        db.prepare('INSERT INTO chat_messages (session_id, role, content, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?)')
          .run(sessionId, 'tool', result, tc.id, Date.now());
      }
    }

    if (text) finalContent = text;
  }

  return { content: finalContent, toolCalls: allToolCalls, pendingEdits };
}
```

- [ ] **Step 3: Replace the entire `processMessage` method**

Replace the entire `processMessage` method — its signature and body (lines 94–319 in the original file) — with:

```typescript
async processMessage(
  userMessage: string,
  sessionId: string,
  onChunk?: (text: string) => void,
): Promise<RuntimeResponse> {
  const db = getDatabase();

  const session = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    db.prepare('INSERT INTO chat_sessions (id, created_at, last_active, metadata) VALUES (?, ?, ?, ?)')
      .run(sessionId, Date.now(), Date.now(), JSON.stringify({ provider: this.config.llm.provider }));
  }

  const recentMessages = db.prepare(
    'SELECT role, content, tool_calls, tool_call_id FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20'
  ).all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;

  const history: Message[] = recentMessages.reverse().map(m => {
    let content = m.content;
    if (m.role === 'tool' && content.length > 500) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (typeof parsed.context === 'string') {
          parsed.context = '[omitted from history]';
          content = JSON.stringify(parsed);
        }
      } catch {
        // Not JSON — leave as-is.
      }
    }
    return {
      role: m.role as 'user' | 'assistant' | 'tool',
      content,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
      toolCallId: m.tool_call_id ?? undefined,
    };
  });

  history.push({ role: 'user', content: userMessage });
  db.prepare('INSERT INTO chat_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'user', userMessage, Date.now());

  // Route: select tool bundle from user message keywords. Default is no tools.
  const selectedNames = routeTools(userMessage);
  const toolDefs = this.registry.getDefinitionsByName(selectedNames);

  // When no tools are selected, buffer chunks during the first pass so we can
  // suppress the failed response if a retry is needed.
  const bufferedChunks: string[] = [];
  const bufferingOnChunk = (text: string) => { bufferedChunks.push(text); };
  const firstPassOnChunk = selectedNames.length === 0 ? bufferingOnChunk : onChunk;
  const firstCallTs = Date.now();

  let result = await this.runAgentLoop(history, toolDefs, userMessage, sessionId, firstPassOnChunk);

  if (selectedNames.length === 0 && needsVaultAccess(result.content)) {
    // Delete the stale assistant DB row so history replay stays clean.
    db.prepare(
      'DELETE FROM chat_messages WHERE rowid = (SELECT rowid FROM chat_messages WHERE session_id = ? AND role = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1)'
    ).run(sessionId, 'assistant', firstCallTs);
    if (history[history.length - 1].role === 'assistant') history.pop();

    const searchDefs = this.registry.getDefinitionsByName([...SEARCH_BUNDLE]);
    result = await this.runAgentLoop(history, searchDefs, userMessage, sessionId, onChunk);
  } else if (selectedNames.length === 0) {
    // No retry needed — replay buffered chunks so the caller receives streaming output.
    for (const chunk of bufferedChunks) onChunk?.(chunk);
  }

  db.prepare('UPDATE chat_sessions SET last_active = ? WHERE id = ?').run(Date.now(), sessionId);

  return result;
}
```

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```

Expected: all previously passing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/runtime.ts
git commit -m "feat: wire lazy tool router into AgentRuntime with buffered one-shot vault retry"
```

---

## Task 6: Unit tests for `assembleSystemPrompt` tool-gating

**Files:**
- Create: `tests/unit/context-prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/context-prompt.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSystemPrompt, getISOWeekInfo } from '../../src/agent/context.js';
import { localDateString } from '../../src/utils/date.js';
import type { ToolDefinition } from '../../src/agent/providers/base.js';

function makeTool(name: string): ToolDefinition {
  return { name, description: '', parameters: {} };
}

let vaultPath: string;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
});

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

describe('assembleSystemPrompt — zero tools', () => {
  it('includes vault-unavailable notice', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).toContain('Vault access is not available');
  });

  it('does NOT include tool-use instruction', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain('you MUST use the appropriate tool');
  });

  it('does NOT include Reading Workflow section', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain('Reading Workflow');
  });

  it('does NOT include Today\'s Diary even if diary file exists', () => {
    const dailyDir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const today = localDateString();
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), '# Today');

    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain("Today's Diary");
  });

  it('does NOT include This Week\'s Plan even if weekly file exists', () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
    // Compute the current ISO week filename the same way production does
    const { week, isoYear } = getISOWeekInfo(new Date());
    const filename = `${isoYear}-W${String(week).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(weeklyDir, filename), '# Week Plan');

    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain("This Week's Plan");
  });
});

describe('assembleSystemPrompt — diary tool only', () => {
  it('includes Today\'s Diary section when diary file exists', () => {
    const dailyDir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const today = localDateString();
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), '# My Diary Entry');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_today_diary')]);
    expect(prompt).toContain("Today's Diary");
    expect(prompt).toContain('My Diary Entry');
  });

  it('does NOT include This Week\'s Plan when only diary tool is active', () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
    fs.writeFileSync(path.join(weeklyDir, '2026-W18.md'), '# Week Plan');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_today_diary')]);
    expect(prompt).not.toContain("This Week's Plan");
  });
});

describe('assembleSystemPrompt — week tool only', () => {
  it('includes This Week\'s Plan when weekly file exists', () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
    // Use the actual current ISO week filename (computed the same way as context.ts)
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const isoYear = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    const filename = `${isoYear}-W${String(week).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(weeklyDir, filename), '# Weekly Plan Content');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_week_plan')]);
    expect(prompt).toContain("This Week's Plan");
    expect(prompt).toContain('Weekly Plan Content');
  });

  it('does NOT include Today\'s Diary when only week tool is active', () => {
    const dailyDir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const today = localDateString();
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), '# Diary');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_week_plan')]);
    expect(prompt).not.toContain("Today's Diary");
  });
});

describe('assembleSystemPrompt — reading tools', () => {
  it('includes Reading Workflow section when reading tools are active', () => {
    const prompt = assembleSystemPrompt(vaultPath, [
      makeTool('create_reading_note'),
      makeTool('vault_read'),
    ]);
    expect(prompt).toContain('Reading Workflow');
  });

  it('does NOT include Reading Workflow without reading tools', () => {
    const prompt = assembleSystemPrompt(vaultPath, [makeTool('vault_search')]);
    expect(prompt).not.toContain('Reading Workflow');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run tests/unit/context-prompt.test.ts
```

Expected: FAIL — tests run against the unmodified `assembleSystemPrompt` (Task 3 not yet applied).

- [ ] **Step 3: Confirm tests pass after Task 3 changes are in place**

```bash
npx vitest run tests/unit/context-prompt.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 4: Run full suite**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/context-prompt.test.ts
git commit -m "test: assembleSystemPrompt — verify diary/week/reading sections gated on active tools"
```

---

## Task 7: Runtime routing unit tests with a fake provider

**Files:**
- Create: `tests/unit/runtime-routing.test.ts`

These tests use an in-memory SQLite DB and a fake `LLMProvider` that records which tool definitions it received, so no live LLM or vault files are needed.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/runtime-routing.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, Message, ToolDefinition, ChatOptions, StreamChunk } from '../../src/agent/providers/base.js';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

// ── Fake provider ──────────────────────────────────────────────────────────

class FakeLLMProvider implements LLMProvider {
  name = 'fake';
  calls: Array<{ tools: ToolDefinition[]; response: string }> = [];
  private responses: string[];

  constructor(responses: string[]) { this.responses = responses; }

  async *chat(
    _messages: Message[],
    tools: ToolDefinition[],
    _opts: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const response = this.responses[this.calls.length] ?? this.responses[this.responses.length - 1];
    this.calls.push({ tools, response });
    yield { type: 'text', text: response };
    yield { type: 'done' };
  }
}

// ── Test setup ─────────────────────────────────────────────────────────────

let vaultPath: string;
let db: Database.Database;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(async () => {
  const { setDatabase } = await import('../../src/storage/database.js');
  db.close();
  setDatabase(null); // clear module singleton so closed instance is not reused by other test files
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

async function makeRuntime(provider: FakeLLMProvider) {
  const { setDatabase } = await import('../../src/storage/database.js');
  setDatabase(db);

  const { AgentRuntime } = await import('../../src/agent/runtime.js');
  const runtime = new AgentRuntime({
    vaultPath,
    llm: { provider: 'openai', apiKey: 'test-key', model: 'test-model' },
  } as never);
  (runtime as Record<string, unknown>).provider = provider;
  return runtime;
}

// ── Tool routing ────────────────────────────────────────────────────────────

describe('processMessage — tool routing', () => {
  it('sends zero tools for a plain chat question', async () => {
    const provider = new FakeLLMProvider(['Western blot detects proteins.']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('explain western blot', 'session-1');

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools).toHaveLength(0);
  });

  it('sends search tools for "search my vault"', async () => {
    const provider = new FakeLLMProvider(['Here are your notes.']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('search my vault for IL-42', 'session-2');

    expect(provider.calls[0].tools.map(t => t.name)).toContain('vault_search');
  });

  it('sends project tools for "create a new experiment"', async () => {
    const provider = new FakeLLMProvider(['Creating experiment...']);
    const runtime = await makeRuntime(provider);

    await runtime.processMessage('create a new experiment for blotting', 'session-3');

    const names = provider.calls[0].tools.map(t => t.name);
    expect(names).toContain('create_experiment');
    expect(names).not.toContain('kb_lint');
  });
});

// ── Retry path ─────────────────────────────────────────────────────────────
// Use phrases the router does NOT match (no "find my", "what did I write", etc.)
// so the first pass receives zero tools and we exercise the retry logic.

describe('processMessage — retry path', () => {
  it('retries once with search tools when no-tool response signals vault needed', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault to search that.",
      'Here are your notes on synaptic tagging.',
    ]);
    const runtime = await makeRuntime(provider);

    // "do I have notes on" does NOT match the search pattern (requires "my notes on")
    const result = await runtime.processMessage('do I have notes on synaptic tagging?', 'session-r1');

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].tools).toHaveLength(0);
    expect(provider.calls[1].tools.map(t => t.name)).toContain('vault_search');
    expect(result.content).toBe('Here are your notes on synaptic tagging.');
  });

  it('deletes the stale assistant DB row before retry', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      'Found your notes.',
    ]);
    const runtime = await makeRuntime(provider);
    const sessionId = 'session-r2';

    await runtime.processMessage('what have I recorded about LTP?', sessionId);

    const rows = db.prepare(
      "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY timestamp ASC"
    ).all(sessionId) as Array<{ content: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Found your notes.');
  });

  it('does not call onChunk with the failed first response', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      'Found your notes.',
    ]);
    const runtime = await makeRuntime(provider);

    const chunks: string[] = [];
    // "recall my work" does NOT match any router rule
    await runtime.processMessage('recall my work on plasticity', 'session-r3', t => chunks.push(t));

    expect(chunks.join('')).not.toContain("don't have access");
    expect(chunks.join('')).toContain('Found your notes.');
  });

  it('does NOT retry a second time if the retry answer also signals vault needed', async () => {
    const provider = new FakeLLMProvider([
      "I don't have access to your vault.",
      "I still don't have access to your vault.",
    ]);
    const runtime = await makeRuntime(provider);

    // "what have I documented" does NOT match any router rule
    await runtime.processMessage('what have I documented about IL-42?', 'session-r4');

    expect(provider.calls).toHaveLength(2);
  });

  it('does NOT retry when tools were selected by the router', async () => {
    const provider = new FakeLLMProvider(["I don't have access to your vault."]);
    const runtime = await makeRuntime(provider);

    // "search my vault" DOES match the router → tools selected → no retry path
    await runtime.processMessage('search my vault for IL-42', 'session-r5');

    expect(provider.calls).toHaveLength(1);
  });

  it('replays buffered chunks through onChunk when no retry is needed', async () => {
    const provider = new FakeLLMProvider(['Western blot detects proteins by size.']);
    const runtime = await makeRuntime(provider);

    const chunks: string[] = [];
    await runtime.processMessage('explain western blot', 'session-r6', t => chunks.push(t));

    expect(chunks.join('')).toBe('Western blot detects proteins by size.');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run tests/unit/runtime-routing.test.ts
```

Expected: FAIL (runtime not yet wired with router, or `setDatabase` missing)

- [ ] **Step 3: Run the full suite after all Tasks are complete**

```bash
npx vitest run
```

Expected: all tests PASS including all 9 runtime-routing tests.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/runtime-routing.test.ts
git commit -m "test: runtime routing — tool selection, retry path, DB cleanup, onChunk isolation"
```

---

## Acceptance Checklist

Manual spot-checks after all tasks are complete.

- [ ] `"explain what PCR is"` → fast response, zero tool calls in server logs
- [ ] `"search my vault for IL-42"` → `vault_search` appears in server logs
- [ ] `"create a new experiment for western blot"` → `create_experiment`, `reserve_prefix` in logs; pending edit produced
- [ ] `"add a task: review Chen 2024"` → `task_add` in logs; task created
- [ ] `"paper chromatography"` → zero tools (false-positive guard)
- [ ] `"what is today's date?"` → zero tools (false-positive guard)
- [ ] `"show me my diary"` → `get_today_diary` in logs; `get_week_plan` absent
- [ ] `"show me my week plan"` → `get_week_plan` in logs; `get_today_diary` absent

---

## Self-Review Against Spec

| Spec requirement | Covered by |
|---|---|
| No tools by default | `routeTools` returns `[]`; tested + false-positive suite |
| Keyword router (rules-first, not LLM) | `tool-router.ts` pattern matching |
| `ToolRegistry.getDefinitionsByName` helper | Task 1 |
| All keyword bundles (search, write, tasks, reading, KB, project, diary, week) | Task 2 |
| One-shot retry when no-tool response signals vault needed | Task 5 retry block; Task 7 tests |
| Retry does not show/persist the failed first answer | Chunk buffering with replay; DB row deletion; Task 7 tests |
| System prompt consistent with active tools | Task 3: gate instructions, diary, week, reading sections |
| Diary and week-plan exposed independently | Separate `diary`/`weekplan` bundles with separate rules |
| `setDatabase` for test injection (correct variable `db`) | Task 4 |
| `assembleSystemPrompt` gating verified by tests | Task 6 |
| Ollama `think: false` path preserved | `chatOllama` in `openai.ts` not touched |
| Obsidian plugin UI unchanged | No plugin files modified |
| Combine bundles; deduplicate tools | `routeTools` accumulates into a `Set`; tested |
