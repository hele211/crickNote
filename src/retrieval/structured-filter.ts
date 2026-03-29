import type { ParsedQuery } from './query-parser.js';

// --- Types ---

export interface StructuredFilterInput {
  date?: string | null;
  dateRange?: { start: string; end: string } | null;
  experimentType?: string | null;
  project?: string | null;
  folder?: string | null;
  status?: string | null;
  keywords?: string[] | null;
}

export interface FilterResult {
  sql: string;
  params: unknown[];
}

/**
 * Build a parameterized WHERE clause from structured filters.
 *
 * Null/undefined filters are omitted entirely. All values are passed
 * as parameterized placeholders to prevent SQL injection.
 *
 * The returned SQL is a WHERE clause (including the "WHERE" keyword)
 * suitable for appending to a SELECT on note_metadata. If no filters
 * are active, returns an empty string and empty params.
 */
export function buildFilter(filters: StructuredFilterInput): FilterResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Exact date
  if (filters.date != null) {
    conditions.push('nm.date = ?');
    params.push(filters.date);
  }

  // Date range (BETWEEN)
  if (filters.dateRange != null) {
    conditions.push('nm.date BETWEEN ? AND ?');
    params.push(filters.dateRange.start, filters.dateRange.end);
  }

  // Experiment type
  if (filters.experimentType != null) {
    conditions.push('nm.experiment_type = ?');
    params.push(filters.experimentType);
  }

  // Project
  if (filters.project != null) {
    conditions.push('nm.project = ?');
    params.push(filters.project);
  }

  // Folder
  if (filters.folder != null) {
    conditions.push('nm.folder = ?');
    params.push(filters.folder);
  }

  // Status
  if (filters.status != null) {
    conditions.push('nm.status = ?');
    params.push(filters.status);
  }

  // Keywords — match against result_summary or joined with BM25 externally.
  // Here we do a simple LIKE match on result_summary for each keyword.
  if (filters.keywords != null && filters.keywords.length > 0) {
    for (const keyword of filters.keywords) {
      conditions.push('(nm.result_summary LIKE ? OR nm.tags LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
  }

  if (conditions.length === 0) {
    return { sql: '', params: [] };
  }

  const sql = 'WHERE ' + conditions.join(' AND ');
  return { sql, params };
}

/**
 * Build a complete SELECT query for note_metadata with the given filters.
 * Returns matching note paths and metadata.
 */
export function buildNoteQuery(filters: StructuredFilterInput): FilterResult {
  const { sql: whereClause, params } = buildFilter(filters);

  const sql = [
    'SELECT nm.path, nm.folder, nm.note_type, nm.date, nm.project,',
    '  nm.experiment_type, nm.protocol_ref, nm.status, nm.tags,',
    '  nm.result_summary',
    'FROM note_metadata nm',
    whereClause,
    'ORDER BY nm.date DESC',
  ]
    .filter(line => line.length > 0)
    .join('\n');

  return { sql, params };
}

/**
 * Build a query that returns chunk IDs for notes matching the filters.
 * Used to feed candidate chunks into the semantic ranker.
 */
export function buildChunkCandidateQuery(filters: StructuredFilterInput): FilterResult {
  const { sql: whereClause, params } = buildFilter(filters);

  const sql = [
    'SELECT nc.id AS chunk_id, nc.path, nc.chunk_index, nc.content',
    'FROM note_chunks nc',
    'JOIN note_metadata nm ON nc.path = nm.path',
    whereClause,
    'ORDER BY nm.date DESC',
  ]
    .filter(line => line.length > 0)
    .join('\n');

  return { sql, params };
}

/**
 * Convenience: convert a ParsedQuery from the query parser into a StructuredFilterInput.
 */
export function parsedQueryToFilterInput(parsed: import('./query-parser.js').ParsedQuery): StructuredFilterInput {
  return {
    date: parsed.date,
    dateRange: parsed.dateRange,
    experimentType: parsed.experimentType,
    project: parsed.project,
    keywords: parsed.keywords.length > 0 ? parsed.keywords : null,
  };
}
