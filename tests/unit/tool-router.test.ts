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
  it('matches multi-word note name "edit my lab meeting note"', () => {
    expect(routeTools('edit my lab meeting note')).toContain('vault_write');
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
  it('does NOT route diary for bare "today"', () => {
    expect(routeTools("what is today's date?")).not.toContain('get_today_diary');
  });
  it("does NOT route diary for someone else's diary", () => {
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

// ── SEARCH_BUNDLE export ─────────────────────────────────────────────────

describe('SEARCH_BUNDLE', () => {
  it('contains vault_search, vault_read, vault_list', () => {
    expect(SEARCH_BUNDLE).toContain('vault_search');
    expect(SEARCH_BUNDLE).toContain('vault_read');
    expect(SEARCH_BUNDLE).toContain('vault_list');
  });
});
