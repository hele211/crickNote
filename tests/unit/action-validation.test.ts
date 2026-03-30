import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeWriter } from '../../src/editing/safe-writer.js';

// audit.js uses the global DB singleton which is not initialised in unit tests.
vi.mock('../../src/storage/audit.js', () => ({
  logEdit: vi.fn().mockReturnValue(1),
  getLastEdit: vi.fn().mockReturnValue(undefined),
}));

// SafeWriter.confirmEdit receives a typed ConfirmAction, but the WebSocket
// layer was previously casting without validating. These tests document the
// safe-writer behavior when an unknown action slips through (regression guard).

let tmpDir: string;
let testFile: string;
let writer: SafeWriter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-action-test-'));
  testFile = path.join(tmpDir, 'note.md');
  fs.writeFileSync(testFile, '# Original content\n');
  writer = new SafeWriter();
  writer.getConflictDetector().recordFileRead(testFile, '# Original content\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SafeWriter confirmEdit — known actions', () => {
  it('apply writes the file', () => {
    const proposal = writer.proposeEdit(testFile, '# New content\n', 'test', 'session-1');
    const result = writer.confirmEdit(proposal.editId, 'apply');
    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('# New content\n');
  });

  it('cancel does not write the file', () => {
    const proposal = writer.proposeEdit(testFile, '# New content\n', 'test', 'session-1');
    const result = writer.confirmEdit(proposal.editId, 'cancel');
    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('# Original content\n');
  });

  it('returns error for unknown editId', () => {
    const result = writer.confirmEdit('nonexistent-id', 'apply');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('WebSocket action guard — invalid action strings', () => {
  // SafeWriter.confirmEdit treats any non-cancel, non-force action as an implicit
  // apply (it falls through to the write path). This means the WebSocket guard in
  // websocket.ts is the sole defence against invalid actions. These tests document
  // that SafeWriter WILL WRITE when given an unknown action string, proving the
  // WebSocket guard is critical.
  const invalidActions = ['delete', 'hack', '', 'APPLY', '1'];

  for (const action of invalidActions) {
    it(`SafeWriter writes the file when given unknown action "${action}" (guard must be in websocket layer)`, () => {
      const proposal = writer.proposeEdit(testFile, '# Hacked content\n', 'test', 'session-1');
      // Force-cast to bypass TypeScript type checking, simulating a runtime bypass.
      const result = writer.confirmEdit(proposal.editId, action as 'apply');
      // SafeWriter treats unknown actions as implicit apply — the file IS modified.
      // This proves the WebSocket guard (websocket.ts) is the essential line of defence.
      expect(result.success).toBe(true);
      expect(fs.readFileSync(testFile, 'utf-8')).toBe('# Hacked content\n');
      // Reset file for next iteration.
      fs.writeFileSync(testFile, '# Original content\n');
      writer.getConflictDetector().recordFileRead(testFile, '# Original content\n');
    });
  }
});
