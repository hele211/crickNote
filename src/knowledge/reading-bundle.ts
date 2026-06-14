import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeReadingSourcePath,
  normalizeReadingSources,
  type ReadingSourceInput,
  type ReadingSourceType,
} from './reading-note.js';
import { resolveVaultPath } from '../utils/paths.js';

export interface DiscoveredBundleFile {
  path: string;
  type: ReadingSourceType;
  readable: boolean;
}

export interface BundleDiscoveryResult {
  slug: string;
  folderExists: boolean;
  bundlePath: string;
  discoveredFiles: DiscoveredBundleFile[];
  recommendedSources: ReadingSourceInput[];
  warnings: string[];
}

const TEXT_SOURCE_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Dotfiles are never reading sources: this covers OS cruft (.DS_Store) and CrickNote's
 * own bundle markers (.zotero-bundle), so discovery doesn't warn about files it created.
 */
function isIgnoredBundleFile(fileName: string): boolean {
  return fileName.startsWith('.');
}

function classifyBundleFile(fileName: string): { type: ReadingSourceType; readable: boolean } {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);

  if (ext === '.pdf') {
    return { type: 'pdf', readable: true };
  }

  if (TEXT_SOURCE_EXTENSIONS.has(ext)) {
    if (lower.includes('notebooklm')) {
      return { type: 'notebooklm', readable: true };
    }
    if (lower.includes('web')) {
      return { type: 'web', readable: true };
    }
    return { type: 'notes', readable: true };
  }

  return { type: 'other', readable: false };
}

/**
 * Inspect <attachmentsDir>/<slug>/ (default Reading/attachments/) and recommend
 * readable source files. Shared by discover_reading_bundle,
 * ingest_reading_bundle, and the defensive source auto-discovery in
 * create_reading_note. `attachmentsDir` mirrors config.zotero.vault_pdf_dir so a
 * Zotero-prepared bundle is discovered at the same path it was written to.
 */
export function discoverBundle(
  vaultPath: string,
  slug: string,
  attachmentsDir = 'Reading/attachments'
): BundleDiscoveryResult {
  const bundleRel = path.join(attachmentsDir, slug);
  const bundlePath = resolveVaultPath(vaultPath, bundleRel);
  const warnings: string[] = [];

  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
    return {
      slug,
      folderExists: false,
      bundlePath,
      discoveredFiles: [],
      recommendedSources: [],
      warnings: [`Reading bundle not found: ${bundleRel}`],
    };
  }

  const discoveredFiles: DiscoveredBundleFile[] = [];

  for (const entry of fs.readdirSync(bundlePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnoredBundleFile(entry.name)) {
      continue;
    }

    if (!entry.isFile()) {
      warnings.push(`Skipping non-file bundle entry "${entry.name}".`);
      continue;
    }

    const relativePath = normalizeReadingSourcePath(entry.name);
    const classified = classifyBundleFile(relativePath);
    discoveredFiles.push({
      path: relativePath,
      type: classified.type,
      readable: classified.readable,
    });

    if (!classified.readable) {
      warnings.push(`Unsupported bundle file "${relativePath}" — only .pdf, .md, and .txt are used for reading intake.`);
    }
  }

  const recommendedSources = normalizeReadingSources(
    discoveredFiles
      .filter((file) => file.readable)
      .map((file) => ({ type: file.type, path: file.path }))
  );

  const pdfCount = discoveredFiles.filter((file) => file.type === 'pdf' && file.readable).length;
  if (pdfCount > 1) {
    warnings.push(`Multiple PDF files found in ${bundleRel}; review the recommended sources before ingesting.`);
  }

  if (recommendedSources.length === 0) {
    warnings.push(`Reading bundle "${slug}" has no readable source files yet.`);
  }

  return {
    slug,
    folderExists: true,
    bundlePath,
    discoveredFiles,
    recommendedSources,
    warnings,
  };
}
