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
        const isReadingNote = /^Reading\/[^/]+\//.test(args.source as string);

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

        // Runtime validation of action enum
        const validActions = new Set(['update', 'create']);
        for (const t of confirmedTargets) {
          if (!validActions.has(t.action)) {
            return JSON.stringify({ error: `Invalid action "${t.action}" for target "${t.slug}". Must be "update" or "create".` });
          }
          if (t.action === 'create' && !t.kind) {
            return JSON.stringify({ error: `Target "${t.slug}" has action "create" but missing required "kind" field (Concepts|Entities|Methods).` });
          }
        }

        // Build mapping artifact content
        const sanitize = (s: string) => s.replace(/[|\n\r]/g, ' ').trim();
        const sourceSlug = path.basename(sourceRel, '.md');
        const sourceDir = path.dirname(sourceRel); // vault-relative directory
        const today = new Date().toISOString().slice(0, 10);
        const targetRows = confirmedTargets.map(t =>
          `| [[${sanitize(t.slug)}]] | ${t.action} | pending | | |`
        ).join('\n');
        const rejectedLines = rejectedTargets.map(t =>
          `- [[${sanitize(t.slug)}]]${t.reason ? ` — "${sanitize(t.reason)}"` : ''}`
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
          const existingParsed = matter(existing);
          if (existingParsed.data.status === 'applied') {
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
          } else if (existingParsed.data.status === 'confirmed') {
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
    {
      definition: {
        name: 'kb_lint',
        description: 'Run structural health checks on the knowledge base. Writes a Lint Report to Knowledge/_Ops/Lint-Reports/.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Optional: specific folder or note to lint. Default: entire vault.' },
          },
          required: [],
        },
      },
      execute: async (args) => {
        const urgent: string[] = [];
        const needsAttention: string[] = [];
        const niceToImprove: string[] = [];

        const knowledgeDirs = ['Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods'];
        const target = args.target as string | undefined;
        const targetAbs = target ? (() => { try { return resolveVaultPath(vaultPath, target); } catch { return null; } })() : null;

        // ── Check #1 & #2: compiled_from and unsourced claims ───────────────────
        for (const rel of knowledgeDirs) {
          const dir = path.join(vaultPath, rel);
          if (!fs.existsSync(dir)) continue;
          if (targetAbs && !targetAbs.startsWith(dir)) continue;
          for (const file of fs.readdirSync(dir)) {
            if (file === '_index.md' || !file.endsWith('.md')) continue;
            const filePath = path.join(dir, file);
            if (targetAbs && filePath !== targetAbs && !filePath.startsWith(targetAbs)) continue;
            const parsed = matter(fs.readFileSync(filePath, 'utf-8'));
            const compiledFrom = parsed.data.compiled_from;
            const slug = path.basename(file, '.md');

            // Check #1: no compiled_from
            if (!compiledFrom || (Array.isArray(compiledFrom) && compiledFrom.length === 0)) {
              urgent.push(`[[${slug}]] has no compiled_from — no source attribution`);
            }

            // Check #2: claims without source links
            const body = parsed.content;
            const claimLines = body.split('\n').filter(l => /^- \[(?:supports|contradicts|extends)\]/.test(l.trim()));
            for (const line of claimLines) {
              if (!line.includes('[[')) {
                urgent.push(`[[${slug}]] has a claim without a source link: "${line.trim().slice(0, 60)}..."`);
              }
            }

            // Check #5: needs_review older than 14 days
            if (parsed.data.needs_review && parsed.data.review_flagged_at) {
              const flaggedAt = new Date(parsed.data.review_flagged_at as string).getTime();
              if (Date.now() - flaggedAt > 14 * 24 * 60 * 60 * 1000) {
                needsAttention.push(`[[${slug}]] has needs_review: true flagged ${parsed.data.review_flagged_at} (>14 days ago)`);
              }
            }
          }
        }

        // ── Check #3: broken wikilinks ────────────────────────────────────────────
        const allSlugs = new Set<string>();
        function collectSlugs(dirPath: string) {
          if (!fs.existsSync(dirPath)) return;
          for (const f of fs.readdirSync(dirPath)) {
            const full = path.join(dirPath, f);
            if (fs.statSync(full).isDirectory()) collectSlugs(full);
            else if (f.endsWith('.md')) allSlugs.add(path.basename(f, '.md'));
          }
        }
        collectSlugs(path.join(vaultPath, 'Knowledge'));
        collectSlugs(path.join(vaultPath, 'Reading'));
        collectSlugs(path.join(vaultPath, 'Projects'));
        collectSlugs(path.join(vaultPath, 'Protocols'));

        for (const rel of knowledgeDirs) {
          const dir = path.join(vaultPath, rel);
          if (!fs.existsSync(dir)) continue;
          for (const file of fs.readdirSync(dir)) {
            if (file === '_index.md' || !file.endsWith('.md')) continue;
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            const links = [...content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim());
            for (const link of links) {
              if (!allSlugs.has(link)) {
                urgent.push(`[[${path.basename(file, '.md')}]] has broken wikilink: [[${link}]]`);
              }
            }
          }
        }

        // ── Check #4: complete reading notes with unfinished KB work ─────────────
        const readingDirs = ['Reading/Papers', 'Reading/Threads'];
        for (const rel of readingDirs) {
          const dir = path.join(vaultPath, rel);
          if (!fs.existsSync(dir)) continue;
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.md') || file.endsWith('-mapping.md')) continue;
            const parsed = matter(fs.readFileSync(path.join(dir, file), 'utf-8'));
            if (parsed.data.status === 'complete' && ['pending', 'mapped', 'merged_with_review'].includes(parsed.data.kb_status as string)) {
              needsAttention.push(`[[${path.basename(file, '.md')}]] is complete but kb_status is "${parsed.data.kb_status}"`);
            }
          }
        }

        // ── Check #6: Review-Queue items older than 14 days ───────────────────────
        const rqDir = path.join(vaultPath, 'Knowledge', 'Review-Queue');
        if (fs.existsSync(rqDir)) {
          for (const file of fs.readdirSync(rqDir)) {
            if (!file.endsWith('.md')) continue;
            const parsed = matter(fs.readFileSync(path.join(rqDir, file), 'utf-8'));
            if (parsed.data.status === 'pending' && parsed.data.created) {
              const createdAt = new Date(parsed.data.created as string).getTime();
              if (Date.now() - createdAt > 14 * 24 * 60 * 60 * 1000) {
                needsAttention.push(`Review-Queue item [[${path.basename(file, '.md')}]] is pending for >14 days`);
              }
            }
          }
        }

        // ── Write Lint Report ────────────────────────────────────────────────────
        const today = new Date().toISOString().slice(0, 10);
        const reportPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports', `${today}.md`);

        const urgentSection = urgent.length > 0 ? `\n## Urgent\n${urgent.map(i => `- ${i}`).join('\n')}` : '';
        const attentionSection = needsAttention.length > 0 ? `\n## Needs Attention\n${needsAttention.map(i => `- ${i}`).join('\n')}` : '';
        const niceSection = niceToImprove.length > 0 ? `\n## Nice to Improve\n${niceToImprove.map(i => `- ${i}`).join('\n')}` : '';

        const noIssues = urgent.length === 0 && needsAttention.length === 0 && niceToImprove.length === 0;
        const reportBody = noIssues ? '\n_No issues found._' : `${urgentSection}${attentionSection}${niceSection}`;

        const reportContent = matter.stringify(
          `\n# KB Lint Report — ${today}${reportBody}`,
          { type: 'lint-report', date: today }
        );
        autoWrite(reportPath, reportContent, vaultPath);

        log.info('kb_lint complete', { urgent: urgent.length, needsAttention: needsAttention.length });
        return JSON.stringify({
          urgent,
          needs_attention: needsAttention,
          nice_to_improve: niceToImprove,
          report_path: `Knowledge/_Ops/Lint-Reports/${today}.md`,
          summary: `${urgent.length} urgent, ${needsAttention.length} needs attention, ${niceToImprove.length} nice to improve`,
        });
      },
    },
  ];
}
