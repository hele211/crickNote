import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildToolRegistry } from '../agent/build-registry.js';
import { ConflictDetector } from '../editing/conflict-detector.js';
import { SafeWriter } from '../editing/safe-writer.js';
import { getDatabase } from '../storage/database.js';
import { applyPendingEdit, type PendingEditPayload, type AppliedEdit } from './apply-edit.js';
import type { ToolContext } from '../agent/tools/registry.js';

export interface RunToolOptions {
  vaultPath: string;
  sessionId: string;
  apply: boolean;
  db?: Database.Database;
}

export interface RunToolOutput {
  ok: boolean;
  result?: unknown;        // raw tool result (parsed JSON, or string)
  applied?: AppliedEdit[]; // present when pending edits were applied
  error?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  parameters: unknown;
}

function resolveVaultRoot(vaultPath: string): string {
  try {
    return fs.realpathSync(vaultPath);
  } catch {
    return path.resolve(vaultPath);
  }
}

/** Execute one tool by name with JSON args; apply any pending edits it returns. */
export async function runTool(name: string, argsJson: string, opts: RunToolOptions): Promise<RunToolOutput> {
  const db = opts.db ?? getDatabase();
  const registry = buildToolRegistry(opts.vaultPath, new ConflictDetector(), db);

  if (!registry.has(name)) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    return { ok: false, error: `Invalid JSON arguments: ${(err as Error).message}` };
  }

  const context: ToolContext = { sessionId: opts.sessionId, vaultPath: opts.vaultPath };
  const raw = await registry.execute({ id: crypto.randomUUID(), name, arguments: args }, context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: true, result: raw };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj && typeof obj === 'object' && typeof obj.error === 'string') {
    return { ok: false, error: obj.error, result: parsed };
  }

  if (!opts.apply) {
    return { ok: true, result: parsed };
  }

  const edits: PendingEditPayload[] = [];
  if (obj?.type === 'pending_edit') {
    edits.push(obj as unknown as PendingEditPayload);
  } else if (obj?.type === 'pending_edits' && Array.isArray(obj.edits)) {
    for (const e of obj.edits as PendingEditPayload[]) edits.push(e);
  }

  if (edits.length === 0) {
    return { ok: true, result: parsed };
  }

  const vaultRoot = resolveVaultRoot(opts.vaultPath);

  // Pre-flight: reject the whole batch if any member escapes the vault, before writing any file.
  for (const e of edits) {
    const abs = path.normalize(e.path);
    if (!path.isAbsolute(abs) || (abs !== vaultRoot && !abs.startsWith(vaultRoot + path.sep))) {
      return { ok: false, error: `Path escapes vault boundary: ${e.path}` };
    }
  }

  const safeWriter = new SafeWriter();
  const applied: AppliedEdit[] = [];
  for (const e of edits) {
    applied.push(applyPendingEdit(e, { vaultRoot, sessionId: opts.sessionId, triggerQuery: `cli:${name}`, safeWriter, db }));
  }

  const allApplied = applied.every(a => a.applied);
  return { ok: allApplied, applied, result: parsed, error: allApplied ? undefined : 'one or more edits failed' };
}

/** Return the full tool catalog (name, description, JSON-schema parameters). */
export function listToolCatalog(vaultPath: string, db?: Database.Database): ToolCatalogEntry[] {
  const registry = buildToolRegistry(vaultPath, new ConflictDetector(), db ?? getDatabase());
  return registry.getDefinitions().map(d => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
  }));
}
