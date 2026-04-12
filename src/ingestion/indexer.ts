import type Database from 'better-sqlite3';
import { getDatabase } from '../storage/database.js';
import type { ParsedNote } from './parser.js';
import type { TextChunk } from './chunker.js';
import { embeddingToBuffer } from './embedder.js';

export interface IndexNoteInput {
  /** Parsed note metadata */
  note: ParsedNote;
  /** Content hash (SHA-256 hex) */
  contentHash: string;
  /** File modification time (ms since epoch) */
  mtime: number;
  /** Chunked text segments */
  chunks: TextChunk[];
  /** Embedding vectors, one per chunk (same order as chunks) */
  embeddings: Float32Array[];
}

/**
 * Upsert a note and its chunks/embeddings into the database.
 * Uses a transaction for atomicity.
 */
export function indexNote(input: IndexNoteInput, db?: Database.Database): void {
  const database = db ?? getDatabase();
  const { note, contentHash, mtime, chunks, embeddings } = input;
  const now = Date.now();

  database.transaction(() => {
    // 1. Upsert note_metadata
    database.prepare(`
      INSERT INTO note_metadata (path, folder, note_type, date, project, project_id, note_id, series,
        last_session, experiment_type, protocol_ref, status, tags, result_summary, content_hash, mtime, last_indexed,
        kb_status, knowledge_kind, needs_review, review_flagged_at, aliases, rq_source, rq_target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        folder = excluded.folder,
        note_type = excluded.note_type,
        date = excluded.date,
        project = excluded.project,
        project_id = excluded.project_id,
        note_id = excluded.note_id,
        series = excluded.series,
        last_session = excluded.last_session,
        experiment_type = excluded.experiment_type,
        protocol_ref = excluded.protocol_ref,
        status = excluded.status,
        tags = excluded.tags,
        result_summary = excluded.result_summary,
        content_hash = excluded.content_hash,
        mtime = excluded.mtime,
        last_indexed = excluded.last_indexed,
        kb_status = excluded.kb_status,
        knowledge_kind = excluded.knowledge_kind,
        needs_review = excluded.needs_review,
        review_flagged_at = excluded.review_flagged_at,
        aliases = excluded.aliases,
        rq_source = excluded.rq_source,
        rq_target = excluded.rq_target
    `).run(
      note.filePath,
      note.folder,
      note.noteType,
      note.date ?? null,
      note.project ?? null,
      note.projectId ?? null,
      note.noteId ?? null,
      note.series ?? null,
      note.lastSession ?? null,
      note.experimentType ?? null,
      note.protocolRef ?? null,
      note.status ?? null,
      note.tags ? JSON.stringify(note.tags) : null,
      note.resultSummary ?? null,
      contentHash,
      mtime,
      now,
      note.kbStatus ?? null,
      note.knowledgeKind ?? null,
      note.needsReview != null ? (note.needsReview ? 1 : 0) : null,
      note.reviewFlaggedAt ?? null,
      note.aliases ? JSON.stringify(note.aliases) : null,
      note.rqSource ?? null,
      note.rqTarget ?? null
    );

    // 2. Delete existing chunks (cascade will remove embeddings and BM25 entries)
    //    First remove BM25 entries for existing chunks
    const existingChunks = database.prepare(
      'SELECT id FROM note_chunks WHERE path = ?'
    ).all(note.filePath) as Array<{ id: number }>;

    for (const chunk of existingChunks) {
      database.prepare('DELETE FROM bm25_index WHERE chunk_id = ?').run(String(chunk.id));
    }

    // Delete old chunks (cascades to chunk_embeddings)
    database.prepare('DELETE FROM note_chunks WHERE path = ?').run(note.filePath);

    // 3. Insert new chunks, embeddings, and BM25 entries
    const insertChunk = database.prepare(`
      INSERT INTO note_chunks (path, chunk_index, start_offset, end_offset, content)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertEmbedding = database.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    const insertBm25 = database.prepare(`
      INSERT INTO bm25_index (chunk_id, content)
      VALUES (?, ?)
    `);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];

      const result = insertChunk.run(
        note.filePath,
        chunk.chunkIndex,
        chunk.startOffset,
        chunk.endOffset,
        chunk.content
      );

      const chunkId = result.lastInsertRowid as number;

      // Insert embedding
      if (embedding) {
        insertEmbedding.run(chunkId, embeddingToBuffer(embedding));
      }

      // Insert BM25 full-text index entry
      insertBm25.run(String(chunkId), chunk.content);
    }

    // 4. Track experiment type if this is an experiment note
    if (note.noteType === 'experiment' && note.experimentType) {
      database.prepare(`
        INSERT INTO experiment_types (name, aliases, count)
        VALUES (?, '[]', 1)
        ON CONFLICT(name) DO UPDATE SET
          count = count + 1
      `).run(note.experimentType);
    }
  })();
}

/**
 * Remove a note and all associated data from the database.
 * Called when a file is deleted from the vault.
 */
export function deleteNote(filePath: string, db?: Database.Database): void {
  const database = db ?? getDatabase();

  database.transaction(() => {
    // Decrement experiment_types.count if this note tracked an experiment type.
    const meta = database.prepare(
      'SELECT note_type, experiment_type FROM note_metadata WHERE path = ?'
    ).get(filePath) as { note_type: string; experiment_type: string | null } | undefined;

    if (meta?.note_type === 'experiment' && meta.experiment_type) {
      database.prepare(`
        UPDATE experiment_types SET count = count - 1 WHERE name = ?
      `).run(meta.experiment_type);
      // Clean up rows that have reached zero.
      database.prepare(
        'DELETE FROM experiment_types WHERE name = ? AND count <= 0'
      ).run(meta.experiment_type);
    }

    // Remove BM25 entries for this note's chunks
    const chunks = database.prepare(
      'SELECT id FROM note_chunks WHERE path = ?'
    ).all(filePath) as Array<{ id: number }>;

    for (const chunk of chunks) {
      database.prepare('DELETE FROM bm25_index WHERE chunk_id = ?').run(String(chunk.id));
    }

    // Delete chunks (cascades to embeddings)
    database.prepare('DELETE FROM note_chunks WHERE path = ?').run(filePath);

    // Delete metadata
    database.prepare('DELETE FROM note_metadata WHERE path = ?').run(filePath);
  })();
}

/**
 * Check if a note needs re-indexing by comparing content hashes.
 * Returns true if the note needs to be re-indexed.
 */
export function needsReindex(filePath: string, contentHash: string, db?: Database.Database): boolean {
  const database = db ?? getDatabase();

  const row = database.prepare(
    'SELECT content_hash FROM note_metadata WHERE path = ?'
  ).get(filePath) as { content_hash: string } | undefined;

  if (!row) return true;
  return row.content_hash !== contentHash;
}

/**
 * Update the indexing_status table with current progress.
 */
export function updateIndexingStatus(
  state: 'idle' | 'indexing' | 'error',
  totalFiles: number,
  indexedFiles: number,
  lastError?: string,
  db?: Database.Database
): void {
  const database = db ?? getDatabase();

  database.prepare(`
    UPDATE indexing_status
    SET state = ?, total_files = ?, indexed_files = ?, last_error = ?, updated_at = ?
    WHERE id = 1
  `).run(state, totalFiles, indexedFiles, lastError ?? null, Date.now());
}

/**
 * Mark the last full index timestamp.
 */
export function markFullIndexComplete(db?: Database.Database): void {
  const database = db ?? getDatabase();

  database.prepare(`
    UPDATE indexing_status
    SET last_full_index = ?, state = 'idle', updated_at = ?
    WHERE id = 1
  `).run(Date.now(), Date.now());
}
