import fs from 'node:fs';
import path from 'node:path';

/**
 * Copy CrickNote skills and agent guide docs from the repo into the vault.
 * Skills go to both `.claude/skills/` (Claude Code) and `.agents/skills/`
 * (Codex). Copies, not symlinks — robust to vault sync tools; re-running
 * refreshes. Idempotent.
 */
export function installAgentAssets(vaultPath: string, repoRoot: string): void {
  const skillsSrc = path.join(repoRoot, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const dest of ['.claude', '.agents']) {
      const target = path.join(vaultPath, dest, 'skills');
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(skillsSrc, target, { recursive: true });
    }
  }

  const docsSrc = path.join(repoRoot, 'templates', 'agent-docs');
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    const src = path.join(docsSrc, doc);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(vaultPath, doc));
    }
  }
}
