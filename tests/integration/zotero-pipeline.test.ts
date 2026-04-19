import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSystemPrompt } from '../../src/agent/context.js';
import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';
import type { CrickNoteConfig } from '../../src/config/config.js';

function makeConfig(overrides: Partial<CrickNoteConfig['zotero']> = {}): CrickNoteConfig {
  return {
    vaultPath: '/tmp/test-vault',
    zotero: {
      enabled: true,
      api_port: 23119,
      storage_root: os.tmpdir(),
      auto_summarize: true,
      ...overrides,
    },
  } as CrickNoteConfig;
}

describe('assembleSystemPrompt — Zotero auto_summarize injection', () => {
  it('auto_summarize true (default) → prompt includes ON rule', () => {
    const config = makeConfig({ auto_summarize: true });
    const prompt = assembleSystemPrompt('/tmp/vault', [], config);
    expect(prompt).toContain('auto_summarize is ON');
  });

  it('auto_summarize false → prompt includes OFF rule', () => {
    const config = makeConfig({ auto_summarize: false });
    const prompt = assembleSystemPrompt('/tmp/vault', [], config);
    expect(prompt).toContain('auto_summarize is OFF');
  });

  it('zotero.enabled false → Zotero workflow section absent', () => {
    const config = makeConfig();
    config.zotero!.enabled = false;
    const prompt = assembleSystemPrompt('/tmp/vault', [], config);
    expect(prompt).not.toContain('Zotero Reading Workflow');
  });

  it('zotero.enabled true → Zotero workflow section present', () => {
    const config = makeConfig({ enabled: true });
    const prompt = assembleSystemPrompt('/tmp/vault', [], config);
    expect(prompt).toContain('Zotero Reading Workflow');
  });

  it('20-page cap note is in the auto_summarize ON branch', () => {
    const config = makeConfig({ auto_summarize: true });
    const prompt = assembleSystemPrompt('/tmp/vault', [], config);
    expect(prompt).toContain('20 pages');
  });
});

describe('ingest_reading_bundle — note_rel_path is vault-relative', () => {
  it('note_rel_path starts with Reading/ and not with /', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
    try {
      const slug = 'smith-2026-rel-path-test';
      const bundleDir = path.join(vault, 'Reading', 'attachments', slug);
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(path.join(vault, 'Reading', 'Papers'), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'paper.pdf'), '%PDF-test');

      const tools = createReadingIntakeTools(vault);
      const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
      const result = JSON.parse(await ingestTool.execute({
        slug,
        title: 'Rel Path Test',
        authors: ['Smith J'],
        year: 2026,
        journal: 'Cell',
        sources: [{ type: 'pdf', path: 'paper.pdf' }],
        zotero_managed: true,
        zotero_files_created: ['paper.pdf'],
      }));

      expect(result.type).toBe('pending_edit');
      expect(result.meta.note_rel_path).toMatch(/^Reading\//);
      expect(result.meta.note_rel_path.startsWith('/')).toBe(false);
      expect(result.meta.note_rel_path).toBe(`Reading/Papers/${slug}.md`);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it('note_rel_path and pending_edit.path differ (path is absolute)', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
    try {
      const slug = 'smith-2026-abs-test';
      const bundleDir = path.join(vault, 'Reading', 'attachments', slug);
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(path.join(vault, 'Reading', 'Papers'), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'paper.pdf'), '%PDF-test');

      const tools = createReadingIntakeTools(vault);
      const ingestTool = tools.find(t => t.definition.name === 'ingest_reading_bundle')!;
      const result = JSON.parse(await ingestTool.execute({
        slug,
        title: 'Abs Test',
        authors: ['Jones A'],
        year: 2025,
        journal: 'Nature',
        sources: [{ type: 'pdf', path: 'paper.pdf' }],
        zotero_managed: true,
        zotero_files_created: [],
      }));

      expect(result.type).toBe('pending_edit');
      // pending_edit.path is absolute; note_rel_path is relative
      expect(path.isAbsolute(result.path)).toBe(true);
      expect(path.isAbsolute(result.meta.note_rel_path)).toBe(false);
      expect(result.path).not.toBe(result.meta.note_rel_path);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
