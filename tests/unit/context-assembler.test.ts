import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleNoteContext } from '../../src/retrieval/context-assembler.js';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('assembleNoteContext path safety', () => {
  let db: Database.Database;
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-context-'));
    vaultPath = path.join(tmpDir, 'vault');
    fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'note.md'), '# Vault note\n', 'utf-8');

    db.prepare(`
      INSERT INTO note_metadata (
        path, folder, note_type, date, project, content_hash, mtime, last_indexed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Projects/note.md', 'Projects', 'experiment', '2026-05-06', 'P001', 'hash', 1000, 1000);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads vault-relative note paths', () => {
    const ctx = assembleNoteContext(db, 'Projects/note.md', { vaultPath });

    expect(ctx?.notePath).toBe('Projects/note.md');
    expect(ctx?.body).toContain('Vault note');
  });

  it('normalizes inside-vault absolute paths back to vault-relative paths', () => {
    const ctx = assembleNoteContext(db, path.join(vaultPath, 'Projects', 'note.md'), { vaultPath });

    expect(ctx?.notePath).toBe('Projects/note.md');
    expect(ctx?.body).toContain('Vault note');
  });

  it('rejects absolute paths outside the vault', () => {
    const outsidePath = path.join(tmpDir, 'outside.md');
    fs.writeFileSync(outsidePath, '# Outside\n', 'utf-8');

    expect(assembleNoteContext(db, outsidePath, { vaultPath })).toBeNull();
  });
});
