import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolHandler } from './registry.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import { resolveVaultPath } from '../../utils/paths.js';

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
            related_projects: { type: 'array', items: { type: 'string' }, description: 'Project IDs this reading is related to' },
          },
          required: ['title', 'authors', 'year', 'journal'],
        },
      },
      execute: async (args) => {
        const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const today = new Date().toISOString().slice(0, 10);
        const relatedProjects = (args.related_projects as string[] | undefined) ?? [];
        const fmData: Record<string, unknown> = {
          title: args.title as string,
          authors: args.authors as string[],
          year: args.year as number,
          journal: args.journal as string,
          read_date: today,
          status: 'draft',
          kb_status: 'pending',
          related_projects: relatedProjects,
          tags: ['reading'],
        };
        if (args.doi) fmData.doi = args.doi as string;
        const body = `\n# ${args.title as string}\n\n## Summary\n\n## Key Findings\n\n## Notes\n`;
        const newContent = matter.stringify(body, fmData);
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, path.join('Reading', 'Papers', `${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved reading note path is outside the vault.' });
        }
        const exists = fs.existsSync(notePath);
        if (exists) {
          conflictDetector?.recordFileRead(notePath, fs.readFileSync(notePath, 'utf-8'));
        }
        return JSON.stringify({ type: 'pending_edit', operation: exists ? 'update' : 'create', path: notePath, newContent });
      },
    },
  ];
}
