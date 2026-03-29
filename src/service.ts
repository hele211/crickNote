import type { CrickNoteConfig } from './config/config.js';
import { getDatabase } from './storage/database.js';
import { createWebSocketServer } from './server/websocket.js';
import { IngestionWorker } from './ingestion/worker.js';

export async function startService(config: CrickNoteConfig): Promise<void> {
  // Initialize database
  getDatabase();

  // Start ingestion worker
  const ingestion = new IngestionWorker(config.vaultPath);
  await ingestion.start();

  // Start WebSocket server
  const wss = createWebSocketServer(config);

  console.log(`CrickNote agent running on ${config.server.host}:${config.server.port}`);
  console.log('Open Obsidian to connect.\n');

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    ingestion.stop();
    wss.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
