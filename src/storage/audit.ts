import type Database from 'better-sqlite3';
import { getDatabase } from './database.js';

export interface AuditEntry {
  id: number;
  timestamp: number;
  file_path: string;
  operation: 'create' | 'update' | 'delete';
  before_content: string | null;
  after_content: string | null;
  before_hash: string | null;
  after_hash: string | null;
  trigger_query: string | null;
  session_id: string | null;
}

export function logEdit(entry: Omit<AuditEntry, 'id'>): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO edit_audit_log
      (timestamp, file_path, operation, before_content, after_content,
       before_hash, after_hash, trigger_query, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.timestamp,
    entry.file_path,
    entry.operation,
    entry.before_content,
    entry.after_content,
    entry.before_hash,
    entry.after_hash,
    entry.trigger_query,
    entry.session_id
  );
  return Number(result.lastInsertRowid);
}

export function getLastEdit(filePath: string): AuditEntry | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM edit_audit_log
    WHERE file_path = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(filePath) as AuditEntry | undefined;
}

export function getEditHistory(filePath: string, limit = 10): AuditEntry[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM edit_audit_log
    WHERE file_path = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(filePath, limit) as AuditEntry[];
}
