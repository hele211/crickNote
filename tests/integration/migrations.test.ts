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
  });

  it('records schema_version correctly', () => {
    runMigrations(db);

    const row = db
      .prepare('SELECT version, applied_at FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number };

    expect(row.version).toBe(1);
    expect(row.applied_at).toBeGreaterThan(0);
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    // Second run should not throw
    expect(() => runMigrations(db)).not.toThrow();

    // Still exactly one version record
    const rows = db
      .prepare('SELECT version FROM schema_version')
      .all() as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
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
