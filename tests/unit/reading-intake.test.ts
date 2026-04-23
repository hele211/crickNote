import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';

describe('reading intake tools', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-reading-intake-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('discover_reading_bundle lists readable files and recommended sources', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf'), 'fake pdf');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notebooklm-summary.md'), '# summary');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'claude-notes.md'), '# notes');

    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'discover_reading_bundle');
    const result = JSON.parse(await tool!.execute({ slug: 'smith-2026-il42' }));

    expect(result.folder_exists).toBe(true);
    expect(result.discovered_files).toEqual([
      { path: 'claude-notes.md', type: 'notes', readable: true },
      { path: 'notebooklm-summary.md', type: 'notebooklm', readable: true },
      { path: 'paper.pdf', type: 'pdf', readable: true },
    ]);
    expect(result.recommended_sources).toEqual([
      { type: 'notes', path: 'claude-notes.md' },
      { type: 'notebooklm', path: 'notebooklm-summary.md' },
      { type: 'pdf', path: 'paper.pdf' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('discover_reading_bundle warns for multiple PDFs, unsupported files, and missing bundles', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper-a.pdf'), 'a');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper-b.pdf'), 'b');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'figure.png'), 'png');

    const tools = createReadingIntakeTools(vaultPath, detector);
    const discover = tools.find((candidate) => candidate.definition.name === 'discover_reading_bundle');

    const result = JSON.parse(await discover!.execute({ slug: 'smith-2026-il42' }));
    expect(result.warnings.some((warning: string) => warning.includes('Multiple PDF files'))).toBe(true);
    expect(result.warnings.some((warning: string) => warning.includes('Unsupported bundle file "figure.png"'))).toBe(true);

    const missing = JSON.parse(await discover!.execute({ slug: 'missing-bundle' }));
    expect(missing.folder_exists).toBe(false);
    expect(missing.warnings[0]).toContain('Reading bundle not found');
  });

  it('ingest_reading_bundle creates a reading note with discovered sources when explicit sources are omitted', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf'), 'fake pdf');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notebooklm-summary.md'), '# summary');

    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'ingest_reading_bundle');
    const result = JSON.parse(await tool!.execute({
      slug: 'smith-2026-il42',
      title: 'IL-42 mediated suppression',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');
    expect(result.path).toBe(path.join(fs.realpathSync(vaultPath), 'Reading', 'Papers', 'smith-2026-il42.md'));

    const parsed = matter(result.newContent);
    expect(parsed.data.sources).toEqual([
      { type: 'notebooklm', path: 'notebooklm-summary.md' },
      { type: 'pdf', path: 'paper.pdf' },
    ]);
    expect(parsed.content).toContain('## Claims');
  });

  it('ingest_reading_bundle errors cleanly when a selected source is missing', async () => {
    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'ingest_reading_bundle');
    const result = JSON.parse(await tool!.execute({
      slug: 'smith-2026-il42',
      title: 'IL-42 mediated suppression',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    }));

    expect(result.error).toContain('Selected source file not found');
  });

  it('ingest_reading_bundle preserves existing body content and records a conflict snapshot on update', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'old-notes.md'), 'old notes');
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\n' +
      'title: Old title\n' +
      'authors: [Old Author]\n' +
      'year: 2025\n' +
      'journal: Old Journal\n' +
      'read_date: 2026-04-10\n' +
      'status: complete\n' +
      'kb_status: mapped\n' +
      'sources:\n' +
      '  - type: notes\n' +
      '    path: old-notes.md\n' +
      '---\n\n' +
      '# Old title\n\n' +
      '## Claims\n\n' +
      'Existing claim content.\n'
    );

    const notePath = path.join(fs.realpathSync(vaultPath), 'Reading', 'Papers', 'smith-2026-il42.md');
    const original = fs.readFileSync(notePath, 'utf-8');

    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'ingest_reading_bundle');
    const result = JSON.parse(await tool!.execute({
      slug: 'smith-2026-il42',
      title: 'Updated title',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      related_projects: ['P001'],
      sources: [{ type: 'notes', path: 'old-notes.md' }],
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('update');
    expect(result.path).toBe(notePath);
    expect(detector.getSnapshot(notePath)?.content).toBe(original);

    const parsed = matter(result.newContent);
    expect(parsed.data.title).toBe('Updated title');
    expect(parsed.data.related_projects).toEqual(['P001']);
    expect(parsed.data.status).toBe('complete');
    expect(parsed.data.kb_status).toBe('mapped');
    expect(parsed.data.sources).toEqual([{ type: 'notes', path: 'old-notes.md' }]);
    expect(parsed.content).toContain('Existing claim content.');
    expect(parsed.content).toContain('# Updated title');
  });

  it('ingest_reading_bundle resets workflow status when the existing note body is still just a blank scaffold', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf'), 'fake pdf');
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\n' +
      'title: Old title\n' +
      'authors: [Old Author]\n' +
      'year: 2025\n' +
      'journal: Old Journal\n' +
      'read_date: 2026-04-10\n' +
      'status: complete\n' +
      'kb_status: mapped\n' +
      '---\n\n' +
      '# Old title\n\n' +
      '## Claims\n\n' +
      '## Reasoning\n\n' +
      '## Evidence\n\n' +
      '## Assumptions\n\n' +
      '## Takeaways\n\n' +
      '## Extensions\n'
    );

    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'ingest_reading_bundle');
    const result = JSON.parse(await tool!.execute({
      slug: 'smith-2026-il42',
      title: 'Updated title',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    }));

    const parsed = matter(result.newContent);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.kb_status).toBe('pending');
  });

  it('ingest_reading_bundle resets workflow status when the selected sources change', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'old-notes.md'), 'old notes');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf'), 'fake pdf');
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\n' +
      'title: Old title\n' +
      'authors: [Old Author]\n' +
      'year: 2025\n' +
      'journal: Old Journal\n' +
      'read_date: 2026-04-10\n' +
      'status: complete\n' +
      'kb_status: merged\n' +
      'sources:\n' +
      '  - type: notes\n' +
      '    path: old-notes.md\n' +
      '---\n\n' +
      '# Old title\n\n' +
      '## Claims\n\n' +
      'Existing claim content.\n'
    );

    const tool = createReadingIntakeTools(vaultPath, detector)
      .find((candidate) => candidate.definition.name === 'ingest_reading_bundle');
    const result = JSON.parse(await tool!.execute({
      slug: 'smith-2026-il42',
      title: 'Updated title',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    }));

    const parsed = matter(result.newContent);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.kb_status).toBe('pending');
    expect(parsed.content).toContain('Existing claim content.');
    expect(parsed.content).toContain('# Updated title');
  });
});

