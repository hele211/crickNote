import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureVaultScaffold } from '../../src/cli/setup.js';

describe('ensureVaultScaffold', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('creates initial Knowledge index files during setup', () => {
    ensureVaultScaffold(vaultPath);

    for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
      const indexPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf-8');
      expect(content).toContain('type: index');
      expect(content).toContain(`folder: Knowledge/${kind}`);
      expect(content).toContain(`# ${kind}`);
      expect(content).toContain('| Title | Aliases | Last Updated | Sources |');
    }
  });

  it('creates the expected vault directories', () => {
    ensureVaultScaffold(vaultPath);

    for (const rel of [
      'Projects',
      'Protocols',
      'Reading/Papers',
      'Reading/Threads',
      'Reading/attachments',
      'Memory/Daily',
      'Knowledge/Concepts',
      'Knowledge/Entities',
      'Knowledge/Methods',
      'Knowledge/Review-Queue',
      'Knowledge/_Ops/Update-Logs',
      'Knowledge/_Ops/Lint-Reports',
    ]) {
      expect(fs.existsSync(path.join(vaultPath, rel))).toBe(true);
    }
  });
});
