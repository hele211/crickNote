import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConflictDetector } from './conflict-detector.js';
import { generateDiff, generateThreeWayDiff } from './diff-generator.js';
import { logEdit, getLastEdit } from '../storage/audit.js';

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
  private pendingEdits: Map<string, EditProposal & { triggerQuery: string; sessionId: string }> = new Map();

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
    this.pendingEdits.set(editId, { ...proposal, triggerQuery, sessionId });

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
    const pending = this.pendingEdits.get(editId);
    if (!pending) {
      return { success: false, editId, action, error: 'Edit proposal not found or already resolved.' };
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

    // --- Update snapshot so future checks work -----------------------------
    this.conflictDetector.recordFileRead(pending.filePath, pending.newContent);

    // --- Clean up ----------------------------------------------------------
    this.pendingEdits.delete(editId);
    return { success: true, editId, action };
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
