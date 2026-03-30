import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolHandler } from './registry.js';
import { getDatabase } from '../../storage/database.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import { resolveVaultPath } from '../../utils/paths.js';

export function createVaultTools(vaultPath: string, conflictDetector?: ConflictDetector): ToolHandler[] {
  return [
    {
      definition: {
        name: 'vault_read',
        description: 'Read a specific note from the vault. Returns frontmatter metadata and markdown body.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the note within the vault (e.g., "Projects/ProjectA/experiment.md")' },
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
        const content = fs.readFileSync(notePath, 'utf-8');
        // Record snapshot so conflict detection works when the agent later writes this file.
        conflictDetector?.recordFileRead(notePath, content);
        const parsed = matter(content);
        return JSON.stringify({
          path: args.path,
          frontmatter: parsed.data,
          content: parsed.content,
        });
      },
    },
    {
      definition: {
        name: 'vault_list',
        description: 'List notes in a folder, optionally filtered by metadata (date, type, project, status).',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder to list (e.g., "Projects", "Protocols", "Reading", "Memory/Daily")' },
            date: { type: 'string', description: 'Filter by ISO date (e.g., "2026-03-24")' },
            experiment_type: { type: 'string', description: 'Filter by experiment type (e.g., "western-blot")' },
            project: { type: 'string', description: 'Filter by project name' },
            status: { type: 'string', description: 'Filter by status (draft, in-progress, complete)' },
          },
          required: ['folder'],
        },
      },
      execute: async (args) => {
        const folder = args.folder as string;
        if (!folder || folder.includes('..')) {
          return JSON.stringify({ error: 'folder must be a non-empty string without path traversal' });
        }
        const db = getDatabase();
        const conditions: string[] = ['folder LIKE ?'];
        const params: unknown[] = [`${folder}%`];

        if (args.date) { conditions.push('date = ?'); params.push(args.date); }
        if (args.experiment_type) { conditions.push('experiment_type = ?'); params.push(args.experiment_type); }
        if (args.project) { conditions.push('project = ?'); params.push(args.project); }
        if (args.status) { conditions.push('status = ?'); params.push(args.status); }

        const sql = `SELECT path, note_type, date, project, experiment_type, status, result_summary
                     FROM note_metadata WHERE ${conditions.join(' AND ')}
                     ORDER BY date DESC LIMIT 50`;
        const results = db.prepare(sql).all(...params);
        return JSON.stringify(results);
      },
    },
    {
      definition: {
        name: 'vault_append',
        description: 'Append content to an existing note. Triggers safe edit flow (diff preview, user confirmation). Use for adding results, notes, or observations to existing experiments or diary entries.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the note' },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
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
        const existing = fs.readFileSync(notePath, 'utf-8');
        // Record snapshot before modification so conflict detection is active.
        conflictDetector?.recordFileRead(notePath, existing);
        const newContent = existing + '\n' + (args.content as string);
        // Return proposed edit — actual writing handled by safe-writer via runtime.
        // Use the resolved absolute path so runtime doesn't need to re-resolve.
        return JSON.stringify({
          type: 'pending_edit',
          path: notePath,
          newContent,
          operation: 'append',
        });
      },
    },
    {
      definition: {
        name: 'vault_write',
        description: 'Create or overwrite a note in the vault. Triggers safe edit flow (diff preview, user confirmation). Use for creating new experiment notes, protocols, or reading notes.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path for the note' },
            content: { type: 'string', description: 'Full markdown content including frontmatter' },
          },
          required: ['path', 'content'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.path as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.path}"` });
        }
        // Use the resolved absolute path so runtime doesn't need to re-resolve.
        return JSON.stringify({
          type: 'pending_edit',
          path: notePath,
          newContent: args.content,
          operation: fs.existsSync(notePath) ? 'update' : 'create',
        });
      },
    },
  ];
}
