import fs from 'node:fs';
import path from 'node:path';
import { loadAgentConfig } from '../config/config.js';
import type { ToolDefinition } from './providers/base.js';
import { localDateString } from '../utils/date.js';

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

  // Layer 5: Today's diary
  const today = localDateString();
  const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);
  if (fs.existsSync(diaryPath)) {
    const diary = fs.readFileSync(diaryPath, 'utf-8');
    sections.push(`## Today's Diary (${today})\n\n${diary}`);
  }

  // Layer 6: Current week's plan
  // Use ISO week year (not calendar year) so late-December dates like 29 Dec 2025
  // (= ISO week 1 of 2026) map to the correct weekly file.
  const { week: weekNum, isoYear } = getISOWeekInfo(new Date());
  const weekPath = path.join(vaultPath, 'Memory', 'Weekly', `${isoYear}-W${String(weekNum).padStart(2, '0')}.md`);
  if (fs.existsSync(weekPath)) {
    const weekPlan = fs.readFileSync(weekPath, 'utf-8');
    sections.push(`## This Week's Plan\n\n${weekPlan}`);
  }

  // Layer 7: Tool definitions summary
  const toolSummary = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  sections.push(`## Available Tools\n\n${toolSummary}`);

  return sections.join('\n\n---\n\n');
}

function getISOWeekInfo(date: Date): { week: number; isoYear: number } {
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
