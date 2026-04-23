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

describe('create_project', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns pending_edit with correct path and reservation', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Cell Migration', prefix: 'CM' }));
    expect(r.type).toBe('pending_edit');
    expect(r.path).toMatch(/P001-CellMigration\/_index\.md$/);
    expect(r.reservation).toEqual({ project_id: 'P001', prefix: 'CM' });
  });

  it('frontmatter built via gray-matter — injection not possible', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Cell:\nmalicious: injected', prefix: 'CM' }));
    const parsed = matter(r.newContent);
    expect(parsed.data.malicious).toBeUndefined();
    expect(parsed.data.note_kind).toBe('project');
  });

  it('rejects invalid prefix format before consuming serial', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'TOOLONG' }));
    expect(r.error).toBeDefined();
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number } | undefined)?.next_val ?? -1).toBe(1);
  });

  it('rejects prefix already permanently registered to another project', async () => {
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P999');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'CM' }));
    expect(r.error).toMatch(/already permanently registered/);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number } | undefined)?.next_val ?? -1).toBe(1);
  });

  it('rejects prefix reserved by different project', async () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P999', Date.now() + 60_000);
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const r = JSON.parse(await tool.execute({ title: 'Test', prefix: 'CM' }));
    expect(r.error).toBeDefined();
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number } | undefined)?.next_val ?? -1).toBe(1);
  });

  it('stores reservation after allocating serial', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    await tool.execute({ title: 'Cell Migration', prefix: 'CM' });
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number } | undefined)?.next_val ?? -1).toBe(2);
    const res = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get('CM') as { project_id: string } | undefined;
    expect(res?.project_id).toBe('P001');
  });
});

describe('create_experiment', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'),
      matter.stringify('', { note_kind: 'project', id: 'P001', prefix: 'CM', title: 'CM', status: 'active', created: '2026-04-11' }));
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns pending_edit with CM001 filename', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'Western Blot', experiment_type: 'western-blot' }));
    expect(r.type).toBe('pending_edit');
    expect(r.path).toMatch(/CM001-western-blot\.md$/);
    const fm = matter(r.newContent).data;
    expect(fm.note_kind).toBe('experiment');
    expect(fm.id).toBe('CM001');
    expect(fm.project_id).toBe('P001');
  });

  it('validates protocol file exists if provided', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'WB', experiment_type: 'wb', protocol: 'PR999-nonexistent' }));
    expect(r.error).toContain('PR999-nonexistent');
  });

  it('auto-heals missing counters and proceeds (no error)', async () => {
    db.prepare('DELETE FROM serial_counters WHERE scope = ?').run('CM');
    db.prepare('DELETE FROM serial_counters WHERE scope = ?').run('CM-S');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'Test', experiment_type: 'pcr' }));
    // Should auto-register counters and return a pending_edit, not an error
    expect(r.error).toBeUndefined();
    expect(r.type).toBe('pending_edit');
    // Counters should now exist in DB
    const cnt = db.prepare('SELECT scope FROM serial_counters WHERE scope = ?').get('CM');
    expect(cnt).toBeDefined();
  });
});

describe('create_protocol', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'prot-'));
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns PR001 filename with correct frontmatter', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_protocol')!;
    const r = JSON.parse(await tool.execute({ title: 'Western Blot', category: 'protein-analysis' }));
    expect(r.path).toMatch(/PR001-western-blot\.md$/);
    const fm = matter(r.newContent).data;
    expect(fm.id).toBe('PR001');
    expect(fm.category).toBe('protein-analysis');
    expect(fm.malicious).toBeUndefined();
  });
});

describe('get_workflow_events', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wfe-'));
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'edit_confirmed', '{"editId":"a"}', Date.now() - 1000);
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'edit_cancelled', '{"editId":"b"}', Date.now());
    db.prepare('INSERT INTO workflow_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)').run('s2', 'edit_confirmed', '{"editId":"c"}', Date.now());
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns only events for current session', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'get_workflow_events')!;
    const r = JSON.parse(await tool.execute({}, { sessionId: 's1', vaultPath }));
    expect(r.events).toHaveLength(2);
  });

  it('returns empty for unknown session', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'get_workflow_events')!;
    const r = JSON.parse(await tool.execute({}, { sessionId: 'none', vaultPath }));
    expect(r.events).toHaveLength(0);
    expect(r.cursor).toBeNull();
  });

  it('respects after_event_id cursor', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'get_workflow_events')!;
    const all = JSON.parse(await tool.execute({}, { sessionId: 's1', vaultPath }));
    const firstId = all.events[0].id;
    const r = JSON.parse(await tool.execute({ after_event_id: firstId }, { sessionId: 's1', vaultPath }));
    expect(r.events).toHaveLength(1);
    expect(r.events[0].event_type).toBe('edit_cancelled');
    expect(r.cursor).toBe(r.events[0].id);
  });
});

