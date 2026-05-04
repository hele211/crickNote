import { describe, it, expect } from 'vitest';
import { routeTools, needsVaultAccess, needsVaultWriteAccess, SEARCH_BUNDLE, FULL_WRITE_BUNDLE } from '../../src/agent/tool-router.js';

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
  it('matches "what have I recorded"', () => {
    expect(routeTools('what have I recorded about LTP?')).toContain('vault_search');
  });
  it('matches "do I have notes"', () => {
    expect(routeTools('do I have notes on synaptic tagging?')).toContain('vault_search');
  });
  it('matches "recall my work"', () => {
    expect(routeTools('recall my work on plasticity')).toContain('vault_search');
  });
  it('matches "show files in my vault"', () => {
    expect(routeTools('show files in my vault')).toContain('vault_search');
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
  it('matches multi-word note name "edit my lab meeting note"', () => {
    expect(routeTools('edit my lab meeting note')).toContain('vault_write');
  });
  it('matches "create a new note in Obsidian"', () => {
    expect(routeTools('create a new note in Obsidian')).toContain('vault_write');
  });
  it('matches "can you create a file in my vault"', () => {
    expect(routeTools('can you create a file in my vault')).toContain('vault_write');
  });
  it('matches "write this to my notes"', () => {
    expect(routeTools('write this to my notes')).toContain('vault_write');
  });
  it('matches "save this in Obsidian"', () => {
    expect(routeTools('save this in Obsidian')).toContain('vault_write');
  });
  it('matches "record this in the vault"', () => {
    expect(routeTools('record this in the vault')).toContain('vault_write');
  });
  it('matches "put this into my vault"', () => {
    expect(routeTools('put this into my vault')).toContain('vault_write');
  });
  it('matches "make a new file in notes"', () => {
    expect(routeTools('make a new file in notes')).toContain('vault_write');
  });
  it('matches bare command "create a new note"', () => {
    expect(routeTools('create a new note')).toContain('vault_write');
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
  it('matches "create todo"', () => {
    expect(routeTools('create todo for imaging analysis')).toContain('task_add');
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
  it('matches "paper bundle"', () => {
    expect(routeTools('discover paper bundle for Chen 2024')).toContain('discover_reading_bundle');
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
  it('matches "add a new project"', () => {
    expect(routeTools('add a new project for me')).toContain('create_project');
  });
  it('matches typo "add an now project"', () => {
    expect(routeTools('add an now project for me')).toContain('create_project');
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
  it('matches "start project"', () => {
    expect(routeTools('start a project for cell migration')).toContain('create_project');
  });
  it('matches "set up experiment"', () => {
    expect(routeTools('set up a new experiment for western blot')).toContain('create_experiment');
  });
  it('matches "make protocol"', () => {
    expect(routeTools('make a protocol for gel electrophoresis')).toContain('create_protocol');
  });
});

describe('routeTools — context bundle (diary and week split)', () => {
  it('matches "my diary" → diary tool only, not week plan', () => {
    const t = routeTools('show me my diary');
    expect(t).toContain('get_today_diary');
    expect(t).not.toContain('get_week_plan');
  });
  it("matches \"today's diary\" → diary tool only", () => {
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
  it("returns [] for \"what is today's date\"", () => {
    expect(routeTools("what is today's date?")).toEqual([]);
  });
  it("returns [] for \"Anne Frank's diary\"", () => {
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
  it('does NOT route write tools for "append to my data" (no "note")', () => {
    expect(routeTools('append to my data')).not.toContain('vault_append');
    expect(routeTools('append to my data')).not.toContain('vault_write');
  });
  it('does NOT route write tools for a tutorial question about creating Obsidian files', () => {
    expect(routeTools('how do I create a file in Obsidian?')).not.toContain('vault_write');
  });
  it('does NOT route diary for bare "today"', () => {
    expect(routeTools("what is today's date?")).not.toContain('get_today_diary');
  });
  it("does NOT route diary for someone else's diary", () => {
    expect(routeTools("I read Einstein's diary")).not.toContain('get_today_diary');
  });
  it('does NOT route kb for bare "claim" without "notes" object', () => {
    expect(routeTools('I claim this theory is wrong')).not.toContain('kb_suggest');
  });
  it('does NOT route project tools for generic project advice', () => {
    expect(routeTools('how do I add project management to my workflow?')).not.toContain('create_project');
  });
  it('does NOT route project tools for tutorial project question', () => {
    expect(routeTools('how do I create a research project?')).not.toContain('create_project');
  });
  it('does NOT route write tools for "write a protocol explanation"', () => {
    expect(routeTools('write a protocol explanation for students')).not.toContain('vault_write');
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
  it("detects \"don't have access to your vault\"", () => {
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
  it("detects \"can't read your notes\"", () => {
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
  it('detects "do not have access to your vault"', () => {
    expect(needsVaultAccess('I do not have access to your vault')).toBe(true);
  });
  it('detects "cannot access your notes"', () => {
    expect(needsVaultAccess('I cannot access your notes')).toBe(true);
  });
});

describe('needsVaultWriteAccess', () => {
  it('detects "cannot create files in Obsidian"', () => {
    expect(needsVaultWriteAccess('I cannot create files in Obsidian.')).toBe(true);
  });
  it('detects "unable to write to your vault"', () => {
    expect(needsVaultWriteAccess('I am unable to write to your vault.')).toBe(true);
  });
  it('returns false for search-only access errors', () => {
    expect(needsVaultWriteAccess('I cannot search your notes.')).toBe(false);
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

// ── FULL_WRITE_BUNDLE export ─────────────────────────────────────────────

describe('FULL_WRITE_BUNDLE', () => {
  it('contains basic write tools', () => {
    expect(FULL_WRITE_BUNDLE).toContain('vault_write');
    expect(FULL_WRITE_BUNDLE).toContain('vault_append');
    expect(FULL_WRITE_BUNDLE).toContain('vault_read');
  });
  it('contains project creation tools', () => {
    expect(FULL_WRITE_BUNDLE).toContain('create_project');
    expect(FULL_WRITE_BUNDLE).toContain('reserve_prefix');
    expect(FULL_WRITE_BUNDLE).toContain('create_experiment');
    expect(FULL_WRITE_BUNDLE).toContain('create_protocol');
  });
  it('has no duplicates', () => {
    expect(FULL_WRITE_BUNDLE.length).toBe(new Set(FULL_WRITE_BUNDLE).size);
  });
});
