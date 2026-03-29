/**
 * Approximate token count. Heuristic: 1 token ~= 4 characters.
 */
const CHARS_PER_TOKEN = 4;

/** Target chunk size in tokens. */
const TARGET_CHUNK_TOKENS = 512;

/** Target chunk size in characters. */
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;

export interface TextChunk {
  /** 0-based chunk index */
  chunkIndex: number;
  /** Character offset in the original text where this chunk starts */
  startOffset: number;
  /** Character offset in the original text where this chunk ends (exclusive) */
  endOffset: number;
  /** The chunk text content */
  content: string;
}

/**
 * Split a block of text at heading or blank-line boundaries.
 * Returns segments with their start offsets in the original text.
 */
function splitIntoSegments(text: string): Array<{ content: string; startOffset: number }> {
  const segments: Array<{ content: string; startOffset: number }> = [];

  // Split on headings (lines starting with #) or double newlines (paragraph breaks)
  const pattern = /^#{1,6}\s/gm;
  const parts: Array<{ content: string; startOffset: number }> = [];
  let lastIndex = 0;

  // First split by headings
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        content: text.slice(lastIndex, match.index),
        startOffset: lastIndex,
      });
    }
    lastIndex = match.index;
  }
  if (lastIndex < text.length) {
    parts.push({
      content: text.slice(lastIndex),
      startOffset: lastIndex,
    });
  }

  // Further split each heading-section by double newlines (paragraphs)
  for (const part of parts) {
    const paragraphPattern = /\n\s*\n/g;
    let pLastIndex = 0;
    let pMatch: RegExpExecArray | null;

    while ((pMatch = paragraphPattern.exec(part.content)) !== null) {
      const endOfParagraph = pMatch.index + pMatch[0].length;
      const content = part.content.slice(pLastIndex, endOfParagraph);
      if (content.trim().length > 0) {
        segments.push({
          content,
          startOffset: part.startOffset + pLastIndex,
        });
      }
      pLastIndex = endOfParagraph;
    }

    if (pLastIndex < part.content.length) {
      const content = part.content.slice(pLastIndex);
      if (content.trim().length > 0) {
        segments.push({
          content,
          startOffset: part.startOffset + pLastIndex,
        });
      }
    }
  }

  return segments;
}

/**
 * Split note content into approximately 512-token chunks.
 *
 * Strategy:
 * 1. Split text into segments at heading/paragraph boundaries
 * 2. Accumulate segments into chunks until target size (~512 tokens / ~2048 chars)
 * 3. If a single segment exceeds target, include it as its own chunk
 *
 * @param text The full markdown body (without frontmatter)
 * @returns Array of text chunks with positional metadata
 */
export function chunkText(text: string): TextChunk[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const segments = splitIntoSegments(text);

  if (segments.length === 0) {
    return [{
      chunkIndex: 0,
      startOffset: 0,
      endOffset: text.length,
      content: text,
    }];
  }

  const chunks: TextChunk[] = [];
  let currentContent = '';
  let currentStartOffset = segments[0].startOffset;
  let currentEndOffset = segments[0].startOffset;

  for (const segment of segments) {
    const combinedLength = currentContent.length + segment.content.length;

    if (currentContent.length === 0) {
      // Start a new chunk
      currentContent = segment.content;
      currentStartOffset = segment.startOffset;
      currentEndOffset = segment.startOffset + segment.content.length;
    } else if (combinedLength <= TARGET_CHUNK_CHARS) {
      // Accumulate into current chunk
      currentContent += segment.content;
      currentEndOffset = segment.startOffset + segment.content.length;
    } else {
      // Current chunk is full enough — finalize it
      chunks.push({
        chunkIndex: chunks.length,
        startOffset: currentStartOffset,
        endOffset: currentEndOffset,
        content: currentContent,
      });

      // Start new chunk with this segment
      currentContent = segment.content;
      currentStartOffset = segment.startOffset;
      currentEndOffset = segment.startOffset + segment.content.length;
    }
  }

  // Don't forget the last chunk
  if (currentContent.length > 0) {
    chunks.push({
      chunkIndex: chunks.length,
      startOffset: currentStartOffset,
      endOffset: currentEndOffset,
      content: currentContent,
    });
  }

  return chunks;
}

/**
 * Estimate the token count for a text string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
