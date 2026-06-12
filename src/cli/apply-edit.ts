import path from 'node:path';
import type Database from 'better-sqlite3';
import { SafeWriter } from '../editing/safe-writer.js';
import { appendFolderChangelog } from '../editing/changelog.js';
import { indexFileSync } from '../ingestion/index-file.js';

export interface PendingEditPayload {
  /** Absolute path emitted by the tool (already vault-resolved). */
  path: string;
  newContent: string;
  operation?: string;
  reservation?: { project_id: string; prefix?: string };
  meta?: Record<string, unknown>;
  warnings?: string[];
}

export interface AppliedEdit {
  path: string;
  operation: string;
  applied: boolean;
  error?: string;
  warnings?: string[];
}

export interface ApplyContext {
  vaultRoot: string;
  sessionId: string;
  triggerQuery: string;
  safeWriter: SafeWriter;
  db: Database.Database;
}

function withinVault(absPath: string, vaultRoot: string): boolean {
  const normalized = path.normalize(absPath);
  return path.isAbsolute(normalized) &&
    (normalized === vaultRoot || normalized.startsWith(vaultRoot + path.sep));
}

/**
 * Apply one pending_edit: atomic write + audit log (via SafeWriter),
 * then reservation finalize, folder changelog, and incremental index —
 * mirroring exactly what AgentRuntime.confirmEdit did for the Obsidian UI.
 */
export function applyPendingEdit(edit: PendingEditPayload, ctx: ApplyContext): AppliedEdit {
  const { vaultRoot, sessionId, triggerQuery, safeWriter, db } = ctx;
  const operation = edit.operation ?? 'edit';
  const absPath = path.normalize(edit.path);

  if (!withinVault(absPath, vaultRoot)) {
    return { path: edit.path, operation, applied: false, error: 'Path escapes vault boundary' };
  }

  const meta: Record<string, unknown> = { operation, path: edit.path };
  if (edit.reservation) Object.assign(meta, edit.reservation);
  if (edit.meta) Object.assign(meta, edit.meta);

  const proposal = safeWriter.proposeEdit(absPath, edit.newContent, triggerQuery, sessionId, meta);
  const result = safeWriter.confirmEdit(proposal.editId, 'apply');

  if (!result.success) {
    if (edit.reservation) {
      db.prepare('DELETE FROM prefix_reservations WHERE project_id = ?').run(edit.reservation.project_id);
    }
    return { path: edit.path, operation, applied: false, error: result.error ?? 'write failed', warnings: edit.warnings };
  }

  if (edit.reservation) {
    db.prepare('UPDATE prefix_reservations SET edit_id = ? WHERE project_id = ?')
      .run(proposal.editId, edit.reservation.project_id);
  }

  const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');
  try {
    appendFolderChangelog({ vaultPath: vaultRoot, targetPath: relPath, operation, description: `${relPath} written` });
  } catch {
    // changelog failure must not fail the apply
  }
  try {
    indexFileSync(relPath, vaultRoot, db);
  } catch {
    // index failure must not fail the apply; a later reindex will recover
  }

  return { path: edit.path, operation, applied: true, warnings: edit.warnings };
}