describe('update_project_index', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'upi-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    const indexContent = `---\nnote_kind: project\nid: P001\nprefix: CM\n---\n\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| old |\n<!-- END AUTO-GENERATED: experiment-log -->\n`;
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), indexContent);
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates allowed section successfully', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_project_index')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', section: 'experiment-log', content: '| CM001 | new row |' }));
    expect(r.updated).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), 'utf-8');
    expect(updated).toContain('CM001');
  });

  it('rejects non-allowlisted section', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_project_index')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', section: 'arbitrary-section', content: 'malicious' }));
    expect(r.error).toMatch(/not allowed/);
  });
});

describe('update_series_table', () => {
  let db: Database.Database;
  let vaultPath: string;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ust-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    const indexContent = `---\nnote_kind: project\nid: P001\nprefix: CM\n---\n`;
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'), indexContent);
    const seriesContent = `---\nnote_kind: series\nid: CMS001\nproject_id: P001\n---\n\n<!-- AUTO-GENERATED: experiment-list -->\n| old |\n<!-- END AUTO-GENERATED: experiment-list -->\n`;
    fs.writeFileSync(path.join(vaultPath, 'Projects', 'P001-CM', 'CMS001-series.md'), seriesContent);
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
  });
  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('updates experiment list in series file', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_series_table')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', series_id: 'CMS001', content: '| CM001 | western blot |' }));
    expect(r.updated).toBe(true);
    const updated = fs.readFileSync(path.join(vaultPath, 'Projects', 'P001-CM', 'CMS001-series.md'), 'utf-8');
    expect(updated).toContain('CM001');
  });

  it('errors if series not found in project', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'update_series_table')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', series_id: 'CMS999', content: '...' }));
    expect(r.error).toContain('not found');
  });
});

