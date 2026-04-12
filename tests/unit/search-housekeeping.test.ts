import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_search housekeeping filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const insert = db.prepare(`
      INSERT INTO note_metadata (
        path, folder, note_type, date, project, experiment_type, protocol_ref, status, tags,
        result_summary, content_hash, mtime, last_indexed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insert.run(
      'Knowledge/Concepts/_index.md',
      'Knowledge',
      'knowledge',
      '2026-04-12',
      null,
      null,
      null,
      null,
      null,
      'Knowledge index',
      'idx',
      now,
      now,
    );
    insert.run(
      'Knowledge/_Ops/Lint-Reports/2026-04-12.md',
      'Knowledge',
      'unknown',
      '2026-04-12',
      null,
      null,
      null,
      null,
      null,
      'Lint report',
      'lint',
      now,
      now,
    );
    insert.run(
      'Knowledge/Concepts/il-42.md',
      'Knowledge',
      'knowledge',
      '2026-04-12',
      null,
      null,
      null,
      null,
      null,
      'IL-42 concept note',
      'real',
      now,
      now,
    );
  });

  afterEach(() => {
    db.close();
  });

  it('removes KB housekeeping files from results even if they are already indexed', async () => {
    const tools = createSearchTools('/tmp/nonexistent-vault', db);
    const searchTool = tools.find(tool => tool.definition.name === 'vault_search');
    if (!searchTool) throw new Error('vault_search tool missing');

    const result = JSON.parse(await searchTool.execute({ query: 'show me', folder: 'Knowledge' }));
    const paths = result.results.map((row: { path: string }) => row.path);

    expect(paths).toEqual(['Knowledge/Concepts/il-42.md']);
  });
});
