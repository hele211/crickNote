import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSources } from '../../src/knowledge/source-loader.js';

describe('loadSources', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      'IL-42 suppresses CD8 by 40%.'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'large.md'),
      'x'.repeat(42000) // > 10 000 tokens at ~4 chars/token
    );
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('loads a markdown source file', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'notes.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toContain('IL-42 suppresses');
    expect(result.warnings).toHaveLength(0);
  });

  it('truncates a source that exceeds 10 000 tokens', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'large.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources[0].truncated).toBe(true);
    expect(result.warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  it('warns and skips missing source files', async () => {
    const result = await loadSources(
      [{ type: 'pdf', path: 'missing.pdf' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('missing.pdf'))).toBe(true);
  });

  it('warns for unsupported types (xlsx, images)', async () => {
    const result = await loadSources(
      [{ type: 'other', path: 'data.xlsx' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.warnings.some(w => w.includes('Cannot read'))).toBe(true);
  });

  it('respects the 30 000 token session cap', async () => {
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(
        path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', `part${i}.md`),
        'y'.repeat(32000)
      );
    }
    const result = await loadSources(
      [1,2,3,4].map(i => ({ type: 'notes', path: `part${i}.md` })),
      'smith-2026-il42',
      vaultPath
    );
    expect(result.totalTokens).toBeLessThanOrEqual(30000);
    expect(result.warnings.some(w => w.includes('session cap'))).toBe(true);
  });

  it('loads sources in priority order (notes > pdf > notebooklm > web > other)', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'), 'MD notes content');
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'summary.md'), 'NotebookLM summary content');
    const result = await loadSources(
      [
        { type: 'other', path: 'other.md' },        // priority 4 — file doesn't exist, skip
        { type: 'notebooklm', path: 'summary.md' }, // priority 2
        { type: 'notes', path: 'notes.md' },         // priority 0 — highest
      ],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources[0].path).toBe('notes.md');
    expect(result.sources[1].path).toBe('summary.md');
  });
});
