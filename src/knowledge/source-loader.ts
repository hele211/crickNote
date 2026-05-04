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

export interface SourceResolveOptions {
  externalPdfRoots?: string[];
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

function pathInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

function realpathIfExists(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function normalizedExternalRoots(options: SourceResolveOptions): string[] {
  return (options.externalPdfRoots ?? [])
    .map((root) => realpathIfExists(root) ?? path.resolve(root))
    .filter((root) => root !== '/' && root.length > 1);
}

export function resolveReadingSourceFile(
  vaultPath: string,
  sourceSlug: string,
  sourcePath: string,
  options: SourceResolveOptions = {},
  bundleBaseDir = 'Reading/attachments'
): string {
  const relativeSource = normalizeReadingSourcePath(sourcePath);
  const relPath = path.join(bundleBaseDir, sourceSlug, relativeSource);

  let realVault: string;
  try {
    realVault = fs.realpathSync(vaultPath);
  } catch {
    realVault = path.resolve(vaultPath);
  }

  const absPath = path.resolve(realVault, relPath);
  if (!pathInside(absPath, realVault)) {
    throw new Error(`Path traversal rejected: "${relativeSource}" resolves outside the vault.`);
  }

  const realTarget = realpathIfExists(absPath);
  if (realTarget && !pathInside(realTarget, realVault)) {
    const ext = path.extname(relativeSource).toLowerCase();
    const allowedExternalRoot = ext === '.pdf'
      ? normalizedExternalRoots(options).find((root) => pathInside(realTarget, root))
      : undefined;

    if (!allowedExternalRoot) {
      throw new Error(`Path traversal rejected: "${relativeSource}" resolves outside the vault via a symlink.`);
    }
  }

  // Reuse the central resolver for normal vault-local sources and missing paths.
  if (!realTarget || pathInside(realTarget, realVault)) {
    return resolveVaultPath(vaultPath, relPath);
  }

  return absPath;
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
  options: SourceResolveOptions = {},
  bundleBaseDir = 'Reading/attachments'
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
      absPath = resolveReadingSourceFile(vaultPath, sourceSlug, src.path, options, bundleBaseDir);
    } catch (err) {
      warnings.push(`Skipping "${src.path}" — ${(err as Error).message}`);
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

  return { sources: loaded, warnings, totalTokens };
}
