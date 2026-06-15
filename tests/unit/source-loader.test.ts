import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectSources,
  loadSources,
  joinPdfPages,
  findCaptionLabels,
  findSupplementaryReferences,
  buildRecommendedPageRanges,
} from '../../src/knowledge/source-loader.js';

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
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'paper.md'),
      'x'.repeat(116000) // ~29 000 tokens at ~4 chars/token — a full paper, under the 50k cap
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'huge.md'),
      'x'.repeat(220000) // ~55 000 tokens — exceeds the 50k cap
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'escaped.md'),
      '\u001f'.repeat(10000) // small raw text, but ~60 KB after JSON escaping
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

  it('returns a full ~29k-token paper without truncation', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'paper.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources[0].truncated).toBe(false);
    expect(result.sources[0].content.length).toBe(116000);
    expect(result.warnings).toHaveLength(0);
  });

  it('flags transport risk for a large but untruncated paper', async () => {
    // paper.md is ~29k tokens / 116 000 bytes: under the 50k internal cap (so
    // truncated:false) but large enough that the serialized response can be
    // clipped in transport. The flag makes that risk explicit next to truncated:false.
    const result = await loadSources(
      [{ type: 'notes', path: 'paper.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.sources[0].truncated).toBe(false);
    expect(result.transportRisk).toBe(true);
  });

  it('does not flag transport risk for a small source', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'notes.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(result.transportRisk).toBe(false);
  });

  it('calculates transport risk from serialized JSON size', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'escaped.md' }],
      'smith-2026-il42',
      vaultPath
    );
    expect(Buffer.byteLength(result.sources[0].content, 'utf8')).toBeLessThan(40000);
    expect(result.transportRisk).toBe(true);
  });

  it('truncates a single source that exceeds the 50 000 token cap', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'huge.md' }],
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

  it('respects the 50 000 token session cap across multiple sources', async () => {
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(
        path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', `part${i}.md`),
        'y'.repeat(60000) // ~15 000 tokens each → 60 000 total, over the 50k cap
      );
    }
    const result = await loadSources(
      [1,2,3,4].map(i => ({ type: 'notes', path: `part${i}.md` })),
      'smith-2026-il42',
      vaultPath
    );
    expect(result.totalTokens).toBeGreaterThan(30000); // proves the cap was raised above the old 30k
    expect(result.totalTokens).toBeLessThanOrEqual(50000);
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

  it('rejects absolute and traversal source paths', async () => {
    const result = await loadSources(
      [
        { type: 'pdf', path: '../paper.pdf' },
        { type: 'pdf', path: '/tmp/paper.pdf' },
      ],
      'smith-2026-il42',
      vaultPath
    );

    expect(result.sources).toHaveLength(0);
    expect(result.warnings[0]).toContain('relative to the attachment folder');
    expect(result.warnings[1]).toContain('relative to the attachment folder');
  });

  it('rejects unknown source types before loading', async () => {
    const result = await loadSources(
      [{ type: 'audio', path: 'notes.md' }],
      'smith-2026-il42',
      vaultPath
    );

    expect(result.sources).toHaveLength(0);
    expect(result.warnings[0]).toContain('source type "audio" is not supported');
  });

  it('continues loading valid sources when one source is invalid', async () => {
    const result = await loadSources(
      [
        { type: 'notes', path: '../escape.md' },
        { type: 'notes', path: 'notes.md' },
      ],
      'smith-2026-il42',
      vaultPath
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].path).toBe('notes.md');
    expect(result.warnings[0]).toContain('relative to the attachment folder');
  });

  it('loads sources from a non-default attachments dir (vault_pdf_dir)', async () => {
    const customDir = 'Library/PDFs';
    fs.mkdirSync(path.join(vaultPath, customDir, 'jones-2025'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, customDir, 'jones-2025', 'notes.md'),
      'Custom-dir source content.'
    );

    const result = await loadSources(
      [{ type: 'notes', path: 'notes.md' }],
      'jones-2025',
      vaultPath,
      customDir
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toContain('Custom-dir source content');
    expect(result.warnings).toHaveLength(0);
  });

  it('loads only the requested source path', async () => {
    const result = await loadSources(
      [
        { type: 'notes', path: 'notes.md' },
        { type: 'notes', path: 'paper.md' },
      ],
      'smith-2026-il42',
      vaultPath,
      'Reading/attachments',
      { sourcePath: 'notes.md' }
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].path).toBe('notes.md');
  });

  it('caps a selected source with maxTokens', async () => {
    const result = await loadSources(
      [{ type: 'notes', path: 'paper.md' }],
      'smith-2026-il42',
      vaultPath,
      'Reading/attachments',
      { maxTokens: 2000 }
    );

    expect(result.sources[0].truncated).toBe(true);
    expect(result.totalTokens).toBe(2000);
    expect(result.transportRisk).toBe(false);
  });

  it('inspects a text source without returning its content', async () => {
    const result = await inspectSources(
      [{ type: 'notes', path: 'notes.md' }],
      'smith-2026-il42',
      vaultPath
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].estimatedTokens).toBeGreaterThan(0);
    expect(result.sources[0]).not.toHaveProperty('content');
  });
});

