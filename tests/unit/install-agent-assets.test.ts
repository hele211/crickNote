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
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'CLAUDE.md'), '# CrickNote Vault — Agent Guide\nclaude');
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'AGENTS.md'), '# CrickNote Vault — Agent Guide\nagents');
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('copies skills into both .claude and .agents skill dirs and writes the doc files', () => {
    const result = installAgentAssets(vault, repo);
    expect(fs.existsSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.agents', 'skills', 'cricknote-record-experiment', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toContain('claude');
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf-8')).toContain('agents');
    expect(result.guidesWritten).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(result.sidecarsWritten).toEqual([]);
  });

  it('refreshes a CrickNote-managed guide in place', () => {
    installAgentAssets(vault, repo);
    fs.writeFileSync(path.join(repo, 'templates', 'agent-docs', 'CLAUDE.md'), '# CrickNote Vault — Agent Guide\nclaude v2');
    const result = installAgentAssets(vault, repo);
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toContain('claude v2');
    expect(result.guidesRefreshed).toContain('CLAUDE.md');
    expect(fs.existsSync(path.join(vault, 'CrickNote-CLAUDE.md'))).toBe(false);
  });

  it("never clobbers a user's own CLAUDE.md — writes a sidecar instead", () => {
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# My own project guide\nkeep me');
    const result = installAgentAssets(vault, repo);
    // User's file is untouched.
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe('# My own project guide\nkeep me');
    // CrickNote guidance lands in the sidecar.
    expect(result.sidecarsWritten).toContain('CrickNote-CLAUDE.md');
    expect(fs.readFileSync(path.join(vault, 'CrickNote-CLAUDE.md'), 'utf-8')).toContain('claude');
  });

  it('is idempotent — re-running refreshes skills without error', () => {
    installAgentAssets(vault, repo);
    fs.writeFileSync(path.join(repo, 'skills', 'cricknote-record-experiment', 'SKILL.md'), '# skill v2');
    installAgentAssets(vault, repo);
    expect(fs.readFileSync(path.join(vault, '.claude', 'skills', 'cricknote-record-experiment', 'SKILL.md'), 'utf-8')).toBe('# skill v2');
  });
});
