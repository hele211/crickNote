#!/usr/bin/env node

import { Command } from 'commander';
import crypto from 'node:crypto';
import { setup } from './cli/setup.js';
import { reindex } from './cli/reindex.js';
import { loadConfig } from './config/config.js';
import { runTool, listToolCatalog } from './cli/tool-dispatch.js';

const program = new Command();

program
  .name('cricknote')
  .description('Scientific research assistant for Obsidian')
  .version('0.1.0');

program
  .command('setup')
  .description('First-time setup: configure your vault and install agent skills')
  .action(async () => {
    await setup();
  });

program
  .command('reindex')
  .description('Force a full vault re-index')
  .action(async () => {
    await reindex();
  });


program
  .command('tool <name> [argsJson]')
  .description('Execute a CrickNote tool with JSON arguments (for AI agents)')
  .option('--session <id>', 'Session id for audit attribution')
  .option('--no-apply', 'Return pending edits without writing them')
  .action(async (name: string, argsJson: string | undefined, options: { session?: string; apply: boolean }) => {
    const config = loadConfig();
    const out = await runTool(name, argsJson ?? '{}', {
      vaultPath: config.vaultPath,
      sessionId: options.session ?? `cli-${crypto.randomUUID().slice(0, 8)}`,
      apply: options.apply,
    });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(out.ok ? 0 : 1);
  });

program
  .command('tools')
  .description('List the CrickNote tool catalog (name, description, parameters)')
  .action(() => {
    const config = loadConfig();
    process.stdout.write(JSON.stringify(listToolCatalog(config.vaultPath), null, 2) + '\n');
  });

program.parse();
