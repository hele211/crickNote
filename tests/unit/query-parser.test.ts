import { describe, it, expect } from 'vitest';
import { parseQuery, type ParserContext } from '../../src/retrieval/query-parser.js';

/**
 * Shared context for all query-parser tests.
 * Uses a fixed referenceDate so date-relative queries are deterministic.
 */
const ctx: ParserContext = {
  experimentTypes: [
    { name: 'western-blot', aliases: ['WB', 'Western Blot', 'western'] },
    { name: 'pcr', aliases: ['PCR', 'qPCR', 'RT-PCR'] },
    { name: 'flow-cytometry', aliases: ['FACS', 'flow'] },
  ],
  projectNames: [
    'ProjectA-CellMigration',
    'ProjectB-Apoptosis',
  ],
  // Wednesday 2026-03-25
  referenceDate: new Date('2026-03-25T12:00:00'),
};

describe('parseQuery', () => {
  it('"last Tuesday" resolves to the correct ISO date', () => {
    const result = parseQuery('last Tuesday', ctx);
    // Last Tuesday relative to Wed 2026-03-25 is 2026-03-24
    expect(result.date).toBe('2026-03-24');
  });

  it('"2 weeks ago" produces a date (single or range)', () => {
    const result = parseQuery('2 weeks ago', ctx);
    // chrono-node treats "2 weeks ago" as a single point in time
    // 2 weeks before 2026-03-25 is 2026-03-11
    const expected = '2026-03-11';
    if (result.date) {
      expect(result.date).toBe(expected);
    } else if (result.dateRange) {
      expect(result.dateRange.start).toBe(expected);
    } else {
      throw new Error('Expected date or dateRange to be set');
    }
  });

  it('"Western Blot" matches the western-blot experiment type', () => {
    const result = parseQuery('Western Blot', ctx);
    expect(result.experimentType).toBe('western-blot');
  });

  it('"WB" matches western-blot via alias', () => {
    const result = parseQuery('WB', ctx);
    expect(result.experimentType).toBe('western-blot');
  });

  it('combined query extracts multiple filters', () => {
    // Separate project and experiment type with stop words so the ngram
    // matcher does not greedily consume the project token.
    const result = parseQuery('show me WB results for ProjectA-CellMigration from March 24', ctx);
    expect(result.experimentType).toBe('western-blot');
    expect(result.project).toBe('ProjectA-CellMigration');
    // chrono should extract a date from "March 24"
    expect(result.date !== null || result.dateRange !== null).toBe(true);
  });

  it('ambiguous input returns null for experiment type', () => {
    // Use words that are long enough to avoid false Levenshtein matches
    // against short aliases like "WB", "flow", "FACS"
    const result = parseQuery('that particular analysis yesterday', ctx);
    expect(result.experimentType).toBeNull();
  });

  it('remaining words become keywords (stop words removed)', () => {
    const result = parseQuery('show me transfection assay results', ctx);
    // "show", "me", "results" are stop words; "transfection" and "assay" should remain
    expect(result.keywords).toContain('transfection');
    expect(result.keywords).toContain('assay');
    expect(result.keywords).not.toContain('show');
    expect(result.keywords).not.toContain('me');
    expect(result.keywords).not.toContain('results');
  });
});
