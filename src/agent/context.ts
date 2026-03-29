import fs from 'node:fs';
import path from 'node:path';
import { loadAgentConfig } from '../config/config.js';
import type { ToolDefinition } from './providers/base.js';

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
  const today = new Date().toISOString().split('T')[0];
  const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);
  if (fs.existsSync(diaryPath)) {
    const diary = fs.readFileSync(diaryPath, 'utf-8');
    sections.push(`## Today's Diary (${today})\n\n${diary}`);
  }

  // Layer 6: Current week's plan
  const weekNum = getISOWeekNumber(new Date());
  const year = new Date().getFullYear();
  const weekPath = path.join(vaultPath, 'Memory', 'Weekly', `${year}-W${String(weekNum).padStart(2, '0')}.md`);
  if (fs.existsSync(weekPath)) {
    const weekPlan = fs.readFileSync(weekPath, 'utf-8');
    sections.push(`## This Week's Plan\n\n${weekPlan}`);
  }

  // Layer 7: Tool definitions summary
  const toolSummary = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
  sections.push(`## Available Tools\n\n${toolSummary}`);

  return sections.join('\n\n---\n\n');
}

function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
