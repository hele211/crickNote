import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  isReadingSourceType,
  normalizeReadingSourcePath,
  type ReadingSourceInput,
  type ReadingSourceType,
} from './reading-note.js';
import { resolveVaultPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const log = logger.child('source-loader');

// The session cap is the only governor: a single source may draw the entire
// budget (no artificial per-source ceiling below it). Raised from 10k/30k after
// a 29k-token paper was being cut off mid-Results. Explicit PDF page ranges and
// maxTokens keep individual tool responses below the transport ceiling.
const SESSION_TOKEN_CAP = 50_000;
const PER_SOURCE_TOKEN_CAP = SESSION_TOKEN_CAP;
const CHARS_PER_TOKEN = 4;

// The CLI/agent bridge can clip serialized JSON near 64 KB. PDF control characters
// expand to six-byte escape sequences, so raw text bytes are not a safe proxy for
// response size. Keep source JSON below 40 KB to leave room for metadata/envelopes.
const TRANSPORT_SAFE_SERIALIZED_BYTES = 40_000;
const RECOMMENDED_RANGE_SERIALIZED_BYTES = 32_000;

const UNSUPPORTED_EXTS = new Set(['.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface LoadedSource {
  path: string;
  content: string;
  truncated: boolean;
  pageCount?: number;
  pageStart?: number;
  pageEnd?: number;
  nextPage?: number;
}

export interface SourceLoadResult {
  sources: LoadedSource[];
  warnings: string[];
  totalTokens: number;
  /** True when loaded content is large enough that the serialized response may be clipped in transport. */
  transportRisk: boolean;
}

export interface SourceLoadOptions {
  sourcePath?: string;
  pageStart?: number;
  pageEnd?: number;
  maxTokens?: number;
}

export interface SourceInspection {
  path: string;
  type: ReadingSourceType;
  bytes: number;
  estimatedTokens: number;
  pageCount?: number;
  nonEmptyPages?: number;
  controlCharacterRatio?: number;
  figureCaptions?: Array<{ label: string; page: number }>;
  tableCaptions?: Array<{ label: string; page: number }>;
  supplementaryReferences?: string[];
  recommendedPageRanges?: Array<{ pageStart: number; pageEnd: number; estimatedTokens: number }>;
  warnings: string[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Join per-page PDF text with `--- page N ---` boundary markers (1-indexed). */
export function joinPdfPages(pages: string[], firstPage = 1): string {
  return pages.map((text, i) => `--- page ${i + firstPage} ---\n${text}`).join('\n\n');
}

async function parsePdfToPages(buffer: Buffer): Promise<string[]> {
  // Dynamic import so environments without pdf-parse installed still start
  const pdfParse = (await import('pdf-parse')).default;
  const pages: string[] = [];
  // Custom per-page render (mirrors pdf-parse's default item-join) so we can
  // insert page boundary markers — these help locate figures when drafting the
  // Figure Map. No content is removed.
  await pdfParse(buffer, {
    max: 80,
    pagerender: async (pageData: {
      getTextContent: (opts: object) => Promise<{ items: Array<{ str: string; transform: number[] }> }>;
    }) => {
      const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = '';
      for (const item of textContent.items) {
        if (lastY === item.transform[5] || lastY === undefined) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pages.push(text);
      return text;
    },
  });
  return pages;
}

/** Path of the cached extraction artifact written next to a PDF (paper.pdf -> paper.extracted.md). */
function extractionArtifactPath(pdfAbsPath: string): string {
  const dir = path.dirname(pdfAbsPath);
  const base = path.basename(pdfAbsPath, path.extname(pdfAbsPath));
  return path.join(dir, `${base}.extracted.md`);
}

/**
 * Serialize extracted pages to a human-readable, page-marked artifact stamped with
 * the source PDF's hash and page count, so it can be reused (and validated) later.
 */
export function serializeExtraction(pages: string[], sourceName: string, sha256: string): string {
  const body = pages.map((text, i) => `--- page ${i + 1} ---\n${text}`).join('\n');
  return `---\ncricknote_extract: true\nsource: ${sourceName}\nsource_sha256: ${sha256}\npage_count: ${pages.length}\n---\n${body}\n`;
}

/**
 * Reconstruct pages from an extraction artifact. Returns null — forcing a fresh
 * extraction — when the header is missing, the hash is stale, or the page count
 * does not reconcile with the markers (guards against a corrupted/edited artifact).
 */
export function parseExtraction(text: string, expectedSha256: string): string[] | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const [, header, body] = match;
  const sha = header.match(/^source_sha256:\s*(\S+)/m)?.[1];
  const count = Number(header.match(/^page_count:\s*(\d+)/m)?.[1]);
  if (sha !== expectedSha256 || !Number.isInteger(count)) return null;
  const pages = body.split(/^--- page \d+ ---\n/m).slice(1).map((p) => p.replace(/\n$/, ''));
  return pages.length === count ? pages : null;
}

/**
 * Extract a PDF's per-page text, caching the result in a `<name>.extracted.md`
 * artifact next to the PDF keyed by the PDF's content hash. Repeat reads — including
 * the separate CLI process spawned for each page range — reuse the artifact instead
 * of re-parsing. discoverBundle ignores the artifact so it is never read as a source.
 */
export async function extractPdfPages(absPath: string): Promise<string[]> {
  const buffer = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const artifactPath = extractionArtifactPath(absPath);

  if (fs.existsSync(artifactPath)) {
    try {
      const cached = parseExtraction(fs.readFileSync(artifactPath, 'utf-8'), sha256);
      if (cached) return cached;
    } catch {
      /* unreadable artifact — fall through and re-extract */
    }
  }

  const pages = await parsePdfToPages(buffer);
  // Only cache an extraction that produced text on at least one page. A degenerate
  // result (no text anywhere) is almost always a transient parse failure; caching it
  // would mask later successful reads of the same unchanged PDF.
  if (pages.some((p) => p.trim().length > 0)) {
    try {
      fs.writeFileSync(artifactPath, serializeExtraction(pages, path.basename(absPath), sha256), 'utf-8');
    } catch (err) {
      log.warn('extraction cache write failed', { path: artifactPath, error: (err as Error).message });
    }
  }
  return pages;
}

function normalizeCaptionLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^fig(?:ure)?s?\.?\s*/i, 'Fig. ')
    .replace(/^tables?\.?\s*/i, 'Table ')
    .replace(/^movies?\.?\s*/i, 'Movie ')
    .trim();
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels.map(normalizeCaptionLabel))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function findCaptionLabels(pageText: string, kind: 'figure' | 'table'): string[] {
  // Accept "Fig.", "Fig", and "Figure", and treat ".", "|" (Nature style), or ":"
  // as the caption delimiter after the number. The line-start anchor + trailing
  // delimiter keep in-text citations ("see Fig. 1 and ...") from matching.
  const pattern = kind === 'figure'
    ? /(?:^|\n)\s*(Fig(?:ure)?\.?\s*S?\d+)\s*[.|:]/gi
    : /(?:^|\n)\s*(Table\s*S?\d+)\s*[.|:]/gi;
  return [...pageText.matchAll(pattern)].map((match) => normalizeCaptionLabel(match[1]));
}

export function findSupplementaryReferences(text: string): string[] {
  const matches = text.match(/\b(?:fig(?:ure)?s?\.?\s*S\d+[A-Z]?|tables?\s*S\d+[A-Z]?|movies?\s*S\d+[A-Z]?)\b/gi) ?? [];
  return uniqueLabels(matches);
}

export function buildRecommendedPageRanges(pages: string[]): Array<{ pageStart: number; pageEnd: number; estimatedTokens: number }> {
  const ranges: Array<{ pageStart: number; pageEnd: number; estimatedTokens: number }> = [];
  let pageStart = 1;
  let tokenCount = 0;
  let serializedBytes = 0;

  pages.forEach((page, index) => {
    const pageTokens = estimateTokens(page);
    const pageSerializedBytes = Buffer.byteLength(JSON.stringify(`--- page ${index + 1} ---\n${page}`), 'utf8');
    if (tokenCount > 0 && serializedBytes + pageSerializedBytes > RECOMMENDED_RANGE_SERIALIZED_BYTES) {
      ranges.push({ pageStart, pageEnd: index, estimatedTokens: tokenCount });
      pageStart = index + 1;
      tokenCount = 0;
      serializedBytes = 0;
    }
    tokenCount += pageTokens;
    serializedBytes += pageSerializedBytes;
  });

  if (pages.length > 0) {
    ranges.push({ pageStart, pageEnd: pages.length, estimatedTokens: tokenCount });
  }
  return ranges;
}

export async function inspectSources(
  sources: Array<{ type: string; path: string }>,
  sourceSlug: string,
  vaultPath: string,
  attachmentsDir = 'Reading/attachments'
): Promise<{ sources: SourceInspection[]; warnings: string[] }> {
  const inspections: SourceInspection[] = [];
  const warnings: string[] = [];

  for (const src of sources) {
    if (!isReadingSourceType(src.type)) {
      warnings.push(`Skipping "${src.path}" - source type "${src.type}" is not supported.`);
      continue;
    }

    let normalizedPath: string;
    try {
      normalizedPath = normalizeReadingSourcePath(src.path);
    } catch (err) {
      warnings.push(`Skipping "${src.path}" - ${(err as Error).message}`);
      continue;
    }

    let absPath: string;
    try {
      absPath = resolveVaultPath(vaultPath, path.join(attachmentsDir, sourceSlug, normalizedPath));
    } catch {
      warnings.push(`Skipping "${src.path}" - path resolves outside vault.`);
      continue;
    }
    if (!fs.existsSync(absPath)) {
      warnings.push(`Source file not found: "${normalizedPath}".`);
      continue;
    }

    const sourceWarnings: string[] = [];
    const bytes = fs.statSync(absPath).size;
    const ext = path.extname(normalizedPath).toLowerCase();
    try {
      if (ext === '.pdf') {
        const pages = await extractPdfPages(absPath);
        const joined = pages.join('\n');
        const controlCharacters = (joined.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
        const controlCharacterRatio = joined.length > 0 ? controlCharacters / joined.length : 0;
        const figureCaptions = pages.flatMap((page, index) =>
          findCaptionLabels(page, 'figure').map((label) => ({ label, page: index + 1 }))
        );
        const tableCaptions = pages.flatMap((page, index) =>
          findCaptionLabels(page, 'table').map((label) => ({ label, page: index + 1 }))
        );
        const supplementaryReferences = findSupplementaryReferences(joined);
        const hasSupplementaryCaptions = [...figureCaptions, ...tableCaptions].some((caption) => /\bS\d+/i.test(caption.label));

        if (controlCharacterRatio > 0.002) {
          sourceWarnings.push(`PDF text extraction contains many control characters (${(controlCharacterRatio * 100).toFixed(2)}%); visually verify plots and labels.`);
        }
        if (supplementaryReferences.length > 0 && !hasSupplementaryCaptions) {
          sourceWarnings.push('The paper references supplementary figures/tables, but no supplementary captions were found in this PDF. Attach the supplement before mapping those items.');
        }

        inspections.push({
          path: normalizedPath,
          type: src.type,
          bytes,
          estimatedTokens: estimateTokens(joinPdfPages(pages)),
          pageCount: pages.length,
          nonEmptyPages: pages.filter((page) => page.trim().length > 0).length,
          controlCharacterRatio,
          figureCaptions,
          tableCaptions,
          supplementaryReferences,
          recommendedPageRanges: buildRecommendedPageRanges(pages),
          warnings: sourceWarnings,
        });
      } else {
        const text = fs.readFileSync(absPath, 'utf-8');
        inspections.push({
          path: normalizedPath,
          type: src.type,
          bytes,
          estimatedTokens: estimateTokens(text),
          warnings: sourceWarnings,
        });
      }
    } catch (err) {
      warnings.push(`Failed to inspect "${normalizedPath}": ${(err as Error).message}.`);
    }
  }

  return { sources: inspections, warnings };
}

const TYPE_PRIORITY: Record<ReadingSourceType, number> = {
  notes: 0,
  pdf: 1,
  notebooklm: 2,
  web: 3,
  other: 4,
};

export async function loadSources(
  sources: Array<{ type: string; path: string }>,
  sourceSlug: string,
  vaultPath: string,
  attachmentsDir = 'Reading/attachments',
  options: SourceLoadOptions = {}
): Promise<SourceLoadResult> {
  const loaded: LoadedSource[] = [];
  const warnings: string[] = [];
  let totalTokens = 0;
  let sessionCapWarningEmitted = false;
  const validSources: ReadingSourceInput[] = [];

  for (const src of sources) {
    if (!isReadingSourceType(src.type)) {
      warnings.push(`Skipping "${src.path}" — source type "${src.type}" is not supported.`);
      continue;
    }

    try {
      validSources.push({
        type: src.type,
        path: normalizeReadingSourcePath(src.path),
      });
    } catch (err) {
      warnings.push(`Skipping "${src.path}" — ${(err as Error).message}`);
    }
  }

  const selectedSources = options.sourcePath
    ? validSources.filter((source) => source.path === options.sourcePath)
    : validSources;
  if (options.sourcePath && selectedSources.length === 0) {
    warnings.push(`Source "${options.sourcePath}" is not listed in the reading note frontmatter.`);
  }

  const sortedSources = [...selectedSources].sort(
    (a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)
  );

  for (const src of sortedSources) {
    if (totalTokens >= SESSION_TOKEN_CAP) {
      if (!sessionCapWarningEmitted) {
        warnings.push(`Session cap (${SESSION_TOKEN_CAP} tokens) reached — remaining sources skipped. Consolidate key points into fewer source files.`);
        sessionCapWarningEmitted = true;
      }
      break;
    }

    const ext = path.extname(src.path).toLowerCase();

    if (UNSUPPORTED_EXTS.has(ext)) {
      const kind = ext === '.xlsx' || ext === '.csv' ? 'spreadsheet' : 'image';
      warnings.push(`Cannot read ${kind} "${src.path}" — paste key data into a .md source file.`);
      continue;
    }

    let absPath: string;
    try {
      absPath = resolveVaultPath(vaultPath, path.join(attachmentsDir, sourceSlug, src.path));
    } catch {
      warnings.push(`Skipping "${src.path}" — path resolves outside vault.`);
      continue;
    }

    if (!fs.existsSync(absPath)) {
      warnings.push(`Source file not found: "${src.path}" (expected at ${path.relative(vaultPath, absPath)}).`);
      continue;
    }

    try {
      let rawText: string;
      let pageMetadata: Pick<LoadedSource, 'pageCount' | 'pageStart' | 'pageEnd' | 'nextPage'> = {};
      if (ext === '.pdf') {
        const pages = await extractPdfPages(absPath);
        const pageStart = options.pageStart ?? 1;
        const pageEnd = options.pageEnd ?? pages.length;
        if (pageStart < 1 || pageEnd < pageStart || pageStart > pages.length) {
          warnings.push(`Skipping "${src.path}" - invalid page range ${pageStart}-${pageEnd} for a ${pages.length}-page PDF.`);
          continue;
        }
        const boundedPageEnd = Math.min(pageEnd, pages.length);
        rawText = joinPdfPages(pages.slice(pageStart - 1, boundedPageEnd), pageStart);
        pageMetadata = {
          pageCount: pages.length,
          pageStart,
          pageEnd: boundedPageEnd,
          nextPage: boundedPageEnd < pages.length ? boundedPageEnd + 1 : undefined,
        };
      } else {
        if (options.pageStart !== undefined || options.pageEnd !== undefined) {
          warnings.push(`Skipping "${src.path}" - page ranges can only be used with PDF sources.`);
          continue;
        }
        rawText = fs.readFileSync(absPath, 'utf-8');
      }

      const remaining = SESSION_TOKEN_CAP - totalTokens;
      const requestedCap = options.maxTokens ?? PER_SOURCE_TOKEN_CAP;
      const perSourceCap = Math.min(PER_SOURCE_TOKEN_CAP, remaining, requestedCap);
      const { text, truncated } = truncateToTokens(rawText, perSourceCap);
      const sessionCapHit = remaining < PER_SOURCE_TOKEN_CAP && truncated;

      if (truncated) {
        if (sessionCapHit) {
          warnings.push(`Source "${src.path}" truncated to ${perSourceCap} tokens due to session cap (original: ${estimateTokens(rawText)} tokens).`);
          if (!sessionCapWarningEmitted) {
            warnings.push(`Session cap (${SESSION_TOKEN_CAP} tokens) reached — remaining sources skipped. Consolidate key points into fewer source files.`);
            sessionCapWarningEmitted = true;
          }
        } else {
          warnings.push(`Source "${src.path}" truncated to ${perSourceCap} tokens (original: ${estimateTokens(rawText)} tokens).`);
        }
      }

      const tokens = estimateTokens(text);
      totalTokens += tokens;
      loaded.push({ path: src.path, content: text, truncated, ...pageMetadata });
      log.info('loaded source', { path: src.path, tokens, truncated });
    } catch (err) {
      warnings.push(`Failed to read "${src.path}": ${(err as Error).message}.`);
    }
  }

  const serializedSourceBytes = loaded.reduce(
    (sum, source) => sum + Buffer.byteLength(JSON.stringify(source.content), 'utf8'),
    0
  );
  const transportRisk = serializedSourceBytes > TRANSPORT_SAFE_SERIALIZED_BYTES;

  return { sources: loaded, warnings, totalTokens, transportRisk };
}
