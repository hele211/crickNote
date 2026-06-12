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

  it('rejects non-object JSON arguments: null', async () => {
    const out = await runTool('vault_read', 'null', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Arguments must be a JSON object');
  });

  it('rejects non-object JSON arguments: array', async () => {
    const out = await runTool('vault_read', '[1,2,3]', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Arguments must be a JSON object');
  });

  it('rejects non-object JSON arguments: number', async () => {
    const out = await runTool('vault_read', '42', { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Arguments must be a JSON object');
  });

  it('executes a read tool and returns its JSON result', async () => {
    const rel = 'Projects/note.md';
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\n---\n\nhello');
    const out = await runTool('vault_read', JSON.stringify({ path: rel }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.result)).toContain('hello');
  });

  // Vault-boundary preflight coverage note:
  // The dispatcher's pre-flight loop (lines ~93-102 of tool-dispatch.ts) rejects any pending_edit
  // whose resolved path escapes the vault root before any file is written. In practice, every
  // existing tool calls resolveVaultPath() which already throws on traversal, so an escaping path
  // can never reach the preflight through a real tool — the preflight is defense-in-depth for
  // future tools. The out-of-vault branch is additionally covered by applyPendingEdit's own
  // resolveVaultPath check (see tests/unit/apply-edit.test.ts). The tests below confirm the
  // happy-path: in-vault edits are applied and written correctly.

  it('applies a pending_edit from task_add and writes the diary', async () => {
    const out = await runTool('task_add', JSON.stringify({ description: 'order ECL substrate' }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(out.applied?.[0].applied).toBe(true);
    const daily = fs.readdirSync(path.join(vault, 'Memory', 'Daily'));
    expect(daily.length).toBe(1);
    expect(fs.readFileSync(path.join(vault, 'Memory', 'Daily', daily[0]), 'utf-8')).toContain('order ECL substrate');
  });

  it('applies an in-vault vault_write pending_edit and the file exists in vault', async () => {
    // Confirms the full apply path (dispatcher preflight passes → applyPendingEdit writes).
    const rel = 'Projects/created-by-dispatch.md';
    const content = '---\nnote_kind: experiment\n---\n\ncreated via dispatcher';
    const out = await runTool('vault_write', JSON.stringify({ path: rel, content }), { vaultPath: vault, sessionId: 's', apply: true, db });
    expect(out.ok).toBe(true);
    expect(out.applied?.[0].applied).toBe(true);
    expect(fs.existsSync(path.join(vault, rel))).toBe(true);
    expect(fs.readFileSync(path.join(vault, rel), 'utf-8')).toContain('created via dispatcher');
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
