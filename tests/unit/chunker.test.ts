import { describe, it, expect } from 'vitest';
import { chunkText, estimateTokens } from '../../src/ingestion/chunker.js';

describe('chunkText', () => {
  it('returns a single chunk for short text (< 512 tokens)', () => {
    const text = 'Just a brief paragraph of text about an experiment.\n';
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[0].content).toContain('brief paragraph');
  });

  it('returns multiple chunks for long text with correct offsets', () => {
    // Build text that exceeds 2048 chars with paragraph breaks.
    // Start with a leading newline to avoid the zero-width lookahead issue
    // in splitIntoSegments when text starts at a heading.
    const paragraphs: string[] = [''];
    for (let i = 0; i < 20; i++) {
      paragraphs.push(
        `This is paragraph ${i} with enough content to accumulate into multiple chunks. ` +
        `We include some filler text to ensure we exceed the 2048-character target per chunk. ` +
        `The chunker should split at paragraph boundaries rather than mid-sentence.`,
      );
    }
    const text = paragraphs.join('\n\n');

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);

    // Verify chunk indices are sequential
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }

    // Verify offsets are non-decreasing and within bounds
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].startOffset).toBeGreaterThanOrEqual(0);
      expect(chunks[i].endOffset).toBeGreaterThan(chunks[i].startOffset);
      expect(chunks[i].endOffset).toBeLessThanOrEqual(text.length);
    }

    // Verify every chunk has non-empty content
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(chunkText('   \n\n  \t  ')).toEqual([]);
  });

  it('splits at paragraph boundaries for large text', () => {
    // Two large paragraphs separated by blank lines, exceeding chunk target
    const para1 = 'First paragraph content. ' + 'A'.repeat(1500);
    const para2 = 'Second paragraph content. ' + 'B'.repeat(1500);
    const text = para1 + '\n\n' + para2 + '\n';

    const chunks = chunkText(text);

    // Should split into at least 2 chunks at the paragraph boundary
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // First chunk should contain first paragraph
    expect(chunks[0].content).toContain('First paragraph');
    // Last chunk should contain second paragraph
    expect(chunks[chunks.length - 1].content).toContain('Second paragraph');
  });
});

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    const text = 'A'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it('rounds up partial tokens', () => {
    const text = 'A'.repeat(5); // 5/4 = 1.25 -> 2
    expect(estimateTokens(text)).toBe(2);
  });
});
