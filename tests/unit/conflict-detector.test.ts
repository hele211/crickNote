import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ConflictDetector', () => {
  let detector: ConflictDetector;
  let tmpDir: string;

  beforeEach(() => {
    detector = new ConflictDetector();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no conflict when file is unchanged', () => {
    const filePath = path.join(tmpDir, 'unchanged.md');
    const content = '# Hello World\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    detector.recordFileRead(filePath, content);

    const result = detector.checkConflict(filePath);
    expect(result.hasConflict).toBe(false);
  });

  it('detects conflict when file content has changed', () => {
    const filePath = path.join(tmpDir, 'changed.md');
    const original = '# Original\n';
    fs.writeFileSync(filePath, original, 'utf-8');

    detector.recordFileRead(filePath, original);

    // Externally modify the file
    const modified = '# Modified by someone else\n';
    fs.writeFileSync(filePath, modified, 'utf-8');

    const result = detector.checkConflict(filePath, '# Agent proposal\n');
    expect(result.hasConflict).toBe(true);
    expect(result.originalContent).toBe(original);
    expect(result.currentContent).toBe(modified);
    expect(result.proposedContent).toBe('# Agent proposal\n');
  });

  it('reports no conflict for a file not previously read', () => {
    const filePath = path.join(tmpDir, 'never-read.md');
    fs.writeFileSync(filePath, '# Some content\n', 'utf-8');

    const result = detector.checkConflict(filePath);
    expect(result.hasConflict).toBe(false);
  });

  it('recordFileRead then checkConflict works correctly for unchanged file', () => {
    const filePath = path.join(tmpDir, 'read-then-check.md');
    const content = '---\ndate: 2026-03-24\n---\n# Experiment\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    detector.recordFileRead(filePath, content);

    // No changes made
    const result = detector.checkConflict(filePath);
    expect(result.hasConflict).toBe(false);
  });

  it('detects conflict when file is deleted after read', () => {
    const filePath = path.join(tmpDir, 'deleted.md');
    const content = '# Will be deleted\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    detector.recordFileRead(filePath, content);

    // Delete the file
    fs.unlinkSync(filePath);

    const result = detector.checkConflict(filePath);
    expect(result.hasConflict).toBe(true);
    expect(result.originalContent).toBe(content);
  });

  it('clearSnapshot removes tracking for a file', () => {
    const filePath = path.join(tmpDir, 'cleared.md');
    const content = '# Content\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    detector.recordFileRead(filePath, content);
    expect(detector.getSnapshot(filePath)).toBeDefined();

    detector.clearSnapshot(filePath);
    expect(detector.getSnapshot(filePath)).toBeUndefined();
  });
});
