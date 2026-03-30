import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPath } from '../../src/utils/paths.js';

describe('resolveVaultPath', () => {
  const vault = '/home/user/vault';

  it('resolves a normal relative path inside the vault', () => {
    const result = resolveVaultPath(vault, 'Projects/foo.md');
    expect(result).toBe(path.join(vault, 'Projects/foo.md'));
  });

  it('resolves a nested path inside the vault', () => {
    const result = resolveVaultPath(vault, 'Memory/Daily/2026-03-30.md');
    expect(result).toBe(path.join(vault, 'Memory/Daily/2026-03-30.md'));
  });

  it('rejects a path that escapes the vault with ../', () => {
    expect(() => resolveVaultPath(vault, '../etc/passwd')).toThrow(
      'Path traversal rejected',
    );
  });

  it('rejects a deeply nested escape attempt', () => {
    expect(() => resolveVaultPath(vault, 'Projects/../../secret')).toThrow(
      'Path traversal rejected',
    );
  });

  it('rejects an absolute path outside the vault', () => {
    expect(() => resolveVaultPath(vault, '/etc/passwd')).toThrow(
      'Path traversal rejected',
    );
  });

  it('accepts a path that resolves exactly to the vault root', () => {
    // Edge case: resolves to root itself — allowed (mkdir scenario)
    expect(() => resolveVaultPath(vault, '.')).not.toThrow();
  });
});

describe('resolveVaultPath — symlink escape', () => {
  let tmpVault: string;
  let tmpOutside: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-vault-'));
    tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-outside-'));
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.rmSync(tmpOutside, { recursive: true, force: true });
  });

  it('rejects a symlink inside the vault that points outside', () => {
    // Create vault/escape -> tmpOutside
    const symlinkPath = path.join(tmpVault, 'escape');
    fs.symlinkSync(tmpOutside, symlinkPath);

    expect(() => resolveVaultPath(tmpVault, 'escape')).toThrow(
      'Path traversal rejected',
    );
  });

  it('rejects a nested path through an escaping symlink', () => {
    // Create vault/escape -> tmpOutside, then reference vault/escape/secret.md
    const symlinkPath = path.join(tmpVault, 'escape');
    fs.symlinkSync(tmpOutside, symlinkPath);

    expect(() => resolveVaultPath(tmpVault, 'escape/secret.md')).toThrow(
      'Path traversal rejected',
    );
  });

  it('accepts a normal file inside the vault', () => {
    const notePath = path.join(tmpVault, 'note.md');
    fs.writeFileSync(notePath, '# Test');
    expect(() => resolveVaultPath(tmpVault, 'note.md')).not.toThrow();
  });

  it('accepts a non-existent write target whose parent is inside the vault', () => {
    // Writing a new file that does not exist yet should be allowed
    expect(() => resolveVaultPath(tmpVault, 'Projects/new-note.md')).not.toThrow();
  });
});
