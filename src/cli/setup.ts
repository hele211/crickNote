import { input } from '@inquirer/prompts';
import fs from 'node:fs';
import path from 'node:path';
import { saveConfig, type CrickNoteConfig } from '../config/config.js';
import { getDatabase, getDataDir, closeDatabase } from '../storage/database.js';
import { rebuildKnowledgeIndex } from '../knowledge/index-builder.js';
import { DEFAULT_TEMPLATE_FILES, renderFolderReadmeSync } from '../templates/template-loader.js';
import { installAgentAssets } from './install-agent-assets.js';

const VAULT_DIRS = [
  'Projects', 'Protocols',
  'Reading', 'Reading/Papers', 'Reading/Threads', 'Reading/attachments',
  'Memory/Daily', 'Memory/Weekly', 'Memory/Monthly',
  'Knowledge', 'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
  'Knowledge/Review-Queue', 'Knowledge/_Ops', 'Knowledge/_Ops/Update-Logs', 'Knowledge/_Ops/Lint-Reports',
] as const;

export function ensureVaultScaffold(vaultPath: string): void {
  for (const dir of VAULT_DIRS) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
    rebuildKnowledgeIndex(kind, vaultPath);
  }

  // Scaffold Agent/templates/ with default files — never overwrite existing files
  const templatesDir = path.join(vaultPath, 'Agent', 'templates');
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }
  for (const [filename, content] of Object.entries(DEFAULT_TEMPLATE_FILES)) {
    const filePath = path.join(templatesDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }

  // Scaffold _README.md stubs in root content folders and existing subfolders.
  // Never overwrite a file the scientist has already written.
  const today = new Date().toISOString().slice(0, 10);
  const readmeDirs = scaffoldReadmeDirs(vaultPath);
  for (const dir of readmeDirs) {
    const readmePath = path.join(dir, '_README.md');
    if (!fs.existsSync(readmePath)) {
      const title = path.basename(dir);
      fs.writeFileSync(readmePath, renderFolderReadmeSync(vaultPath, title, today), 'utf-8');
    }
  }
}

/**
 * Collect all directories that should receive a _README.md stub:
 * - Root content folders: Projects/, Reading/Papers, Reading/Threads,
 *   Knowledge/Concepts, Knowledge/Entities, Knowledge/Methods
 * - Their immediate non-ignored subdirectories (one level deep)
 *
 * Ignored: attachments/, _Ops/, hidden dirs (start with .)
 */
function scaffoldReadmeDirs(vaultPath: string): string[] {
  const rootContentDirs = [
    path.join(vaultPath, 'Projects'),
    path.join(vaultPath, 'Reading', 'Papers'),
    path.join(vaultPath, 'Reading', 'Threads'),
    path.join(vaultPath, 'Knowledge', 'Concepts'),
    path.join(vaultPath, 'Knowledge', 'Entities'),
    path.join(vaultPath, 'Knowledge', 'Methods'),
  ];

  const result: string[] = [];
  for (const dir of rootContentDirs) {
    if (!fs.existsSync(dir)) continue;
    result.push(dir);
    // Walk one level of subdirectories
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'attachments' || entry.name === '_Ops' || entry.name === 'Review-Queue') continue;
      result.push(path.join(dir, entry.name));
    }
  }
  return result;
}

export async function setup(): Promise<void> {
  console.log('\nWelcome to CrickNote!\n');

  // Step 1: Vault path
  const vaultPath = await input({
    message: 'Where is your Obsidian vault?',
    validate: (val) => {
      if (!fs.existsSync(val)) return 'Directory does not exist';
      return true;
    },
  });

  const resolvedVaultPath = path.resolve(vaultPath);

  // Save config. The agent (Claude Code / Codex) provides the language model,
  // so CrickNote stores no provider/API-key config of its own.
  const config: CrickNoteConfig = {
    vaultPath: resolvedVaultPath,
  };
  saveConfig(config);
  console.log(`\u2713 Config saved to ${path.join(getDataDir(), 'config.json')}`);

  // Repo root is two levels up from dist/cli/ (or src/cli/ in dev).
  // dist/cli/setup.js -> dist/cli/../../ = repo root (skills/ and templates/ live there, not under dist/).
  // src/cli/setup.ts  -> src/cli/../../  = repo root (same relative path works in both modes).
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  try {
    installAgentAssets(resolvedVaultPath, repoRoot);
    console.log('Installed CrickNote skills and agent guides into the vault.');
  } catch (err) {
    console.warn(`Could not install agent assets: ${(err as Error).message}`);
  }

  // Initialize database
  const dbPath = path.join(getDataDir(), 'db.sqlite');
  getDatabase(dbPath);
  closeDatabase();
  console.log(`\u2713 Database initialized (${dbPath})`);

  // Create vault Agent directory if needed
  const agentDir = path.join(resolvedVaultPath, 'Agent');
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'agent.md'),
      '# CrickNote Agent\n\nYou are a scientific research assistant helping with biology experiments.\n'
    );
    fs.writeFileSync(
      path.join(agentDir, 'soul.md'),
      '# Personality\n\nBe precise, helpful, and scientifically rigorous.\n'
    );
    fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    console.log(`\u2713 Agent config created in vault (${agentDir})`);
  }

  // Create vault directories and initial KB indexes if needed
  ensureVaultScaffold(resolvedVaultPath);
  console.log('\u2713 Vault directories verified');

  console.log('\nSetup complete!');
  console.log('Run Claude Code or Codex from your vault directory and start a lab session.');
  console.log('Tools: `cricknote tools` lists them; `cricknote reindex` refreshes search.\n');
}
