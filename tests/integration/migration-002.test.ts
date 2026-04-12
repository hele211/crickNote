// tests/integration/migration-002.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('migration 002 — serial numbering', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('creates serial_counters with scope, next_val, project_id', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(serial_counters)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('scope');
    expect(names).toContain('next_val');
    expect(names).toContain('project_id');
  });

  it('creates prefix_reservations table', () => {
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain('prefix_reservations');
  });

  it('creates workflow_events table with session index', () => {
    runMigrations(db);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map(i => i.name)).toContain('idx_workflow_events_session');
  });

  it('adds note_id, series, project_id, last_session to note_metadata', () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(note_metadata)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    ['note_id', 'series', 'project_id', 'last_session'].forEach(c => expect(names).toContain(c));
  });

  it('seeds project and protocol serial_counters', () => {
    runMigrations(db);
    const rows = db.prepare("SELECT scope FROM serial_counters").all() as Array<{ scope: string }>;
    expect(rows.map(r => r.scope)).toContain('project');
    expect(rows.map(r => r.scope)).toContain('protocol');
  });

  it('is idempotent — running migrations twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('latest schema_version is 3 after migrations', () => {
    runMigrations(db);
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(3);
  });
});
