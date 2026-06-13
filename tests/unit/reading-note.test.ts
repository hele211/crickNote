import { describe, expect, it } from 'vitest';
import {
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasFigureMapHeading,
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

  it('buildCreateReadingBody returns the CREATE scaffold with Figure Map before Claims', () => {
    const body = buildCreateReadingBody({ title: 'IL-42 mediated suppression' });
    expect(body).toContain('# IL-42 mediated suppression');
    expect(body).toContain('## Figure Map');
    expect(body).toContain('## Claims');
    expect(body).toContain('## Reasoning');
    expect(body).toContain('## Evidence');
    expect(body).toContain('## Assumptions');
    expect(body).toContain('## Takeaways');
    expect(body).toContain('## Extensions');
    // Figure Map must appear before Claims
    expect(body.indexOf('## Figure Map')).toBeLessThan(body.indexOf('## Claims'));
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

describe('hasFigureMapHeading', () => {
  it('returns true when ## Figure Map heading is present', () => {
    expect(hasFigureMapHeading('## Figure Map\n\n| Fig | What | Significance |\n')).toBe(true);
  });

  it('returns false when heading is absent', () => {
    expect(hasFigureMapHeading('## Claims\n## Reasoning\n## Evidence\n')).toBe(false);
  });

  it('does not match a heading that only starts with the words', () => {
    expect(hasFigureMapHeading('## Figure Mapping Strategy\n')).toBe(false);
  });

  it('matches with trailing whitespace on the heading line', () => {
    expect(hasFigureMapHeading('## Figure Map   \n')).toBe(true);
  });

  it('returns true for the scaffold produced by buildCreateReadingBody', () => {
    expect(hasFigureMapHeading(buildCreateReadingBody({ title: 'Test Paper' }))).toBe(true);
  });
});
