import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mapPendingEditForPlugin } from '../../src/server/websocket.js';

const vaultPath = '/vault';

function makePe(overrides: Partial<{ editId: string; batchId: string | undefined; filePath: string; diff: string; hasConflict: boolean; warnings: string[] }> = {}) {
  const filePath = overrides.filePath ?? path.join(vaultPath, 'Projects/P001-CM/CM001.md');
  return {
    editId: overrides.editId ?? 'edit-1',
    batchId: overrides.batchId,
    proposal: {
      filePath,
      diff: overrides.diff ?? '--- a\n+++ b\n',
      hasConflict: overrides.hasConflict ?? false,
      newContent: '# content',
    },
    warnings: overrides.warnings ?? [],
  };
}

describe('mapPendingEditForPlugin', () => {
  it('forwards batchId when present', () => {
    const pe = makePe({ batchId: 'batch-abc' });
    const result = mapPendingEditForPlugin(pe, vaultPath);
    expect(result.batchId).toBe('batch-abc');
  });

  it('forwards batchId as undefined when absent', () => {
    const pe = makePe({ batchId: undefined });
    const result = mapPendingEditForPlugin(pe, vaultPath);
    expect(result.batchId).toBeUndefined();
  });

  it('normalises filePath to vault-relative path', () => {
    const pe = makePe({ filePath: path.join(vaultPath, 'Reading/Papers/smith-2026.md') });
    const result = mapPendingEditForPlugin(pe, vaultPath);
    expect(result.path).toBe('Reading/Papers/smith-2026.md');
  });

  it('preserves editId, diff, hasConflict, and warnings', () => {
    const pe = makePe({ editId: 'e-42', diff: '--- x\n', hasConflict: true, warnings: ['w1'] });
    const result = mapPendingEditForPlugin(pe, vaultPath);
    expect(result.editId).toBe('e-42');
    expect(result.diff).toBe('--- x\n');
    expect(result.hasConflict).toBe(true);
    expect(result.warnings).toEqual(['w1']);
  });

  it('does not include newContent in the output', () => {
    const pe = makePe();
    const result = mapPendingEditForPlugin(pe, vaultPath);
    expect(Object.keys(result)).not.toContain('newContent');
  });
});
