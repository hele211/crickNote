import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVaultPath } from '../../src/utils/paths.js';

/**
 * These tests exercise the symlinked-vault-root paths that were fixed in
 * websocket.ts (pending-edit path rendering) and runtime.ts (boundary check).
 *
 * Setup: a real vault directory on disk, plus a symlink that points to it.
 * All operations use the symlink as the "configured vaultPath", simulating
 * a user whose vault root is itself a symlink (e.g. ~/vault → /Volumes/data/vault).
 */
describe('symlinked vault root — path rendering (websocket fix)', () => {
  let realVault: string;
  let symlinkVault: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-symvault-')));
    realVault = path.join(tmpDir, 'real-vault');
    symlinkVault = path.join(tmpDir, 'symlink-vault');

    fs.mkdirSync(realVault);
    fs.mkdirSync(path.join(realVault, 'Projects'));
    fs.writeFileSync(path.join(realVault, 'Projects', 'experiment.md'), '# Exp');
    fs.symlinkSync(realVault, symlinkVault);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('path.relative produces a clean relative path when vault root is resolved through symlink', () => {
    // This mirrors what websocket.ts does:
    //   realVaultPath = fs.realpathSync(config.vaultPath)
    //   path.relative(realVaultPath, pe.proposal.filePath)
    //
    // pe.proposal.filePath comes from resolveVaultPath(), which resolves through realpathSync.
    const configVaultPath = symlinkVault; // user configured a symlink
    const resolvedFile = resolveVaultPath(configVaultPath, 'Projects/experiment.md');

    // The resolved file path is under the real directory (realpath-resolved)
    expect(resolvedFile).toBe(path.join(realVault, 'Projects', 'experiment.md'));

    // --- THE BUG (before fix): using config.vaultPath directly ---
    const brokenRelative = path.relative(configVaultPath, resolvedFile);
    // On most OS this would still work if the OS resolves symlinks in relative,
    // but on others it produces a path with ../. The key point: it's unreliable.

    // --- THE FIX: resolve vaultPath through realpathSync first ---
    const realVaultPath = fs.realpathSync(configVaultPath);
    const correctRelative = path.relative(realVaultPath, resolvedFile);

    expect(correctRelative).toBe(path.join('Projects', 'experiment.md'));
    // No leading "../" — this is the correct UI-visible path
    expect(correctRelative.startsWith('..')).toBe(false);
  });

  it('path.relative works for a file directly in the vault root', () => {
    fs.writeFileSync(path.join(realVault, 'note.md'), '# Note');
    const resolvedFile = resolveVaultPath(symlinkVault, 'note.md');

    const realVaultPath = fs.realpathSync(symlinkVault);
    const relative = path.relative(realVaultPath, resolvedFile);

    expect(relative).toBe('note.md');
  });

  it('path.relative works for deeply nested paths through symlinked root', () => {
    fs.mkdirSync(path.join(realVault, 'Memory', 'Daily'), { recursive: true });
    fs.writeFileSync(path.join(realVault, 'Memory', 'Daily', '2026-03-30.md'), '# Daily');

    const resolvedFile = resolveVaultPath(symlinkVault, 'Memory/Daily/2026-03-30.md');
    const realVaultPath = fs.realpathSync(symlinkVault);
    const relative = path.relative(realVaultPath, resolvedFile);

    expect(relative).toBe(path.join('Memory', 'Daily', '2026-03-30.md'));
    expect(relative.startsWith('..')).toBe(false);
  });
});

describe('symlinked vault root — boundary check (runtime fix)', () => {
  let realVault: string;
  let symlinkVault: string;
  let outsideDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-boundary-')));
    realVault = path.join(tmpDir, 'real-vault');
    symlinkVault = path.join(tmpDir, 'symlink-vault');
    outsideDir = path.join(tmpDir, 'outside');

    fs.mkdirSync(realVault);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(realVault, 'safe.md'), '# Safe');
    fs.writeFileSync(path.join(outsideDir, 'evil.md'), '# Evil');
    fs.symlinkSync(realVault, symlinkVault);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Mirrors the boundary check in runtime.ts (line ~174):
   *   if (!path.isAbsolute(absolutePath) ||
   *       (absolutePath !== this.realVaultPath &&
   *        !absolutePath.startsWith(this.realVaultPath + path.sep)))
   *
   * We extract this logic into a helper to test it in isolation.
   */
  function isInsideVault(realVaultPath: string, absolutePath: string): boolean {
    return (
      path.isAbsolute(absolutePath) &&
      (absolutePath === realVaultPath || absolutePath.startsWith(realVaultPath + path.sep))
    );
  }

  it('accepts a realpath-resolved file that is inside the vault', () => {
    const realVaultPath = fs.realpathSync(symlinkVault);
    const filePath = resolveVaultPath(symlinkVault, 'safe.md');

    expect(isInsideVault(realVaultPath, filePath)).toBe(true);
  });

  it('rejects a file outside the vault', () => {
    const realVaultPath = fs.realpathSync(symlinkVault);
    const outsideFile = path.join(outsideDir, 'evil.md');

    expect(isInsideVault(realVaultPath, outsideFile)).toBe(false);
  });

  it('rejects a relative path', () => {
    const realVaultPath = fs.realpathSync(symlinkVault);
    expect(isInsideVault(realVaultPath, 'Projects/note.md')).toBe(false);
  });

  it('accepts a path equal to the vault root itself', () => {
    const realVaultPath = fs.realpathSync(symlinkVault);
    expect(isInsideVault(realVaultPath, realVaultPath)).toBe(true);
  });

  it('rejects a path that is a prefix but not a child (e.g. /vault-backup)', () => {
    // This tests the + path.sep guard: /tmp/.../real-vault-backup should NOT match /tmp/.../real-vault
    const realVaultPath = fs.realpathSync(symlinkVault);
    const decoyPath = realVaultPath + '-backup';

    expect(isInsideVault(realVaultPath, decoyPath)).toBe(false);
  });

  it('boundary check would fail without realpath resolution (demonstrates the bug)', () => {
    // If we used the raw symlink path for the check, a realpath-resolved file path
    // would not start with the symlink path when they differ.
    const rawVaultPath = path.resolve(symlinkVault); // does NOT resolve symlink
    const resolvedFile = resolveVaultPath(symlinkVault, 'safe.md'); // resolves through realpathSync

    // The raw path and real path differ (one is a symlink, one is the target)
    const realVaultPath = fs.realpathSync(symlinkVault);
    if (rawVaultPath !== realVaultPath) {
      // Using the raw (symlink) path: the resolved file would NOT appear to be inside the vault
      expect(isInsideVault(rawVaultPath, resolvedFile)).toBe(false);
      // Using the real path: it correctly identifies the file as inside
      expect(isInsideVault(realVaultPath, resolvedFile)).toBe(true);
    }
  });
});
