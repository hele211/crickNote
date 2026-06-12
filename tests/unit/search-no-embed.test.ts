import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import * as embedder from '../../src/ingestion/embedder.js';
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_search does not load the embedding model', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sne-'));
    // Register experiment type so parseQuery can extract it from the query.
    db.prepare('INSERT INTO experiment_types (name, aliases) VALUES (?, ?)')
      .run('western-blot', JSON.stringify(['western blot', 'wb']));
    // 6+ candidates would have triggered semantic ranking in the old code.
    for (let i = 1; i <= 8; i++) {
      db.prepare('INSERT INTO note_metadata (path, folder, note_type, experiment_type, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`Projects/wb${i}.md`, 'Projects', 'experiment', 'western-blot', `h${i}`, 1, 1);
      // Add a chunk so the old semantic-rank code's inner guard (chunks.length > 0) was satisfied.
      db.prepare('INSERT INTO note_chunks (path, chunk_index, start_offset, end_offset, content) VALUES (?, ?, ?, ?, ?)')
        .run(`Projects/wb${i}.md`, 0, 0, 20, `western blot data ${i}`);
    }
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('never calls embedText', async () => {
    const spy = vi.spyOn(embedder, 'embedText');
    const tools = createSearchTools(vault, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const res = JSON.parse(await tool.execute({ query: 'western blot' }));
    expect(res.results.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
