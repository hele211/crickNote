import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runMigrations } from './migrations/001-initial.js';

let db: Database.Database | null = null;

export function getDatabase(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? path.join(getDataDir(), 'db.sqlite');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function setDatabase(instance: Database.Database | null): void {
  db = instance;
}

export function getDataDir(): string {
  const configuredDir = process.env.CRICKNOTE_DATA_DIR?.trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  return path.join(os.homedir(), '.cricknote');
}
