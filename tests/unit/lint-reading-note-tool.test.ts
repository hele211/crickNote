import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStyleLintTools } from '../../src/agent/tools/style-lint.js';
import { buildToolRegistry } from '../../src/agent/build-registry.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const goldenRaw = fs.readFileSync(path.join(repoRoot, 'skills', '_shared', 'examples', 'reading-note-v2.md'), 'utf-8');

describe('lint_reading_note tool', () => {
  let vault: string;
  let tool: ReturnType<typeof createStyleLintTools>[number];

  const writeNote = (rel: string, content: string): void => {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const run = async (args: Record<string, unknown>) => JSON.parse(await tool.execute(args));

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-lint-tool-'));
    tool = createStyleLintTools(vault)[0];
  });
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('is named lint_reading_note and documents that it is advisory and read-only', () => {
    expect(tool.definition.name).toBe('lint_reading_note');
    expect(tool.definition.description).toMatch(/advisory/i);
    expect(tool.definition.description).toMatch(/read-only/i);
  });

  it('lints a note by path, using frontmatter sources for the Source check', async () => {
    writeNote('Reading/Papers/lee-2026-il42.md', goldenRaw);
    const result = await run({ path: 'Reading/Papers/lee-2026-il42.md' });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ warn: 0, info: 0 });
    expect(result.stats.claims).toBe(6);
  });

  it('warns in path mode when the declared Source is not a registered source', async () => {
    const withoutPaper = goldenRaw.replace('  - type: notes\n    path: paper.md\n', '');
    expect(withoutPaper).not.toBe(goldenRaw);
    writeNote('Reading/Papers/lee-2026-il42.md', withoutPaper);
    const result = await run({ path: 'Reading/Papers/lee-2026-il42.md' });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f: { code: string }) => f.code)).toContain('source-not-registered');
    expect(result.counts.warn).toBeGreaterThan(0);
  });

  it('works on Reading/Threads notes too', async () => {
    writeNote('Reading/Threads/topic.md', goldenRaw);
    const result = await run({ path: 'Reading/Threads/topic.md' });
    expect(result.ok).toBe(true);
  });

  it('lints a supplied body without touching the vault; a body with frontmatter still gets the Source check', async () => {
    const result = await run({ body: goldenRaw });
    expect(result.ok).toBe(true);
    const bare = await run({ body: '## Claims\n\n- text only\n' });
    expect(bare.ok).toBe(false);
    expect(bare.findings.map((f: { code: string }) => f.code)).toContain('missing-tldr');
  });

  it('rejects paths outside Reading/Papers and Reading/Threads', async () => {
    for (const p of ['Knowledge/Concepts/x.md', 'Projects/P001-x/_index.md', '../outside.md', 'Reading/attachments/x/paper.md', 'Reading/Papers/sub/x.md']) {
      writeNote('Knowledge/Concepts/x.md', goldenRaw);
      const result = await run({ path: p });
      expect(result.error, p).toBeTruthy();
    }
  });

  it('rejects mapping artifacts and underscore housekeeping files', async () => {
    writeNote('Reading/Papers/x-mapping.md', goldenRaw);
    writeNote('Reading/Papers/x-mapping-20260101T120000.md', goldenRaw);
    writeNote('Reading/Papers/_README.md', goldenRaw);
    writeNote('Reading/Papers/_changelog.md', goldenRaw);
    for (const name of ['x-mapping.md', 'x-mapping-20260101T120000.md', '_README.md', '_changelog.md']) {
      const result = await run({ path: `Reading/Papers/${name}` });
      expect(result.error, name).toBeTruthy();
    }
  });

  it('returns an error for a missing file, and for neither or both of path and body', async () => {
    expect((await run({ path: 'Reading/Papers/nope.md' })).error).toMatch(/not found/i);
    expect((await run({})).error).toBeTruthy();
    expect((await run({ path: 'Reading/Papers/a.md', body: 'x' })).error).toBeTruthy();
  });

  it('never writes: the note is byte-identical and no pending_edit is returned', async () => {
    writeNote('Reading/Papers/lee-2026-il42.md', goldenRaw);
    const before = fs.readFileSync(path.join(vault, 'Reading/Papers/lee-2026-il42.md'), 'utf-8');
    const raw = await tool.execute({ path: 'Reading/Papers/lee-2026-il42.md' });
    expect(raw).not.toContain('pending_edit');
    expect(fs.readFileSync(path.join(vault, 'Reading/Papers/lee-2026-il42.md'), 'utf-8')).toBe(before);
  });

  it('is part of the full tool registry', () => {
    const names = buildToolRegistry(vault).getDefinitions().map((d) => d.name);
    expect(names).toContain('lint_reading_note');
  });
});
