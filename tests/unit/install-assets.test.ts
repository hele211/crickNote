import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installAssets, refreshAgentAssets } from '../../src/cli/install-assets.js';
import { resetConfigCache } from '../../src/config/config.js';

describe('refreshAgentAssets', () => {
  let vault: string;
  let repo: string;

  const write = (root: string, rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-vault-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-repo-'));
    write(repo, 'skills/cricknote-reading-intake/SKILL.md', '# intake v2');
    write(repo, 'skills/_shared/readable-output.md', '# guide');
    write(repo, 'skills/_shared/examples/reading-note-v2.md', '# example');
    write(repo, 'templates/agent-docs/CLAUDE.md', '# claude v2');
    write(repo, 'templates/agent-docs/AGENTS.md', '# agents v2');
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('copies skills (including _shared/) into .claude and .agents and writes the guides', () => {
    const report = refreshAgentAssets(vault, repo);
    for (const root of ['.claude', '.agents']) {
      expect(fs.readFileSync(path.join(vault, root, 'skills/_shared/readable-output.md'), 'utf-8')).toBe('# guide');
      expect(fs.readFileSync(path.join(vault, root, 'skills/_shared/examples/reading-note-v2.md'), 'utf-8')).toBe('# example');
      expect(fs.readFileSync(path.join(vault, root, 'skills/cricknote-reading-intake/SKILL.md'), 'utf-8')).toBe('# intake v2');
    }
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe('# claude v2');
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf-8')).toBe('# agents v2');
    expect(report.dryRun).toBe(false);
    expect(report.docs).toEqual([
      { file: 'CLAUDE.md', status: 'new' },
      { file: 'AGENTS.md', status: 'new' },
    ]);
  });

  it('leaves extra user skills untouched', () => {
    write(vault, '.agents/skills/cricknote-add-paper-link/SKILL.md', '# mine');
    write(vault, '.claude/skills/my-own/SKILL.md', '# mine too');
    refreshAgentAssets(vault, repo);
    expect(fs.readFileSync(path.join(vault, '.agents/skills/cricknote-add-paper-link/SKILL.md'), 'utf-8')).toBe('# mine');
    expect(fs.readFileSync(path.join(vault, '.claude/skills/my-own/SKILL.md'), 'utf-8')).toBe('# mine too');
  });

  it('reports which guides it would overwrite, and writes nothing in dry-run mode', () => {
    write(vault, 'CLAUDE.md', '# older claude');
    write(vault, 'AGENTS.md', '# agents v2');
    write(vault, '.claude/skills/cricknote-reading-intake/SKILL.md', '# intake v1');
    const report = refreshAgentAssets(vault, repo, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.docs).toEqual([
      { file: 'CLAUDE.md', status: 'overwritten' },
      { file: 'AGENTS.md', status: 'unchanged' },
    ]);
    expect(report.skillFiles.changed).toBeGreaterThanOrEqual(1);
    expect(report.skillFiles.new).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe('# older claude');
    expect(fs.readFileSync(path.join(vault, '.claude/skills/cricknote-reading-intake/SKILL.md'), 'utf-8')).toBe('# intake v1');
    expect(fs.existsSync(path.join(vault, '.agents'))).toBe(false);
  });
});

describe('installAssets (config-driven)', () => {
  let dataDir: string;
  let vault: string;
  let repo: string;
  const previousEnv = process.env.CRICKNOTE_DATA_DIR;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-data-'));
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-vault-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-repo-'));
    fs.mkdirSync(path.join(repo, 'skills', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', 'x', 'SKILL.md'), '# x');
    fs.mkdirSync(path.join(repo, 'templates', 'agent-docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'CLAUDE.md'), '# claude');
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'AGENTS.md'), '# agents');
    process.env.CRICKNOTE_DATA_DIR = dataDir;
    resetConfigCache();
  });
  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CRICKNOTE_DATA_DIR;
    else process.env.CRICKNOTE_DATA_DIR = previousEnv;
    resetConfigCache();
    for (const d of [dataDir, vault, repo]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('installs into the configured vault and leaves config.json byte-identical (zotero block intact)', () => {
    const config = JSON.stringify({ vaultPath: vault, zotero: { enabled: true, api_port: 23119, vault_pdf_dir: 'Reading/custom', auto_summarize: true } }, null, 2);
    fs.writeFileSync(path.join(dataDir, 'config.json'), config);

    const report = installAssets({ repoRoot: repo });

    expect(report.vaultPath).toBe(vault);
    expect(fs.readFileSync(path.join(vault, '.claude/skills/x/SKILL.md'), 'utf-8')).toBe('# x');
    expect(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8')).toBe(config);
  });

  it('follows the CRICKNOTE_DATA_DIR override, so a scratch vault never touches the real one', () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ vaultPath: vault }));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-other-'));
    try {
      installAssets({ repoRoot: repo });
      expect(fs.existsSync(path.join(vault, 'CLAUDE.md'))).toBe(true);
      expect(fs.readdirSync(other)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('fails clearly when there is no config', () => {
    expect(() => installAssets({ repoRoot: repo })).toThrow(/Config file not found/);
  });
});
