import { describe, it, expect } from 'vitest';
import { shouldIgnoreIngestionPath } from '../../src/ingestion/worker.js';

describe('shouldIgnoreIngestionPath', () => {
  it('ignores markdown files under Reading attachments', () => {
    expect(shouldIgnoreIngestionPath('Reading/attachments/smith-2026/notes.md')).toBe(true);
  });

  it('ignores markdown files under project attachments', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/attachments/CM001/notes.md')).toBe(true);
  });

  it('ignores mapping artifacts stored alongside reading notes', () => {
    expect(shouldIgnoreIngestionPath('Reading/Papers/smith-2026-mapping.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/CM001-western-blot-mapping-20260412T104938.md')).toBe(true);
  });

  it('ignores KB housekeeping artifacts', () => {
    expect(shouldIgnoreIngestionPath('Knowledge/_Ops/Lint-Reports/2026-04-12.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_index.md')).toBe(true);
  });

  it('does not ignore real vault notes', () => {
    expect(shouldIgnoreIngestionPath('Reading/Papers/smith-2026.md')).toBe(false);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/il-42.md')).toBe(false);
  });

  it('ignores _changelog.md files in any content folder', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/_changelog.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Reading/Papers/_changelog.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_changelog.md')).toBe(true);
  });
});
