import type Database from 'better-sqlite3';

export function applyMigration003(db: Database.Database): void {
  // ALTER TABLE must run outside transaction in SQLite
  for (const [col, type] of [
    ['kb_status', 'TEXT'],
    ['knowledge_kind', 'TEXT'],
    ['needs_review', 'INTEGER DEFAULT 0'],
    ['review_flagged_at', 'TEXT'],
    ['aliases', 'TEXT'],
    ['rq_source', 'TEXT'],
    ['rq_target', 'TEXT'],
  ] as Array<[string, string]>) {
    try { db.exec(`ALTER TABLE note_metadata ADD COLUMN ${col} ${type};`); }
    catch (e) { if (!(e as Error).message.includes('duplicate column name')) throw e; }
  }

  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_note_metadata_kb_status
        ON note_metadata(kb_status);
      CREATE INDEX IF NOT EXISTS idx_note_metadata_needs_review
        ON note_metadata(needs_review);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(3, Date.now());
  })();
}
