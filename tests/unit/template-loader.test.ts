import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

describe('renderNoteTemplate — Load step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function load() {
    // Dynamic import so each test gets a fresh module evaluation with the current filesystem state
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    return renderNoteTemplate;
  }

  it('uses builtin renderer when Agent/templates/ folder is absent', async () => {
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'Test Exp' },
      context: { title: 'Test Exp', date: '2026-04-22' },
    });
    expect(result.templateUsed).toBe('builtin');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Editable templates are missing');
    expect(result.body).toContain('# Test Exp');
    expect(result.body).toContain('## 2026-04-22 - Initial Setup');
  });

  it('uses builtin renderer when template file is absent from existing templates folder', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'protocol',
      protectedFrontmatter: { note_kind: 'protocol', id: 'PR001', title: 'Western Blot' },
      context: { title: 'Western Blot' },
    });
    expect(result.templateUsed).toBe('builtin');
    expect(result.body).toContain('## Materials');
    expect(result.body).toContain('## Procedure');
  });

  it('loads a valid template file', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n\n## Materials\n`
    );
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T' },
      context: { title: 'My Experiment', date: '2026-04-22' },
    });
    expect(result.templateUsed).toBe('file');
    expect(result.warnings).toHaveLength(0);
  });

  it('throws when template file has invalid YAML frontmatter', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\nkey: [unclosed bracket\n---\n\n# body`
    );
    const renderNoteTemplate = await load();
    await expect(
      renderNoteTemplate({
        vaultPath,
        kind: 'experiment',
        protectedFrontmatter: {},
        context: {},
      })
    ).rejects.toThrow(/invalid YAML/i);
  });

  it('falls back reading-thread to reading-paper.md when reading-thread.md is absent', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const renderNoteTemplate = await load();
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'reading-thread',
      protectedFrontmatter: { title: 'T', authors: [], year: 2026, journal: 'J' },
      context: { title: 'Thread Title' },
    });
    expect(result.templateUsed).toBe('file');
    expect(result.body).toContain('## Claims');
  });
});
