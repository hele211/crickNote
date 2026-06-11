import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseNote } from './parser.js';
import { chunkText } from './chunker.js';
import { indexNote, deleteNote, needsReindex } from './indexer.js';
import { shouldIgnoreIngestionPath } from './ignore.js';
import { resolveVaultPath } from '../utils/paths.js';

export type IndexOutcome = 'indexed' | 'skipped' | 'unchanged' | 'gone';

/**
 * Index a single note by its vault-relative path, writing BM25 + metadata only
 * (no embeddings — empty embeddings array means indexNote skips the embedding
 * insert while still populating chunks and BM25). Safe to call in a short-lived
 * CLI process: no model load, no watcher.
 */
export function indexFileSync(relativePath: string, vaultRoot: string, db?: Database.Database): IndexOutcome {
  if (shouldIgnoreIngestionPath(relativePath)) return 'skipped';

  let absolutePath: string;
  try {
    absolutePath = resolveVaultPath(vaultRoot, relativePath);
  } catch {
    return 'skipped';
  }

  let content: string;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return 'skipped';
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    deleteNote(relativePath, db);
    return 'gone';
  }

  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  if (!needsReindex(relativePath, contentHash, db)) return 'unchanged';

  const parsed = parseNote(relativePath, content);
  const chunks = chunkText(parsed.body);
  indexNote({ note: parsed, contentHash, mtime: stat.mtimeMs, chunks, embeddings: [] }, db);
  return 'indexed';
}

/**
 * Recursively list markdown files under vaultRoot, returning vault-relative
 * POSIX paths. Skips dot-directories (e.g. .obsidian, .git) and non-.md files.
 */
export function listMarkdownFiles(vaultRoot: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relPath);
      }
    }
  };
  walk(vaultRoot, '');
  return out;
}
