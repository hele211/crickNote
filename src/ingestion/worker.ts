import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VaultWatcher, type FileChange } from './watcher.js';
import { parseNote } from './parser.js';
import { chunkText } from './chunker.js';
import { embedTexts, preloadModel } from './embedder.js';
import {
  indexNote,
  deleteNote,
  needsReindex,
  updateIndexingStatus,
  markFullIndexComplete,
  deleteStaleNotes,
} from './indexer.js';
import { logger } from '../utils/logger.js';

const log = logger.child('ingestion');

export interface WorkerEvents {
  /** Emitted when indexing state changes */
  status: [state: 'idle' | 'indexing' | 'error', message: string];
  /** Emitted when progress updates during full index */
  progress: [indexed: number, total: number];
  /** Emitted when a single note is indexed */
  indexed: [filePath: string];
  /** Emitted when a note is removed from index */
  removed: [filePath: string];
  /** Emitted on errors */
  error: [error: Error, filePath?: string];
}

export interface IngestionWorkerOptions {
  watchForChanges?: boolean;
}

export class IngestionWorker extends EventEmitter<WorkerEvents> {
  private readonly vaultPath: string;
  private readonly watchForChanges: boolean;
  private watcher: VaultWatcher | null = null;
  private running = false;
  private processingQueue: FileChange[] = [];
  private processing = false;

  constructor(vaultPath: string, options: IngestionWorkerOptions = {}) {
    super();
    this.vaultPath = vaultPath;
    this.watchForChanges = options.watchForChanges ?? true;
  }

  /**
   * Start the ingestion worker.
   * 1. Pre-loads the embedding model
   * 2. Performs an initial full index of the vault
   * 3. Starts watching for incremental changes
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.emit('status', 'indexing', 'Starting ingestion worker...');

    let fullIndexStarted = false;
    try {
      // Pre-load embedding model
      log.info('Loading embedding model');
      this.emit('status', 'indexing', 'Loading embedding model...');
      await preloadModel();

      // Perform initial full index
      fullIndexStarted = true;
      await this.fullIndex();

      if (this.watchForChanges) {
        // Start file watcher for incremental updates
        this.watcher = new VaultWatcher(this.vaultPath, (change) => {
          this.enqueueChange(change);
        });
        this.watcher.start();
        this.emit('status', 'idle', 'Ingestion worker ready. Watching for changes.');
      } else {
        this.emit('status', 'idle', 'Ingestion worker ready.');
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // fullIndex already emitted status/error events for its own failures;
      // only re-emit here for errors that occurred before fullIndex was called.
      if (!fullIndexStarted) {
        this.emit('status', 'error', `Failed to start: ${err.message}`);
        this.emit('error', err);
      }
      throw err;
    }
  }

  /**
   * Stop the ingestion worker and file watcher.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    this.processingQueue = [];
    this.emit('status', 'idle', 'Ingestion worker stopped.');
  }

  /**
   * Perform a full index of all markdown files in the vault.
   * Skips files whose content hash hasn't changed.
   */
  private async fullIndex(): Promise<void> {
    this.emit('status', 'indexing', 'Starting full vault index...');

    let totalFiles = 0;
    let indexedCount = 0;

    try {
      const allFiles = await VaultWatcher.getAllMarkdownFiles(this.vaultPath);
      const indexableFiles = allFiles.filter(f => !shouldIgnoreIngestionPath(f));

      totalFiles = indexableFiles.length;
      updateIndexingStatus('indexing', totalFiles, 0);
      this.emit('progress', 0, totalFiles);

      for (const relativePath of indexableFiles) {
        if (!this.running) break;

        try {
          await this.processFile(relativePath);
          indexedCount++;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.emit('error', err, relativePath);
          // Continue with other files even if one fails
        }

        updateIndexingStatus('indexing', totalFiles, indexedCount);
        this.emit('progress', indexedCount, totalFiles);
      }

      deleteStaleNotes(indexableFiles);
      markFullIndexComplete();
      log.info('Full index complete', { indexed: indexedCount, total: totalFiles });
      this.emit('status', 'idle', `Full index complete. ${indexedCount}/${totalFiles} files indexed.`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      updateIndexingStatus('error', totalFiles, indexedCount, err.message);
      this.emit('status', 'error', `Full index failed: ${err.message}`);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Process a single file: read → parse → chunk → embed → index.
   * Skips if content hash hasn't changed.
   */
  private async processFile(relativePath: string): Promise<void> {
    if (shouldIgnoreIngestionPath(relativePath)) {
      return;
    }

    const absolutePath = path.join(this.vaultPath, relativePath);

    // Read file
    let content: string;
    let stat: fs.Stats;
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
      stat = fs.lstatSync(absolutePath);
      // Never process symlinks – they could escape the vault boundary
      if (stat.isSymbolicLink()) return;
    } catch {
      // File may have been deleted between detection and processing
      return;
    }

    // Compute content hash
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // Check if re-indexing is needed
    if (!needsReindex(relativePath, contentHash)) {
      return;
    }

    // Parse frontmatter and classify
    const parsed = parseNote(relativePath, content);

    // Log validation warnings
    if (parsed.warnings.length > 0) {
      for (const warning of parsed.warnings) {
        this.emit('error', new Error(`[${relativePath}] ${warning.message}`), relativePath);
      }
    }

    // Chunk the body content
    const chunks = chunkText(parsed.body);

    // Generate embeddings for all chunks
    const texts = chunks.map(c => c.content);
    const embeddings = await embedTexts(texts);

    // Write to database
    indexNote({
      note: parsed,
      contentHash,
      mtime: stat.mtimeMs,
      chunks,
      embeddings,
    });

    log.debug('Indexed file', { path: relativePath, chunks: chunks.length });
    this.emit('indexed', relativePath);
  }

  /**
   * Enqueue a file change event for processing.
   */
  private enqueueChange(change: FileChange): void {
    this.processingQueue.push(change);
    this.drainQueue();
  }

  /**
   * Process queued file changes sequentially.
   */
  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.processingQueue.length > 0 && this.running) {
        const change = this.processingQueue.shift()!;

        try {
          if (change.event === 'unlink') {
            log.debug('File removed', { path: change.filePath });
            deleteNote(change.filePath);
            this.emit('removed', change.filePath);
          } else {
            // 'add' or 'change'
            log.debug('File changed', { path: change.filePath, event: change.event });
            await this.processFile(change.filePath);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.emit('error', err, change.filePath);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export function shouldIgnoreIngestionPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    /(^|\/)attachments\//.test(normalized) ||
    /^(Reading\/[^/]+|Projects\/[^/]+)\/[^/]+-mapping(?:-\d{8}T\d{6})?\.md$/.test(normalized) ||
    normalized.startsWith('Knowledge/_Ops/') ||
    /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(normalized) ||
    /(^|\/)_changelog\.md$/.test(normalized)
  );
}
