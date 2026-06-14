import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverBundle } from '../../src/knowledge/reading-bundle.js';

describe('discoverBundle', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('discovers bundle files in the default Reading/attachments dir', () => {
    const dir = path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), 'fake pdf');

    const result = discoverBundle(vaultPath, 'smith-2026-il42');

    expect(result.folderExists).toBe(true);
    expect(result.recommendedSources).toEqual([{ type: 'pdf', path: 'paper.pdf' }]);
  });

  it('ignores dotfiles such as the .zotero-bundle marker it writes itself', () => {
    const dir = path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), 'fake pdf');
    fs.writeFileSync(path.join(dir, '.zotero-bundle'), 'marker');

    const result = discoverBundle(vaultPath, 'smith-2026-il42');

    expect(result.discoveredFiles.some((f) => f.path === '.zotero-bundle')).toBe(false);
    expect(result.warnings.some((w) => w.includes('.zotero-bundle'))).toBe(false);
    expect(result.recommendedSources).toEqual([{ type: 'pdf', path: 'paper.pdf' }]);
  });

  it('discovers bundle files in a non-default attachments dir (vault_pdf_dir)', () => {
    const customDir = 'Library/PDFs';
    const dir = path.join(vaultPath, customDir, 'smith-2026-il42');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), 'fake pdf');

    const result = discoverBundle(vaultPath, 'smith-2026-il42', customDir);

    expect(result.folderExists).toBe(true);
    expect(result.recommendedSources).toEqual([{ type: 'pdf', path: 'paper.pdf' }]);
    expect(result.bundlePath).toBe(
      path.join(fs.realpathSync(vaultPath), customDir, 'smith-2026-il42')
    );
  });

  it('does not find a bundle in the default dir when files live under a custom dir', () => {
    const dir = path.join(vaultPath, 'Library', 'PDFs', 'smith-2026-il42');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), 'fake pdf');

    // Reader still pointed at the default dir → bundle is invisible.
    const result = discoverBundle(vaultPath, 'smith-2026-il42');

    expect(result.folderExists).toBe(false);
    expect(result.warnings[0]).toContain('Reading bundle not found');
  });
});
