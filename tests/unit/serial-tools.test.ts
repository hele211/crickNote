import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import matter from 'gray-matter';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('reserve_prefix', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns reserved:true for valid prefix', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.reserved).toBe(true);
    expect(r.expires_at).toBeGreaterThan(Date.now());
  });

  it('rejects reserved system prefix PR', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'PR', project_id: 'P001' }));
    expect(r.error).toBeDefined();
  });

  it('rejects invalid prefix format (1 char)', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'C', project_id: 'P001' }));
    expect(r.error).toContain('format');
  });

  it('rejects CM if CMS is already registered in serial_counters', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CMS', 'P002');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.error).toContain('collision');
  });

  it('rejects CM if CMS is already reserved in prefix_reservations', async () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CMS', 'P002', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.error).toContain('collision');
  });

  it('is idempotent for same project_id', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    await tool.execute({ prefix: 'CM', project_id: 'P001' });
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P001' }));
    expect(r.reserved).toBe(true);
  });

  it('rejects if prefix reserved by different project', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'reserve_prefix')!;
    await tool.execute({ prefix: 'CM', project_id: 'P001' });
    const r = JSON.parse(await tool.execute({ prefix: 'CM', project_id: 'P002' }));
    expect(r.error).toContain('reserved by project');
  });
});

describe('register_project_counters', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('registers both counters and removes reservation when _index.md confirmed', async () => {
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
    expect(r.counters).toContain('CM');
    expect(r.counters).toContain('CM-S');
    expect(db.prepare('SELECT * FROM prefix_reservations WHERE prefix = ?').get('CM')).toBeUndefined();
  });

  it('errors when no _index.md exists even with active reservation', async () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toMatch(/Apply the pending project edit/);
  });

  it('is idempotent — both counters already exist for same project (no file check needed)', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
  });

  it('errors on partial state (only one counter) when no _index.md exists', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toMatch(/Apply the pending project edit/);
  });

  it('repairs partial state when _index.md exists', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
    expect(r.repaired).toBe(true);
    const cmS = db.prepare('SELECT * FROM serial_counters WHERE scope = ?').get('CM-S') as { project_id: string } | undefined;
    expect(cmS?.project_id).toBe('P001');
  });

  it('errors if prefix counter registered by different project', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P002');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toContain('already registered');
  });

  it('errors if only one counter exists (partial state)', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toMatch(/Apply the pending project edit/);
  });

  it('auto-heals from _index.md when no reservation exists', async () => {
    const indexPath = path.join(vaultPath, 'Projects', 'P001-CM', '_index.md');
    fs.writeFileSync(indexPath, matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.registered).toBe(true);
  });

  it('errors on duplicate project folders during auto-heal', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-OtherName'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-OtherName', '_index.md'), matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM' }));
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'register_project_counters')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', prefix: 'CM' }));
    expect(r.error).toContain('Duplicate');
  });
});
