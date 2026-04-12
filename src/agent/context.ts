import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadAgentConfig } from '../config/config.js';
import type { ToolDefinition } from './providers/base.js';
import { localDateString } from '../utils/date.js';

const contextCache: { [key: string]: { content: string; mtime: number } } = {};

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

  const sections: string[] = [];

  // Layer 1: Base instructions
  sections.push(`You are CrickNote, a scientific research assistant for biology/life sciences.
You help researchers record experiments, retrieve data, manage protocols, track literature, and plan their work.
You operate on an Obsidian vault and can read, search, and write notes.

IMPORTANT RULES:
- When writing to the vault, you MUST use the appropriate tool. Never output vault content as plain text.
- Always use structured frontmatter when creating experiment or reading notes.
- When asked about experiments, search the vault first before answering.
- Be precise with scientific data — never fabricate results.
- When uncertain, say so and ask the user to clarify.`);

  // Layer 2: Agent config (user's core rules)
  if (agentMd) {
    sections.push(`## User-Defined Agent Rules\n\n${agentMd}`);
  }

  // Layer 3: Soul (personality)
  if (soulMd) {
    sections.push(`## Personality\n\n${soulMd}`);
  }

  // Layer 4: Skills
  for (const skill of skills) {
    sections.push(`## Skill\n\n${skill}`);
  }

  // Layer 5: Today's diary (cached to avoid repeated disk reads)
  const today = localDateString();
  const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);
  const diary = cachedReadFile(diaryPath);
  if (diary !== null) {
    sections.push(`## Today's Diary (${today})\n\n${diary}`);
  }

  // Layer 5b: KB lint reminder + unfinished KB work count
  const lintReportsDir = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports');
  if (fs.existsSync(lintReportsDir)) {
    const reports = fs.readdirSync(lintReportsDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();

    let unfinishedKbCount = 0;
    for (const readingSubdir of ['Reading/Papers', 'Reading/Threads']) {
      const readingDir = path.join(vaultPath, readingSubdir);
      if (!fs.existsSync(readingDir)) continue;
      for (const f of fs.readdirSync(readingDir).filter(n => n.endsWith('.md'))) {
        try {
          const fm = matter(fs.readFileSync(path.join(readingDir, f), 'utf-8')).data as Record<string, unknown>;
          if (fm['status'] === 'complete' && ['pending', 'mapped', 'merged_with_review'].includes(fm['kb_status'] as string)) {
            unfinishedKbCount++;
          }
        } catch { /* skip */ }
      }
    }

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

  // Layer 6: Current week's plan (cached to avoid repeated disk reads)
  // Use ISO week year (not calendar year) so late-December dates like 29 Dec 2025
  // (= ISO week 1 of 2026) map to the correct weekly file.
  const { week: weekNum, isoYear } = getISOWeekInfo(new Date());
  const weekPath = path.join(vaultPath, 'Memory', 'Weekly', `${isoYear}-W${String(weekNum).padStart(2, '0')}.md`);
  const weekPlan = cachedReadFile(weekPath);
  if (weekPlan !== null) {
    sections.push(`## This Week's Plan\n\n${weekPlan}`);
  }

  // Layer 7: Tool definitions summary
  const toolSummary = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  sections.push(`## Available Tools\n\n${toolSummary}`);

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
