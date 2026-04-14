import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';

function readingNote(frontmatter: string, body: string): string {
  return `---\n${frontmatter}---\n\n${body}`;
}

describe('reading pipeline status', () => {
  let vaultPath: string;
  let statusTool: ReturnType<typeof createReadingIntakeTools>[number];
  let setStatusTool: ReturnType<typeof createReadingIntakeTools>[number];

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-reading-status-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    const tools = createReadingIntakeTools(vaultPath);
    statusTool = tools.find((tool) => tool.definition.name === 'reading_pipeline_status')!;
    setStatusTool = tools.find((tool) => tool.definition.name === 'set_reading_note_status')!;
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('returns missing_bundle when the bundle folder is absent', async () => {
    const result = JSON.parse(await statusTool.execute({ slug: 'missing-paper' }));
    expect(result.next_step).toBe('missing_bundle');
  });

  it('returns ready_to_ingest when the bundle exists but the note does not', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.pdf'), 'fake pdf');

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('ready_to_ingest');
    expect(result.required_metadata).toEqual(['title', 'authors', 'year', 'journal']);
  });

  it('returns needs_sources when the note exists without sources', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote('title: Test\nstatus: draft\nkb_status: pending\n', '# Test\n')
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('needs_sources');
  });

  it('returns ready_to_compile when sources exist but CREATE sections are still empty', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: draft\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\n## Reasoning\n\n## Evidence\n\n## Assumptions\n\n## Takeaways\n\n## Extensions\n'
      )
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('ready_to_compile');
    expect(result.has_create_headings).toBe(true);
  });

  it('returns needs_human_review when CREATE content is drafted but the note is not complete', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: in-progress\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\nFilled claim.\n'
      )
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('needs_human_review');
  });

  it('returns ready_for_kb_mapping when the note is complete and kb_status is pending', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: complete\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\nFilled claim.\n'
      )
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('ready_for_kb_mapping');
  });

  it('returns kb_apply_in_progress when a mapped note has pending mapping rows', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: complete\nkb_status: mapped\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\nFilled claim.\n'
      )
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      '---\nstatus: confirmed\nsource: [[smith-2026-il42]]\n---\n\n' +
      '## Targets\n\n' +
      '| Target | Action | State | Review-Queue | Updated |\n' +
      '|--------|--------|-------|--------------|---------|\n' +
      '| [[cd4-cd8-interaction]] | update | pending | | |\n'
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('kb_apply_in_progress');
    expect(result.mapping_path).toBe('Reading/Papers/smith-2026-il42-mapping.md');
  });

  it('returns done when the note is merged', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: complete\nkb_status: merged\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\nFilled claim.\n'
      )
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('done');
  });

  it('returns needs_mapping_cleanup when multiple confirmed mapping artifacts exist', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: Test\nstatus: complete\nkb_status: mapped\nsources:\n  - type: notes\n    path: notes.md\n',
        '# Test\n\n## Claims\n\nFilled claim.\n'
      )
    );
    // Two confirmed artifacts — ambiguous which is active
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      '---\nstatus: confirmed\nsource: [[smith-2026-il42]]\n---\n\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------|\n| [[il42-signalling]] | update | pending | | |\n'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping-20260414T120000.md'),
      '---\nstatus: confirmed\nsource: [[smith-2026-il42]]\n---\n\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------|\n| [[il42-receptor]] | update | pending | | |\n'
    );

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('needs_mapping_cleanup');
    expect(result.mapping_cleanup_candidates).toHaveLength(2);
  });

  it('set_reading_note_status returns a pending_edit with the updated status field', async () => {
    const notePath = path.join(vaultPath, 'Reading', 'Threads', 'smith-2026-il42.md');
    fs.writeFileSync(
      notePath,
      readingNote('title: Test\nstatus: draft\nkb_status: pending\n', '# Test\n')
    );

    const result = JSON.parse(await setStatusTool.execute({
      path: 'Reading/Threads/smith-2026-il42.md',
      status: 'complete',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('update');
    expect(result.newContent).toContain('status: complete');
    expect(result.newContent).toContain('kb_status: pending');
    // File on disk should NOT be modified — the edit is pending user confirmation
    const onDisk = fs.readFileSync(notePath, 'utf-8');
    expect(onDisk).toContain('status: draft');
  });
});
