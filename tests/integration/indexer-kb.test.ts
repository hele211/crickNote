import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';
import { indexNote } from '../../src/ingestion/indexer.js';

describe('indexer — KB fields', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('persists all 7 KB fields to note_metadata', () => {
    indexNote({
      note: {
        filePath: 'Knowledge/Concepts/test.md',
        folder: 'Knowledge', noteType: 'knowledge', isValid: true, warnings: [],
        kbStatus: 'pending', knowledgeKind: 'concept', needsReview: false,
        reviewFlaggedAt: undefined, aliases: ['test alias'], rqSource: undefined, rqTarget: undefined,
      },
      contentHash: 'abc', mtime: Date.now(), chunks: [], embeddings: [],
    }, db);
    const row = db.prepare('SELECT kb_status, knowledge_kind, needs_review, aliases FROM note_metadata WHERE path = ?')
      .get('Knowledge/Concepts/test.md') as Record<string, unknown>;
    expect(row.kb_status).toBe('pending');
    expect(row.knowledge_kind).toBe('concept');
    expect(row.needs_review).toBe(0);
    expect(JSON.parse(row.aliases as string)).toEqual(['test alias']);
  });
});
