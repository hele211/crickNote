import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler } from './registry.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { loadSources } from '../../knowledge/source-loader.js';
import { logger } from '../../utils/logger.js';

const log = logger.child('kb-tools');

export function createKbTools(
  vaultPath: string,
  injectedDb?: Database.Database,
): ToolHandler[] {
  void log;
  void injectedDb;
  return [
    {
      definition: {
        name: 'compile_reading_note',
        description:
          'Load all source files attached to a reading note and return their content so you can draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions, Takeaways, Extensions). After calling this tool, draft the filled-in reading note body and call vault_write to propose it.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative vault path to the reading note (e.g. "Reading/Papers/smith-2026-il42-signalling.md")',
            },
          },
          required: ['path'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.path as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.path}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.path}` });
        }

        const raw = fs.readFileSync(notePath, 'utf-8');
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;

        const sources = fm['sources'];
        if (!Array.isArray(sources) || sources.length === 0) {
          return JSON.stringify({
            note: { frontmatter: fm, body: parsed.content },
            sources: [],
            warnings: ['No sources listed in frontmatter. Add a "sources:" array and re-run.'],
            instruction: 'No sources to load. Draft CREATE sections from any content already in the note body, or ask the user to add source files first.',
          });
        }

        const sourceSlug = path.basename(notePath, '.md');
        const result = await loadSources(
          sources as Array<{ type: string; path: string }>,
          sourceSlug,
          vaultPath
        );

        return JSON.stringify({
          note: { path: args.path, frontmatter: fm, body: parsed.content },
          sources: result.sources,
          warnings: result.warnings,
          totalTokens: result.totalTokens,
          instruction: `Draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions, Takeaways, Extensions) based on the source content above. Then call vault_write with the complete reading note including filled-in sections. Preserve all existing frontmatter fields. Do NOT mark status: complete — the user will do that after reviewing.`,
        });
      },
    },
  ];
}
