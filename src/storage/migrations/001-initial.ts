import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  if (currentVersion < 1) {
    applyMigration001(db);
  }
}

function applyMigration001(db: Database.Database): void {
  db.transaction(() => {
    // --- DERIVED TABLES (rebuildable from vault) ---

    db.exec(`
      CREATE TABLE IF NOT EXISTS note_metadata (
        path TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        note_type TEXT NOT NULL,
        date TEXT,
        project TEXT,
        experiment_type TEXT,
        protocol_ref TEXT,
        status TEXT,
        tags JSON,
        result_summary TEXT,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        last_indexed INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS note_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL REFERENCES note_metadata(path) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES note_chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      );
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS bm25_index USING fts5(
        chunk_id,
        content
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS experiment_types (
        name TEXT PRIMARY KEY,
        aliases JSON NOT NULL DEFAULT '[]',
        count INTEGER NOT NULL DEFAULT 0
      );
    `);

    // --- DURABLE TABLES (app-owned state) ---

    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        metadata JSON
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls JSON,
        tool_call_id TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS edit_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        before_content TEXT,
        after_content TEXT,
        before_hash TEXT,
        after_hash TEXT,
        trigger_query TEXT,
        session_id TEXT
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS indexing_status (
        id INTEGER PRIMARY KEY DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'idle',
        total_files INTEGER NOT NULL DEFAULT 0,
        indexed_files INTEGER NOT NULL DEFAULT 0,
        last_full_index INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
    `);

    // Insert initial indexing status
    db.exec(`
      INSERT OR IGNORE INTO indexing_status (id, state, total_files, indexed_files, updated_at)
      VALUES (1, 'idle', 0, 0, ${Date.now()});
    `);

    // Indexes for common queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_metadata_date ON note_metadata(date);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_metadata_type ON note_metadata(experiment_type);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_metadata_project ON note_metadata(project);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_metadata_folder ON note_metadata(folder);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_chunks_path ON note_chunks(path);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edit_audit_file ON edit_audit_log(file_path);`);

    // Record migration
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, Date.now());
  })();
}
