import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler } from './registry.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { loadSources } from '../../knowledge/source-loader.js';
import { logger } from '../../utils/logger.js';
import { autoWrite, frontmatterFieldUpdate } from '../../editing/auto-writer.js';

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
    {
      definition: {
        name: 'kb_suggest',
        description:
          'Given a source note (reading, experiment, or series), load it along with the three Knowledge index files and propose which Knowledge notes to update or create. Present the proposal to the user and wait for their confirmation before calling kb_write_mapping.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Relative vault path to the source note',
            },
          },
          required: ['source'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.source as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.source}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.source}` });
        }

        const sourceContent = fs.readFileSync(notePath, 'utf-8');

        // Load all three indexes (missing index is not an error — just means empty KB)
        const indexes: Record<string, string> = {};
        for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
          const idxPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
          indexes[kind] = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf-8') : '(empty)';
        }

        return JSON.stringify({
          sourceContent,
          sourcePath: args.source,
          indexes,
          instruction: [
            'STEP 1 (required): Call vault_search with query: key terms from the source content, search_path: "Knowledge/". This finds semantic matches in existing knowledge notes that the index may miss.',
            'STEP 2: Based on the source content, the Knowledge indexes above, AND the vault_search results, propose a knowledge mapping.',
            'Format your proposal as:',
            '',
            'PROPOSED KNOWLEDGE UPDATES:',
            '',
            'HIGH confidence:',
            '  [[note-slug]] — reason (include if found via index or semantic search)',
            '',
            'MEDIUM confidence:',
            '  [[note-slug]] — reason',
            '',
            'NEW (not yet in knowledge base):',
            '  Suggest creating: Knowledge/Entities/slug (entity_type: protein, kind: Entities)',
            '',
            'REJECTED (no KB value):',
            '  [[note-slug]] — reason',
            '',
            'STEP 3: After the user confirms/edits this mapping, call kb_write_mapping with the confirmed and rejected targets.',
          ].join('\n'),
        });
      },
    },
    {
      definition: {
        name: 'kb_write_mapping',
        description:
          'Write the confirmed mapping artifact and update kb_status on the source note. Call this ONLY after the user has confirmed the kb_suggest proposal. If zero targets are confirmed, pass an empty confirmed_targets array — kb_status will be set to skipped and no artifact is written.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Relative vault path to the source note',
            },
            confirmed_targets: {
              type: 'array',
              description: 'Targets the user confirmed — each has slug and action (update|create)',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  action: { type: 'string', enum: ['update', 'create'] },
                  kind: { type: 'string', description: 'Concepts|Entities|Methods (required for create)' },
                },
                required: ['slug', 'action'],
              },
            },
            rejected_targets: {
              type: 'array',
              description: 'Targets the user explicitly rejected',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['slug'],
              },
            },
            rerun_confirmed: {
              type: 'boolean',
              description: 'Set to true to confirm creating a new mapping when a completed artifact already exists',
            },
          },
          required: ['source', 'confirmed_targets', 'rejected_targets'],
        },
      },
      execute: async (args) => {
        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, args.source as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.source}"` });
        }
        if (!fs.existsSync(notePath)) {
          return JSON.stringify({ error: `File not found: ${args.source}` });
        }

        const confirmedTargets = (args.confirmed_targets as Array<{ slug: string; action: string; kind?: string }>) || [];
        const rejectedTargets = (args.rejected_targets as Array<{ slug: string; reason?: string }>) || [];
        // Determine source type once — only Reading notes use kb_status
        const isReadingNote = (args.source as string).startsWith('Reading/');

        // Use args.source (vault-relative) to derive all paths — avoids symlink
        // desync between raw vaultPath and realpathSync-resolved notePath on macOS.
        const sourceRel = (args.source as string).replace(/\\/g, '/');
        // Absolute path constructed from vaultPath directly (no realpathSync desync)
        const sourceAbsVault = path.join(vaultPath, sourceRel);

        // Case B: no confirmed targets → skipped
        if (confirmedTargets.length === 0) {
          if (isReadingNote) {
            frontmatterFieldUpdate(sourceAbsVault, 'kb_status', 'skipped', vaultPath);
          }
          return JSON.stringify({ status: 'skipped', message: 'No targets confirmed. No mapping artifact written.' + (isReadingNote ? ' kb_status set to skipped.' : '') });
        }

        // Build mapping artifact content
        const sourceSlug = path.basename(sourceRel, '.md');
        const sourceDir = path.dirname(sourceRel); // vault-relative directory
        const today = new Date().toISOString().slice(0, 10);
        const targetRows = confirmedTargets.map(t =>
          `| [[${t.slug}]] | ${t.action} | pending | | |`
        ).join('\n');
        const rejectedLines = rejectedTargets.map(t =>
          `- [[${t.slug}]]${t.reason ? ` — "${t.reason}"` : ''}`
        ).join('\n');

        const artifactContent = `---
type: kb-mapping
source: [[${sourceSlug}]]
created: ${today}
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
${targetRows}

## Rejected
${rejectedLines || '(none)'}
`;

        // Determine artifact path (alongside source note) — vault-relative
        const artifactRel = `${sourceDir}/${sourceSlug}-mapping.md`;
        const artifactAbs = path.join(vaultPath, artifactRel);

        // Check collision (spec §10)
        if (fs.existsSync(artifactAbs)) {
          const existing = fs.readFileSync(artifactAbs, 'utf-8');
          if (existing.includes('status: applied')) {
            if (!args.rerun_confirmed) {
              return JSON.stringify({
                status: 'needs_confirmation',
                message: `A completed mapping artifact already exists at "${artifactRel}". Call kb_write_mapping again with rerun_confirmed: true to create a new timestamped mapping.`,
              });
            }
            const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
            const newRel = `${sourceDir}/${sourceSlug}-mapping-${ts}.md`;
            autoWrite(path.join(vaultPath, newRel), artifactContent, vaultPath);
            if (isReadingNote) {
              frontmatterFieldUpdate(sourceAbsVault, 'kb_status', 'mapped', vaultPath);
            }
            return JSON.stringify({ status: 'mapped', artifactPath: newRel, targetCount: confirmedTargets.length, note: 'Previous applied artifact preserved; new timestamped artifact created.' });
          } else if (existing.includes('status: confirmed')) {
            return JSON.stringify({ status: 'already_in_progress', message: 'A mapping is already in progress. Run kb_apply to continue.' });
          }
          // status: draft → overwrite
        }

        autoWrite(path.join(vaultPath, artifactRel), artifactContent, vaultPath);
        if (isReadingNote) {
          frontmatterFieldUpdate(sourceAbsVault, 'kb_status', 'mapped', vaultPath);
        }

        return JSON.stringify({
          status: 'mapped',
          artifactPath: artifactRel,
          targetCount: confirmedTargets.length,
          message: `Mapping artifact written. Run kb_apply with mapping: "${artifactRel}" to start applying updates.`,
        });
      },
    },
  ];
}
