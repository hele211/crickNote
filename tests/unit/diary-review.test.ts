import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiaryReviewTools } from '../../src/agent/tools/diary-review.js';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { setDatabase, closeDatabase } from '../../src/storage/database.js';
import { runTool } from '../../src/cli/tool-dispatch.js';
import { applyPendingEdit, type PendingEditPayload } from '../../src/cli/apply-edit.js';
import { SafeWriter } from '../../src/editing/safe-writer.js';

const DATE = '2026-05-01';
const BLOCK = 'voice2note-1111111111111111';
const DIARY = [
  '# Daily diary',
  '',
  'Manual note: check freezer alarm.',
  '',
  '<!-- voice2note:1111111111111111 -->',
  '> add 2.5 mL buffer',
  '> measured 7.2 mg',
  '^voice2note-1111111111111111',
  '',
  '<!-- voice2note:2222222222222222 -->',
  '> incubate 10 min',
  '^voice2note-2222222222222222',
  '',
].join('\n');

function hash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('diary-first review tools', () => {
  let db: Database.Database;
  let vault: string;
  let diaryPath: string;
  let targetA: string;
  let targetB: string;

  const diaryRelative = `Memory/Daily/${DATE}.md`;
  const targetARelative = 'Projects/P001-alpha/AL001-buffer.md';
  const targetBRelative = 'Projects/P001-alpha/AL002-measurement.md';

  function tools() {
    return createDiaryReviewTools(vault, undefined, db);
  }

  function tool(name: string) {
    return tools().find(item => item.definition.name === name)!;
  }

  function writeTarget(relativePath: string, content: string): string {
    const absolutePath = path.join(vault, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    return absolutePath;
  }

  function insertIndexed(relativePath: string, noteId: string, noteType = 'experiment'): void {
    const content = fs.readFileSync(path.join(vault, relativePath), 'utf8');
    db.prepare(`INSERT INTO note_metadata
      (path, folder, note_type, date, project, project_id, note_id, experiment_type, status, tags, result_summary, content_hash, mtime, last_indexed)
      VALUES (?, 'Projects', ?, '2026-05-01', 'Alpha', 'P001', ?, NULL, 'in-progress', '[]', NULL, ?, 0, 0)`)
      .run(relativePath, noteType, noteId, hash(content));
  }

  async function reviewContext(): Promise<Record<string, unknown>> {
    return JSON.parse(await tool('diary_review_context').execute({ date: DATE }));
  }

  async function route(
    quote: string,
    targetPath: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const source = fs.readFileSync(diaryPath, 'utf8');
    const targetAbsolutePath = path.join(vault, targetPath);
    const target = fs.existsSync(targetAbsolutePath) ? fs.readFileSync(targetAbsolutePath, 'utf8') : '';
    return JSON.parse(await tool('route_diary_excerpt').execute({
      date: DATE,
      source_block_id: BLOCK,
      source_quote: quote,
      target_path: targetPath,
      source_hash: hash(source),
      target_hash: hash(target),
      ...overrides,
    }));
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    setDatabase(db);
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diary-review-')));
    diaryPath = writeTarget(diaryRelative, DIARY);
    targetA = writeTarget(targetARelative, '---\nnote_kind: experiment\nid: AL001\n---\n\n# Buffer\n');
    targetB = writeTarget(targetBRelative, '---\nnote_kind: experiment\nid: AL002\n---\n\n# Measurement\n');
    insertIndexed(targetARelative, 'AL001');
    insertIndexed(targetBRelative, 'AL002');
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('returns full diary content, exact voice transcripts, manual text, and explicit candidate pagination', async () => {
    const result = await reviewContext();

    expect(result.source_path).toBe(diaryRelative);
    expect(result.source_hash).toBe(hash(DIARY));
    expect(result.content).toBe(DIARY);
    expect(result.voice_entries).toEqual([
      { block_id: BLOCK, transcript: 'add 2.5 mL buffer\nmeasured 7.2 mg' },
      { block_id: 'voice2note-2222222222222222', transcript: 'incubate 10 min' },
    ]);
    expect(result.manual_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('Manual note: check freezer alarm.') }),
    ]));
    expect(result.indexed_candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: targetARelative, note_id: 'AL001', project_id: 'P001' }),
      expect.objectContaining({ path: targetBRelative, note_id: 'AL002', project_id: 'P001' }),
    ]));
    expect(result.pagination).toMatchObject({ candidate_offset: 0, candidate_limit: 50, returned: 2, total: 2, has_more: false });
  });

  it('routes two exact excerpts from one mixed voice recording to distinct existing notes without mutating the diary', async () => {
    const originalDiary = fs.readFileSync(diaryPath, 'utf8');
    const pendingA = await route('add 2.5 mL buffer', targetARelative);
    const pendingB = await route('measured 7.2 mg', targetBRelative);

    for (const pending of [pendingA, pendingB]) {
      expect(pending.type).toBe('pending_edit');
      expect(pending.operation).toBe('route_diary_excerpt');
      expect(pending.expectedBeforeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(pending.newContent).toContain(`[[${diaryRelative}#^${BLOCK}]]`);
    }
    expect(pendingA.newContent).toContain('> add 2.5 mL buffer');
    expect(pendingA.newContent).not.toContain('> measured 7.2 mg');
    expect(pendingB.newContent).toContain('> measured 7.2 mg');
    expect(pendingB.newContent).not.toContain('> add 2.5 mL buffer');

    for (const pending of [pendingA, pendingB]) {
      const applied = applyPendingEdit(pending as unknown as PendingEditPayload, {
        vaultRoot: vault,
        sessionId: 'mixed-recording',
        triggerQuery: 'test route',
        safeWriter: new SafeWriter(),
        db,
      });
      expect(applied.applied).toBe(true);
    }
    expect(fs.readFileSync(targetA, 'utf8')).toContain('> add 2.5 mL buffer');
    expect(fs.readFileSync(targetB, 'utf8')).toContain('> measured 7.2 mg');
    expect(fs.readFileSync(diaryPath, 'utf8')).toBe(originalDiary);
  });

  it('does not route a duplicate after application or after an unrelated diary append', async () => {
    const pending = await route('add 2.5 mL buffer', targetARelative) as unknown as PendingEditPayload;
    const applied = applyPendingEdit(pending, {
      vaultRoot: vault,
      sessionId: 'review',
      triggerQuery: 'test route',
      safeWriter: new SafeWriter(),
      db,
    });
    expect(applied.applied).toBe(true);
    const targetAfterApply = fs.readFileSync(targetA, 'utf8');
    expect(targetAfterApply).toContain('<!-- cricknote-diary-route:');

    let retried = await route('add 2.5 mL buffer', targetARelative);
    expect(retried.status).toBe('already_filed');

    fs.appendFileSync(diaryPath, '\nManual note: unrelated late sync.\n');
    retried = await route('add 2.5 mL buffer', targetARelative);
    expect(retried.status).toBe('already_filed');
    expect(fs.readFileSync(targetA, 'utf8')).toBe(targetAfterApply);
  });

  it('supports manual diary text only when the quote is exact and has no source block ID', async () => {
    const pending = await route('Manual note: check freezer alarm.', targetARelative, { source_block_id: undefined });
    expect(pending.type).toBe('pending_edit');
    expect(pending.newContent).toContain(`[[${diaryRelative}]]`);
    expect(pending.newContent).toContain('> Manual note: check freezer alarm.');
  });

  it('supports a verified optional vault-relative daily directory for late-synced dates', async () => {
    const customRelative = 'Memory/ImportedDaily';
    const customPath = writeTarget(`${customRelative}/2025-12-31.md`, DIARY);
    const result = JSON.parse(await tool('diary_review_context').execute({
      date: '2025-12-31',
      daily_dir: customRelative,
    }));

    expect(result.source_path).toBe(`${customRelative}/2025-12-31.md`);
    expect(result.source_hash).toBe(hash(fs.readFileSync(customPath, 'utf8')));
    expect(result.voice_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ block_id: BLOCK }),
    ]));
  });

  it('rejects malformed dates, traversal, symlink escapes, missing targets/blocks, and fabricated quotes', async () => {
    let result = JSON.parse(await tool('diary_review_context').execute({ date: '2026-02-30' }));
    expect(result.error).toMatch(/real calendar date/i);
    result = JSON.parse(await tool('diary_review_context').execute({ date: DATE, daily_dir: '../Memory/Daily' }));
    expect(result.error).toMatch(/daily_dir/i);

    result = await route('add 2.5 mL buffer', '../outside.md');
    expect(result.error).toMatch(/target_path/i);
    result = await route('add 2.5 mL buffer', 'Projects/P001-alpha/missing.md');
    expect(result.error).toMatch(/not found/i);
    result = await route('add 2.5 mL buffer', targetARelative, { source_block_id: 'voice2note-aaaaaaaaaaaaaaaa' });
    expect(result.error).toMatch(/source block not found/i);
    result = await route('fabricated 999 mL', targetARelative);
    expect(result.error).toMatch(/does not occur exactly/i);

    const otherDiaryRelative = 'Memory/Daily/2026-05-02.md';
    writeTarget(otherDiaryRelative, '# another diary\n');
    result = await route('add 2.5 mL buffer', otherDiaryRelative);
    expect(result.error).toMatch(/non-diary/i);

    const malformedBlock = 'voice2note-3333333333333333';
    fs.appendFileSync(diaryPath, `\n<!-- voice2note:3333333333333333 -->\n> malformed missing end\n`);
    result = await route('malformed missing end', targetARelative, { source_block_id: malformedBlock });
    expect(result.error).toMatch(/source block not found/i);
    result = await route('malformed missing end', targetARelative, { source_block_id: undefined });
    expect(result.error).toMatch(/manual diary text/i);
    const malformedContext = await reviewContext();
    expect(malformedContext.malformed_voice_blocks).toBe(1);

    const outside = path.join(os.tmpdir(), `outside-${crypto.randomUUID()}.md`);
    fs.writeFileSync(outside, '# outside\n');
    const escapeRelative = 'Projects/P001-alpha/escape.md';
    fs.symlinkSync(outside, path.join(vault, escapeRelative));
    result = await route('add 2.5 mL buffer', escapeRelative);
    expect(result.error).toMatch(/escapes vault boundary/i);
    fs.rmSync(outside, { force: true });
  });

  it('rejects stale source and target hashes before proposing a route', async () => {
    let result = await route('add 2.5 mL buffer', targetARelative, { source_hash: hash('old diary') });
    expect(result.error).toMatch(/source_hash is stale/i);
    result = await route('add 2.5 mL buffer', targetARelative, { target_hash: hash('old target') });
    expect(result.error).toMatch(/target_hash is stale/i);
  });

  it('keeps a route pending under CLI preview, then applies it through the audited CLI path', async () => {
    const source = fs.readFileSync(diaryPath, 'utf8');
    const target = fs.readFileSync(targetA, 'utf8');
    const args = JSON.stringify({
      date: DATE,
      source_block_id: BLOCK,
      source_quote: 'add 2.5 mL buffer',
      target_path: targetARelative,
      source_hash: hash(source),
      target_hash: hash(target),
    });

    const preview = await runTool('route_diary_excerpt', args, { vaultPath: vault, sessionId: 'preview', apply: false, db });
    expect(preview.ok).toBe(true);
    expect((preview.result as Record<string, unknown>).type).toBe('pending_edit');
    expect(fs.readFileSync(targetA, 'utf8')).toBe(target);

    const applied = await runTool('route_diary_excerpt', args, { vaultPath: vault, sessionId: 'apply', apply: true, db });
    expect(applied.ok).toBe(true);
    expect(applied.applied?.[0]).toMatchObject({ applied: true, operation: 'route_diary_excerpt' });
    expect((applied.result as Record<string, unknown>).newContent).toBeUndefined();
    expect(fs.readFileSync(targetA, 'utf8')).toContain('> add 2.5 mL buffer');
    const audit = db.prepare('SELECT operation, before_hash, after_hash FROM edit_audit_log WHERE file_path = ?').get(targetA) as { operation: string; before_hash: string; after_hash: string } | undefined;
    expect(audit?.operation).toBe('update');
    expect(audit?.before_hash).toBe(hash(target));
    expect(audit?.after_hash).toBeTruthy();
  });

  it('rejects an expectedBeforeHash that becomes stale after a preview', async () => {
    const pending = await route('add 2.5 mL buffer', targetARelative) as unknown as PendingEditPayload;
    fs.appendFileSync(targetA, 'human changed target\n');
    const result = applyPendingEdit(pending, {
      vaultRoot: vault,
      sessionId: 'stale',
      triggerQuery: 'test route',
      safeWriter: new SafeWriter(),
      db,
    });
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/expectedBeforeHash mismatch/i);
    expect(fs.readFileSync(targetA, 'utf8')).not.toContain('> add 2.5 mL buffer');
    const audit = db.prepare('SELECT COUNT(*) AS count FROM edit_audit_log WHERE file_path = ?').get(targetA) as { count: number };
    expect(audit.count).toBe(0);
  });
});
