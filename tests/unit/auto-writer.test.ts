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
});

describe('frontmatterFieldUpdate', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ffu-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
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
});
