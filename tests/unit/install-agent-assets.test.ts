import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgentAssets } from '../../src/cli/install-agent-assets.js';

describe('installAgentAssets', () => {
  let vault: string;
  let repo: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.mkdirSync(path.join(repo, 'skills', 'cricknote-record-experiment'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills', 'cricknote-record-experiment', 'SKILL.md'), '# skill');
    fs.mkdirSync(path.join(repo, 'templates', 'agent-docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'CLAUDE.md'), '# claude');
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'AGENTS.md'), '# agents');
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('copies skills into both .claude and .agents skill dirs and writes the doc files', () => {
    installAgentAssets(vault, repo);
    expect(fs.existsSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.agents', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe('# claude');
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf-8')).toBe('# agents');
  });

  it('is idempotent — re-running refreshes without error', () => {
    installAgentAssets(vault, repo);
    fs.writeFileSync(path.join(repo, 'skills', 'cricknote-record-experiment', 'SKILL.md'), '# skill v2');
    installAgentAssets(vault, repo);
    expect(fs.readFileSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'), 'utf-8')).toBe('# skill v2');
  });
});
