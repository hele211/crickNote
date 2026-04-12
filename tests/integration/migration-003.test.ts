import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('migration 003 — knowledge base columns', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('adds 7 new columns to note_metadata', () => {
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(note_metadata)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const col of ['kb_status', 'knowledge_kind', 'needs_review', 'review_flagged_at', 'aliases', 'rq_source', 'rq_target']) {
      expect(names).toContain(col);
    }
  });

  it('creates kb_status and needs_review indexes', () => {
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_note_metadata_kb_status');
    expect(names).toContain('idx_note_metadata_needs_review');
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
