import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConflictDetector } from './conflict-detector.js';
import { generateDiff, generateThreeWayDiff } from './diff-generator.js';
import { logEdit, getLastEdit } from '../storage/audit.js';
import { logger } from '../utils/logger.js';

const log = logger.child('safe-writer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditProposal {
  editId: string;
  filePath: string;
  diff: string;
  hasConflict: boolean;
  newContent: string;
  conflictDetails?: {
    original: string;
    current: string;
    proposed: string;
  };
}

export type ConfirmAction = 'apply' | 'force' | 'cancel';

export interface ConfirmResult {
  success: boolean;
  editId: string;
  action: ConfirmAction;
  error?: string;
}

// ---------------------------------------------------------------------------
// SafeWriter
// ---------------------------------------------------------------------------

/**
 * Atomic file writer implementing the full safe-edit pipeline:
 *
 *   conflict check → diff preview → user confirmation →
 *   final hash check → audit log → atomic write (tmp + rename)
 */
export class SafeWriter {
  private conflictDetector: ConflictDetector;
  private pendingEdits: Map<string, EditProposal & { triggerQuery: string; sessionId: string; createdAt: number; meta: Record<string, unknown> }> = new Map();

  constructor(conflictDetector?: ConflictDetector) {
    this.conflictDetector = conflictDetector ?? new ConflictDetector();
  }

  /**
   * Access the underlying conflict detector (e.g., for recording file reads).
   */
  getConflictDetector(): ConflictDetector {
    return this.conflictDetector;
  }

  // -----------------------------------------------------------------------
  // Propose
  // -----------------------------------------------------------------------

  /**
   * Build an edit proposal: detect conflicts, generate diff, and store
   * the proposal for later confirmation.
   *
   * @returns An EditProposal that the caller can present to the user.
   */
  proposeEdit(
    filePath: string,
    newContent: string,
    triggerQuery: string,
    sessionId: string,
    meta: Record<string, unknown> = {},
  ): EditProposal {
    const editId = crypto.randomUUID();

    // --- Conflict detection ------------------------------------------------
    const conflictResult = this.conflictDetector.checkConflict(filePath, newContent);

    // --- Diff generation ---------------------------------------------------
    let diff: string;
    let conflictDetails: EditProposal['conflictDetails'];

    if (conflictResult.hasConflict && conflictResult.originalContent !== undefined && conflictResult.currentContent !== undefined) {
      // Real conflict — produce a three-way diff.
      diff = generateThreeWayDiff(
        conflictResult.originalContent,
        conflictResult.currentContent,
        newContent,
        filePath,
      );
      conflictDetails = {
        original: conflictResult.originalContent,
        current: conflictResult.currentContent,
        proposed: newContent,
      };
    } else {
      // No conflict (or new file) — produce a normal unified diff.
      const beforeContent = this.readFileOrEmpty(filePath);
      diff = generateDiff(beforeContent, newContent, filePath);
    }

    const proposal: EditProposal = {
      editId,
      filePath,
      diff,
      hasConflict: conflictResult.hasConflict,
      newContent,
      conflictDetails,
    };

    // Store internally so confirmEdit can retrieve it.
    this.pendingEdits.set(editId, { ...proposal, triggerQuery, sessionId, createdAt: Date.now(), meta });

    log.info('Edit proposed', { editId, filePath, hasConflict: conflictResult.hasConflict });
    return proposal;
  }

  // -----------------------------------------------------------------------
  // Confirm
  // -----------------------------------------------------------------------

