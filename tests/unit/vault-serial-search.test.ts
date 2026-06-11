import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { createVaultTools } from '../../src/agent/tools/vault.js';
import { createSearchTools } from '../../src/agent/tools/search.js';

describe('vault_list with project_id and series filter (injectable db)', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vlt-'));
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P001-CM/CM001-wb.md', 'Projects', 'experiment', '2026-04-11', 'P001', 'CMS001', 'CM001', 'abc', 1000, 1000);
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P002-PCR/PCR001-pcr.md', 'Projects', 'experiment', '2026-04-11', 'P002', null, 'PCR001', 'def', 1000, 1000);
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('Memory/Daily/2026-04-11.md', 'Memory', 'diary', '2026-04-11', 'ghi', 1000, 1000);
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('Memory/Weekly/2026-W15.md', 'Memory', 'diary', '2026-04-12', 'jkl', 1000, 1000);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('filters by project_id', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Projects', project_id: 'P001' }));
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('P001');
  });

  it('includes series in result', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Projects' }));
    const withSeries = result.find((r: Record<string, unknown>) => r.series === 'CMS001');
    expect(withSeries).toBeDefined();
  });

  it('lists top-level Memory notes', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Memory' }));
    const paths = result.map((row: { path: string }) => row.path);

    expect(paths).toContain('Memory/Daily/2026-04-11.md');
    expect(paths).toContain('Memory/Weekly/2026-W15.md');
  });

  it('lists only notes under a requested subfolder', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Memory/Daily' }));

    expect(result.map((row: { path: string }) => row.path)).toEqual(['Memory/Daily/2026-04-11.md']);
  });

  it('rejects folder path traversal', async () => {
    const tools = createVaultTools(vaultPath, undefined, db);
    const tool = tools.find(t => t.definition.name === 'vault_list')!;
    const result = JSON.parse(await tool.execute({ folder: 'Memory/../Daily' }));

    expect(result.error).toContain('without traversal');
  });
});

describe('vault_search serial ID fast path', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    // runMigrations applies both 001 and 002; note_id/series/project_id columns require 002.
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-'));
    db.prepare(`INSERT INTO note_metadata (path, folder, note_type, date, project_id, series, note_id, content_hash, mtime, last_indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('Projects/P001-CM/CM001-wb.md', 'Projects', 'experiment', '2026-04-11', 'P001', 'CMS001', 'CM001', 'abc', 1000, 1000);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns serial_exact match for known note_id', async () => {
    const tools = createSearchTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const result = JSON.parse(await tool.execute({ query: 'CM001' }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].match_type).toBe('serial_exact');
    expect(result.results[0].note_id).toBe('CM001');
    expect(result.totalCandidates).toBe(1);
  });

  it('does not apply serial fast path for non-serial queries', async () => {
    const tools = createSearchTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const result = JSON.parse(await tool.execute({ query: 'western blot' }));
    expect(result).toHaveProperty('results');
    if (Array.isArray(result.results)) {
      for (const r of result.results) {
        expect(r.match_type).not.toBe('serial_exact');
      }
    }
  });

  it('falls through to normal search when serial ID is not in DB', async () => {
    const tools = createSearchTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'vault_search')!;
    const result = JSON.parse(await tool.execute({ query: 'CM999' }));
    expect(result.results?.every((r: Record<string, unknown>) => r.match_type !== 'serial_exact')).toBe(true);
  });
});
