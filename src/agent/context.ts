import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadAgentConfig } from '../config/config.js';
import type { ToolDefinition } from './providers/base.js';
import { localDateString } from '../utils/date.js';

const contextCache: { [key: string]: { content: string; mtime: number } } = {};

// Cache for the unfinished-KB count so we don't rescan every reading note on
// every processMessage call.  Keyed by the combined mtime of both reading dirs;
// invalidates automatically when files are added, removed, or renamed.
let kbCountCache: { count: number; dirMtimeKey: string } | null = null;

function readingDirMtimeKey(vaultPath: string): string {
  let key = '';
  for (const sub of ['Reading/Papers', 'Reading/Threads']) {
    const dir = path.join(vaultPath, sub);
    try {
      key += fs.statSync(dir).mtimeMs.toString() + ':';
    } catch {
      key += '0:';
    }
  }
  return key;
}

function getCachedUnfinishedKbCount(vaultPath: string): number {
  const mtimeKey = readingDirMtimeKey(vaultPath);
  if (kbCountCache && kbCountCache.dirMtimeKey === mtimeKey) {
    return kbCountCache.count;
  }

  let count = 0;
  for (const sub of ['Reading/Papers', 'Reading/Threads']) {
    const dir = path.join(vaultPath, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.md'))) {
      try {
        const fm = matter(fs.readFileSync(path.join(dir, f), 'utf-8')).data as Record<string, unknown>;
        if (fm['status'] === 'complete' && ['pending', 'mapped', 'merged_with_review'].includes(fm['kb_status'] as string)) {
          count++;
        }
      } catch { /* skip */ }
    }
  }

  kbCountCache = { count, dirMtimeKey: mtimeKey };
  return count;
}

function cachedReadFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const mtime = fs.statSync(filePath).mtimeMs;
  const cached = contextCache[filePath];
  if (cached && cached.mtime === mtime) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  contextCache[filePath] = { content, mtime };
  return content;
}

export function assembleSystemPrompt(
  vaultPath: string,
  tools: ToolDefinition[]
): string {
  const { agentMd, soulMd, skills } = loadAgentConfig(vaultPath);
  const activeToolNames = new Set(tools.map(t => t.name));
  const hasTools = tools.length > 0;
  const hasVaultWrite = activeToolNames.has('vault_write') || activeToolNames.has('vault_append');
  const hasVaultSearch = activeToolNames.has('vault_search');
  const hasReadingTools = activeToolNames.has('create_reading_note') || activeToolNames.has('ingest_reading_bundle');
  const hasDiaryTool = activeToolNames.has('get_today_diary');
  const hasWeekTool = activeToolNames.has('get_week_plan');

  const sections: string[] = [];

  // Layer 1: Base instructions — adapt to tool availability
  if (hasTools) {
    const rules: string[] = [
      '- Be precise with scientific data — never fabricate results.',
      '- When uncertain, say so and ask the user to clarify.',
    ];
    if (hasVaultWrite) {
      rules.unshift('- When writing to the vault, you MUST use the appropriate tool. Never output vault content as plain text.');
      rules.unshift('- Always use structured frontmatter when creating experiment or reading notes.');
    }
    if (hasVaultSearch) {
      rules.unshift('- When asked about experiments, search the vault first before answering.');
    }
    sections.push(`You are CrickNote, a scientific research assistant for biology/life sciences.
You help researchers record experiments, retrieve data, manage protocols, track literature, and plan their work.
You operate on an Obsidian vault and can use the active tools to assist you.

IMPORTANT RULES:
${rules.join('\n')}`);
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
  // Use ISO week year (not calendar year) so late-December dates like 29 Dec 2025
  // (= ISO week 1 of 2026) map to the correct weekly file.
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

export function getISOWeekInfo(date: Date): { week: number; isoYear: number } {
  // Construct UTC midnight from local date components so the week boundary
  // is based on the user's local date, not UTC date.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  // Shift to the Thursday of the same ISO week (ISO weeks run Mon–Sun).
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // The ISO week year is the year that contains this Thursday.
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, isoYear };
}
