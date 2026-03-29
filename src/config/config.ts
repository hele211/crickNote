import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../storage/database.js';

export interface CrickNoteConfig {
  vaultPath: string;
  llm: {
    provider: 'anthropic' | 'openai';
    apiKey: string;
    model?: string;
  };
  embeddingModelPath?: string;
  server: {
    host: string;
    port: number;
  };
}

const DEFAULT_CONFIG: Partial<CrickNoteConfig> = {
  server: {
    host: '127.0.0.1',
    port: 18789,
  },
};

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
  cachedConfig = { ...DEFAULT_CONFIG, ...raw } as CrickNoteConfig;
  return cachedConfig;
}

export function saveConfig(config: CrickNoteConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
