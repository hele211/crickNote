// tests/unit/kb-lint.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

describe('kb_lint checks', () => {
  let db: Database.Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbl-test-'));
    for (const dir of [
      'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
      'Knowledge/Review-Queue', 'Knowledge/_Ops/Lint-Reports',
      'Reading/Papers',
    ]) {
      fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('check #1: flags knowledge note with no compiled_from', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'no-source.md'),
      '---\ntype: knowledge\nknowledge_kind: concept\ntitle: No Source\ncompiled_from: []\n---\n\n## Key Claims\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('no-source') && i.includes('compiled_from'))).toBe(true);
  });

  it('check #2: flags knowledge note with claim missing source link', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'unsourced.md'),
      '---\ntype: knowledge\nknowledge_kind: concept\ntitle: Test\ncompiled_from: ["[[smith-2026]]"]\n---\n\n## Key Claims\n- [supports] This is an unsourced claim without a wikilink.\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('unsourced') && i.includes('source link'))).toBe(true);
  });

  it('check #4: flags complete reading note with kb_status pending', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'jones-2025.md'),
      '---\ntitle: Jones\nauthors: [Jones]\nyear: 2025\njournal: Cell\ndoi: 10.x/y\nread_date: 2025-01-01\nstatus: complete\nkb_status: pending\n---\n'
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needs_attention.some((i: string) => i.includes('jones-2025') && i.includes('pending'))).toBe(true);
  });

  it('check #6: flags Review-Queue item older than 14 days', async () => {
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', `${oldDate}-old-item.md`),
      `---\ntype: review-queue\nsource: "[[some-paper]]"\ntarget_concept: "[[some-concept]]"\nstatus: pending\ncreated: ${oldDate}\n---\n`
    );
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needs_attention.some((i: string) => i.includes('old-item') || i.includes('Review-Queue'))).toBe(true);
  });

  it('writes Lint Report to _Ops/Lint-Reports/', async () => {
    const { createKbTools } = await import('../../src/agent/tools/kb-tools.js');
    const tools = createKbTools(vaultPath, db);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    await tool.execute({});
    const reports = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'));
    expect(reports.length).toBeGreaterThan(0);
  });
});
