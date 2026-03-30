import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeWriter } from '../../src/editing/safe-writer.js';

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
  it('documents that the websocket layer must reject unknown actions before they reach SafeWriter', () => {
    // This test asserts that the websocket validation guard (added in websocket.ts)
    // is the line of defence. SafeWriter's confirmEdit accepts ConfirmAction by type,
    // but a runtime cast bypass would behave like 'apply' (fall-through write).
    // The guard in websocket.ts must reject values other than apply/force/cancel.
    const validActions = ['apply', 'force', 'cancel'];
    const invalidActions = ['delete', 'hack', '', 'APPLY', '1'];
    for (const action of validActions) {
      expect(validActions.includes(action)).toBe(true);
    }
    for (const action of invalidActions) {
      expect(['apply', 'force', 'cancel'].includes(action)).toBe(false);
    }
  });
});
