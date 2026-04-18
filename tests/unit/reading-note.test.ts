import { describe, expect, it } from 'vitest';
import {
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasMeaningfulReadingBody,
  normalizeReadingSources,
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
