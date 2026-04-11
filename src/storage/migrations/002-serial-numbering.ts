import type Database from 'better-sqlite3';

export function applyMigration002(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events_session ON workflow_events(session_id, id);
      CREATE TABLE IF NOT EXISTS prefix_reservations (
        prefix     TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        edit_id    TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS serial_counters (
        scope      TEXT PRIMARY KEY,
        next_val   INTEGER NOT NULL DEFAULT 1,
        project_id TEXT
      );
    `);
    db.exec(`INSERT OR IGNORE INTO serial_counters (scope, next_val, project_id) VALUES ('project', 1, NULL), ('protocol', 1, NULL);`);
    for (const [col, type] of [['note_id', 'TEXT'], ['series', 'TEXT'], ['project_id', 'TEXT'], ['last_session', 'TEXT']] as Array<[string, string]>) {
      try { db.exec(`ALTER TABLE note_metadata ADD COLUMN ${col} ${type};`); }
      catch (e) { if (!(e as Error).message.includes('duplicate column name')) throw e; }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_note_metadata_note_id ON note_metadata(note_id) WHERE note_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_note_metadata_series ON note_metadata(series);
      CREATE INDEX IF NOT EXISTS idx_note_metadata_project_id ON note_metadata(project_id);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, Date.now());
  })();
}
