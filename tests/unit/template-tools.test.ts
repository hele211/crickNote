import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { createTemplateTools } from '../../src/agent/tools/templates.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';

describe('template tools', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-template-tools-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('create_reading_note uses an absolute path and tracks overwrites', async () => {
    const realVaultPath = fs.realpathSync(vaultPath);
    const existingPath = path.join(realVaultPath, 'Reading', 'Papers', 'migration-paper.md');
    fs.writeFileSync(existingPath, '# Existing note\n', 'utf-8');

    const createReadingTool = createTemplateTools(vaultPath, detector)
      .find(tool => tool.definition.name === 'create_reading_note');
    const result = JSON.parse(await createReadingTool!.execute({
      title: 'Migration Paper',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2026,
      journal: 'Nature',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.path).toBe(existingPath);
    expect(result.operation).toBe('update');
    expect(detector.getSnapshot(existingPath)?.content).toBe('# Existing note\n');
  });

  it('create_reading_note writes CREATE headings and optional sources', async () => {
    const createReadingTool = createTemplateTools(vaultPath, detector)
      .find(tool => tool.definition.name === 'create_reading_note');
    const result = JSON.parse(await createReadingTool!.execute({
      title: 'Signal Transfer Review',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Cell',
      slug: 'Signal Transfer Review',
      sources: [
        { type: 'pdf', path: 'paper.pdf' },
        { type: 'notes', path: './notes.md' },
      ],
    }));

    expect(result.path).toBe(path.join(fs.realpathSync(vaultPath), 'Reading', 'Papers', 'signal-transfer-review.md'));
    const parsed = matter(result.newContent);
    expect(parsed.data.sources).toEqual([
      { type: 'pdf', path: 'paper.pdf' },
      { type: 'notes', path: 'notes.md' },
    ]);
    expect(parsed.content).toContain('## Claims');
    expect(parsed.content).toContain('## Reasoning');
    expect(parsed.content).toContain('## Evidence');
    expect(parsed.content).toContain('## Assumptions');
    expect(parsed.content).toContain('## Takeaways');
    expect(parsed.content).toContain('## Extensions');
  });

  it('create_reading_note preserves meaningful body content on update', async () => {
    const existingPath = path.join(fs.realpathSync(vaultPath), 'Reading', 'Papers', 'drafted-paper.md');
    fs.writeFileSync(
      existingPath,
      '---\n' +
      'title: Drafted Paper\n' +
      'authors: [Alice]\n' +
      'year: 2026\n' +
      'journal: Cell\n' +
      'status: in-progress\n' +
      'kb_status: pending\n' +
      '---\n\n' +
      '# Drafted Paper\n\n' +
      '## Claims\n\n' +
      'IL-42 suppresses T-cell activation.\n\n' +
      '## Reasoning\n\n' +
      'Detailed reasoning here.\n'
    );

    const createReadingTool = createTemplateTools(vaultPath, detector)
      .find(tool => tool.definition.name === 'create_reading_note');
    const result = JSON.parse(await createReadingTool!.execute({
      title: 'Drafted Paper',
      authors: ['Alice'],
      year: 2026,
      journal: 'Cell',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('update');
    const parsed = matter(result.newContent);
    // Drafted body should be preserved — not replaced with blank scaffold
    expect(parsed.content).toContain('IL-42 suppresses T-cell activation.');
    expect(parsed.content).toContain('Detailed reasoning here.');
  });

  it('create_reading_note resets workflow status when refreshing an existing note template', async () => {
    const existingPath = path.join(fs.realpathSync(vaultPath), 'Reading', 'Papers', 'status-reset.md');
    fs.writeFileSync(
      existingPath,
      '---\n' +
      'title: Status Reset\n' +
      'authors: [Alice]\n' +
      'year: 2026\n' +
      'journal: Cell\n' +
      'read_date: 2026-04-11\n' +
      'status: complete\n' +
      'kb_status: mapped\n' +
      '---\n\n' +
      '# Status Reset\n'
    );

    const createReadingTool = createTemplateTools(vaultPath, detector)
      .find(tool => tool.definition.name === 'create_reading_note');
    const result = JSON.parse(await createReadingTool!.execute({
      title: 'Status Reset',
      authors: ['Alice'],
      year: 2026,
      journal: 'Cell',
    }));

    const parsed = matter(result.newContent);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.kb_status).toBe('pending');
  });
});

describe('create_reading_note — template integration', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-tpl-reading-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns warnings array (builtin warning when no templates folder)', async () => {
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('applies custom template field when template file present', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    const parsed = matter(r.newContent);
    expect(parsed.data.lab_relevance).toBeNull();
    expect(parsed.data.cricknote_template).toBe('reading-paper');
  });

  it('preserves meaningful existing body without applying template', async () => {
    const existingPath = path.join(vaultPath, 'Reading', 'Papers', 'il-42-review.md');
    fs.writeFileSync(
      existingPath,
      matter.stringify(
        '\n# IL-42 Review\n\n## Claims\nThis paper claims stuff.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n',
        { title: 'IL-42 Review', authors: ['Smith'], year: 2026, journal: 'Nature' }
      )
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const { createTemplateTools } = await import('../../src/agent/tools/templates.js');
    const tool = createTemplateTools(vaultPath, detector).find(t => t.definition.name === 'create_reading_note')!;
    const r = JSON.parse(await tool.execute({
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
    }));
    const parsed = matter(r.newContent);
    // Body was preserved — should still contain existing content
    expect(parsed.content).toContain('This paper claims stuff.');
    // Template was NOT applied (body was meaningful) — lab_relevance should not appear
    expect(parsed.data.lab_relevance).toBeUndefined();
  });
});
