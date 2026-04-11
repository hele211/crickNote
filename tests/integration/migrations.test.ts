import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('database migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all expected tables on a fresh database', () => {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('note_metadata');
    expect(tableNames).toContain('note_chunks');
    expect(tableNames).toContain('chunk_embeddings');
    expect(tableNames).toContain('experiment_types');
    expect(tableNames).toContain('chat_sessions');
    expect(tableNames).toContain('chat_messages');
    expect(tableNames).toContain('edit_audit_log');
    expect(tableNames).toContain('indexing_status');
    expect(tableNames).toContain('workflow_events');
    expect(tableNames).toContain('prefix_reservations');
    expect(tableNames).toContain('serial_counters');
  });

  it('records schema_version correctly', () => {
    runMigrations(db);

    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(2);
    expect(row.v).toBeGreaterThan(0);
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    // Second run should not throw
    expect(() => runMigrations(db)).not.toThrow();

    const maxRow = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(maxRow.v).toBe(2);
  });

  it('creates expected indexes', () => {
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_note_metadata_date');
    expect(indexNames).toContain('idx_note_metadata_type');
    expect(indexNames).toContain('idx_note_metadata_project');
    expect(indexNames).toContain('idx_note_metadata_folder');
    expect(indexNames).toContain('idx_note_chunks_path');
    expect(indexNames).toContain('idx_chat_messages_session');
    expect(indexNames).toContain('idx_edit_audit_file');
  });

  it('creates the FTS5 virtual table for bm25_index', () => {
    runMigrations(db);

    const vtables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'")
      .all() as Array<{ name: string }>;

    // FTS5 tables may appear differently; check via direct query
    expect(() => {
      db.prepare('SELECT * FROM bm25_index LIMIT 0').all();
    }).not.toThrow();
  });
});
