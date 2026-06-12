import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_search runs on BM25 + metadata only (no embedding model)', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sne-'));
    // Register experiment type so parseQuery can extract it from the query.
    db.prepare('INSERT INTO experiment_types (name, aliases) VALUES (?, ?)')
      .run('western-blot', JSON.stringify(['western blot', 'wb']));
    for (let i = 1; i <= 8; i++) {
      db.prepare('INSERT INTO note_metadata (path, folder, note_type, experiment_type, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`Projects/wb${i}.md`, 'Projects', 'experiment', 'western-blot', `h${i}`, 1, 1);
      db.prepare('INSERT INTO note_chunks (path, chunk_index, start_offset, end_offset, content) VALUES (?, ?, ?, ?, ?)')
        .run(`Projects/wb${i}.md`, 0, 0, 20, `western blot data ${i}`);
    }
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('returns matches without any embedding step', async () => {
    const tools = createSearchTools(db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const res = JSON.parse(await tool.execute({ query: 'western blot' }));
    expect(res.results.length).toBeGreaterThan(0);
  });
});
