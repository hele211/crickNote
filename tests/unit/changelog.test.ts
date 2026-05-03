import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendFolderChangelog } from '../../src/editing/changelog.js';

describe('appendFolderChangelog', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Memory', 'Daily'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('creates and appends an entry to _changelog.md in the target folder', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/CM001-test.md',
      operation: 'create_experiment',
      description: 'CM001-test.md created',
    });

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    expect(fs.existsSync(changelogPath)).toBe(true);
    const content = fs.readFileSync(changelogPath, 'utf-8');
    expect(content).toContain('| create_experiment |');
    expect(content).toContain('CM001-test.md created');
  });

  it('appends (does not overwrite) when _changelog.md already exists', () => {
    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    fs.writeFileSync(changelogPath, '2026-01-01T00:00:00Z | old_op | first entry\n', 'utf-8');

    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/CM002-test.md',
      operation: 'create_experiment',
      description: 'CM002-test.md created',
    });

    const content = fs.readFileSync(changelogPath, 'utf-8');
    expect(content).toContain('first entry');
    expect(content).toContain('CM002-test.md created');
  });

  it('skips without writing when targetPath is _changelog.md (no recursion)', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/_changelog.md',
      operation: 'auto_write',
      description: 'changelog itself',
    });

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    expect(fs.existsSync(changelogPath)).toBe(false);
  });

  it('skips when targetPath is _index.md', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/_index.md',
      operation: 'create_project',
      description: '_index.md created',
    });

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    expect(fs.existsSync(changelogPath)).toBe(false);
  });

  it('strips newlines from description to prevent injection', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/CM001.md',
      operation: 'create_experiment',
      description: 'line one\nline two\r\nline three',
    });

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    const content = fs.readFileSync(changelogPath, 'utf-8');
    // The whole entry should be exactly one line (ends with single \n)
    const lines = content.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).not.toContain('\r');
  });

  it('skips non-content folders (Memory/, Agent/, root)', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Memory/Daily/2026-05-03.md',
      operation: 'auto_write',
      description: 'daily note',
    });

    expect(fs.existsSync(path.join(vaultPath, 'Memory', 'Daily', '_changelog.md'))).toBe(false);
  });

  it('writes correctly for Reading/ folder', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Reading/Papers/smith-2026.md',
      operation: 'frontmatter_update',
      description: 'kb_status updated',
    });

    const changelogPath = path.join(vaultPath, 'Reading', 'Papers', '_changelog.md');
    expect(fs.existsSync(changelogPath)).toBe(true);
    const content = fs.readFileSync(changelogPath, 'utf-8');
    expect(content).toContain('| frontmatter_update |');
  });

  it('writes correctly for Knowledge/ folder', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Knowledge/Concepts/il-42.md',
      operation: 'frontmatter_update',
      description: 'needs_review updated',
    });

    const changelogPath = path.join(vaultPath, 'Knowledge', 'Concepts', '_changelog.md');
    expect(fs.existsSync(changelogPath)).toBe(true);
  });

  it('rejects a path that escapes the vault boundary', () => {
    expect(() => appendFolderChangelog({
      vaultPath,
      targetPath: '../outside/Projects/evil.md',
      operation: 'evil',
      description: 'escape attempt',
    })).toThrow(/traversal rejected|outside/i);
  });

  it('skips Knowledge/Review-Queue/ (excluded prefix)', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Knowledge/Review-Queue/some-paper.md',
      operation: 'frontmatter_update',
      description: 'kb_status updated',
    });

    expect(fs.existsSync(path.join(vaultPath, 'Knowledge', 'Review-Queue', '_changelog.md'))).toBe(false);
  });

  it('strips newlines from operation to prevent log-line injection', () => {
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/CM001.md',
      operation: 'create_experiment\n1970-01-01T00:00:00Z | injected | fake',
      description: 'real entry',
    });

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    const content = fs.readFileSync(changelogPath, 'utf-8');
    // Newline replaced by space — only one log line written (no fake second line).
    const lines = content.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('entry format is ISO timestamp | operation | description', () => {
    const before = Date.now();
    appendFolderChangelog({
      vaultPath,
      targetPath: 'Projects/P001-CM/CM001.md',
      operation: 'create_experiment',
      description: 'test entry',
    });
    const after = Date.now();

    const changelogPath = path.join(vaultPath, 'Projects', 'P001-CM', '_changelog.md');
    const line = fs.readFileSync(changelogPath, 'utf-8').trim();
    // Format: <ISO-Z> | <op> | <desc>
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \| create_experiment \| test entry$/);

    const ts = new Date(line.split(' | ')[0]).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });
});
