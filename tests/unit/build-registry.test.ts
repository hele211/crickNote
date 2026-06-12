import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { buildToolRegistry } from '../../src/agent/build-registry.js';

describe('buildToolRegistry', () => {
  let db: Database.Database;
  let vault: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('registers the full tool surface', () => {
    const reg = buildToolRegistry(vault, undefined, db);
    const names = reg.getDefinitions().map(d => d.name);
    for (const expected of [
      'vault_read', 'vault_search', 'create_project', 'create_experiment',
      'task_add', 'task_list', 'compile_reading_note', 'kb_suggest', 'zotero_fetch_item',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('has no duplicate tool names', () => {
    const reg = buildToolRegistry(vault, undefined, db);
    const names = reg.getDefinitions().map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
