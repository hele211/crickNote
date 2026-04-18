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
