import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolHandler } from './registry.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import {
  READING_SOURCE_TYPES,
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasMeaningfulReadingBody,
  normalizeReadingSources,
  slugifyReadingTitle,
  syncReadingBodyTitle,
  type ReadingSourceInput,
} from '../../knowledge/reading-note.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { renderNoteTemplate, type RenderResult } from '../../templates/template-loader.js';

export function createTemplateTools(vaultPath: string, conflictDetector?: ConflictDetector): ToolHandler[] {
  return [
    {
      definition: {
        name: 'create_reading_note',
        description: 'Create a new literature/reading note from template. Triggers safe edit flow.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Paper title' },
            authors: { type: 'array', items: { type: 'string' }, description: 'Author names' },
            year: { type: 'number', description: 'Publication year' },
            journal: { type: 'string', description: 'Journal name' },
            doi: { type: 'string', description: 'DOI (optional — omit for preprints or thread captures)' },
            slug: { type: 'string', description: 'Optional custom filename slug. Will be normalized to a vault-safe reading-note slug.' },
            sources: {
              type: 'array',
              description: 'Optional source files relative to Reading/attachments/<slug>/',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: [...READING_SOURCE_TYPES] },
                  path: { type: 'string' },
                },
                required: ['type', 'path'],
              },
            },
            related_projects: { type: 'array', items: { type: 'string' }, description: 'Project IDs this reading is related to' },
          },
          required: ['title', 'authors', 'year', 'journal'],
        },
      },
      execute: async (args) => {
        const slug = slugifyReadingTitle((args.slug as string | undefined) ?? (args.title as string));
        let normalizedSources: ReadingSourceInput[] | undefined;
        if (Array.isArray(args.sources)) {
          try {
            normalizedSources = normalizeReadingSources(args.sources as ReadingSourceInput[]);
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }
        }
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, path.join('Reading', 'Papers', `${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved reading note path is outside the vault.' });
        }

        const exists = fs.existsSync(notePath);
        let existingFrontmatter: Record<string, unknown> = {};
        let existingBody = '';
        if (exists) {
          const existingContent = fs.readFileSync(notePath, 'utf-8');
          conflictDetector?.recordFileRead(notePath, existingContent);
          const parsed = matter(existingContent);
          existingFrontmatter = parsed.data as Record<string, unknown>;
          existingBody = parsed.content;
        }

        let fmData: Record<string, unknown>; // must be let — template integration may reassign
        try {
          fmData = buildReadingFrontmatter(
            {
              title: args.title as string,
              authors: args.authors as string[],
              year: args.year as number,
              journal: args.journal as string,
              doi: args.doi as string | undefined,
              related_projects: args.related_projects as string[] | undefined,
              status: 'draft',
              kb_status: 'pending',
            },
            normalizedSources,
            existingFrontmatter
          );
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        let body: string;
        let warnings: string[] = [];
        if (exists && hasMeaningfulReadingBody(existingBody)) {
          body = syncReadingBodyTitle(existingBody, args.title as string);
        } else {
          let renderResult: RenderResult;
          try {
            renderResult = await renderNoteTemplate({
              vaultPath,
              kind: 'reading-paper',
              protectedFrontmatter: fmData,
              context: { title: args.title as string },
            });
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }
          fmData = renderResult.frontmatter;
          body = renderResult.body;
          warnings = renderResult.warnings;
        }
        const newContent = matter.stringify(body, fmData);

        return JSON.stringify({ type: 'pending_edit', operation: exists ? 'update' : 'create', path: notePath, newContent, warnings });
      },
    },
  ];
}
