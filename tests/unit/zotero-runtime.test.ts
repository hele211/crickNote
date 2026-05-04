import { describe, it, expect } from 'vitest';
import { SafeWriter } from '../../src/editing/safe-writer.js';

describe('runtime pending_edit meta passthrough', () => {
  it('generic meta fields survive proposeEdit → getPendingEditMeta', () => {
    const sw = new SafeWriter();
    const meta = {
      operation: 'create',
      path: '/vault/Reading/Papers/foo.md',
      zotero_slug: 'smith-2026-il42',
      zotero_files_created: ['paper.pdf'],
      note_rel_path: 'Reading/Papers/smith-2026-il42.md',
    };
    sw.proposeEdit('/vault/Reading/Papers/foo.md', '# content', 'trigger', 'sess1', meta);
    const editId = [...(sw as unknown as { pendingEdits: Map<string, unknown> }).pendingEdits.keys()][0];
    const retrieved = (sw as unknown as { getPendingEditMeta: (id: string) => Record<string, unknown> | undefined }).getPendingEditMeta?.(editId) ?? (sw as unknown as { pendingEdits: Map<string, { meta?: Record<string, unknown> }> }).pendingEdits.get(editId)?.meta;
    expect(retrieved?.zotero_slug).toBe('smith-2026-il42');
    expect(retrieved?.zotero_files_created).toEqual(['paper.pdf']);
    expect(retrieved?.note_rel_path).toBe('Reading/Papers/smith-2026-il42.md');
  });
});
