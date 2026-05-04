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

  it('discover_reading_bundle treats a managed PDF symlink as a readable PDF source', async () => {
    const targetPdf = path.join(os.tmpdir(), `cricknote-zotero-target-${Date.now()}.pdf`);
    fs.writeFileSync(targetPdf, '%PDF-linked');
    fs.symlinkSync(
      targetPdf,
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf')
    );

    try {
      const tool = createReadingIntakeTools(vaultPath, detector)
        .find((candidate) => candidate.definition.name === 'discover_reading_bundle');
      const result = JSON.parse(await tool!.execute({ slug: 'smith-2026-il42' }));

      expect(result.discovered_files).toContainEqual({ path: 'paper.pdf', type: 'pdf', readable: true });
      expect(result.recommended_sources).toContainEqual({ type: 'pdf', path: 'paper.pdf' });
    } finally {
      fs.unlinkSync(targetPdf);
    }
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
      'citekey: smith2026il42\n' +
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
      citekey: 'smith2026il42',
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
      'citekey: smith2026il42\n' +
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
      citekey: 'smith2026il42',
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
      'citekey: smith2026il42\n' +
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
      citekey: 'smith2026il42',
    }));

    const parsed = matter(result.newContent);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.kb_status).toBe('pending');
    // sources changed → body reset to scaffold
    expect(parsed.content).not.toContain('Existing claim content.');
    expect(parsed.content).toContain('# Updated title');
    expect(parsed.content).toContain('## Claims');
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
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review', citekey: 'smith2026' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-thread.md'),
      `---\ntemplate_version: 1\nthread_topic:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest({ citekey: 'smith2026' });
    const parsed = matter(r.newContent);
    expect(parsed.data.cricknote_template).toBe('reading-thread');
    expect(parsed.data.thread_topic).toBeNull();
  });

  it('falls back reading-thread to reading-paper.md when reading-thread.md absent', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md'),
      matter.stringify('\n# IL-42 Review\n', { title: 'IL-42 Review', citekey: 'smith2026' })
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Only reading-paper.md present, no reading-thread.md
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest({ citekey: 'smith2026' });
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
        { title: 'IL-42 Review', sources: [{ type: 'notes', path: 'notes.md' }], citekey: 'smith2026' }
      )
    );
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'reading-paper.md'),
      `---\ntemplate_version: 1\nlab_relevance:\n---\n\n# {{title}}\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`
    );
    const r = await ingest({ citekey: 'smith2026' });
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('This paper claims stuff.');
  });
});

