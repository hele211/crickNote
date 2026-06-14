import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVaultTools } from '../../src/agent/tools/vault.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';

// Frontmatter with a folded title and a multi-line author list — exactly the
// kind of block the agent should never have to retype (feedback #5).
const FRONTMATTER = [
  '---',
  'title: >-',
  '  A Very Long Title That Folds Across Lines',
  'authors:',
  '  - Alice Smith',
  '  - Bob Jones',
  '  - Carol Δ White',
  'year: 2026',
  'journal: Nature',
  'sources:',
  '  - type: pdf',
  '    path: paper.pdf',
  '---',
].join('\n');

const originalContent = `${FRONTMATTER}\n\n# Old Title\n\n## Claims\n\nold body content\n`;

describe('vault_write_body', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  function getTool() {
    return createVaultTools(vaultPath, detector).find(t => t.definition.name === 'vault_write_body')!;
  }

  beforeEach(() => {
    vaultPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vwb-')));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('preserves frontmatter verbatim and replaces only the body', async () => {
    const rel = 'Reading/Papers/test.md';
    fs.writeFileSync(path.join(vaultPath, rel), originalContent);

    const result = JSON.parse(await getTool().execute({
      path: rel,
      body: '# New Title\n\n## Figure Map\n\n## Claims\n\nnew analysis',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('update');
    // The frontmatter block (incl. folded title, author list, unicode) is byte-identical.
    expect(result.newContent.startsWith(FRONTMATTER)).toBe(true);
    expect(result.newContent).toContain('new analysis');
    expect(result.newContent).not.toContain('old body content');
    expect(result.newContent).not.toContain('# Old Title');
  });

  it('errors when the file does not exist', async () => {
    const result = JSON.parse(await getTool().execute({ path: 'Reading/Papers/missing.md', body: 'x' }));
    expect(result.error).toMatch(/not found/i);
  });

  it('errors when the file has no frontmatter', async () => {
    const rel = 'Reading/Papers/no-fm.md';
    fs.writeFileSync(path.join(vaultPath, rel), '# Just a body, no frontmatter\n');
    const result = JSON.parse(await getTool().execute({ path: rel, body: 'x' }));
    expect(result.error).toMatch(/frontmatter/i);
  });

  it('records a conflict snapshot before proposing the edit', async () => {
    const rel = 'Reading/Papers/test.md';
    const abs = path.join(vaultPath, rel);
    fs.writeFileSync(abs, originalContent);

    await getTool().execute({ path: rel, body: 'new' });

    expect(detector.getSnapshot(abs)?.content).toBe(originalContent);
  });
});
