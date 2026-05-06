import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultWatcher } from '../../src/ingestion/watcher.js';

describe('VaultWatcher.getAllMarkdownFiles', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM', 'attachments', 'CM001'), { recursive: true });

    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026.md'), '# reading note');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-mapping.md'), '# mapping artifact');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026', 'notes.md'), '# source notes');
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', 'attachments', 'CM001', 'notes.md'), '# attachment notes');
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('ignores markdown files inside attachments directories', async () => {
    const files = await VaultWatcher.getAllMarkdownFiles(vaultPath);

    expect(files).toContain('Reading/Papers/smith-2026.md');
    expect(files).not.toContain('Reading/Papers/smith-2026-mapping.md');
    expect(files).not.toContain('Reading/attachments/smith-2026/notes.md');
    expect(files).not.toContain('Projects/P001-CM/attachments/CM001/notes.md');
  });

  it('excludes _changelog.md files from the full markdown scan', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', '_changelog.md'),
      '2026-05-03T12:00:00Z | op | desc\n'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md'),
      '2026-05-03T12:00:00Z | op | desc\n'
    );

    const files = await VaultWatcher.getAllMarkdownFiles(vaultPath);

    expect(files).not.toContain('Reading/Papers/_changelog.md');
    expect(files).not.toContain('Projects/P001-CM/_changelog.md');
    expect(files).toContain('Reading/Papers/smith-2026.md');
  });
});
