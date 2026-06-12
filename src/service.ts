import type { CrickNoteConfig } from './config/config.js';
import { getDatabase } from './storage/database.js';
import { createWebSocketServer } from './server/websocket.js';
import { IngestionWorker } from './ingestion/worker.js';
import { logger } from './utils/logger.js';

const log = logger.child('service');

export async function startService(config: CrickNoteConfig): Promise<void> {
  // Initialize database
  getDatabase();

  // Start WebSocket server first so clients can connect immediately
  const wss = await createWebSocketServer(config);

  log.info('CrickNote agent running', { host: config.server.host, port: config.server.port });
  log.info('Open Obsidian to connect');

  // Start ingestion worker in the background (model preload + indexing)
  const ingestion = new IngestionWorker(config.vaultPath);
  // Must register 'error' listener before start() — Node.js throws on unhandled error events.
  ingestion.on('error', (err, filePath) => {
    log.warn('Ingestion warning', { error: err.message, file: filePath });
  });
  ingestion.start().catch((err) => {
    log.error('Ingestion worker failed to start', { error: (err as Error).message });
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down');
    ingestion.stop();
    wss.close();
    log.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