describe('ingest_reading_bundle — Zotero fields and note_rel_path', () => {
  it('does not warn about .zotero-bundle in the bundle directory', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
    const slug = 'smith-2026-test';
    const bundleDir = path.join(vault, 'Reading', 'attachments', slug);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(path.join(vault, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'paper.pdf'), '%PDF-test');
    fs.writeFileSync(path.join(bundleDir, '.zotero-bundle'), JSON.stringify({ created_by: 'zotero_prepare_bundle', files: {} }));
    const tools = createReadingIntakeTools(vault);
    const discoverTool = tools.find(t => t.definition.name === 'discover_reading_bundle')!;
    const result = JSON.parse(await discoverTool.execute({ slug }));
    // Should not have a warning mentioning .zotero-bundle
    const warnings = result.warnings ?? [];
    expect(warnings.every((w: string) => !w.includes('.zotero-bundle'))).toBe(true);
  });

  it('emits note_rel_path in pending_edit meta when zotero_managed is true', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
    const slug = 'smith-2026-il42';
    const bundleDir = path.join(vault, 'Reading', 'attachments', slug);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(path.join(vault, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'paper.pdf'), '%PDF-test');
    const tools = createReadingIntakeTools(vault);
    const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
    const result = JSON.parse(await ingestTool.execute({
      slug,
      title: 'IL-42 Paper',
      authors: ['Smith J'],
      year: 2026,
      journal: 'Cell',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
      zotero_managed: true,
      zotero_files_created: ['paper.pdf'],
    }));
    expect(result.type).toBe('pending_edit');
    expect(result.meta).toBeDefined();
    expect(result.meta.note_rel_path).toBe(`Reading/Papers/${slug}.md`);
    expect(result.meta.zotero_slug).toBe(slug);
    expect(result.meta.zotero_files_created).toEqual(['paper.pdf']);
    // note_rel_path must NOT start with /
    expect(result.meta.note_rel_path.startsWith('/')).toBe(false);
  });

  it('does NOT emit note_rel_path when zotero_managed is false/absent', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
    const slug = 'smith-2026-normal';
    const bundleDir = path.join(vault, 'Reading', 'attachments', slug);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(path.join(vault, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'paper.pdf'), '%PDF-test');
    const tools = createReadingIntakeTools(vault);
    const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
    const result = JSON.parse(await ingestTool.execute({
      slug,
      title: 'Normal Paper',
      authors: ['Jones A'],
      year: 2025,
      journal: 'Nature',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    }));
    expect(result.type).toBe('pending_edit');
    expect(result.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers for duplicate-slug and collision-check tests
// ---------------------------------------------------------------------------

function makeZoteroVault(slug: string = 'smith-2026-il42'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
  for (const sub of ['Reading/Papers', 'Reading/Threads', `Reading/attachments/${slug}`]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, `Reading/attachments/${slug}/paper.pdf`), '%PDF-test');
  return dir;
}

async function ingestBundle(vaultPath: string, args: object): Promise<Record<string, unknown>> {
  const tools = createReadingIntakeTools(vaultPath);
  const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
  return JSON.parse(await ingestTool.execute(args));
}

const BASE_ARGS = {
  slug: 'smith-2026-il42',
  title: 'T',
  authors: ['S'],
  year: 2026,
  journal: 'J',
  sources: [{ type: 'pdf', path: 'paper.pdf' }],
};

describe('duplicate-slug detection', () => {
  it('errors when slug exists in both Papers and Threads', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'), '---\ntitle: A\n---\n');
    fs.writeFileSync(path.join(vault, 'Reading/Threads/smith-2026-il42.md'), '---\ntitle: B\n---\n');
    const result = await ingestBundle(vault, BASE_ARGS);
    expect(result.error).toMatch(/both Reading\/Papers.*Reading\/Threads/);
  });
});

describe('collision-check tiers', () => {
  it('zotero_key match → proceed silently (same paper)', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: ABCD1234\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, zotero_key: 'ABCD1234', zotero_managed: true, zotero_files_created: [] });
    expect(result.type).toBe('pending_edit');
  });

  it('zotero_key mismatch → stop and ask user', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: OTHER123\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, zotero_key: 'ABCD1234', zotero_managed: true });
    expect(result.error).toMatch(/zotero_key/i);
  });

  it('DOI match (no zotero_key on either side) → proceed silently', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ndoi: "10.1016/j.cell"\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, doi: 'https://doi.org/10.1016/j.cell' });
    expect(result.type).toBe('pending_edit');
  });

  it('DOI mismatch → stop and ask user', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ndoi: "10.9999/other"\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, doi: '10.1016/j.cell', zotero_managed: true });
    expect(result.error).toMatch(/doi/i);
  });

  it('citekey match, no stronger ID → proceed silently (weak identity)', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ncitekey: smith2026\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, citekey: 'smith2026' });
    expect(result.type).toBe('pending_edit');
  });

  it('citekey mismatch, no stronger ID → stop and ask user', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\ncitekey: jones2025\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, citekey: 'smith2026', zotero_managed: true });
    expect(result.error).toMatch(/citekey/i);
  });

  it('no shared identifier → stop and ask user (slug-match only)', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\n---\n');
    const result = await ingestBundle(vault, { ...BASE_ARGS, zotero_managed: true });
    expect(result.error).toMatch(/slug/i);
  });

  it('existing note has zotero_key but fetched item has none (Path A) → falls through to DOI tier', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old T\nzotero_key: ABCD1234\ndoi: "10.1016/j.cell"\n---\n');
    // No zotero_key in args (Path A), but DOI matches
    const result = await ingestBundle(vault, { ...BASE_ARGS, doi: '10.1016/j.cell' });
    expect(result.type).toBe('pending_edit');
  });
});

