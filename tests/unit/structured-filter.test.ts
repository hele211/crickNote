import { describe, it, expect } from 'vitest';
import { buildFilter } from '../../src/retrieval/structured-filter.js';

describe('buildFilter', () => {
  it('single date filter produces correct SQL and params', () => {
    const result = buildFilter({ date: '2026-03-24' });

    expect(result.sql).toContain('WHERE');
    expect(result.sql).toContain('nm.date = ?');
    expect(result.params).toEqual(['2026-03-24']);
  });

  it('date range produces BETWEEN clause', () => {
    const result = buildFilter({
      dateRange: { start: '2026-03-01', end: '2026-03-31' },
    });

    expect(result.sql).toContain('BETWEEN ? AND ?');
    expect(result.params).toEqual(['2026-03-01', '2026-03-31']);
  });

  it('multiple filters are combined with AND', () => {
    const result = buildFilter({
      date: '2026-03-24',
      experimentType: 'western-blot',
      project: 'ProjectA-CellMigration',
    });

    expect(result.sql).toContain('AND');
    expect(result.sql).toContain('nm.date = ?');
    expect(result.sql).toContain('nm.experiment_type = ?');
    expect(result.sql).toContain('nm.project = ?');
    expect(result.params).toEqual([
      '2026-03-24',
      'western-blot',
      'ProjectA-CellMigration',
    ]);
  });

  it('all null filters produce empty SQL and no params', () => {
    const result = buildFilter({
      date: null,
      dateRange: null,
      experimentType: null,
      project: null,
      folder: null,
      status: null,
      keywords: null,
    });

    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('empty input object produces empty SQL', () => {
    const result = buildFilter({});
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('values are parameterized, not interpolated into SQL', () => {
    const malicious = "'; DROP TABLE note_metadata; --";
    const result = buildFilter({ project: malicious });

    // The SQL should contain only placeholder ?, not the actual value
    expect(result.sql).not.toContain(malicious);
    expect(result.sql).toContain('?');
    expect(result.params).toContain(malicious);
  });

  it('keywords produce LIKE clauses for each keyword', () => {
    const result = buildFilter({ keywords: ['p53', 'migration'] });

    expect(result.sql).toContain('nm.result_summary LIKE ?');
    expect(result.sql).toContain('nm.tags LIKE ?');
    // Two keywords, each producing 2 params (result_summary + tags)
    expect(result.params).toEqual(['%p53%', '%p53%', '%migration%', '%migration%']);
  });
});
