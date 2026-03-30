import { input, select } from '@inquirer/prompts';
import fs from 'node:fs';
import path from 'node:path';
import { saveConfig, type CrickNoteConfig } from '../config/config.js';
import { generateToken, getTokenPath } from '../server/auth.js';
import { getDatabase, getDataDir, closeDatabase } from '../storage/database.js';

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

  // Step 2: LLM provider
  const provider = await select({
    message: 'Which LLM provider?',
    choices: [
      { name: 'Anthropic Claude', value: 'anthropic' as const },
      { name: 'OpenAI GPT', value: 'openai' as const },
    ],
  });

  // Step 3: API key
  const apiKey = await input({
    message: `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
    validate: (val) => val.length > 0 || 'API key is required',
  });

  // Save config
  const config: CrickNoteConfig = {
    vaultPath: resolvedVaultPath,
    llm: { provider, apiKey },
    server: { host: '127.0.0.1', port: 18789 },
  };
  saveConfig(config);
  console.log(`\u2713 Config saved to ${path.join(getDataDir(), 'config.json')}`);

  // Generate auth token
  generateToken();
  console.log(`\u2713 Auth token generated (${getTokenPath()})`);

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

  // Create vault directories if needed
  for (const dir of ['Projects', 'Protocols', 'Reading', 'Memory/Daily', 'Memory/Weekly', 'Memory/Monthly']) {
    const dirPath = path.join(resolvedVaultPath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
  console.log('\u2713 Vault directories verified');

  // Install Obsidian plugin
  const pluginDir = path.join(resolvedVaultPath, '.obsidian', 'plugins', 'cricknote');
  fs.mkdirSync(pluginDir, { recursive: true });

  // dist/cli/setup.js → dist/ → project root → obsidian-plugin/
  const pluginSourceDir = path.join(import.meta.dirname, '..', '..', 'obsidian-plugin');
  const mainJs = path.join(pluginSourceDir, 'main.js');
  const manifest = path.join(pluginSourceDir, 'manifest.json');
  const styles = path.join(pluginSourceDir, 'styles.css');

  if (!fs.existsSync(mainJs)) {
    console.warn('\u26a0  Plugin bundle not found. Run "npm run build:plugin" first, then re-run setup.');
    console.warn(`  Expected: ${mainJs}`);
  } else {
    fs.copyFileSync(mainJs, path.join(pluginDir, 'main.js'));
    if (fs.existsSync(manifest)) {
      fs.copyFileSync(manifest, path.join(pluginDir, 'manifest.json'));
    }
    if (fs.existsSync(styles)) {
      fs.copyFileSync(styles, path.join(pluginDir, 'styles.css'));
    }
    console.log(`\u2713 Obsidian plugin installed to ${pluginDir}`);
  }

  console.log('\nSetup complete! Start the agent: cricknote start');
  console.log('Then enable CrickNote in Obsidian → Settings → Community Plugins.\n');
}
