import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { LAYOUT_HEADINGS, LINT_LIMITS, SUPPORT_TYPES } from '../../src/knowledge/reading-note-lint.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sharedDir = path.join(repoRoot, 'skills', '_shared');
const guide = fs.readFileSync(path.join(sharedDir, 'readable-output.md'), 'utf-8');
const layout = fs.readFileSync(path.join(sharedDir, 'reading-note-layout.md'), 'utf-8');

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe('skills/_shared documents', () => {
  it('contain no double-bracket link syntax (kb_lint scans installed skill folders for wikilinks)', () => {
    const offenders = listFiles(sharedDir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => /\[\[|\]\]/.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it('the layout lists every checker heading, in the checker order', () => {
    const positions = LAYOUT_HEADINGS.map((h) => layout.indexOf(`\`## ${h}\``));
    expect(positions.every((p) => p >= 0), `missing heading in layout: ${LAYOUT_HEADINGS.filter((_, i) => positions[i] < 0)}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('the layout defines every support type the checker accepts', () => {
    for (const type of SUPPORT_TYPES) expect(layout).toContain(`\`${type}\``);
  });

  it('the docs quote the same numeric limits as the checker', () => {
    expect(guide).toContain(`${LINT_LIMITS.tldrMaxWords} words`);
    expect(layout).toContain(`${LINT_LIMITS.tldrMaxWords} words`);
    expect(layout).toContain(`${LINT_LIMITS.figureMapMaxRows} rows`);
    expect(layout).toContain(`${LINT_LIMITS.mermaidMaxNodes} nodes`);
    expect(layout).toContain(`${LINT_LIMITS.mermaidMaxDiagrams} diagrams`);
    expect(guide).toContain(`${LINT_LIMITS.longSentenceWords - 5} words or fewer`);
  });

  it('both documents point agents at the checker tool', () => {
    expect(guide).toContain('lint_reading_note');
    expect(layout).toContain('lint_reading_note');
  });

  it('the vault guides in templates/agent-docs point at the shared documents and the checker', () => {
    const claude = fs.readFileSync(path.join(repoRoot, 'templates', 'agent-docs', 'CLAUDE.md'), 'utf-8');
    const agents = fs.readFileSync(path.join(repoRoot, 'templates', 'agent-docs', 'AGENTS.md'), 'utf-8');
    expect(claude).toContain('.claude/skills/_shared/readable-output.md');
    expect(claude).toContain('lint_reading_note');
    expect(agents).toContain('.agents/skills/_shared/readable-output.md');
    expect(agents).toContain('lint_reading_note');
  });
});
