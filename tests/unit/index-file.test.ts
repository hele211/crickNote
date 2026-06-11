import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexFileSync, listMarkdownFiles } from '../../src/ingestion/index-file.js';

describe('indexFileSync', () => {
  let db: Database.Database;
  let vault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'idxf-'));
  });
  afterEach(() => { db.close(); fs.rmSync(vault, { recursive: true, force: true }); });

  it('indexes a note into note_metadata and bm25 with no embeddings', () => {
    const rel = 'Projects/P001-il42/IL001-dose.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel),
      '---\nnote_kind: experiment\nid: IL001\nproject_id: P001\n---\n\nWestern blot dose response pSTAT3.');

    const outcome = indexFileSync(rel, vault, db);
    expect(outcome).toBe('indexed');

    const meta = db.prepare('SELECT note_id FROM note_metadata WHERE path = ?').get(rel) as { note_id: string } | undefined;
    expect(meta?.note_id).toBe('IL001');

    const bm25 = db.prepare(
      `SELECT COUNT(*) AS n FROM bm25_index bi JOIN note_chunks nc ON nc.id = CAST(bi.chunk_id AS INTEGER) WHERE nc.path = ?`
    ).get(rel) as { n: number };
    expect(bm25.n).toBeGreaterThan(0);

    const emb = db.prepare(
      `SELECT COUNT(*) AS n FROM chunk_embeddings ce JOIN note_chunks nc ON nc.id = ce.chunk_id WHERE nc.path = ?`
    ).get(rel) as { n: number };
    expect(emb.n).toBe(0);
  });

  it('skips ignored paths', () => {
    const rel = 'Reading/attachments/smith/paper.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), 'x');
    expect(indexFileSync(rel, vault, db)).toBe('skipped');
  });

  it('returns unchanged on second call with same content', () => {
    const rel = 'Projects/P001-il42/IL002-x.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\nid: IL002\n---\n\nbody');
    expect(indexFileSync(rel, vault, db)).toBe('indexed');
    expect(indexFileSync(rel, vault, db)).toBe('unchanged');
  });

  it('removes metadata when the file is gone', () => {
    const rel = 'Projects/P001-il42/IL003-x.md';
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), '---\nnote_kind: experiment\nid: IL003\n---\n\nbody');
    indexFileSync(rel, vault, db);
    fs.rmSync(path.join(vault, rel));
    expect(indexFileSync(rel, vault, db)).toBe('gone');
    const meta = db.prepare('SELECT path FROM note_metadata WHERE path = ?').get(rel);
    expect(meta).toBeUndefined();
  });

  it('listMarkdownFiles returns relative md paths and skips dot dirs', () => {
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', 'a.md'), 'a');
    fs.writeFileSync(path.join(vault, '.obsidian', 'b.md'), 'b');
    fs.writeFileSync(path.join(vault, 'Projects', 'c.txt'), 'c');
    const files = listMarkdownFiles(vault).sort();
    expect(files).toEqual(['Projects/a.md']);
  });
});
