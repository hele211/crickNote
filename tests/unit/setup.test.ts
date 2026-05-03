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

  it('folder-readme.md is included in DEFAULT_TEMPLATE_FILES and scaffolded', () => {
    ensureVaultScaffold(vaultPath);
    const filePath = path.join(vaultPath, 'Agent', 'templates', 'folder-readme.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('template_version: 1');
  });
});

describe('ensureVaultScaffold — _README.md scaffolding', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-readme-test-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  const ROOT_CONTENT_DIRS = [
    'Projects',
    'Reading/Papers',
    'Reading/Threads',
    'Knowledge/Concepts',
    'Knowledge/Entities',
    'Knowledge/Methods',
  ];

  it('creates _README.md stubs in all root content directories on first run', () => {
    ensureVaultScaffold(vaultPath);
    for (const rel of ROOT_CONTENT_DIRS) {
      const readmePath = path.join(vaultPath, rel, '_README.md');
      expect(fs.existsSync(readmePath), `missing _README.md in ${rel}`).toBe(true);
      const content = fs.readFileSync(readmePath, 'utf-8');
      expect(content).toContain('note_kind: folder-readme');
      expect(content).not.toContain('template_version');
    }
  });

  it('creates _README.md in existing project subfolders', () => {
    // Pre-create a project subfolder (simulating an existing project)
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    ensureVaultScaffold(vaultPath);
    const readmePath = path.join(vaultPath, 'Projects', 'P001-CM', '_README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
  });

  it('creates _README.md in existing Reading/Papers subfolders', () => {
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers', 'Smith2026'), { recursive: true });
    ensureVaultScaffold(vaultPath);
    const readmePath = path.join(vaultPath, 'Reading', 'Papers', 'Smith2026', '_README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
  });

  it('does not overwrite an existing _README.md in a subfolder', () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    const readmePath = path.join(vaultPath, 'Projects', 'P001-CM', '_README.md');
    fs.writeFileSync(readmePath, '# scientist wrote this', 'utf-8');
    ensureVaultScaffold(vaultPath);
    expect(fs.readFileSync(readmePath, 'utf-8')).toBe('# scientist wrote this');
  });

  it('does not scaffold _README.md in ignored dirs (attachments, _Ops, hidden)', () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM', 'attachments'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    ensureVaultScaffold(vaultPath);
    expect(fs.existsSync(path.join(vaultPath, 'Projects', 'P001-CM', 'attachments', '_README.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultPath, 'Knowledge', '_Ops', '_README.md'))).toBe(false);
  });
});
