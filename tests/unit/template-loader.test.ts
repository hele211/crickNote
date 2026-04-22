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

describe('renderNoteTemplate — Validate step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-val-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function render(kind: string, templateContent: string, pf: Record<string, unknown> = {}) {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', `${kind === 'project-index' ? 'project-index' : kind}.md`),
      templateContent
    );
    return renderNoteTemplate({
      vaultPath,
      kind: kind as import('../../src/templates/template-loader.js').TemplateKind,
      protectedFrontmatter: pf,
      context: { title: 'T', date: '2026-01-01' },
    });
  }

  it('warns when template defines a protected field', async () => {
    const result = await render(
      'experiment',
      `---\ntemplate_version: 1\nid: BAD\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes("'id'") && w.includes('ignored'))).toBe(true);
  });

  it('warns when template_version is missing', async () => {
    const result = await render(
      'experiment',
      `---\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes('no version'))).toBe(true);
  });

  it('warns when template_version is older than current contract', async () => {
    const result = await render(
      'experiment',
      `---\ntemplate_version: 0\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    expect(result.warnings.some(w => w.includes('version 0'))).toBe(true);
  });

  it('throws when project-index template is missing AUTO-GENERATED markers', async () => {
    await expect(
      render(
        'project-index',
        `---\ntemplate_version: 1\n---\n\n## Experiment Log\n## Project Summary\n`
      )
    ).rejects.toThrow(/missing required marker/i);
  });

  it('throws when series template is missing AUTO-GENERATED experiment-list marker', async () => {
    await expect(
      render(
        'series',
        `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## Objective\n{{objective}}\n\n## Summary\n`
      )
    ).rejects.toThrow(/missing required marker/i);
  });

  it('throws when reading-paper template is missing a required heading', async () => {
    await expect(
      render(
        'reading-paper',
        `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n`
        // Missing ## Extensions
      )
    ).rejects.toThrow(/missing required heading.*Extensions/i);
  });

  it('reading-paper validates successfully with all 6 headings', async () => {
    const result = await render(
      'reading-paper',
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    expect(result.warnings).toHaveLength(0);
  });
});
