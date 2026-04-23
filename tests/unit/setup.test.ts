import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureVaultScaffold } from '../../src/cli/setup.js';

describe('ensureVaultScaffold', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('creates initial Knowledge index files during setup', () => {
    ensureVaultScaffold(vaultPath);

    for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
      const indexPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('type: index');
      expect(content).toContain(`folder: Knowledge/${kind}`);
      expect(content).toContain(`# ${kind}`);
      expect(content).toContain('| Title | Aliases | Last Updated | Sources |');
    }
  });

  it('creates the expected vault directories', () => {
    ensureVaultScaffold(vaultPath);

    for (const rel of [
      'Projects',
      'Protocols',
      'Reading/Papers',
      'Reading/Threads',
      'Reading/attachments',
      'Memory/Daily',
      'Knowledge/Concepts',
      'Knowledge/Entities',
      'Knowledge/Methods',
      'Knowledge/Review-Queue',
      'Knowledge/_Ops/Update-Logs',
      'Knowledge/_Ops/Lint-Reports',
    ]) {
      expect(fs.existsSync(path.join(vaultPath, rel))).toBe(true);
    }
  });
});

describe('ensureVaultScaffold — template scaffolding', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-tpl-test-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  const EXPECTED_TEMPLATES = [
    'experiment.md',
    'project-index.md',
    'series.md',
    'protocol.md',
    'reading-paper.md',
    'reading-thread.md',
    'README.md',
  ];

  it('creates Agent/templates/ and all default template files on first run', () => {
    ensureVaultScaffold(vaultPath);
    const templatesDir = path.join(vaultPath, 'Agent', 'templates');
    expect(fs.existsSync(templatesDir)).toBe(true);
    for (const filename of EXPECTED_TEMPLATES) {
      const filePath = path.join(templatesDir, filename);
      expect(fs.existsSync(filePath), `missing ${filename}`).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8').length).toBeGreaterThan(0);
    }
  });

  it('does NOT overwrite existing template files on rerun (scientist-edited templates survive)', () => {
    ensureVaultScaffold(vaultPath);
    // Simulate scientist editing experiment.md
    const expPath = path.join(vaultPath, 'Agent', 'templates', 'experiment.md');
    fs.writeFileSync(expPath, '# scientist edited this');
    // Rerun setup
    ensureVaultScaffold(vaultPath);
    // Scientist content must survive
    expect(fs.readFileSync(expPath, 'utf-8')).toBe('# scientist edited this');
  });

  it('creates missing template files without touching existing ones on rerun', () => {
    // First run creates all files
    ensureVaultScaffold(vaultPath);
    // Delete one file to simulate a new template being added in a CrickNote update
    const seriesPath = path.join(vaultPath, 'Agent', 'templates', 'series.md');
    fs.unlinkSync(seriesPath);
    // Edit another file to simulate scientist customization
    const expPath = path.join(vaultPath, 'Agent', 'templates', 'experiment.md');
    fs.writeFileSync(expPath, '# my custom experiment template');
    // Rerun setup
    ensureVaultScaffold(vaultPath);
    // Missing file restored
    expect(fs.existsSync(seriesPath)).toBe(true);
    // Existing file preserved
    expect(fs.readFileSync(expPath, 'utf-8')).toBe('# my custom experiment template');
  });

  it('experiment.md default content contains template_version and required placeholders', () => {
    ensureVaultScaffold(vaultPath);
    const content = fs.readFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      'utf-8'
    );
    expect(content).toContain('template_version: 1');
    expect(content).toContain('{{title}}');
    expect(content).toContain('{{date}}');
  });
});
