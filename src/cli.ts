#!/usr/bin/env node

import { Command } from 'commander';
import { setup } from './cli/setup.js';
import { start } from './cli/start.js';
import { reindex } from './cli/reindex.js';
import { rotateToken } from './server/auth.js';

const program = new Command();

program
  .name('cricknote')
  .description('Scientific research assistant for Obsidian')
  .version('0.1.0');

program
  .command('setup')
  .description('First-time setup: configure vault, LLM, and install plugin')
  .action(async () => {
    await setup();
  });

program
  .command('start')
  .description('Start the CrickNote agent service')
  .action(async () => {
    await start();
  });

program
  .command('reindex')
  .description('Force a full vault re-index')
  .action(async () => {
    await reindex();
  });

program
  .command('rotate-token')
  .description('Generate a new auth token')
  .action(() => {
    const token = rotateToken();
    console.log('New auth token generated.');
    console.log('Restart the agent service and Obsidian plugin to use the new token.');
  });

program.parse();
