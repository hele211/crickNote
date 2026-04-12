import fs from 'node:fs';
import path from 'node:path';
import { resolveVaultPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

const log = logger.child('source-loader');

const PER_SOURCE_TOKEN_CAP = 10_000;
const SESSION_TOKEN_CAP = 30_000;
const CHARS_PER_TOKEN = 4;

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
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function extractPdf(absPath: string): Promise<string> {
  // Dynamic import so servers without pdf-parse installed still start
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = fs.readFileSync(absPath);
  const data = await pdfParse(buffer, { max: 20 });
  return data.text;
}

const TYPE_PRIORITY: Record<string, number> = {
  notes: 0,
  pdf: 1,
  notebooklm: 2,
  web: 3,
  other: 4,
};

export async function loadSources(
  sources: Array<{ type: string; path: string }>,
  sourceSlug: string,
  vaultPath: string
): Promise<SourceLoadResult> {
  const loaded: LoadedSource[] = [];
  const warnings: string[] = [];
  let totalTokens = 0;

  const sortedSources = [...sources].sort(
    (a, b) => (TYPE_PRIORITY[a.type] ?? 99) - (TYPE_PRIORITY[b.type] ?? 99)
  );

  for (const src of sortedSources) {
    if (totalTokens >= SESSION_TOKEN_CAP) {
      warnings.push(`Session cap (${SESSION_TOKEN_CAP} tokens) reached — remaining sources skipped. Consolidate key points into fewer source files.`);
      break;
    }

    const ext = path.extname(src.path).toLowerCase();

    if (UNSUPPORTED_EXTS.has(ext)) {
      const kind = ext === '.xlsx' || ext === '.csv' ? 'spreadsheet' : 'image';
      warnings.push(`Cannot read ${kind} "${src.path}" — paste key data into a .md source file.`);
      continue;
    }

    // Reject paths that escape the attachment folder
    const normalizedSrcPath = path.normalize(src.path);
    if (normalizedSrcPath.startsWith('..') || path.isAbsolute(normalizedSrcPath)) {
      warnings.push(`Skipping "${src.path}" — source paths must be relative to the attachment folder.`);
      continue;
    }

    let absPath: string;
    try {
      absPath = resolveVaultPath(vaultPath, path.join('Reading', 'attachments', sourceSlug, src.path));
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
          warnings.push(`Session cap (${SESSION_TOKEN_CAP} tokens) reached — remaining sources skipped. Consolidate key points into fewer source files.`);
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

  return { sources: loaded, warnings, totalTokens };
}
