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

describe('renderNoteTemplate — Merge step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-merge-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('custom template fields appear in merged frontmatter', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: HEK293\npassage_number:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T', status: 'draft' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.cell_line).toBe('HEK293');
    expect(result.frontmatter.passage_number).toBeNull();
  });

  it('protected fields always win over template fields', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\nid: SHOULD-BE-IGNORED\ncell_line: HEK293\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment', id: 'CM001', title: 'T' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.id).toBe('CM001');
    expect(result.frontmatter.cell_line).toBe('HEK293');
  });

  it('template_version is stripped from created note frontmatter', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line:\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.frontmatter.template_version).toBeUndefined();
  });

  it('cricknote_template injected for reading-paper and reading-thread only', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');

    const paperResult = await renderNoteTemplate({
      vaultPath,
      kind: 'reading-paper',
      protectedFrontmatter: { title: 'T' },
      context: { title: 'T' },
    });
    expect(paperResult.frontmatter.cricknote_template).toBe('reading-paper');

    const expResult = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(expResult.frontmatter.cricknote_template).toBeUndefined();
  });
});

describe('renderNoteTemplate — Substitute step', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-sub-'));
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('substitutes known placeholders in body', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## {{date}} - Start\n\n## ID: {{id}}\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: { note_kind: 'experiment' },
      context: { title: 'My Exp', date: '2026-04-22', id: 'CM001' },
    });
    expect(result.body).toContain('# My Exp');
    expect(result.body).toContain('## 2026-04-22 - Start');
    expect(result.body).toContain('## ID: CM001');
  });

  it('warns and leaves unknown placeholders unchanged in body', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\n---\n\n# {{title}}\n\n## {{cell_line}} protocol\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: {},
      context: { title: 'T', date: '2026-01-01' },
    });
    expect(result.body).toContain('{{cell_line}}');
    expect(result.warnings.some(w => w.includes('{{cell_line}}'))).toBe(true);
  });

  it('does not substitute placeholders inside frontmatter values', async () => {
    const { renderNoteTemplate } = await import('../../src/templates/template-loader.js');
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: "{{cell_line}}"\n---\n\n# {{title}}\n`
    );
    const result = await renderNoteTemplate({
      vaultPath,
      kind: 'experiment',
      protectedFrontmatter: {},
      context: { title: 'T', date: '2026-01-01', cell_line: 'HEK293' },
    });
    expect(result.body).toContain('# T');
    expect(result.frontmatter.cell_line).toBe('{{cell_line}}');
  });
});

describe('DEFAULT_TEMPLATE_FILES', () => {
  it('exports a file for every TemplateKind plus README', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const expected = [
      'experiment.md',
      'project-index.md',
      'series.md',
      'protocol.md',
      'reading-paper.md',
      'reading-thread.md',
      'README.md',
    ];
    for (const filename of expected) {
      expect(DEFAULT_TEMPLATE_FILES[filename], `missing ${filename}`).toBeTruthy();
    }
  });

  it('experiment.md default template has template_version and custom field stubs', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['experiment.md'];
    expect(content).toContain('template_version: 1');
    expect(content).toContain('cell_line:');
    expect(content).toContain('{{title}}');
    expect(content).toContain('{{date}}');
  });

  it('reading-paper.md default template has all 6 required headings', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['reading-paper.md'];
    for (const heading of ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions']) {
      expect(content).toContain(`## ${heading}`);
    }
  });

  it('project-index.md default template has all AUTO-GENERATED markers', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['project-index.md'];
    expect(content).toContain('<!-- AUTO-GENERATED: experiment-log -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: experiment-log -->');
    expect(content).toContain('<!-- AUTO-GENERATED: project-summary -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: project-summary -->');
  });

  it('series.md default template has AUTO-GENERATED experiment-list markers', async () => {
    const { DEFAULT_TEMPLATE_FILES } = await import('../../src/templates/template-loader.js');
    const content = DEFAULT_TEMPLATE_FILES['series.md'];
    expect(content).toContain('<!-- AUTO-GENERATED: experiment-list -->');
    expect(content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
  });
});