describe('effective_sources and downgrade protection', () => {
  it('abstract-only rerun against existing PDF source preserves PDF source and emits message', async () => {
    const vault = makeZoteroVault();
    // Write existing note with PDF source and meaningful body
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: T\nauthors: [S]\nyear: 2026\njournal: J\ncitekey: s2026\nsources:\n  - type: pdf\n    path: paper.pdf\n---\n\n# T\n\n## Claims\n\nsome content');
    // Set up abstract.md for the abstract-only rerun
    fs.writeFileSync(path.join(vault, 'Reading/attachments/smith-2026-il42/abstract.md'), '# Abstract\n\nsome abstract');
    const result = await ingestBundle(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      citekey: 's2026',
      sources: [{ type: 'notes', path: 'abstract.md' }],
      zotero_managed: true, zotero_files_created: [],
    });
    expect(result.type).toBe('pending_edit');
    // message must be present and mention pdf
    expect(typeof result.message).toBe('string');
    expect((result.message as string).toLowerCase()).toContain('pdf');
    // effective_sources unchanged → body must be preserved
    expect(result.newContent).toContain('some content');
  });

  it('abstract→PDF upgrade resets status/kb_status and resets body to scaffold', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: T\nauthors: [S]\nyear: 2026\njournal: J\nstatus: complete\nkb_status: mapped\ncitekey: s2026\nsources:\n  - type: notes\n    path: abstract.md\n---\n\n# T\n\n## Claims\n\nsome content');
    const result = await ingestBundle(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      citekey: 's2026',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
      zotero_managed: true, zotero_files_created: ['paper.pdf'],
    });
    expect(result.type).toBe('pending_edit');
    expect(result.newContent).toContain('status: draft');
    expect(result.newContent).toContain('kb_status: pending');
    // sources changed → body must be reset to scaffold, not preserve prior content
    expect(result.newContent).not.toContain('some content');
    expect(result.newContent).toContain('## Claims');
  });

  it('sources change resets body to scaffold even when prior body was meaningful', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: T\nauthors: [S]\nyear: 2026\njournal: J\nstatus: complete\ncitekey: s2026\nsources:\n  - type: pdf\n    path: old.pdf\n---\n\n# T\n\n## Claims\n\ndetailed analysis');
    const result = await ingestBundle(vault, {
      slug: 'smith-2026-il42', title: 'T', authors: ['S'], year: 2026, journal: 'J',
      citekey: 's2026',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    });
    expect(result.type).toBe('pending_edit');
    expect(result.newContent).not.toContain('detailed analysis');
    expect(result.newContent).toContain('## Claims');
  });

  it('unchanged effective_sources preserves body and syncs H1', async () => {
    const vault = makeZoteroVault();
    fs.writeFileSync(path.join(vault, 'Reading/Papers/smith-2026-il42.md'),
      '---\ntitle: Old Title\nauthors: [S]\nyear: 2026\njournal: J\nstatus: complete\ncitekey: s2026\nsources:\n  - type: pdf\n    path: paper.pdf\n---\n\n# Old Title\n\n## Claims\n\nsome content');
    const result = await ingestBundle(vault, {
      slug: 'smith-2026-il42', title: 'New Title', authors: ['S'], year: 2026, journal: 'J',
      citekey: 's2026',
      sources: [{ type: 'pdf', path: 'paper.pdf' }],
    });
    expect(result.type).toBe('pending_edit');
    expect(result.newContent).toContain('some content');
    expect(result.newContent).toContain('# New Title');
    expect(result.newContent).toContain('status: complete');
  });
});
