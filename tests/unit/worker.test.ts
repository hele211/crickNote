import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldIgnoreIngestionPath, IngestionWorker } from '../../src/ingestion/worker.js';
import * as embedderModule from '../../src/ingestion/embedder.js';
import * as watcherModule from '../../src/ingestion/watcher.js';
import * as indexerModule from '../../src/ingestion/indexer.js';

describe('shouldIgnoreIngestionPath', () => {
  it('ignores markdown files under Reading attachments', () => {
    expect(shouldIgnoreIngestionPath('Reading/attachments/smith-2026/notes.md')).toBe(true);
  });

  it('ignores markdown files under project attachments', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/attachments/CM001/notes.md')).toBe(true);
  });

  it('ignores mapping artifacts stored alongside reading notes', () => {
    expect(shouldIgnoreIngestionPath('Reading/Papers/smith-2026-mapping.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/CM001-western-blot-mapping-20260412T104938.md')).toBe(true);
  });

  it('ignores KB housekeeping artifacts', () => {
    expect(shouldIgnoreIngestionPath('Knowledge/_Ops/Lint-Reports/2026-04-12.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_index.md')).toBe(true);
  });

  it('does not ignore real vault notes', () => {
    expect(shouldIgnoreIngestionPath('Reading/Papers/smith-2026.md')).toBe(false);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/il-42.md')).toBe(false);
  });

  it('ignores _changelog.md files in any content folder', () => {
    expect(shouldIgnoreIngestionPath('Projects/P001-CM/_changelog.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Reading/Papers/_changelog.md')).toBe(true);
    expect(shouldIgnoreIngestionPath('Knowledge/Concepts/_changelog.md')).toBe(true);
  });
});

describe('IngestionWorker.fullIndex error state', () => {
  it('writes state=error when getAllMarkdownFiles throws', async () => {
    vi.spyOn(embedderModule, 'preloadModel').mockResolvedValue(undefined);
    vi.spyOn(watcherModule.VaultWatcher, 'getAllMarkdownFiles').mockRejectedValue(new Error('disk failure'));
    const updateStatus = vi.spyOn(indexerModule, 'updateIndexingStatus').mockReturnValue(undefined);

    vi.spyOn(indexerModule, 'getIndexingStatus').mockReturnValue({ state: 'idle', totalFiles: 0, indexedFiles: 0, lastError: null });

    const worker = new IngestionWorker('/tmp/test-vault', { watchForChanges: false });

    await expect(worker.start()).rejects.toThrow('disk failure');
    expect(updateStatus).toHaveBeenCalledWith('error', 0, 0, 'disk failure');

    vi.restoreAllMocks();
  });
});

describe('IngestionWorker.processFile path safety', () => {
  it('skips symlinked markdown files before reading file contents', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-worker-symlink-'));
    const vaultPath = path.join(tmpDir, 'vault');
    const outsidePath = path.join(tmpDir, 'outside.md');
    const linkedPath = path.join(vaultPath, 'linked.md');
    fs.mkdirSync(vaultPath);
    fs.writeFileSync(outsidePath, '# Outside vault\n', 'utf-8');
    fs.symlinkSync(outsidePath, linkedPath);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const worker = new IngestionWorker(vaultPath, { watchForChanges: false });

    try {
      await (worker as unknown as { processFile(relativePath: string): Promise<void> })
        .processFile('linked.md');

      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IngestionWorker startup recovery', () => {
  it('completes start() and runs full index when indexing_status.state is indexing on startup', async () => {
    vi.spyOn(embedderModule, 'preloadModel').mockResolvedValue(undefined);
    vi.spyOn(watcherModule.VaultWatcher, 'getAllMarkdownFiles').mockResolvedValue([]);
    vi.spyOn(indexerModule, 'updateIndexingStatus').mockReturnValue(undefined);
    vi.spyOn(indexerModule, 'markFullIndexComplete').mockReturnValue(undefined);
    vi.spyOn(indexerModule, 'deleteStaleNotes').mockReturnValue(undefined);
    vi.spyOn(indexerModule, 'getIndexingStatus').mockReturnValue({
      state: 'indexing', totalFiles: 20, indexedFiles: 13, lastError: null,
    });

    const worker = new IngestionWorker('/tmp/test-vault', { watchForChanges: false });
    await worker.start();

    // Verify start() completed and triggered a full index (updateIndexingStatus called with 'indexing')
    expect(indexerModule.updateIndexingStatus).toHaveBeenCalledWith('indexing', 0, 0);

    vi.restoreAllMocks();
  });
});
