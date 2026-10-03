import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { LAYOUT_HEADINGS } from '../../src/knowledge/reading-note-lint.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'cricknote-reading-intake', 'SKILL.md'), 'utf-8');

describe('cricknote-reading-intake skill (layout v2 wiring)', () => {
  it('tells the analysis subagent to read the shared guide and layout first, for Claude Code and Codex', () => {
    expect(skill).toContain('_shared/readable-output.md');
    expect(skill).toContain('_shared/reading-note-layout.md');
    expect(skill).toContain('.claude/skills/_shared/');
    expect(skill).toContain('.agents/skills/_shared/');
  });

  it('drafts the v2 layout: TL;DR with a Source line, then the layout headings in order', () => {
    expect(skill).toMatch(/TL;DR/);
    expect(skill).toMatch(/\*\*Source:\*\*|Source line|`Source:`/);
    let last = -1;
    for (const heading of LAYOUT_HEADINGS) {
      const at = skill.indexOf(heading, last + 1);
      expect(at, `layout heading "${heading}" must appear in order in the skill`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('runs the checker once after writing, makes at most one corrective write, and returns the remaining findings', () => {
    expect(skill).toContain('lint_reading_note');
    expect(skill).toMatch(/one corrective write|at most one corrective/i);
    expect(skill).toMatch(/remaining (warnings|findings)/i);
  });

  it('moves the Figure Map below Evidence and no longer says it goes at the top', () => {
    expect(skill).not.toMatch(/goes at the top, before `## Claims`/);
    expect(skill).toMatch(/Figure Map[^\n]*(after|below)[^\n]*Evidence|(after|below)[^\n]*`## Evidence`[^\n]*Figure Map/i);
  });

  it('keeps the long Figure Map rows rather than truncating them', () => {
    expect(skill).toMatch(/### Main figures/);
    expect(skill).toMatch(/do not (truncate|delete)/i);
  });

  it('keeps the earlier safeguards: subagent isolation, per-range compile, supplement rules, body-only write', () => {
    expect(skill).toContain('subagent');
    expect(skill).toContain('inspect_reading_note_sources');
    expect(skill).toContain('vault_write_body');
    expect(skill).toContain('Never reconstruct a missing supplementary caption');
    expect(skill).toContain('Do NOT return the compiled paper');
    expect(skill).toMatch(/A citation to an unavailable\s+supplement is a warning/);
  });

  it('keeps the note a draft until the user reviews it', () => {
    expect(skill).toMatch(/stays\s+`draft`/);
  });
});
