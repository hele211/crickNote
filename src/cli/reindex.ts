import type Database from 'better-sqlite3';
import { loadConfig } from '../config/config.js';
import { getDatabase } from '../storage/database.js';
import { listMarkdownFiles, indexFileSync } from '../ingestion/index-file.js';
import { deleteStaleNotes } from '../ingestion/indexer.js';

export interface ReindexSummary {
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
}

/**
 * Full standalone reindex: BM25 + metadata for every markdown file in the
 * vault, no embeddings, no watcher. Removes DB rows for files that no longer
 * exist. Pure function over an injected db for testability.
 */
export function reindexVault(vaultRoot: string, db: Database.Database): ReindexSummary {
  const files = listMarkdownFiles(vaultRoot);
  const summary: ReindexSummary = { indexed: 0, unchanged: 0, skipped: 0, removed: 0 };
  const indexablePaths: string[] = [];

  for (const rel of files) {
    const outcome = indexFileSync(rel, vaultRoot, db);
    if (outcome === 'indexed') { summary.indexed++; indexablePaths.push(rel); }
    else if (outcome === 'unchanged') { summary.unchanged++; indexablePaths.push(rel); }
    else if (outcome === 'skipped') { summary.skipped++; }
  }

  const before = (db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number }).n;
  deleteStaleNotes(indexablePaths, db);
  const after = (db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number }).n;
  summary.removed = Math.max(0, before - after);

  return summary;
}

/** CLI entry point. */
export async function reindex(): Promise<void> {
  const config = loadConfig();
  const db = getDatabase();
  const vaultRoot = config.vaultPath;
  console.log(`Reindexing vault at ${vaultRoot} ...`);
  const summary = reindexVault(vaultRoot, db);
  console.log(`Done. indexed=${summary.indexed} unchanged=${summary.unchanged} skipped=${summary.skipped} removed=${summary.removed}`);
}
