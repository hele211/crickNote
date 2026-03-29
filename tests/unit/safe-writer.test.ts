import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SafeWriter } from '../../src/editing/safe-writer.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the audit module since it depends on a global database connection
vi.mock('../../src/storage/audit.js', () => ({
  logEdit: vi.fn().mockReturnValue(1),
  getLastEdit: vi.fn().mockReturnValue(undefined),
}));

describe('SafeWriter', () => {
  let writer: SafeWriter;
  let detector: ConflictDetector;
  let tmpDir: string;

  beforeEach(() => {
    detector = new ConflictDetector();
    writer = new SafeWriter(detector);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-writer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('proposeEdit for a new file generates a diff with no conflict', () => {
    const filePath = path.join(tmpDir, 'new-file.md');
    const content = '# New Note\n\nSome content.\n';

    const proposal = writer.proposeEdit(filePath, content, 'test query', 'session-1');

    expect(proposal.editId).toBeDefined();
    expect(proposal.filePath).toBe(filePath);
    expect(proposal.hasConflict).toBe(false);
    expect(proposal.diff).toBeDefined();
    expect(proposal.diff.length).toBeGreaterThan(0);
    expect(proposal.newContent).toBe(content);
  });

  it('proposeEdit for an existing file generates a diff', () => {
    const filePath = path.join(tmpDir, 'existing.md');
    const original = '# Original\n';
    fs.writeFileSync(filePath, original, 'utf-8');

    // Record a read so the detector knows about the file
    detector.recordFileRead(filePath, original);

    const newContent = '# Modified by Agent\n\nNew paragraph.\n';
    const proposal = writer.proposeEdit(filePath, newContent, 'update query', 'session-2');

    expect(proposal.hasConflict).toBe(false);
    expect(proposal.diff).toContain('Original');
    expect(proposal.diff).toContain('Modified by Agent');
  });

  it('confirmEdit with "apply" writes the file', () => {
    const filePath = path.join(tmpDir, 'to-write.md');
    const content = '# Written by SafeWriter\n';

    const proposal = writer.proposeEdit(filePath, content, 'write query', 'session-3');
    const result = writer.confirmEdit(proposal.editId, 'apply');

    expect(result.success).toBe(true);
    expect(result.action).toBe('apply');

    // Verify file was actually written
    const written = fs.readFileSync(filePath, 'utf-8');
    expect(written).toBe(content);
  });

  it('confirmEdit with "cancel" does not write the file', () => {
    const filePath = path.join(tmpDir, 'not-written.md');
    const content = '# Should Not Be Written\n';

    const proposal = writer.proposeEdit(filePath, content, 'cancel query', 'session-4');
    const result = writer.confirmEdit(proposal.editId, 'cancel');

    expect(result.success).toBe(true);
    expect(result.action).toBe('cancel');

    // File should not exist
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('confirmEdit with unknown editId returns failure', () => {
    const result = writer.confirmEdit('nonexistent-id', 'apply');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('getConflictDetector returns the injected detector', () => {
    expect(writer.getConflictDetector()).toBe(detector);
  });
});
