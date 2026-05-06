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
  it('includes vault-unavailable notice with retry-triggering phrases', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).toContain('No vault tools are loaded');
    expect(prompt).toContain('I cannot write to your vault for this query');
    expect(prompt).toContain('I cannot access your vault for this query');
  });

  it('does NOT include tool-use instruction', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain('you MUST use the appropriate tool');
  });

  it('does NOT include Reading Workflow section', () => {
    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain('Reading Workflow');
  });

  it("does NOT include Today's Diary even if diary file exists", () => {
    const dailyDir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const today = localDateString();
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), '# Today');

    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain("Today's Diary");
  });

  it("does NOT include This Week's Plan even if weekly file exists", () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
    const { week, isoYear } = getISOWeekInfo(new Date());
    const filename = `${isoYear}-W${String(week).padStart(2, '0')}.md`;
    fs.writeFileSync(path.join(weeklyDir, filename), '# Week Plan');

    const prompt = assembleSystemPrompt(vaultPath, []);
    expect(prompt).not.toContain("This Week's Plan");
  });
});

describe('assembleSystemPrompt — diary tool only', () => {
  it("includes Today's Diary section when diary file exists", () => {
    const dailyDir = path.join(vaultPath, 'Memory', 'Daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const today = localDateString();
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), '# My Diary Entry');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_today_diary')]);
    expect(prompt).toContain("Today's Diary");
    expect(prompt).toContain('My Diary Entry');
  });

  it("does NOT include This Week's Plan when only diary tool is active", () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
    fs.writeFileSync(path.join(weeklyDir, '2026-W18.md'), '# Week Plan');

    const prompt = assembleSystemPrompt(vaultPath, [makeTool('get_today_diary')]);
    expect(prompt).not.toContain("This Week's Plan");
  });
});

describe('assembleSystemPrompt — week tool only', () => {
  it("includes This Week's Plan when weekly file exists", () => {
    const weeklyDir = path.join(vaultPath, 'Memory', 'Weekly');
    fs.mkdirSync(weeklyDir, { recursive: true });
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

  it("does NOT include Today's Diary when only week tool is active", () => {
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
