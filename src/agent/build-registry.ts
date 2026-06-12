import type Database from 'better-sqlite3';
import { ToolRegistry, type ToolHandler } from './tools/registry.js';
import type { ConflictDetector } from '../editing/conflict-detector.js';
import { createVaultTools } from './tools/vault.js';
import { createSearchTools } from './tools/search.js';
import { createTaskTools } from './tools/tasks.js';
import { createTemplateTools } from './tools/templates.js';
import { createReadingIntakeTools } from './tools/reading-intake.js';
import { createContextTools } from './tools/context.js';
import { createSerialTools } from './tools/serial-tools.js';
import { createKbTools } from './tools/kb-tools.js';
import { createZoteroTools } from './tools/zotero-tools.js';

/**
 * Build the complete CrickNote tool registry. Shared by the Obsidian runtime
 * and the CLI dispatcher so both expose an identical tool surface.
 *
 * @param vaultPath   Vault root (unresolved config path is fine).
 * @param conflictDetector Optional; passed to tools that record read snapshots.
 *                    The CLI passes a throwaway detector (no snapshots → no
 *                    spurious conflicts in a fresh process).
 * @param db          Optional injected database (tests / explicit handle).
 */
export function buildToolRegistry(
  vaultPath: string,
  conflictDetector?: ConflictDetector,
  db?: Database.Database,
): ToolRegistry {
  const registry = new ToolRegistry();
  const add = (handlers: ToolHandler[]) => {
    for (const h of handlers) registry.register(h);
  };

  add(createVaultTools(vaultPath, conflictDetector, db));
  add(createSearchTools(db));
  add(createTaskTools(vaultPath, conflictDetector));
  add(createTemplateTools(vaultPath, conflictDetector));
  add(createReadingIntakeTools(vaultPath, conflictDetector));
  add(createContextTools(vaultPath));
  add(createSerialTools(vaultPath, db));
  add(createKbTools(vaultPath));
  add(createZoteroTools(vaultPath));

  return registry;
}