describe('joinPdfPages', () => {
  it('joins pages with page-number markers', () => {
    expect(joinPdfPages(['alpha', 'beta'])).toBe('--- page 1 ---\nalpha\n\n--- page 2 ---\nbeta');
  });

  it('returns an empty string when there are no pages', () => {
    expect(joinPdfPages([])).toBe('');
  });

  it('preserves original page numbers for a selected range', () => {
    expect(joinPdfPages(['gamma', 'delta'], 3)).toBe('--- page 3 ---\ngamma\n\n--- page 4 ---\ndelta');
  });
});

describe('findCaptionLabels', () => {
  it('detects classic "Fig. N." captions at line start', () => {
    expect(findCaptionLabels('Fig. 1. IL-42 suppresses CD8.', 'figure')).toEqual(['Fig. 1']);
  });

  it('detects spelled-out "Figure N." captions', () => {
    expect(findCaptionLabels('Figure 2. Dose response curve.', 'figure')).toEqual(['Fig. 2']);
  });

  it('detects Nature-style "Figure N |" pipe captions', () => {
    expect(findCaptionLabels('Figure 3 | TRIM21 recruits the proteasome.', 'figure')).toEqual(['Fig. 3']);
  });

  it('detects colon-delimited "Fig N:" captions', () => {
    expect(findCaptionLabels('Fig 4: knockout phenotype.', 'figure')).toEqual(['Fig. 4']);
  });

  it('detects supplementary figure captions in any style', () => {
    expect(findCaptionLabels('Figure S1 | gating strategy.', 'figure')).toEqual(['Fig. S1']);
  });

  it('does not treat an in-text citation as a caption', () => {
    expect(findCaptionLabels('As shown in Fig. 1 the signal rises.', 'figure')).toEqual([]);
  });

  it('detects Nature-style "Table N |" captions', () => {
    expect(findCaptionLabels('Table 2 | cohort characteristics.', 'table')).toEqual(['Table 2']);
  });

  it('detects classic "Table SN." captions', () => {
    expect(findCaptionLabels('Table S1. primer sequences.', 'table')).toEqual(['Table S1']);
  });
});

describe('findSupplementaryReferences', () => {
  it('collects supplementary refs across spelling styles', () => {
    const refs = findSupplementaryReferences('We rely on Figure S1 and Fig. S2 and Table S3.');
    expect(refs).toEqual(['Fig. S1', 'Fig. S2', 'Table S3']);
  });

  it('returns nothing when only main figures/tables are cited', () => {
    expect(findSupplementaryReferences('See Fig. 1 and Table 2.')).toEqual([]);
  });
});

describe('buildRecommendedPageRanges', () => {
  it('returns one range when pages fit under the serialized-byte budget', () => {
    const ranges = buildRecommendedPageRanges(['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)]);
    expect(ranges).toEqual([{ pageStart: 1, pageEnd: 3, estimatedTokens: expect.any(Number) }]);
  });

  it('splits into multiple ranges and preserves 1-indexed page numbers', () => {
    // Each page ~20 KB serialized; the 32 KB range budget forces one page per range.
    const ranges = buildRecommendedPageRanges(['x'.repeat(20000), 'y'.repeat(20000), 'z'.repeat(20000)]);
    expect(ranges.map((r) => [r.pageStart, r.pageEnd])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('returns an empty array for no pages', () => {
    expect(buildRecommendedPageRanges([])).toEqual([]);
  });
});