describe('create_experiment and create_protocol — template integration', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tpl-'));
    // Project folder must start with projectId- so resolveProject('P001') can find it
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'),
      matter.stringify('\n', { note_kind: 'project', id: 'P001', prefix: 'CM', title: 'CM Project', status: 'active', created: '2026-01-01' })
    );
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, ?, ?)').run('CM', 1, 'P001');
    db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, ?, ?)').run('CM-S', 1, 'P001');
    // Permanent reservation (far-future expiry) so resolveProject does not auto-heal against a foreign reservation
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run('CM', 'P001', 9999999999999);
  });

  afterEach(() => { db.close(); fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('create_experiment returns warnings:[] when no template file is present', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    // No templates folder — builtin used, warning about missing templates
    expect(r.warnings.some((w: string) => w.includes('Editable templates are missing'))).toBe(true);
  });

  it('create_experiment applies custom template fields and warns on protected field', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\ntemplate_version: 1\ncell_line: HEK293\nid: BAD\n---\n\n# {{title}}\n\n## {{date}} - Start\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(r.type).toBe('pending_edit');
    const parsed = matter(r.newContent);
    expect(parsed.data.cell_line).toBe('HEK293');
    expect(parsed.data.id).toBe('CM001'); // protected field wins
    expect(r.warnings.some((w: string) => w.includes("'id'") && w.includes('ignored'))).toBe(true);
  });

  it('create_experiment emits each structural warning exactly once (no duplicates from preload path)', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Template with no version and a protected-field collision — both produce structural warnings
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\nid: BAD\n---\n\n# {{title}}\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(r.type).toBe('pending_edit');
    const idWarnings = (r.warnings as string[]).filter((w: string) => w.includes("'id'") && w.includes('ignored'));
    expect(idWarnings).toHaveLength(1);
    const versionWarnings = (r.warnings as string[]).filter((w: string) => w.includes('no version'));
    expect(versionWarnings).toHaveLength(1);
  });

  it('create_experiment does not consume a serial when template rendering fails', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'experiment.md'),
      `---\nkey: [oops\n---\n\n# {{title}}\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;

    const failed = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Experiment',
      experiment_type: 'western-blot',
    }));
    expect(failed.error).toMatch(/invalid YAML/i);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('CM') as { next_val: number }).next_val).toBe(1);
  });

  it('create_protocol returns warnings:[] and uses builtin body when no templates', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_protocol')!;
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
    const r = JSON.parse(await tool.execute({ title: 'Western Blot', category: 'gel' }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('## Materials');
    expect(parsed.content).toContain('## Procedure');
  });

  it('create_project returns warnings array and body has AUTO-GENERATED markers', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    // create_project allocates its own reservation — do NOT pre-insert one or the tool will reject it as a collision
    const r = JSON.parse(await tool.execute({ title: 'My Project', prefix: 'XY' }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: experiment-log -->');
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: project-summary -->');
  });

  it('create_project substitutes generated id and prefix placeholders', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'project-index.md'),
      `---\ntemplate_version: 1\n---\n\n# {{title}}\n\nProject ID: {{id}}\nPrefix: {{prefix}}\n\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|---------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;

    const r = JSON.parse(await tool.execute({ title: 'My Project', prefix: 'XY' }));
    expect(r.warnings).toEqual([]);
    const parsed = matter(r.newContent);
    expect(parsed.data.id).toBe('P001');
    expect(parsed.data.prefix).toBe('XY');
    expect(parsed.content).toContain('Project ID: P001');
    expect(parsed.content).toContain('Prefix: XY');
    expect(parsed.content).not.toContain('{{id}}');
    expect(parsed.content).not.toContain('{{prefix}}');
  });

  it('create_series returns warnings array and body has AUTO-GENERATED experiment-list', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_series')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Series',
      objective: 'Test objective',
    }));
    expect(r.type).toBe('pending_edit');
    expect(Array.isArray(r.warnings)).toBe(true);
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('<!-- AUTO-GENERATED: experiment-list -->');
    expect(parsed.content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
  });

  it('create_series injects experiment rows into AUTO-GENERATED block when experiments provided', async () => {
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    // Create an experiment file so validation passes
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CM', 'CM001-my-exp.md'),
      matter.stringify('\n# My Exp\n', { note_kind: 'experiment', id: 'CM001', project_id: 'P001' })
    );
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_series')!;
    const r = JSON.parse(await tool.execute({
      project_id: 'P001',
      title: 'My Series',
      objective: 'Test',
      experiments: ['CM001'],
    }));
    expect(r.type).toBe('pending_edit');
    const parsed = matter(r.newContent);
    expect(parsed.content).toContain('| CM001 |');
    expect(parsed.content).toContain('<!-- END AUTO-GENERATED: experiment-list -->');
    // Rows must appear BEFORE the END marker
    const endIdx = parsed.content.indexOf('<!-- END AUTO-GENERATED: experiment-list -->');
    const rowIdx = parsed.content.indexOf('| CM001 |');
    expect(rowIdx).toBeLessThan(endIdx);
  });

  it('create_project does not consume a serial when template rendering fails', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Unique key name avoids gray-matter's parse-error cache stale-hit from sibling tests
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'project-index.md'),
      `---\ncreate_project_bad: [oops\n---\n\n# {{title}}\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_project')!;
    const failed = JSON.parse(await tool.execute({ title: 'My Project', prefix: 'XY' }));
    expect(failed.error).toMatch(/invalid YAML/i);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('project') as { next_val: number }).next_val).toBe(1);
  });

  it('create_series does not consume a serial when template rendering fails', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Unique key name avoids gray-matter's parse-error cache stale-hit from sibling tests
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'series.md'),
      `---\ncreate_series_bad: [oops\n---\n\n# {{title}}\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_series')!;
    const failed = JSON.parse(await tool.execute({ project_id: 'P001', title: 'My Series' }));
    expect(failed.error).toMatch(/invalid YAML/i);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('CM-S') as { next_val: number }).next_val).toBe(1);
  });

  it('create_protocol does not consume a serial when template rendering fails', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Agent', 'templates'), { recursive: true });
    // Unique key name avoids gray-matter's parse-error cache stale-hit from sibling tests
    fs.writeFileSync(
      path.join(vaultPath, 'Agent', 'templates', 'protocol.md'),
      `---\ncreate_protocol_bad: [oops\n---\n\n# {{title}}\n`
    );
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_protocol')!;
    fs.mkdirSync(path.join(vaultPath, 'Protocols'), { recursive: true });
    const failed = JSON.parse(await tool.execute({ title: 'Western Blot', category: 'gel' }));
    expect(failed.error).toMatch(/invalid YAML/i);
    expect((db.prepare('SELECT next_val FROM serial_counters WHERE scope = ?').get('protocol') as { next_val: number }).next_val).toBe(1);
  });
});
