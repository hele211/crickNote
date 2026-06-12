import fs from 'node:fs';
import path from 'node:path';

/**
 * Heading that every CrickNote-authored agent guide starts with. Used to tell a
 * CrickNote-managed guide (safe to refresh) apart from a user's own CLAUDE.md /
 * AGENTS.md (must never be clobbered).
 */
const MANAGED_GUIDE_HEADING = '# CrickNote Vault — Agent Guide';

export interface InstalledAgentAssets {
  /** Guides written fresh at the vault root (no file was there before). */
  guidesWritten: string[];
  /** CrickNote-managed guides that were refreshed in place. */
  guidesRefreshed: string[];
  /** A user guide already existed; CrickNote's guidance went to this sidecar instead. */
  sidecarsWritten: string[];
}

/**
 * Copy CrickNote skills and agent guide docs from the repo into the vault.
 * Skills go to both `.claude/skills/` (Claude Code) and `.agents/skills/`
 * (Codex). Copies, not symlinks — robust to vault sync tools; re-running
 * refreshes. Idempotent.
 *
 * The root guides (CLAUDE.md / AGENTS.md) are never clobbered: a fresh vault
 * gets them written, a CrickNote-managed guide is refreshed, but a guide the
 * user wrote themselves is left untouched and CrickNote's guidance is written
 * alongside it as `CrickNote-<doc>` for them to @-import or merge.
 */
export function installAgentAssets(vaultPath: string, repoRoot: string): InstalledAgentAssets {
  const skillsSrc = path.join(repoRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dest of ['.claude', '.agents']) {
      const target = path.join(vaultPath, dest, 'skills');
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(skillsSrc, target, { recursive: true });
    }
  }

  const result: InstalledAgentAssets = { guidesWritten: [], guidesRefreshed: [], sidecarsWritten: [] };
  const docsSrc = path.join(repoRoot, 'templates', 'agent-docs');
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    const src = path.join(docsSrc, doc);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(vaultPath, doc);

    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      result.guidesWritten.push(doc);
      continue;
    }

    const existing = fs.readFileSync(dest, 'utf-8');
    if (existing.trimStart().startsWith(MANAGED_GUIDE_HEADING)) {
      // Our own guide from a previous setup — safe to refresh.
      fs.copyFileSync(src, dest);
      result.guidesRefreshed.push(doc);
    } else {
      // The user's own guide — leave it; drop our guidance beside it.
      const sidecar = `CrickNote-${doc}`;
      fs.copyFileSync(src, path.join(vaultPath, sidecar));
      result.sidecarsWritten.push(sidecar);
    }
  }
  return result;
}
