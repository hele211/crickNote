import { describe, it, expect } from 'vitest';
import { SafeWriter } from '../../src/editing/safe-writer.js';

describe('SafeWriter.getPendingEditMeta', () => {
  it('returns meta before confirmEdit deletes the entry', () => {
    const sw = new SafeWriter();
    const meta = { operation: 'create_project', project_id: 'P001', prefix: 'CM' };
    sw.proposeEdit('/tmp/test-meta.md', '# content', 'trigger', 'sess1', meta);
    const editId = [...(sw as unknown as { pendingEdits: Map<string, { editId: string }> }).pendingEdits.keys()][0];
    const retrieved = sw.getPendingEditMeta(editId);
    expect(retrieved).toEqual(meta);
  });

  it('returns undefined after confirmEdit (entry deleted)', () => {
    const sw = new SafeWriter();
    const meta = { operation: 'create_project', project_id: 'P001', prefix: 'CM' };
    sw.proposeEdit('/tmp/test-meta2.md', '# content', 'trigger', 'sess1', meta);
    const editId = [...(sw as unknown as { pendingEdits: Map<string, unknown> }).pendingEdits.keys()][0];
    sw.confirmEdit(editId, 'cancel');
    expect(sw.getPendingEditMeta(editId)).toBeUndefined();
  });
});
