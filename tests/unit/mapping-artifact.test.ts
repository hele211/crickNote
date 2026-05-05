import { describe, it, expect } from 'vitest';
import { normalizeMappingSource } from '../../src/knowledge/mapping-artifact.js';

describe('normalizeMappingSource', () => {
  it('handles clean [[slug]] wikilink', () => {
    expect(normalizeMappingSource('[[smith-2026-il42]]')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles plain string slug', () => {
    expect(normalizeMappingSource('smith-2026-il42')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles nested array [["slug"]] (malformed old format)', () => {
    expect(normalizeMappingSource([['smith-2026-il42']])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles single-level array ["slug"]', () => {
    expect(normalizeMappingSource(['smith-2026-il42'])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('returns empty strings for null/undefined', () => {
    expect(normalizeMappingSource(null)).toEqual({ source: '', sourceSlug: '' });
    expect(normalizeMappingSource(undefined)).toEqual({ source: '', sourceSlug: '' });
  });
});