  /**
   * Execute (or cancel) a previously proposed edit.
   *
   * - `apply`  — write if there is no conflict (rejects if a new conflict arose).
   * - `force`  — write regardless of conflict state.
   * - `cancel` — discard the proposal.
   */
  confirmEdit(editId: string, action: ConfirmAction): ConfirmResult {
    const EDIT_TTL_MS = 30 * 60 * 1000;
    const pending = this.pendingEdits.get(editId);
    if (!pending) {
      return { success: false, editId, action, error: 'Edit proposal not found or already resolved.' };
    }
    if (Date.now() - pending.createdAt > EDIT_TTL_MS) {
      this.pendingEdits.delete(editId);
      return { success: false, editId, action, error: 'Edit expired — please re-run the tool to generate a fresh edit.' };
    }

    // Cancel path — just clean up.
    if (action === 'cancel') {
      this.pendingEdits.delete(editId);
      return { success: true, editId, action };
    }

    // --- Final hash check right before writing (race-condition guard) ------
    const finalConflict = this.conflictDetector.checkConflict(pending.filePath, pending.newContent);
    if (finalConflict.hasConflict && action !== 'force') {
      // A new conflict appeared between propose and confirm.
      return {
        success: false,
        editId,
        action,
        error: 'File was modified after the proposal was created. Use "force" to overwrite, or re-propose.',
      };
    }

    // --- Read current content for the audit log ----------------------------
    const beforeContent = this.readFileOrEmpty(pending.filePath);
    const beforeHash = this.computeHash(beforeContent);
    const afterHash = this.computeHash(pending.newContent);
    const operation = beforeContent === '' ? 'create' : 'update';

    // --- Atomic write: tmp → rename ----------------------------------------
    try {
      this.atomicWrite(pending.filePath, pending.newContent);
    } catch (err) {
      return {
        success: false,
        editId,
        action,
        error: `Atomic write failed: ${(err as Error).message}`,
      };
    }

    // --- Audit log ---------------------------------------------------------
    // Audit failure is non-fatal: the file was already written successfully.
    // Catch separately so a DB problem never surfaces as a write failure.
    try {
      logEdit({
        timestamp: Date.now(),
        file_path: pending.filePath,
        operation: operation as 'create' | 'update',
        before_content: beforeContent || null,
        after_content: pending.newContent,
        before_hash: beforeContent ? beforeHash : null,
        after_hash: afterHash,
        trigger_query: pending.triggerQuery,
        session_id: pending.sessionId,
      });
    } catch (auditErr) {
      log.error('Audit log failed', { filePath: pending.filePath, error: (auditErr as Error).message });
    }

    // --- Update snapshot so future checks work -----------------------------
    this.conflictDetector.recordFileRead(pending.filePath, pending.newContent);

    // --- Clean up ----------------------------------------------------------
    this.pendingEdits.delete(editId);
    return { success: true, editId, action };
  }

  /**
   * Return metadata from a pending edit without consuming it.
   * Must be called BEFORE confirmEdit (which deletes the entry on success/cancel).
   */
  getPendingEditMeta(editId: string): Record<string, unknown> | undefined {
    return this.pendingEdits.get(editId)?.meta;
  }

  /**
   * Check whether an edit can be applied without writing it.
   * Used to preflight all members of a batch before committing any.
   */
  preflightEdit(editId: string, action: ConfirmAction): { ok: boolean; error?: string } {
    const EDIT_TTL_MS = 30 * 60 * 1000;
    const pending = this.pendingEdits.get(editId);
    if (!pending) return { ok: false, error: 'Edit proposal not found or already resolved.' };
    if (Date.now() - pending.createdAt > EDIT_TTL_MS) return { ok: false, error: 'Edit expired.' };
    if (action === 'cancel') return { ok: true };
    const finalConflict = this.conflictDetector.checkConflict(pending.filePath, pending.newContent);
    if (finalConflict.hasConflict && action !== 'force') {
      return { ok: false, error: 'File was modified after the proposal was created — use force or re-propose.' };
    }
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Remove all pending edits associated with a given session.
   * Called when a client disconnects so stale proposals don't accumulate.
   */
  cleanupSession(sessionId: string): number {
    let removed = 0;
    for (const [editId, pending] of this.pendingEdits) {
      if (pending.sessionId === sessionId) {
        this.pendingEdits.delete(editId);
        removed++;
      }
    }
    if (removed > 0) {
      log.info('Cleaned up pending edits for disconnected session', { sessionId, removed });
    }
    return removed;
  }

  /**
   * Remove pending edits older than `ttlMs` (default: 30 minutes).
   */
  cleanupExpired(ttlMs: number = 30 * 60 * 1000): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [editId, pending] of this.pendingEdits) {
      if (pending.createdAt < cutoff) {
        this.pendingEdits.delete(editId);
        removed++;
      }
    }
    if (removed > 0) {
      log.info('Cleaned up expired pending edits', { removed, ttlMs });
    }
    return removed;
  }

  // -----------------------------------------------------------------------
  // Undo
  // -----------------------------------------------------------------------

  /**
   * Propose an undo of the last edit for a file.
   * Reads the previous content from the audit log and creates a new
   * EditProposal that would restore it.
   *
   * @returns An EditProposal for the rollback, or null if no prior edit exists.
   */
  undoLastEdit(filePath: string): EditProposal | null {
    const lastEdit = getLastEdit(filePath);
    if (!lastEdit || lastEdit.before_content === null) {
      return null;
    }

    return this.proposeEdit(
      filePath,
      lastEdit.before_content,
      `undo edit #${lastEdit.id}`,
      lastEdit.session_id ?? 'undo',
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Atomically write content: write to a `.tmp` sibling, then rename.
   */
  private atomicWrite(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // Clean up the tmp file if rename fails.
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
      throw renameErr;
    }
  }

  /**
   * Read a file's content, returning an empty string if the file does not exist.
   */
  private readFileOrEmpty(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Compute SHA-256 hex digest of a string.
   */
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}
