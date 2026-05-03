import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoWrite, fencedSectionUpdate, frontmatterFieldUpdate } from '../../src/editing/auto-writer.js';

describe('autoWrite', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('writes a file in the allowlist', () => {
    const target = path.join(vaultPath, 'Knowledge', 'Review-Queue', 'test.md');
    autoWrite(target, '# Test', vaultPath);
    expect(fs.readFileSync(target, 'utf-8')).toBe('# Test');
  });

  it('throws for paths outside the allowlist', () => {
    const target = path.join(vaultPath, 'Projects', 'P001', 'CM001.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    expect(() => autoWrite(target, '# x', vaultPath)).toThrow('autoWrite not permitted');
  });

  it('writes a mapping file in Reading/Papers', () => {
    const target = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-mapping.md');
    autoWrite(target, '# mapping', vaultPath);
    expect(fs.readFileSync(target, 'utf-8')).toBe('# mapping');
  });

  it('rejects a vault-escape path', () => {
    const escapeTarget = path.join(vaultPath, '..', '..', 'etc', 'passwd');
    expect(() => autoWrite(escapeTarget, 'x', vaultPath))
      .toThrow(/traversal rejected|autoWrite not permitted/);
  });

  it('appends a changelog entry after writing a Reading/Papers file', () => {
    const target = path.join(vaultPath, 'Reading', 'Papers', 'jones-2026-mapping.md');
    autoWrite(target, '# mapping', vaultPath);
    const changelog = path.join(vaultPath, 'Reading', 'Papers', '_changelog.md');
    expect(fs.existsSync(changelog)).toBe(true);
    const lines = fs.readFileSync(changelog, 'utf-8');
    expect(lines).toMatch(/auto_write/);
  });
});

describe('fencedSectionUpdate', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fsu-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('replaces only the fenced section, leaving user content untouched', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(filePath, `---\nnote_kind: project\n---\n\n<!-- AUTO-GENERATED: experiment-log -->\nold\n<!-- END AUTO-GENERATED: experiment-log -->\n\nUser content.\n`);
    fencedSectionUpdate(filePath, 'experiment-log', 'new row', vaultPath);
    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).toContain('new row');
    expect(result).not.toContain('\nold\n');
    expect(result).toContain('User content.');
  });

  it('throws for ineligible paths', () => {
    const fp = path.join(vaultPath, 'Knowledge', 'foo.md');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'x');
    expect(() => fencedSectionUpdate(fp, 'experiment-log', 'x', vaultPath)).toThrow('not permitted');
  });

  it('throws if open marker not found', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(filePath, '# no fence');
    expect(() => fencedSectionUpdate(filePath, 'experiment-log', 'x', vaultPath)).toThrow("fence 'experiment-log' not found");
  });

  it('throws if close marker not found', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(filePath, '<!-- AUTO-GENERATED: experiment-log -->\nno close tag');
    expect(() => fencedSectionUpdate(filePath, 'experiment-log', 'x', vaultPath))
      .toThrow("END AUTO-GENERATED fence 'experiment-log' not found");
  });

  it('throws for duplicate open marker', () => {
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_index.md');
    fs.writeFileSync(
      filePath,
      '<!-- AUTO-GENERATED: experiment-log -->\nfirst\n<!-- END AUTO-GENERATED: experiment-log -->\n' +
      '<!-- AUTO-GENERATED: experiment-log -->\nsecond\n<!-- END AUTO-GENERATED: experiment-log -->\n'
    );
    expect(() => fencedSectionUpdate(filePath, 'experiment-log', 'x', vaultPath))
      .toThrow("Duplicate AUTO-GENERATED fence 'experiment-log'");
  });

  it('appends a changelog entry after updating a fenced section', () => {
    // _index.md is excluded from changelog; use a series note instead
    const filePath = path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CMS001-test.md');
    fs.writeFileSync(filePath, `---\nnote_kind: series\n---\n\n<!-- AUTO-GENERATED: summary -->\nold\n<!-- END AUTO-GENERATED: summary -->\n`);
    fencedSectionUpdate(filePath, 'summary', 'new row', vaultPath);
    const changelog = path.join(vaultPath, 'Projects', 'P001-CellMigration', '_changelog.md');
    expect(fs.existsSync(changelog)).toBe(true);
    expect(fs.readFileSync(changelog, 'utf-8')).toMatch(/fenced_section_update/);
  });
});

describe('frontmatterFieldUpdate', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ffu-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates kb_status in a Reading/Papers note', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: Test\nkb_status: pending\n---\n\n# Body');
    frontmatterFieldUpdate(filePath, 'kb_status', 'mapped', vaultPath);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('kb_status: mapped');
    expect(content).not.toContain('kb_status: pending');
    expect(content).toContain('# Body');
  });

  it('updates status in a Reading/Threads note', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Threads', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: Test\nstatus: draft\n---\n\n# Body');
    frontmatterFieldUpdate(filePath, 'status', 'complete', vaultPath);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('status: complete');
    expect(content).not.toContain('status: draft');
    expect(content).toContain('# Body');
  });

  it('throws for ineligible field', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: x\n---\n');
    expect(() => frontmatterFieldUpdate(filePath, 'title', 'new', vaultPath)).toThrow('not permitted');
  });

  it('updates needs_review in a Knowledge/Concepts note', () => {
    const filePath = path.join(vaultPath, 'Knowledge', 'Concepts', 'pcr.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '---\ntitle: PCR\nneeds_review: false\n---\n\n# Body');
    frontmatterFieldUpdate(filePath, 'needs_review', true, vaultPath);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('needs_review: true');
    expect(content).toContain('# Body');
  });

  it('throws for needs_review on _index.md (excluded)', () => {
    const filePath = path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '---\ntitle: x\n---\n');
    expect(() => frontmatterFieldUpdate(filePath, 'needs_review', true, vaultPath)).toThrow('not permitted');
  });

  it('still rejects unrelated reading-note fields', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Threads', 'smith-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: x\nstatus: draft\n---\n');
    expect(() => frontmatterFieldUpdate(filePath, 'authors', 'Alice', vaultPath)).toThrow('not permitted');
  });

  it('appends a changelog entry after updating a frontmatter field', () => {
    const filePath = path.join(vaultPath, 'Reading', 'Papers', 'jones-2026.md');
    fs.writeFileSync(filePath, '---\ntitle: Jones\nkb_status: pending\n---\n\n# Body');
    frontmatterFieldUpdate(filePath, 'kb_status', 'mapped', vaultPath);
    const changelog = path.join(vaultPath, 'Reading', 'Papers', '_changelog.md');
    expect(fs.existsSync(changelog)).toBe(true);
    expect(fs.readFileSync(changelog, 'utf-8')).toMatch(/frontmatter_update/);
  });
});
