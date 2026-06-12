import type { ToolHandler } from './registry.js';
import { parseQuery, type ParserContext } from '../../retrieval/query-parser.js';
import { buildNoteQuery, parsedQueryToFilterInput } from '../../retrieval/structured-filter.js';
import { getDatabase } from '../../storage/database.js';
import type Database from 'better-sqlite3';

function isSearchHousekeepingPath(notePath: string): boolean {
  const normalized = notePath.replace(/\\/g, '/');
  return normalized.startsWith('Knowledge/_Ops/')
    || /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(normalized);
}

function filterSearchCandidates<T extends { path: string }>(candidates: T[]): T[] {
  return candidates.filter(candidate => !isSearchHousekeepingPath(candidate.path));
}

export function createSearchTools(injectedDb?: Database.Database): ToolHandler[] {
  return [
    {
      definition: {
        name: 'vault_search',
        description: 'Search the vault using structured filters (date, experiment type, project) and full-text (BM25) matching. Use this when the user asks about specific experiments, results, or information in their vault.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            date: { type: 'string', description: 'Optional ISO date filter' },
            experiment_type: { type: 'string', description: 'Optional experiment type filter' },
            project: { type: 'string', description: 'Optional project filter' },
            folder: { type: 'string', description: 'Optional folder filter (Projects, Protocols, Reading, Memory)' },
          },
          required: ['query'],
        },
      },
      execute: async (args) => {
        const database = injectedDb ?? getDatabase();
        const query = (args.query as string).trim();

        // Serial fast path: if query looks like a note_id (e.g. CM001, P001), do direct lookup
        const serialPattern = /^([A-Z]{1,4}\d{3,4}|P\d{3,4})$/;
        if (serialPattern.test(query)) {
          const exact = database.prepare(
            'SELECT path, note_type, date, project_id, note_id, series FROM note_metadata WHERE note_id = ?'
          ).get(query) as Record<string, unknown> | undefined;
          if (exact) {
            return JSON.stringify({ results: [{ ...exact, match_type: 'serial_exact' }], totalCandidates: 1 });
          }
        }

        // Load known types and projects for the parser
        const knownTypes = database.prepare('SELECT name, aliases FROM experiment_types').all() as Array<{ name: string; aliases: string }>;
        const knownProjects = database.prepare("SELECT DISTINCT project FROM note_metadata WHERE project IS NOT NULL").all() as Array<{ project: string }>;

        const context: ParserContext = {
          experimentTypes: knownTypes.map(t => ({
            name: t.name,
            aliases: JSON.parse(t.aliases) as string[],
          })),
          projectNames: knownProjects.map(p => p.project),
        };

        // Step 1: Deterministic parse
        const parsed = parseQuery(query, context);

        // Apply explicit overrides from tool args
        if (args.date) parsed.date = args.date as string;
        if (args.experiment_type) parsed.experimentType = args.experiment_type as string;
        if (args.project) parsed.project = args.project as string;

        // Step 2: Structured SQL filter
        const filterInput = parsedQueryToFilterInput(parsed);
        if (args.folder) filterInput.folder = args.folder as string;

        // buildNoteQuery uses "FROM note_metadata nm" so nm. aliases in WHERE clauses are valid.
        const mainQuery = buildNoteQuery(filterInput);
        type Candidate = { path: string; note_type: string; date: string; project: string; experiment_type: string; result_summary: string };
        let candidates = database.prepare(mainQuery.sql).all(...mainQuery.params) as Candidate[];

        // Fallback chain if no results
        if (candidates.length === 0 && parsed.experimentType) {
          const q = buildNoteQuery({ experimentType: parsed.experimentType, project: parsed.project });
          candidates = database.prepare(q.sql).all(...q.params) as Candidate[];
        }

        if (candidates.length === 0 && parsed.date) {
          const dateObj = new Date(parsed.date);
          const start = new Date(dateObj.getTime() - 7 * 86400000).toISOString().split('T')[0];
          const end = new Date(dateObj.getTime() + 7 * 86400000).toISOString().split('T')[0];
          const q = buildNoteQuery({ dateRange: { start, end } });
          candidates = database.prepare(q.sql).all(...q.params) as Candidate[];
        }

        // Step 3: Fall back to BM25 full-text search
        if (candidates.length === 0) {
          try {
            const bm25Results = database.prepare(
              `SELECT nc.path FROM bm25_index bi
               JOIN note_chunks nc ON nc.id = CAST(bi.chunk_id AS INTEGER)
               WHERE bm25_index MATCH ?
               GROUP BY nc.path
               LIMIT 10`
            ).all(query) as Array<{ path: string }>;

            if (bm25Results.length > 0) {
              const paths = bm25Results.map(r => r.path);
              const placeholders = paths.map(() => '?').join(',');
              candidates = database.prepare(
                `SELECT path, note_type, date, project, experiment_type, result_summary
                 FROM note_metadata WHERE path IN (${placeholders})`
              ).all(...paths) as typeof candidates;
            }
          } catch {
            // BM25 query syntax error — skip
          }
        }

        if (candidates.length === 0) {
          return JSON.stringify({
            results: [],
            message: 'No matching notes found. Would you like to search more broadly?',
          });
        }

        candidates = filterSearchCandidates(candidates);
        if (candidates.length === 0) {
          return JSON.stringify({
            results: [],
            message: 'No matching notes found. Would you like to search more broadly?',
          });
        }

        return JSON.stringify({
          results: candidates.slice(0, 10),
          totalCandidates: candidates.length,
        });
      },
    },
  ];
}
