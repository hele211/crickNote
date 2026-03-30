import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a vault-relative path to an absolute path, and verify it stays
 * inside the vault root. Throws if the resolved path would escape the vault
 * via "../" segments or via a symlink inside the vault that points outside it.
 *
 * Usage:
 *   const absPath = resolveVaultPath(vaultPath, args.path);
 *   // safe to read/write absPath
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  // Canonicalise the vault root through symlinks so the prefix check is reliable.
  let realVault: string;
  try {
    realVault = fs.realpathSync(vaultRoot);
  } catch {
    realVault = path.resolve(vaultRoot);
  }

  const absTarget = path.resolve(realVault, relativePath);

  // --- String-based check (fast path) ---------------------------------------
  if (absTarget !== realVault && !absTarget.startsWith(realVault + path.sep)) {
    throw new Error(
      `Path traversal rejected: "${relativePath}" resolves outside the vault.`,
    );
  }

  // --- Symlink check (follow any symlinks in the target path) ---------------
  // For paths that don't exist yet (writes), walk up to the nearest existing
  // ancestor and resolve that. Stop once we've walked up to or past the vault
  // root — the non-existent portion can't contain a symlink so no escape is
  // possible (the string-based check above already guaranteed the lexical path
  // is inside the vault).
  let pathToResolve = absTarget;
  while (
    pathToResolve !== path.dirname(pathToResolve) &&
    (pathToResolve === realVault || pathToResolve.startsWith(realVault + path.sep))
  ) {
    try {
      const real = fs.realpathSync(pathToResolve);
      if (real !== realVault && !real.startsWith(realVault + path.sep)) {
        throw new Error(
          `Path traversal rejected: "${relativePath}" resolves outside the vault via a symlink.`,
        );
      }
      break; // resolved successfully — no escape
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Path doesn't exist yet; check the parent.
        pathToResolve = path.dirname(pathToResolve);
        continue;
      }
      throw err; // re-throw our own traversal errors and unexpected errors
    }
  }

  return absTarget;
}
