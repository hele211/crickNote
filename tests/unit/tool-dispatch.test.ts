import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { runTool, listToolCatalog } from '../../src/cli/tool-dispatch.js';

describe('runTool', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disp-')));
    fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('returns a structured error for an unknown tool', async () => {
    const out = await runTool('does_not_exist', '{}', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown tool/i);
  });

  it('returns a structured error for malformed JSON', async () => {
    const out = await runTool('vault_read', '{not json', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/json/i);
  });

  it('executes a read tool and returns its JSON result', async () => {
    const rel = 'Projects/note.md';
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\n---\n\nhello');
    const out = await runTool('vault_read', JSON.stringify({ path: rel }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.result)).toContain('hello');
  });

  it('applies a pending_edit from task_add and writes the diary', async () => {
    const out = await runTool('task_add', JSON.stringify({ description: 'order ECL substrate' }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(out.applied?.[0].applied).toBe(true);
    const daily = fs.readdirSync(path.join(vault, 'Memory', 'Daily'));
    expect(daily.length).toBe(1);
    expect(fs.readFileSync(path.join(vault, 'Memory', 'Daily', daily[0]), 'utf-8')).toContain('order ECL substrate');
  });

  it('with apply:false returns the pending edit without writing', async () => {
    const out = await runTool('task_add', JSON.stringify({ description: 'do not write me' }), { vaultPath: vault, sessionId: 's', apply: false, db });
    expect(out.ok).toBe(true);
    expect(out.applied).toBeUndefined();
    expect(fs.existsSync(path.join(vault, 'Memory', 'Daily'))).toBe(true);
    expect(fs.readdirSync(path.join(vault, 'Memory', 'Daily')).length).toBe(0);
  });

  it('listToolCatalog returns name + description for every tool', () => {
    const catalog = listToolCatalog(vault, db);
    expect(catalog.length).toBeGreaterThan(20);
    for (const entry of catalog) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
    }
  });
});
