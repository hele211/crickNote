import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { runTool } from '../../src/cli/tool-dispatch.js';

describe('CLI bridge — full lab cycle', () => {
  let db: Database.Database;
  let vault: string;
  const opts = () => ({ vaultPath: vault, sessionId: 's1', apply: true, db });

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-int-')));
    // No template setup needed: when <vault>/Agent/templates/ is absent,
    // loadTemplate falls back to a built-in template (with a warning), so
    // create_project / create_experiment still render and apply.
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('creates a project, experiment, appends an observation, and finds it', async () => {
    // 1. Create project with explicit prefix
    const proj = await runTool('create_project', JSON.stringify({ title: 'IL42 signalling', prefix: 'IL' }), opts());
    expect(proj.ok).toBe(true);
    expect(proj.applied?.some(a => a.operation === 'create_project' && a.applied)).toBe(true);

    // 2. Register counters (finalize project)
    const reg = await runTool('register_project_counters', JSON.stringify({ project_id: 'P001', prefix: 'IL' }), opts());
    expect(reg.ok).toBe(true);

    // 3. Create experiment
    const exp = await runTool('create_experiment', JSON.stringify({
      project_id: 'P001', title: 'dose response', experiment_type: 'western-blot',
    }), opts());
    expect(exp.ok).toBe(true);
    const expEdit = exp.applied?.find(a => a.applied);
    expect(expEdit).toBeDefined();

    // The experiment file exists on disk
    const expRel = expEdit!.path;
    expect(fs.existsSync(expRel)).toBe(true);

    // 4. Append an observation
    const relInVault = path.relative(vault, expRel);
    const appendRes = await runTool('vault_append', JSON.stringify({
      path: relInVault, content: '\n- 14:32 transfer complete, membrane clean',
    }), opts());
    expect(appendRes.ok).toBe(true);
    expect(fs.readFileSync(expRel, 'utf-8')).toContain('transfer complete');

    // 5. Search finds the experiment by serial
    const search = await runTool('vault_search', JSON.stringify({ query: 'IL001' }), opts());
    expect(search.ok).toBe(true);
    const searchResult = search.result as { results: Array<{ note_id?: string }> };
    expect(searchResult.results.length).toBeGreaterThan(0);
    expect(searchResult.results.some(r => r.note_id === 'IL001')).toBe(true);
  });
});
