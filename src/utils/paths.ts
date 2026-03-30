import path from 'node:path';

/**
 * Resolve a vault-relative path to an absolute path, and verify it stays
 * inside the vault root. Throws if the resolved path would escape the vault
 * (e.g. via "../" segments or symlink tricks at the path level).
 *
 * Usage:
 *   const absPath = resolveVaultPath(vaultPath, args.path);
 *   // safe to read/write absPath
 */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  const absVault = path.resolve(vaultRoot);
  const absTarget = path.resolve(absVault, relativePath);

  // Ensure target starts with vault root followed by separator (or IS vault root).
  if (absTarget !== absVault && !absTarget.startsWith(absVault + path.sep)) {
    throw new Error(
      `Path traversal rejected: "${relativePath}" resolves outside the vault.`,
    );
  }

  return absTarget;
}
