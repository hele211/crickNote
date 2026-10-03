import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config/config.js';
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
 * Copy skills and guide docs into the vault and report what changed. Unlike
 * `cricknote setup` this never reads or writes config.json, so it is safe to
 * re-run (setup overwrites config.json with only the vault path).
 */
export function refreshAgentAssets(vaultPath: string, repoRoot: string, options: { dryRun?: boolean } = {}): AssetRefreshReport {
  const dryRun = options.dryRun ?? false;

  const docs: AssetRefreshReport['docs'] = [];
  for (const file of GUIDE_DOCS) {
    const src = path.join(repoRoot, 'templates', 'agent-docs', file);
    if (!fs.existsSync(src)) continue;
    const state = compare(src, path.join(vaultPath, file));
    docs.push({ file, status: state === 'changed' ? 'overwritten' : state });
  }

  const skillFiles = { new: 0, changed: 0, unchanged: 0 };
  const skillsSrc = path.join(repoRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const rel of listFiles(skillsSrc)) {
      for (const root of SKILL_ROOTS) {
        skillFiles[compare(path.join(skillsSrc, rel), path.join(vaultPath, root, 'skills', rel))] += 1;
      }
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
