import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexNote, deleteNote } from '../../src/ingestion/indexer.js';

describe('indexer — experiment_types counts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function indexExperiment(contentHash: string, experimentType = 'western-blot'): void {
    indexNote({
      note: {
        filePath: 'Projects/P001-CellMigration/CM001-western-blot.md',
        folder: 'Projects',
        noteType: 'experiment',
        frontmatter: {},
        body: '# Test',
        warnings: [],
        isValid: true,
        date: '2026-04-12',
        project: 'Cell Migration',
        experimentType,
      },
      contentHash,
      mtime: Date.now(),
      chunks: [],
    }, db);
  }

  it('does not increment count when the same experiment note is re-indexed', () => {
    indexExperiment('hash-1');
    indexExperiment('hash-2');

    const row = db.prepare('SELECT count FROM experiment_types WHERE name = ?')
      .get('western-blot') as { count: number };

    expect(row.count).toBe(1);
  });

  it('moves the count when an experiment changes type', () => {
    indexExperiment('hash-1', 'western-blot');
    indexExperiment('hash-2', 'qpcr');

    const rows = db.prepare('SELECT name, count FROM experiment_types ORDER BY name')
      .all() as Array<{ name: string; count: number }>;

    expect(rows).toEqual([{ name: 'qpcr', count: 1 }]);
  });

  it('removes the count when the note is deleted after re-indexing', () => {
    indexExperiment('hash-1');
    indexExperiment('hash-2');
    deleteNote('Projects/P001-CellMigration/CM001-western-blot.md', db);

    const rows = db.prepare('SELECT name, count FROM experiment_types').all();
    expect(rows).toEqual([]);
  });
});
