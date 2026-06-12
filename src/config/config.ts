import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '../storage/database.js';

export interface ZoteroConfig {
  enabled: boolean;
  api_port: number;
  storage_root: string;
  vault_pdf_dir: string;
  bbt_export_path?: string;
  auto_summarize: boolean;
}

export function normalizeZoteroConfig(raw: Partial<ZoteroConfig> | undefined, vaultPath?: string): ZoteroConfig {
  const defaults: ZoteroConfig = {
    enabled: false,
    api_port: 23119,
    storage_root: path.join(os.homedir(), 'Zotero', 'storage'),
    vault_pdf_dir: 'Reading/attachments',
    auto_summarize: true,
  };
  const merged: ZoteroConfig = { ...defaults, ...(raw ?? {}) };

  if (merged.storage_root.startsWith('~/')) {
    merged.storage_root = path.join(os.homedir(), merged.storage_root.slice(2));
  }

  if (!Number.isInteger(merged.api_port) || merged.api_port < 1 || merged.api_port > 65535) {
    throw new Error(`Invalid Zotero config: api_port must be 1–65535, got ${merged.api_port}`);
  }

  if (!merged.vault_pdf_dir || merged.vault_pdf_dir.trim() === '') {
    throw new Error(`Invalid Zotero config: vault_pdf_dir must not be empty`);
  }
  if (path.isAbsolute(merged.vault_pdf_dir)) {
    throw new Error(`Invalid Zotero config: vault_pdf_dir must be a relative path, got "${merged.vault_pdf_dir}"`);
  }
  const normalizedPdfDir = path.normalize(merged.vault_pdf_dir);
  if (normalizedPdfDir.startsWith('..')) {
    throw new Error(`Invalid Zotero config: vault_pdf_dir must not escape the vault, got "${merged.vault_pdf_dir}"`);
  }
  merged.vault_pdf_dir = normalizedPdfDir;

  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(merged.storage_root);
  } catch {
    resolvedRoot = path.resolve(merged.storage_root);
  }
  if (resolvedRoot === '/' || resolvedRoot === os.homedir()) {
    throw new Error(`Invalid Zotero config: storage_root "${merged.storage_root}" resolves to an unsafe path`);
  }

  if (vaultPath) {
    let resolvedVault: string;
    try {
      resolvedVault = fs.realpathSync(vaultPath);
    } catch {
      resolvedVault = path.resolve(vaultPath);
    }
    const sep = path.sep;
    const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    const vaultWithSep = resolvedVault.endsWith(sep) ? resolvedVault : resolvedVault + sep;
    if (
      resolvedRoot === resolvedVault ||
      vaultWithSep.startsWith(rootWithSep) ||
      rootWithSep.startsWith(vaultWithSep)
    ) {
      throw new Error(
        `Invalid Zotero config: storage_root "${merged.storage_root}" overlaps with vault path "${vaultPath}"`
      );
    }
  }

  merged.storage_root = resolvedRoot;
  return merged;
}

export interface CrickNoteConfig {
  vaultPath: string;
  zotero?: ZoteroConfig;
}

let cachedConfig: CrickNoteConfig | null = null;

export function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

export function loadConfig(): CrickNoteConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}. Run "cricknote setup" first.`
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const config = { ...raw } as CrickNoteConfig;

  // Runtime validation of critical fields
  const errors: string[] = [];
  if (!config.vaultPath || typeof config.vaultPath !== 'string') {
    errors.push('vaultPath must be a non-empty string');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid config at ${configPath}:\n  - ${errors.join('\n  - ')}`);
  }

  if (raw.zotero !== undefined) {
    config.zotero = normalizeZoteroConfig(raw.zotero, config.vaultPath);
  }

  cachedConfig = config;
  return cachedConfig;
}

export function saveConfig(config: CrickNoteConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  cachedConfig = config;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function loadAgentConfig(vaultPath: string): { agentMd: string; soulMd: string; skills: string[] } {
  const agentDir = path.join(vaultPath, 'Agent');
  const agentMdPath = path.join(agentDir, 'agent.md');
  const soulMdPath = path.join(agentDir, 'soul.md');
  const skillsDir = path.join(agentDir, 'skills');

  const agentMd = fs.existsSync(agentMdPath) ? fs.readFileSync(agentMdPath, 'utf-8') : '';
  const soulMd = fs.existsSync(soulMdPath) ? fs.readFileSync(soulMdPath, 'utf-8') : '';

  let skills: string[] = [];
  if (fs.existsSync(skillsDir)) {
    skills = fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => fs.readFileSync(path.join(skillsDir, f), 'utf-8'));
  }

  return { agentMd, soulMd, skills };
}

export function loadExperimentTypes(vaultPath: string): Array<{ name: string; aliases: string[] }> {
  const typesPath = path.join(vaultPath, 'Agent', 'experiment-types.yml');
  if (!fs.existsSync(typesPath)) return [];

  // Simple YAML parser for the seed file format
  const content = fs.readFileSync(typesPath, 'utf-8');
  const types: Array<{ name: string; aliases: string[] }> = [];
  let current: { name: string; aliases: string[] } | null = null;

  for (const line of content.split('\n')) {
    const nameMatch = line.match(/^-\s+name:\s+(.+)/);
    const aliasMatch = line.match(/^\s+aliases:\s+\[(.+)\]/);

    if (nameMatch) {
      if (current) types.push(current);
      current = { name: nameMatch[1].trim(), aliases: [] };
    } else if (aliasMatch && current) {
      current.aliases = aliasMatch[1].split(',').map(a => a.trim().replace(/^["']|["']$/g, ''));
    }
  }
  if (current) types.push(current);

  return types;
}
