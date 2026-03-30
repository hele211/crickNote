import { describe, it, expect } from 'vitest';
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
