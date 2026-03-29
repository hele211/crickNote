import { loadConfig } from '../config/config.js';
import { getDatabase } from '../storage/database.js';

export async function reindex(): Promise<void> {
  const config = loadConfig();
  const db = getDatabase();

  console.log('Clearing derived tables...');
  db.exec('DELETE FROM chunk_embeddings');
  db.exec('DELETE FROM note_chunks');
  db.exec('DELETE FROM note_metadata');
  db.exec('DELETE FROM bm25_index');
  db.exec('DELETE FROM experiment_types');
  db.prepare('UPDATE indexing_status SET state = ?, indexed_files = 0, updated_at = ? WHERE id = 1')
    .run('idle', Date.now());

  console.log(`Derived tables cleared. Restart "cricknote start" to re-index vault at ${config.vaultPath}`);
}
