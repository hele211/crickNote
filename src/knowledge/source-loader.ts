import fs from 'node:fs';
import path from 'node:path';
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
// a 29k-token paper was being cut off mid-Results. Pagination (offset/maxTokens)
// handles papers that exceed even this.
const SESSION_TOKEN_CAP = 50_000;
const PER_SOURCE_TOKEN_CAP = SESSION_TOKEN_CAP;
const CHARS_PER_TOKEN = 4;

// Content can fit under the 50k internal cap (truncated:false) yet still be large
// enough that the serialized tool response is clipped by the agent-bridge stdout
// transport — silently dropping Results/Discussion. A ~29.5k-token (~118 KB) paper
// was observed to clip, so flag at 96 KB (~24k tokens) to leave headroom. Heuristic,
// not a hard limit: it sets transportRisk so callers see the risk beside truncated:false.
const TRANSPORT_SAFE_BYTES = 96_000;

const UNSUPPORTED_EXTS = new Set(['.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export interface LoadedSource {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SourceLoadResult {
  sources: LoadedSource[];
  warnings: string[];
  totalTokens: number;
  /** True when loaded content is large enough that the serialized response may be clipped in transport. */
  transportRisk: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Join per-page PDF text with `--- page N ---` boundary markers (1-indexed). */
export function joinPdfPages(pages: string[]): string {
  return pages.map((text, i) => `--- page ${i + 1} ---\n${text}`).join('\n\n');
}

async function extractPdf(absPath: string): Promise<string> {
  // Dynamic import so environments without pdf-parse installed still start
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = fs.readFileSync(absPath);
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
  return joinPdfPages(pages);
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
  attachmentsDir = 'Reading/attachments'
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

  const sortedSources = [...validSources].sort(
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
      if (ext === '.pdf') {
        rawText = await extractPdf(absPath);
      } else {
        rawText = fs.readFileSync(absPath, 'utf-8');
      }

      const remaining = SESSION_TOKEN_CAP - totalTokens;
      const perSourceCap = Math.min(PER_SOURCE_TOKEN_CAP, remaining);
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
      loaded.push({ path: src.path, content: text, truncated });
      log.info('loaded source', { path: src.path, tokens, truncated });
    } catch (err) {
      warnings.push(`Failed to read "${src.path}": ${(err as Error).message}.`);
    }
  }

  const loadedBytes = loaded.reduce((sum, s) => sum + Buffer.byteLength(s.content, 'utf8'), 0);
  const transportRisk = loadedBytes > TRANSPORT_SAFE_BYTES;

  return { sources: loaded, warnings, totalTokens, transportRisk };
}
