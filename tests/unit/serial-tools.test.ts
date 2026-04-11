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

  it('errors if project counters not registered', async () => {
    db.prepare('DELETE FROM serial_counters WHERE scope = ?').run('CM');
    const { createSerialTools } = await import('../../src/agent/tools/serial-tools.js');
    const tool = createSerialTools(vaultPath, db).find(t => t.definition.name === 'create_experiment')!;
    const r = JSON.parse(await tool.execute({ project_id: 'P001', title: 'Test', experiment_type: 'pcr' }));
    expect(r.error).toBeDefined();
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
