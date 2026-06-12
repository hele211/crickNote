import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { SafeWriter } from '../../src/editing/safe-writer.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { applyPendingEdit } from '../../src/cli/apply-edit.js';

describe('applyPendingEdit', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db); // audit log + indexer use getDatabase() internally
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-')));
  });
  afterEach(() => { closeDatabase(); fs.rmSync(vault, { recursive: true, force: true }); });

  const ctx = () => ({ vaultRoot: vault, sessionId: 's1', triggerQuery: 'test', safeWriter: new SafeWriter(), db });

  it('writes a new file and records an audit row', () => {
    const abs = path.join(vault, 'Projects/P001-il42/IL001-dose.md');
    const res = applyPendingEdit(
      { path: abs, newContent: '---\nnote_kind: experiment\nid: IL001\n---\n\nbody', operation: 'create_experiment' },
      ctx(),
    );
    expect(res.applied).toBe(true);
    expect(fs.readFileSync(abs, 'utf-8')).toContain('IL001');
    const audit = db.prepare('SELECT COUNT(*) AS n FROM edit_audit_log WHERE file_path = ?').get(abs) as { n: number };
    expect(audit.n).toBe(1);
  });

  it('incrementally indexes the written file', () => {
    const abs = path.join(vault, 'Projects/P001-il42/IL002-x.md');
    applyPendingEdit({ path: abs, newContent: '---\nnote_kind: experiment\nid: IL002\n---\n\nbody', operation: 'create_experiment' }, ctx());
    const meta = db.prepare('SELECT note_id FROM note_metadata WHERE path = ?').get('Projects/P001-il42/IL002-x.md') as { note_id: string } | undefined;
    expect(meta?.note_id).toBe('IL002');
  });

  it('rejects a path outside the vault without writing', () => {
    const res = applyPendingEdit({ path: '/etc/evil.md', newContent: 'x', operation: 'create' }, ctx());
    expect(res.applied).toBe(false);
    expect(res.error).toMatch(/escapes vault/i);
    expect(fs.existsSync('/etc/evil.md')).toBe(false);
  });

  it('deletes the reservation when the write fails', () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)')
      .run('ZZ', 'P099', Date.now() + 600000);
    // Create a read-only directory so the atomic tmp-write fails with EACCES.
    const roDir = path.join(vault, 'ReadOnly');
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555); // no write permission
    const abs = path.join(roDir, '_index.md');
    const res = applyPendingEdit(
      { path: abs, newContent: 'body', operation: 'create_project', reservation: { project_id: 'P099', prefix: 'ZZ' } },
      ctx(),
    );
    fs.chmodSync(roDir, 0o755); // restore so afterEach rmSync can clean up
    expect(res.applied).toBe(false);
    const row = db.prepare('SELECT project_id FROM prefix_reservations WHERE project_id = ?').get('P099');
    expect(row).toBeUndefined();
  });

  it('finalizes a prefix reservation on success', () => {
    db.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)')
      .run('IL', 'P001', Date.now() + 600000);
    const abs = path.join(vault, 'Projects/P001-il42/_index.md');
    const res = applyPendingEdit(
      { path: abs, newContent: '---\nnote_kind: project\nid: P001\n---\n\nbody', operation: 'create_project', reservation: { project_id: 'P001', prefix: 'IL' } },
      ctx(),
    );
    expect(res.applied).toBe(true);
    const row = db.prepare('SELECT edit_id FROM prefix_reservations WHERE project_id = ?').get('P001') as { edit_id: string | null };
    expect(row.edit_id).toBeTruthy();
  });
});
