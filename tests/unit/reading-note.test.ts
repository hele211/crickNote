import { describe, expect, it } from 'vitest';
import {
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasMeaningfulReadingBody,
  normalizeReadingSources,
  normalizeDoi,
  readingSourcesEqual,
  slugifyReadingTitle,
} from '../../src/knowledge/reading-note.js';

describe('reading-note helpers', () => {
  it('slugifyReadingTitle produces a stable ASCII-safe slug', () => {
    expect(slugifyReadingTitle('Muller & Garcia: IL-42 / beta?')).toBe('muller-garcia-il-42-beta');
  });

  it('normalizeReadingSources deduplicates equivalent paths', () => {
    expect(
      normalizeReadingSources([
        { type: 'notes', path: './notes.md' },
        { type: 'notes', path: 'notes.md' },
        { type: 'pdf', path: 'paper.pdf' },
      ])
    ).toEqual([
      { type: 'notes', path: 'notes.md' },
      { type: 'pdf', path: 'paper.pdf' },
    ]);
  });

  it('normalizeReadingSources rejects invalid paths cleanly', () => {
    expect(() => normalizeReadingSources([{ type: 'pdf', path: '../paper.pdf' }]))
      .toThrow('relative to the attachment folder');
  });

  it('buildCreateReadingBody returns the CREATE scaffold without legacy sections', () => {
    const body = buildCreateReadingBody({ title: 'IL-42 mediated suppression' });
    expect(body).toContain('# IL-42 mediated suppression');
    expect(body).toContain('## Claims');
    expect(body).toContain('## Reasoning');
    expect(body).toContain('## Evidence');
    expect(body).toContain('## Assumptions');
    expect(body).toContain('## Takeaways');
    expect(body).toContain('## Extensions');
    expect(body).not.toContain('## Summary');
    expect(body).not.toContain('## Key Findings');
    expect(body).not.toContain('## Notes');
  });

  it('buildReadingFrontmatter preserves user fields and defaults reading workflow status', () => {
    const frontmatter = buildReadingFrontmatter(
      {
        title: 'IL-42 mediated suppression',
        authors: ['Alice Smith'],
        year: 2026,
        journal: 'Nature Immunology',
      },
      [{ type: 'notes', path: 'notes.md' }],
      {
        related_projects: ['P001'],
        custom_field: 'keep-me',
        status: 'complete',
        kb_status: 'mapped',
      }
    );

    expect(frontmatter).toMatchObject({
      title: 'IL-42 mediated suppression',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      status: 'complete',
      kb_status: 'mapped',
      related_projects: ['P001'],
      custom_field: 'keep-me',
      sources: [{ type: 'notes', path: 'notes.md' }],
    });
    expect(frontmatter.tags).toEqual(['reading']);
    expect(typeof frontmatter.read_date).toBe('string');
  });

  it('hasMeaningfulReadingBody distinguishes a blank CREATE scaffold from filled content', () => {
    expect(hasMeaningfulReadingBody(buildCreateReadingBody({ title: 'IL-42 mediated suppression' }))).toBe(false);
    expect(hasMeaningfulReadingBody('# IL-42 mediated suppression\n\n## Claims\n\nFilled claim.\n')).toBe(true);
  });
});

describe('hasMeaningfulReadingBody — custom template sections', () => {
  it('returns false for a note with only the 6 CREATE headings and no content', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });

  it('returns false for a note with custom headings and no content below them', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n## Methods Notes\n## Lab Protocol\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });

  it('returns true when any section has content', () => {
    const body = `\n# Some Paper\n\n## Claims\nThis paper claims IL-42 suppresses inflammation.\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(true);
  });

  it('returns true for a custom heading with content', () => {
    const body = `\n# Some Paper\n\n## Claims\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n## Methods Notes\nWestern blot protocol used.\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(true);
  });

  it('ignores HTML comments when evaluating content', () => {
    const body = `\n# Some Paper\n\n## Claims\n<!-- placeholder -->\n## Reasoning\n## Evidence\n## Assumptions\n## Takeaways\n## Extensions\n`;
    expect(hasMeaningfulReadingBody(body)).toBe(false);
  });
});

describe('readingSourcesEqual (order-insensitive)', () => {
  it('treats reordered identical sources as equal', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }, { type: 'notes' as const, path: 'abstract.md' }];
    const b = [{ type: 'notes' as const, path: 'abstract.md' }, { type: 'pdf' as const, path: 'paper.pdf' }];
    expect(readingSourcesEqual(a, b)).toBe(true);
  });

  it('detects genuinely different sources', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }];
    const b = [{ type: 'notes' as const, path: 'abstract.md' }];
    expect(readingSourcesEqual(a, b)).toBe(false);
  });

  it('treats different lengths as unequal', () => {
    const a = [{ type: 'pdf' as const, path: 'paper.pdf' }];
    const b = [{ type: 'pdf' as const, path: 'paper.pdf' }, { type: 'notes' as const, path: 'notes.md' }];
    expect(readingSourcesEqual(a, b)).toBe(false);
  });
});

describe('normalizeDoi', () => {
  it('lowercases the input', () => {
    expect(normalizeDoi('10.1016/J.Cell')).toBe('10.1016/j.cell');
  });

  it('strips https://doi.org/ prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1016/j.cell.2026.01.001')).toBe('10.1016/j.cell.2026.01.001');
  });

  it('strips http://doi.org/ prefix', () => {
    expect(normalizeDoi('http://doi.org/10.1016/j.cell')).toBe('10.1016/j.cell');
  });

  it('handles mixed case with prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1016/J.Cell.2026')).toBe('10.1016/j.cell.2026');
  });

  it('returns bare DOI unchanged (already normalized)', () => {
    expect(normalizeDoi('10.1016/j.cell')).toBe('10.1016/j.cell');
  });
});
