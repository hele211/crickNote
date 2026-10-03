import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config/config.js';
import { resolveVaultPath } from '../utils/paths.js';
import { installAgentAssets } from './install-agent-assets.js';

const GUIDE_DOCS = ['CLAUDE.md', 'AGENTS.md'] as const;
const SKILL_ROOTS = ['.claude', '.agents'] as const;

export interface AssetRefreshReport {
  vaultPath: string;
  dryRun: boolean;
  docs: Array<{ file: (typeof GUIDE_DOCS)[number]; status: 'new' | 'unchanged' | 'overwritten' }>;
  /** Counts per (skill root × file) copy, so a file that differs in both .claude and .agents counts twice. */
  skillFiles: { new: number; changed: number; unchanged: number };
}

function listFiles(root: string, rel = ''): string[] {
  const dir = path.join(root, rel);
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function compare(src: string, dest: string): 'new' | 'unchanged' | 'changed' {
  if (!fs.existsSync(dest)) return 'new';
  return fs.readFileSync(src).equals(fs.readFileSync(dest)) ? 'unchanged' : 'changed';
}

/**
 * Refuse, before anything is written, if a copy could land outside the vault or overwrite a symlink
 * target: a symlinked guide doc (AGENTS.md -> CLAUDE.md would clobber CLAUDE.md), a symlinked skill
 * file, or a skills directory whose real path leaves the vault. In-vault directory symlinks are fine.
 */
function assertSafeDestinations(vaultPath: string, repoRoot: string, skillRels: string[]): void {
  const dests: string[] = [];
  for (const file of GUIDE_DOCS) {
    if (fs.existsSync(path.join(repoRoot, 'templates', 'agent-docs', file))) dests.push(file);
  }
  for (const rel of skillRels) {
    for (const root of SKILL_ROOTS) dests.push(path.join(root, 'skills', rel));
  }
  for (const rel of dests) {
    let abs: string;
    try {
      abs = resolveVaultPath(vaultPath, rel);
    } catch {
      throw new Error(`Refusing to install: ${rel} resolves outside the vault through a symlink. Remove or fix the symlink and re-run.`);
    }
    const direct = path.join(vaultPath, rel);
    let isLink = false;
    try {
      isLink = fs.lstatSync(direct).isSymbolicLink();
    } catch {
      // destination does not exist yet
    }
    if (isLink) {
      throw new Error(`Refusing to overwrite ${rel}: it is a symlink (target ${abs}). Replace it with a regular file or remove it, then re-run.`);
    }
  }
}

/**
 * Copy skills and guide docs into the vault and report what changed. Unlike
 * `cricknote setup` this never reads or writes config.json, so it is safe to
 * re-run (setup overwrites config.json with only the vault path).
 */
export function refreshAgentAssets(vaultPath: string, repoRoot: string, options: { dryRun?: boolean } = {}): AssetRefreshReport {
  const dryRun = options.dryRun ?? false;

  const skillsSrc = path.join(repoRoot, 'skills');
  const skillRels = fs.existsSync(skillsSrc) ? listFiles(skillsSrc) : [];
  assertSafeDestinations(vaultPath, repoRoot, skillRels);

  const docs: AssetRefreshReport['docs'] = [];
  for (const file of GUIDE_DOCS) {
    const src = path.join(repoRoot, 'templates', 'agent-docs', file);
    if (!fs.existsSync(src)) continue;
    const state = compare(src, path.join(vaultPath, file));
    docs.push({ file, status: state === 'changed' ? 'overwritten' : state });
  }

  const skillFiles = { new: 0, changed: 0, unchanged: 0 };
  for (const rel of skillRels) {
    for (const root of SKILL_ROOTS) {
      skillFiles[compare(path.join(skillsSrc, rel), path.join(vaultPath, root, 'skills', rel))] += 1;
    }
  }

  if (!dryRun) installAgentAssets(vaultPath, repoRoot);
  return { vaultPath, dryRun, docs, skillFiles };
}

/** Refresh assets in the vault named by the active config (honours CRICKNOTE_DATA_DIR). */
export function installAssets(options: { repoRoot?: string; dryRun?: boolean } = {}): AssetRefreshReport {
  const config = loadConfig();
  // dist/cli/install-assets.js -> repo root is two levels up (same layout as setup.ts).
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, '..', '..');
  return refreshAgentAssets(config.vaultPath, repoRoot, { dryRun: options.dryRun });
}
