import type Database from 'better-sqlite3';

// --- Types ---

export interface RankedResult {
  chunkId: number;
  score: number;
}

export interface ChunkEmbeddingRow {
  chunk_id: number;
  embedding: Buffer;
}

// --- Vector math ---

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns a value in [-1, 1]. Higher is more similar.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Deserialize a BLOB (Buffer) into a Float32Array.
 * The embedding is stored as raw float32 bytes in the chunk_embeddings table.
 */
export function blobToFloat32Array(blob: Buffer): Float32Array {
  const arrayBuffer = blob.buffer.slice(
    blob.byteOffset,
    blob.byteOffset + blob.byteLength,
  );
  return new Float32Array(arrayBuffer);
}

// --- Semantic ranker ---

/**
 * Rank candidate chunks by cosine similarity to a query embedding.
 *
 * Only used when candidateChunkIds.length > 5 (per spec).
 * If candidates <= 5, the caller should skip ranking and use all candidates.
 *
 * @param db - better-sqlite3 database instance
 * @param queryEmbedding - the embedded query vector (Float32Array)
 * @param candidateChunkIds - chunk IDs from the structured filter step
 * @param topK - maximum number of results to return (default: 10)
 * @returns ranked results sorted by descending cosine similarity score
 */
export function rankChunks(
  db: Database.Database,
  queryEmbedding: Float32Array,
  candidateChunkIds: number[],
  topK: number = 10,
): RankedResult[] {
  if (candidateChunkIds.length === 0) {
    return [];
  }

  // Load embeddings for candidate chunks.
  // Use batched queries to avoid SQLite variable limit issues.
  const batchSize = 500;
  const allRows: ChunkEmbeddingRow[] = [];

  for (let i = 0; i < candidateChunkIds.length; i += batchSize) {
    const batch = candidateChunkIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT chunk_id, embedding FROM chunk_embeddings WHERE chunk_id IN (${placeholders})`,
    );
    const rows = stmt.all(...batch) as ChunkEmbeddingRow[];
    allRows.push(...rows);
  }

  // Compute cosine similarity for each chunk
  const scored: RankedResult[] = [];

  for (const row of allRows) {
    const chunkEmbedding = blobToFloat32Array(row.embedding);
    const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
    scored.push({ chunkId: row.chunk_id, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top-k
  return scored.slice(0, topK);
}

/**
 * Full semantic ranking pipeline: loads embeddings, computes similarity,
 * returns ranked results. Skips ranking if candidate count <= 5.
 *
 * @returns If candidates <= 5, returns all candidate IDs with score 1.0.
 *          If candidates > 5, returns top-k ranked by cosine similarity.
 */
export function semanticRank(
  db: Database.Database,
  queryEmbedding: Float32Array,
  candidateChunkIds: number[],
  topK: number = 10,
): RankedResult[] {
  // Per spec: only use semantic ranking when candidate count > 5
  if (candidateChunkIds.length <= 5) {
    return candidateChunkIds.map(chunkId => ({ chunkId, score: 1.0 }));
  }

  return rankChunks(db, queryEmbedding, candidateChunkIds, topK);
}
