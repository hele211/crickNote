/**
 * Embedding generator using @xenova/transformers with all-MiniLM-L6-v2.
 * Lazy-loads the model on first use. Uses an async queue to avoid blocking.
 */

// Use dynamic import for @xenova/transformers to handle ESM/CJS interop
type Pipeline = (texts: string | string[], options?: Record<string, unknown>) =>
  Promise<{ data: Float32Array }>;

let pipeline: Pipeline | null = null;
let modelLoadPromise: Promise<Pipeline> | null = null;

/** Default model for semantic embeddings */
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Embedding dimension for all-MiniLM-L6-v2 */
export const EMBEDDING_DIM = 384;

/**
 * Lazy-load the embedding model. Only loads once, subsequent calls return
 * the cached pipeline. Safe to call concurrently — all callers await
 * the same promise.
 */
async function getEmbeddingPipeline(): Promise<Pipeline> {
  if (pipeline) return pipeline;

  if (!modelLoadPromise) {
    modelLoadPromise = (async () => {
      // Dynamic import of the transformers library
      const { pipeline: createPipeline } = await import('@xenova/transformers');

      const modelPath = process.env.CRICKNOTE_EMBEDDING_MODEL_PATH ?? DEFAULT_MODEL;
      const pipe = await createPipeline('feature-extraction', modelPath, {
        quantized: true,
      });

      pipeline = pipe as unknown as Pipeline;
      return pipeline;
    })();
  }

  return modelLoadPromise;
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a Float32Array of dimension 384.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const pipe = await getEmbeddingPipeline();
  const result = await pipe(text, { pooling: 'mean', normalize: true });

  // The result.data is a flat Float32Array; extract the embedding
  return new Float32Array(result.data);
}

/**
 * Generate embeddings for multiple text chunks.
 * Processes sequentially via an internal queue to avoid overwhelming
 * memory or blocking the event loop for too long.
 *
 * @param texts Array of text strings to embed
 * @returns Array of Float32Array embeddings, one per input text
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  // Ensure the model is loaded before processing
  await getEmbeddingPipeline();

  const results: Float32Array[] = [];

  for (const text of texts) {
    const embedding = await embedText(text);
    results.push(embedding);

    // Yield to the event loop between embeddings to avoid blocking
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  return results;
}

/**
 * Convert a Float32Array embedding to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert a SQLite BLOB Buffer back to a Float32Array embedding.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

/**
 * Pre-load the embedding model. Call during startup to avoid
 * latency on the first embedding request.
 */
export async function preloadModel(): Promise<void> {
  await getEmbeddingPipeline();
}
