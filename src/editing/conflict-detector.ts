import crypto from 'node:crypto';
import fs from 'node:fs';

export interface ConflictCheckResult {
  hasConflict: boolean;
  originalContent?: string;
  currentContent?: string;
  proposedContent?: string;
}

interface FileSnapshot {
  contentHash: string;
  mtime: number;
  content: string;
}

/**
 * Content-hash-based conflict detection.
 *
 * Fast path: compare mtime. If mtime unchanged, no conflict.
 * If mtime changed: compute SHA-256 of current content.
 *   - Hash match → no real conflict (mtime changed from touch/backup).
 *   - Hash mismatch → REAL CONFLICT.
 */
export class ConflictDetector {
  private snapshots: Map<string, FileSnapshot> = new Map();

  /**
   * Compute SHA-256 hex digest of a string.
   */
  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Record a snapshot when the agent reads a file.
   * Stores the content hash, mtime, and raw content for later conflict checks.
   */
  recordFileRead(filePath: string, content: string): void {
    let mtime: number;
    try {
      const stat = fs.statSync(filePath);
      mtime = stat.mtimeMs;
    } catch {
      // File may not exist on disk yet (new file scenario).
      mtime = 0;
    }

    this.snapshots.set(filePath, {
      contentHash: this.computeHash(content),
      mtime,
      content,
    });
  }

  /**
   * Check whether a file has been modified since the agent last read it.
   *
   * If no snapshot exists for the file, there is no conflict
   * (the agent never read it, so there is nothing to conflict with).
   */
  checkConflict(filePath: string, proposedContent?: string): ConflictCheckResult {
    const snapshot = this.snapshots.get(filePath);

    // No prior read recorded — treat as no conflict.
    if (!snapshot) {
      return { hasConflict: false };
    }

    // Check whether the file still exists.
    let currentStat: fs.Stats;
    try {
      currentStat = fs.statSync(filePath);
    } catch {
      // File was deleted since we read it — that is a conflict.
      return {
        hasConflict: true,
        originalContent: snapshot.content,
        currentContent: undefined,
        proposedContent,
      };
    }

    // Fast path: mtime unchanged → no conflict.
    if (currentStat.mtimeMs === snapshot.mtime) {
      return { hasConflict: false };
    }

    // Mtime changed — compute hash of current content to decide.
    const currentContent = fs.readFileSync(filePath, 'utf-8');
    const currentHash = this.computeHash(currentContent);

    if (currentHash === snapshot.contentHash) {
      // Content identical despite mtime change (touch / backup / metadata-only change).
      return { hasConflict: false };
    }

    // Real conflict: content has changed.
    return {
      hasConflict: true,
      originalContent: snapshot.content,
      currentContent,
      proposedContent,
    };
  }

  /**
   * Remove the stored snapshot for a file (e.g., after a successful write).
   */
  clearSnapshot(filePath: string): void {
    this.snapshots.delete(filePath);
  }

  /**
   * Get the stored snapshot for a file, if any.
   */
  getSnapshot(filePath: string): FileSnapshot | undefined {
    return this.snapshots.get(filePath);
  }
}
