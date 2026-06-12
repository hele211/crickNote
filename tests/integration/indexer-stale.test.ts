import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexNote, deleteStaleNotes, getIndexingStatus, updateIndexingStatus } from '../../src/ingestion/indexer.js';

function minNote(filePath: string) {
  return {
    note: {
      filePath,
      folder: 'Reading',
      noteType: 'reading' as const,
      isValid: true,
      warnings: [],
    },
    contentHash: 'abc',
    mtime: Date.now(),
    chunks: [],
  };
}

describe('deleteStaleNotes', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('removes rows for paths not in validPaths', () => {
    indexNote(minNote('Reading/Papers/a.md'), db);
    indexNote(minNote('Reading/Papers/b.md'), db);
    deleteStaleNotes(['Reading/Papers/a.md'], db);
    const rows = db.prepare('SELECT path FROM note_metadata').all() as Array<{ path: string }>;
    expect(rows.map(r => r.path)).toEqual(['Reading/Papers/a.md']);
  });

  it('does nothing when all DB paths are still valid', () => {
    indexNote(minNote('Reading/Papers/a.md'), db);
    indexNote(minNote('Reading/Papers/b.md'), db);
    deleteStaleNotes(['Reading/Papers/a.md', 'Reading/Papers/b.md'], db);
    const rows = db.prepare('SELECT path FROM note_metadata').all() as Array<{ path: string }>;
    expect(rows).toHaveLength(2);
  });

  it('removes all rows when validPaths is empty', () => {
    indexNote(minNote('Reading/Papers/a.md'), db);
    deleteStaleNotes([], db);
    const rows = db.prepare('SELECT path FROM note_metadata').all();
    expect(rows).toHaveLength(0);
  });
});

describe('getIndexingStatus', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('returns current state from indexing_status', () => {
    updateIndexingStatus('indexing', 20, 13, undefined, db);
    const status = getIndexingStatus(db);
    expect(status.state).toBe('indexing');
    expect(status.totalFiles).toBe(20);
    expect(status.indexedFiles).toBe(13);
  });
});
