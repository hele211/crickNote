import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

export type FileChangeEvent = 'add' | 'change' | 'unlink';

export interface FileChange {
  event: FileChangeEvent;
  filePath: string;
  /** Absolute path to the file */
  absolutePath: string;
}

export type FileChangeCallback = (change: FileChange) => void;

/** Directories to ignore when watching the vault. */
const IGNORED_DIRS = [
  '.obsidian',
  '.trash',
  '.git',
  'node_modules',
  'Agent',
];

/** Debounce interval in milliseconds for file change events. */
const DEBOUNCE_MS = 1500;

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly vaultPath: string;
  private readonly callback: FileChangeCallback;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(vaultPath: string, callback: FileChangeCallback) {
    this.vaultPath = vaultPath;
    this.callback = callback;
  }

  /**
   * Start watching the vault for .md file changes.
   * Returns the chokidar watcher instance for external control.
   */
  start(): FSWatcher {
    const ignoredPatterns = IGNORED_DIRS.map(dir =>
      path.join(this.vaultPath, dir, '**')
    );

    this.watcher = chokidar.watch(this.vaultPath, {
      ignored: [
        ...ignoredPatterns,
        // Also ignore dotfiles/dotdirs at any level
        /(^|[/\\])\../,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    const handleEvent = (event: FileChangeEvent, filePath: string): void => {
      // Only process .md files
      if (!filePath.endsWith('.md')) return;

      const relativePath = path.relative(this.vaultPath, filePath);

      // Clear existing debounce timer for this file
      const existing = this.debounceTimers.get(filePath);
      if (existing) {
        clearTimeout(existing);
      }

      // Set new debounce timer
      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.callback({
          event,
          filePath: relativePath,
          absolutePath: filePath,
        });
      }, DEBOUNCE_MS);

      this.debounceTimers.set(filePath, timer);
    };

    this.watcher.on('add', (filePath: string) => handleEvent('add', filePath));
    this.watcher.on('change', (filePath: string) => handleEvent('change', filePath));
    this.watcher.on('unlink', (filePath: string) => handleEvent('unlink', filePath));

    return this.watcher;
  }

  /**
   * Stop watching the vault.
   */
  async stop(): Promise<void> {
    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get all .md files in the vault (for initial full index).
   * Walks the vault directory, respecting the same ignore rules.
   */
  static async getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const { readdir, stat } = await import('node:fs/promises');
      const entries = await readdir(dir);

      for (const entry of entries) {
        // Skip ignored directories
        if (IGNORED_DIRS.includes(entry)) continue;
        // Skip hidden files/dirs
        if (entry.startsWith('.')) continue;

        const fullPath = path.join(dir, entry);
        const entryStat = await stat(fullPath);

        if (entryStat.isDirectory()) {
          await walk(fullPath);
        } else if (entry.endsWith('.md')) {
          files.push(path.relative(vaultPath, fullPath));
        }
      }
    };

    await walk(vaultPath);
    return files;
  }
}
