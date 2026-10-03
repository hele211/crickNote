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
import { createStyleLintTools } from './tools/style-lint.js';
import { loadConfig } from '../config/config.js';

/**
 * Resolve the vault-relative attachments directory for the reading-intake
 * pipeline. Mirrors where zotero_prepare_bundle writes PDFs
 * (config.zotero.vault_pdf_dir) so discover/ingest/compile read from the same
 * place a Zotero bundle was written to. Defaults to 'Reading/attachments' and
 * never throws — a missing or unreadable config falls back to the default.
 */
function resolveAttachmentsDir(): string {
  try {
    return loadConfig().zotero?.vault_pdf_dir ?? 'Reading/attachments';
  } catch {
    return 'Reading/attachments';
  }
}

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

  const attachmentsDir = resolveAttachmentsDir();

  add(createVaultTools(vaultPath, conflictDetector, db));
  add(createSearchTools(db));
  add(createTaskTools(vaultPath, conflictDetector));
  add(createTemplateTools(vaultPath, conflictDetector, attachmentsDir));
  add(createReadingIntakeTools(vaultPath, conflictDetector, attachmentsDir));
  add(createContextTools(vaultPath));
  add(createSerialTools(vaultPath, db));
  add(createKbTools(vaultPath, undefined, attachmentsDir));
  add(createZoteroTools(vaultPath));
  add(createStyleLintTools(vaultPath));

  return registry;
}
