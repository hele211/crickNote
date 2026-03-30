import type { ToolHandler } from './registry.js';
import { parseQuery, type ParserContext } from '../../retrieval/query-parser.js';
import { buildNoteQuery, buildFilter, parsedQueryToFilterInput } from '../../retrieval/structured-filter.js';
import { semanticRank } from '../../retrieval/semantic-ranker.js';
import { assembleContext } from '../../retrieval/context-assembler.js';
import { embedText } from '../../ingestion/embedder.js';
import { getDatabase } from '../../storage/database.js';

export function createSearchTools(vaultPath: string): ToolHandler[] {
  return [
    {
      definition: {
        name: 'vault_search',
        description: 'Search the vault using structured filters (date, experiment type, project) and semantic similarity. Use this when the user asks about specific experiments, results, or information in their vault.',
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
        const db = getDatabase();
        const query = args.query as string;

        // Load known types and projects for the parser
        const knownTypes = db.prepare('SELECT name, aliases FROM experiment_types').all() as Array<{ name: string; aliases: string }>;
        const knownProjects = db.prepare("SELECT DISTINCT project FROM note_metadata WHERE project IS NOT NULL").all() as Array<{ project: string }>;

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
        let candidates = db.prepare(mainQuery.sql).all(...mainQuery.params) as Candidate[];

        // Fallback chain if no results
        if (candidates.length === 0 && parsed.experimentType) {
          const q = buildNoteQuery({ experimentType: parsed.experimentType, project: parsed.project });
          candidates = db.prepare(q.sql).all(...q.params) as Candidate[];
        }

        if (candidates.length === 0 && parsed.date) {
          const dateObj = new Date(parsed.date);
          const start = new Date(dateObj.getTime() - 7 * 86400000).toISOString().split('T')[0];
          const end = new Date(dateObj.getTime() + 7 * 86400000).toISOString().split('T')[0];
          const q = buildNoteQuery({ dateRange: { start, end } });
          candidates = db.prepare(q.sql).all(...q.params) as Candidate[];
        }

        // Step 3: Fall back to BM25 full-text search
        if (candidates.length === 0) {
          try {
            const bm25Results = db.prepare(
              `SELECT nc.path FROM bm25_index bi
               JOIN note_chunks nc ON nc.id = CAST(bi.chunk_id AS INTEGER)
               WHERE bm25_index MATCH ?
               GROUP BY nc.path
               LIMIT 10`
            ).all(query) as Array<{ path: string }>;

            if (bm25Results.length > 0) {
              const paths = bm25Results.map(r => r.path);
              const placeholders = paths.map(() => '?').join(',');
              candidates = db.prepare(
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

        // Step 3: Semantic ranking — only when candidates > 5 (per architecture spec)
        if (candidates.length > 5) {
          try {
            const candidatePaths = candidates.map(c => c.path);
            const placeholders = candidatePaths.map(() => '?').join(',');
            const chunks = db.prepare(
              `SELECT id, path FROM note_chunks WHERE path IN (${placeholders})`
            ).all(...candidatePaths) as Array<{ id: number; path: string }>;

            if (chunks.length > 0) {
              const queryEmbedding = await embedText(query);
              const chunkIds = chunks.map(c => c.id);
              const ranked = semanticRank(db, queryEmbedding, chunkIds, 10);

              // Map ranked chunk IDs back to note paths (deduplicated, rank-ordered)
              const chunkIdToPath = new Map(chunks.map(c => [c.id, c.path]));
              const seenPaths = new Set<string>();
              const rankedPaths: string[] = [];
              for (const r of ranked) {
                const p = chunkIdToPath.get(r.chunkId);
                if (p && !seenPaths.has(p)) {
                  seenPaths.add(p);
                  rankedPaths.push(p);
                }
              }

              // Reorder candidates: ranked paths first, then any unranked remainder
              const pathToCandidateMap = new Map(candidates.map(c => [c.path, c]));
              candidates = [
                ...rankedPaths.map(p => pathToCandidateMap.get(p)!).filter(Boolean),
                ...candidates.filter(c => !seenPaths.has(c.path)),
              ];
            }
          } catch {
            // Embedding or ranking failed — fall through with unranked candidates
          }
        }

        // Step 4: Assemble context
        const topPaths = candidates.slice(0, 5).map(c => c.path);
        const assembledContext = assembleContext(db, topPaths, { vaultPath });

        return JSON.stringify({
          results: candidates.slice(0, 10),
          context: assembledContext,
          totalCandidates: candidates.length,
        });
      },
    },
  ];
}
