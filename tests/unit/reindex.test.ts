import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { reindexVault } from '../../src/cli/reindex.js';

describe('reindexVault', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reidx-')));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('indexes all markdown files and reports counts', () => {
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'IL001.md'), '---\nnote_kind: experiment\nid: IL001\n---\n\nbody one');
    fs.writeFileSync(path.join(vault, 'Projects', 'IL002.md'), '---\nnote_kind: experiment\nid: IL002\n---\n\nbody two');

    const summary = reindexVault(vault, db);
    expect(summary.indexed).toBe(2);

    const n = db.prepare('SELECT COUNT(*) AS n FROM note_metadata').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('removes stale rows for files no longer present', () => {
    db.prepare('INSERT INTO note_metadata (path, folder, note_type, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Projects/ghost.md', 'Projects', 'experiment', 'h', 1, 1);
    const summary = reindexVault(vault, db);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT path FROM note_metadata WHERE path = ?').get('Projects/ghost.md')).toBeUndefined();
  });
});