describe('ingest_reading_bundle — template integration', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-intake-tpl-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      '# notes'
    );
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  async function ingest(overrides: Record<string, unknown> = {}) {
    const { createReadingIntakeTools } = await import('../../src/agent/tools/reading-intake.js');
    const tool = createReadingIntakeTools(vaultPath, detector)
      .find(t => t.definition.name === 'ingest_reading_bundle')!;
    return JSON.parse(await tool.execute({
      slug: 'smith-2026-il42',
      title: 'IL-42 Review',
      authors: ['Smith'],
      year: 2026,
      journal: 'Nature',
      sources: [{ type: 'notes', path: 'notes.md' }],
      ...overrides,
    }));
  }

  it('returns warnings array when no templates folder exists', async () => {
    const r = await ingest();
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('applies custom template field from reading-paper.md template', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.data.lab_relevance).toBeNull();
    expect(parsed.data.cricknote_template).toBe('reading-paper');
    expect(r.warnings).toHaveLength(0);
  });

  it('uses reading-thread kind when note is in Reading/Threads/', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    // Place an existing thread note so findReadingNoteBySlug returns the Threads path
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md'),
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-thread.md'),
      `---\ntemplate_version: 1\nthread_topic:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.data.cricknote_template).toBe('reading-thread');
    expect(parsed.data.thread_topic).toBeNull();
  });

  it('falls back reading-thread to reading-paper.md when reading-thread.md absent', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md'),
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Only reading-paper.md present, no reading-thread.md
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    // Still kind=reading-thread from loader's perspective, cricknote_template is 'reading-thread'
    expect(parsed.data.cricknote_template).toBe('reading-thread');
    // Custom field from reading-paper.md fallback is present
    expect(parsed.data.lab_relevance).toBeNull();
  });

  it('preserves meaningful existing body without re-applying template', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      matter.stringify(
        '\n# IL-42 Review\n\n## Claims\nThis paper claims stuff.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n',
        { title: 'IL-42 Review', sources: [] }
      )
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest();
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('This paper claims stuff.');
  });
});
