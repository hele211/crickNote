import { describe, it, expect } from 'vitest';
import { shouldIgnoreIngestionPath } from '../../src/ingestion/ignore.js';

describe('shouldIgnoreIngestionPath', () => {
  it('ignores attachments', () => {
    expect(shouldIgnoreIngestionPath('Reading/attachments/smith-2026/paper.md')).toBe(true);
  });
  it('ignores mapping artifacts', () => {
    expect(shouldIgnoreIngestionPath('Reading/foo/foo-mapping.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001/P001-mapping-20260101T120000.md')).toBe(true);
  });
  it('ignores Knowledge ops and index files and changelogs', () => {
    expect(shouldIgnoreIngestionPath('Knowledge/_Ops/state.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_index.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001/_changelog.md')).toBe(true);
  });
  it('does not ignore a normal experiment note', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-il42/IL001-dose.md')).toBe(false);
  });
});
