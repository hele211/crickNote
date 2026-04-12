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

// Helper: validate path is inside vault (including symlink resolution), then return
// a path.join result to avoid realpathSync desync on macOS with autoWrite.
function safeVaultJoin(vaultRoot: string, rel: string): string {
  const normalized = path.normalize(rel.replace(/\\/g, '/'));
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`Path traversal rejected: "${rel}"`);
  }
  // Use resolveVaultPath to validate symlinks don't escape the vault (throws if they do),
  // but return path.join to keep consistent prefix with vaultRoot for autoWrite.
  resolveVaultPath(vaultRoot, normalized); // throws if outside vault after symlink resolution
  return path.join(vaultRoot, normalized);
}

// Slug validation — must not contain path separators or traversal sequences.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidSlug(s: string): boolean { return SLUG_RE.test(s); }

// Escape regex metacharacters in a literal string.
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Helper: parse the Targets table from a mapping artifact body.
// Scoped to the ## Targets section; supports [[slug|alias]] wikilinks.
interface MappingTarget {
  slug: string;
  action: string;
  state: string;
  reviewQueue: string;
  updated: string;
}

function parseMappingTargets(body: string): MappingTarget[] {
  const targets: MappingTarget[] = [];
  const sectionMatch = body.match(/## Targets\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!sectionMatch) return targets;
  for (const line of sectionMatch[1].split('\n')) {
    if (!line.includes('[[')) continue;
    const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 5) continue;
    const slugMatch = cells[0].match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    if (!slugMatch) continue;
    const slug = slugMatch[1].trim();
    if (!slug) continue;
    targets.push({ slug, action: cells[1], state: cells[2], reviewQueue: cells[3], updated: cells[4] });
  }
  return targets;
}

// Update a target row's state in the mapping body. Returns updated content and a flag.
function updateMappingTargetState(
  artifactContent: string,
  slug: string,
  newState: string,
  reviewQueueLink: string,
): { content: string; updated: boolean } {
  const escapedSlug = escapeRegex(slug);
  const rowRegex = new RegExp(
    `(\\|\\s*\\[\\[${escapedSlug}(?:\\|[^\\]]*)?\\]\\]\\s*\\|\\s*\\S+\\s*\\|)\\s*\\S+\\s*(\\|[^|]*\\|)[^|]*(\\|)`,
  );
  const timestamp = new Date().toISOString().slice(0, 16);
  const newContent = artifactContent.replace(rowRegex, `$1 ${newState} | ${reviewQueueLink} | ${timestamp} |`);
  return { content: newContent, updated: newContent !== artifactContent };
}

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

    // -----------------------------------------------------------------------
    // kb_apply (Mode 1 — from mapping artifact)
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply',
        description:
          'Load the next pending target from a mapping artifact alongside the source note. Returns their content so you can propose an update via vault_write. After the user confirms vault_write, call kb_apply_advance to record the state change.',
        parameters: {
          type: 'object',
          properties: {
            mapping: {
              type: 'string',
              description: 'Relative vault path to the mapping artifact (*-mapping.md)',
            },
          },
          required: ['mapping'],
        },
      },
      execute: async (args) => {
        let artifactPath: string;
        try {
          artifactPath = resolveVaultPath(vaultPath, args.mapping as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.mapping}"` });
        }
        if (!fs.existsSync(artifactPath)) {
          return JSON.stringify({ error: `Mapping artifact not found: ${args.mapping}` });
        }

        const raw = fs.readFileSync(artifactPath, 'utf-8');
        const parsed = matter(raw);
        const targets = parseMappingTargets(parsed.content);

        const pending = targets.find(t => t.state === 'pending');
        if (!pending) {
          return JSON.stringify({ status: 'all_done', message: 'No pending targets remain. Call kb_apply_advance with the final update_log to complete the workflow.' });
        }

        // Resolve source slug from mapping frontmatter; validate it
        const sourceWikilink = String(parsed.data['source'] || '');
        const sourceSlug = sourceWikilink.replace(/^\[\[|\]\]$/g, '').trim();
        if (!isValidSlug(sourceSlug)) {
          return JSON.stringify({ error: `Invalid source slug in mapping frontmatter: "${sourceSlug}"` });
        }
        if (!isValidSlug(pending.slug)) {
          return JSON.stringify({ error: `Invalid target slug in mapping table: "${pending.slug}"` });
        }

        // Find source note — first try mapping artifact directory (supports experiment notes
        // in project subdirs like Projects/P001-*/CM003-qpcr.md), then fall back to common locations
        let sourceContent = '(source note not found)';
        const artifactDir = path.dirname(artifactPath);
        const candidatePaths = [
          path.join(artifactDir, `${sourceSlug}.md`),
          path.join(vaultPath, 'Reading', 'Papers', `${sourceSlug}.md`),
          path.join(vaultPath, 'Reading', 'Threads', `${sourceSlug}.md`),
        ];
        for (const candidatePath of candidatePaths) {
          if (fs.existsSync(candidatePath)) {
            sourceContent = fs.readFileSync(candidatePath, 'utf-8');
            break;
          }
        }
        // If still not found, search recursively under Projects/
        if (sourceContent === '(source note not found)') {
          const projectsDir = path.join(vaultPath, 'Projects');
          if (fs.existsSync(projectsDir)) {
            function findInDir(dir: string): string | null {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) { const r = findInDir(path.join(dir, entry.name)); if (r) return r; }
                else if (entry.name === `${sourceSlug}.md`) return path.join(dir, entry.name);
              }
              return null;
            }
            const found = findInDir(projectsDir);
            if (found) sourceContent = fs.readFileSync(found, 'utf-8');
          }
        }

        // Find target knowledge note (try all three kinds)
        let targetContent = '(target note not found — will be created)';
        let targetPath = '';
        for (const kind of ['Concepts', 'Entities', 'Methods']) {
          const candidate = path.join(vaultPath, 'Knowledge', kind, `${pending.slug}.md`);
          if (fs.existsSync(candidate)) {
            targetContent = fs.readFileSync(candidate, 'utf-8');
            targetPath = `Knowledge/${kind}/${pending.slug}.md`;
            break;
          }
        }

        // Crash-recovery dedup: if source already in compiled_from, skip.
        // Normalize entries to bare slugs (strip [[/]]) and use exact equality.
        if (targetContent !== '(target note not found — will be created)') {
          const targetFm = matter(targetContent).data as Record<string, unknown>;
          const compiledFrom = Array.isArray(targetFm['compiled_from']) ? targetFm['compiled_from'] : [];
          const normalizedFrom = compiledFrom.map((cf: unknown) =>
            String(cf).replace(/^\[\[|\]\]$/g, '').trim()
          );
          if (normalizedFrom.includes(sourceSlug)) {
            return JSON.stringify({
              status: 'already_applied',
              message: `Source [[${sourceSlug}]] is already in compiled_from of [[${pending.slug}]]. Skipping — call kb_apply_advance with state: "applied" to advance.`,
              target_slug: pending.slug,
            });
          }
        }

        return JSON.stringify({
          sourceContent,
          targetContent,
          targetSlug: pending.slug,
          targetAction: pending.action,
          targetPath: targetPath || `(determine correct Kind folder before creating)`,
          mappingPath: args.mapping,
          remainingPending: targets.filter(t => t.state === 'pending').length,
          instruction: [
            `Update [[${pending.slug}]] (action: ${pending.action}) using the source content above.`,
            'Rules:',
            '  1. Prefer updating an existing note over creating a new one.',
            '  2. Every Key Claims bullet must use format: - [supports|contradicts|extends] Text. [[source-slug]]',
            '  3. Never silently delete old claims — add contradiction tag instead.',
            '  4. Put disagreements into Contradictions and Caveats section.',
            '  5. Update compiled_from, last_updated, and aliases if new synonyms found.',
            '',
            'Call vault_write with the updated knowledge note content.',
            'After the user confirms, call kb_apply_advance.',
          ].join('\n'),
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_apply_advance
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply_advance',
        description:
          'Record the outcome of one kb_apply step: update the mapping artifact state, create a Review-Queue note if deferred, set needs_review if contradiction was added. When all targets are done, writes the Update Log, rebuilds Knowledge indexes, and updates kb_status.',
        parameters: {
          type: 'object',
          properties: {
            mapping: { type: 'string', description: 'Relative vault path to the mapping artifact' },
            target_slug: { type: 'string', description: 'Slug of the knowledge note just processed' },
            state: { type: 'string', enum: ['applied', 'skipped', 'deferred'], description: 'Outcome for this target' },
            contradiction_added: { type: 'boolean', description: 'True if a contradiction was added to the knowledge note' },
            review_queue_title: { type: 'string', description: 'Title for Review-Queue note (required when state=deferred)' },
            review_queue_reason: { type: 'string', description: 'Reason slug (ambiguous-relationship, source-conflict, etc.)' },
            review_queue_body: { type: 'string', description: 'Full body of the Review-Queue note (required when state=deferred)' },
            update_log: {
              type: 'object',
              description: 'Summary of all changes this session — provide on FINAL advance (last pending target)',
              properties: {
                updated: { type: 'array', items: { type: 'string' } },
                created: { type: 'array', items: { type: 'string' } },
                deferred: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['mapping', 'target_slug', 'state', 'contradiction_added'],
        },
      },
      execute: async (args) => {
        // -- Input validation ------------------------------------------------
        let artifactPath: string;
        try {
          artifactPath = safeVaultJoin(vaultPath, args.mapping as string);
        } catch {
          return JSON.stringify({ error: `Invalid mapping path: "${args.mapping}"` });
        }
        if (!fs.existsSync(artifactPath)) {
          return JSON.stringify({ error: `Mapping artifact not found: ${args.mapping}` });
        }

        const slug = args.target_slug as string;
        const state = args.state as string;
        const contradictionAdded = Boolean(args.contradiction_added);

        if (!isValidSlug(slug)) {
          return JSON.stringify({ error: `Invalid target_slug: "${slug}"` });
        }
        const validStates = new Set(['applied', 'skipped', 'deferred']);
        if (!validStates.has(state)) {
          return JSON.stringify({ error: `Invalid state: "${state}". Must be applied, skipped, or deferred.` });
        }
        if (state === 'deferred' && !args.review_queue_body) {
          return JSON.stringify({ error: 'review_queue_body is required when state is "deferred".' });
        }

        // -- Parse mapping artifact ------------------------------------------
        const raw = fs.readFileSync(artifactPath, 'utf-8');
        const parsed = matter(raw);
        const allTargetsBefore = parseMappingTargets(parsed.content);

        if (allTargetsBefore.length === 0) {
          return JSON.stringify({ error: 'Mapping artifact has no parseable target rows.' });
        }
        if (!allTargetsBefore.some(t => t.slug === slug)) {
          return JSON.stringify({ error: `Target slug "${slug}" not found in mapping artifact.` });
        }

        // Require update_log (with valid shape) on the final advance — validate before side effects
        const remainingAfter = allTargetsBefore.filter(t => t.slug !== slug && t.state === 'pending');
        if (remainingAfter.length === 0) {
          if (!args.update_log) {
            return JSON.stringify({ error: 'update_log is required on the final kb_apply_advance call.' });
          }
          const ul = args.update_log as Record<string, unknown>;
          if (!Array.isArray(ul['updated']) || !Array.isArray(ul['created']) || !Array.isArray(ul['deferred'])) {
            return JSON.stringify({ error: 'update_log must have arrays: updated, created, deferred.' });
          }
        }

        // Validate sourceSlug from frontmatter before it is used in filenames/paths
        const sourceSlugRaw = String(parsed.data['source'] || '').replace(/^\[\[|\]\]$/g, '').trim();
        if (remainingAfter.length === 0 && !isValidSlug(sourceSlugRaw)) {
          return JSON.stringify({ error: `Invalid source slug in mapping frontmatter: "${sourceSlugRaw}"` });
        }

        let rqLink = '';

        // -- Create Review-Queue note if deferred ----------------------------
        if (state === 'deferred') {
          const rqTitle = (args.review_queue_title as string) || `${slug}-review`;
          const today = new Date().toISOString().slice(0, 10);
          // Add millisecond suffix to avoid collision on same-day same-target deferrals
          const rqSuffix = Date.now().toString(36);
          const rqSlug = `${today}-${slug}-${rqSuffix}`;
          const rqBody = args.review_queue_body as string;
          const rqContent = `---
type: review-queue
source: ${parsed.data['source'] || ''}
target_concept: [[${slug}]]
reason: ${(args.review_queue_reason as string) || 'ambiguous-relationship'}
created: ${today}
status: pending
rq_source: ${String(parsed.data['source'] || '').replace(/^\[\[|\]\]$/g, '')}
rq_target: ${slug}
---

# ${rqTitle}

## The Issue
${rqBody}

## Source Claim

## Existing Knowledge

## Resolution
`;
          const rqPath = path.join(vaultPath, 'Knowledge', 'Review-Queue', `${rqSlug}.md`);
          autoWrite(rqPath, rqContent, vaultPath);
          rqLink = `[[${rqSlug}]]`;

          for (const kind of ['Concepts', 'Entities', 'Methods']) {
            const candidate = path.join(vaultPath, 'Knowledge', kind, `${slug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'needs_review', true, vaultPath);
              frontmatterFieldUpdate(candidate, 'review_flagged_at', new Date().toISOString(), vaultPath);
              break;
            }
          }
        }

        // -- Set needs_review if contradiction added -------------------------
        if (contradictionAdded && state !== 'deferred') {
          for (const kind of ['Concepts', 'Entities', 'Methods']) {
            const candidate = path.join(vaultPath, 'Knowledge', kind, `${slug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'needs_review', true, vaultPath);
              frontmatterFieldUpdate(candidate, 'review_flagged_at', new Date().toISOString(), vaultPath);
              break;
            }
          }
        }

        // -- Update mapping artifact target row ------------------------------
        const { content: newBody, updated: rowUpdated } = updateMappingTargetState(parsed.content, slug, state, rqLink);
        if (!rowUpdated) {
          return JSON.stringify({ error: `Could not update row for target "${slug}" in mapping artifact — row not found or already updated.` });
        }
        const allTargets = parseMappingTargets(newBody);
        const anyPending = allTargets.some(t => t.state === 'pending');
        const newStatus = anyPending ? 'confirmed' : 'applied';

        const updatedArtifact = matter.stringify(newBody, { ...parsed.data, status: newStatus });
        autoWrite(artifactPath, updatedArtifact, vaultPath);

        // -- Finalisation: Update Log, index rebuild, kb_status --------------
        if (!anyPending) {
          const sourceSlug = sourceSlugRaw;
          const today = new Date().toISOString().slice(0, 10);
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

          const updateLog = args.update_log as { updated: string[]; created: string[]; deferred: string[] };
          const logContent = `---
type: update-log
source: ${parsed.data['source'] || ''}
date: ${today}
---

# KB Update Log — ${sourceSlug}

## Updated
${updateLog.updated.map(u => `- ${u}`).join('\n') || '(none)'}

## Created
${updateLog.created.map(c => `- ${c}`).join('\n') || '(none)'}

## Deferred to Review
${updateLog.deferred.map(d => `- ${d}`).join('\n') || '(none)'}
`;
          const logPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs', `${ts}-${sourceSlug}.md`);
          autoWrite(logPath, logContent, vaultPath);

          const { rebuildKnowledgeIndex } = await import('../../knowledge/index-builder.js');
          for (const kind of ['Concepts', 'Entities', 'Methods'] as const) {
            const kindDir = path.join(vaultPath, 'Knowledge', kind);
            if (fs.existsSync(kindDir)) rebuildKnowledgeIndex(kind, vaultPath);
          }

          const anyDeferred = allTargets.some(t => t.state === 'deferred');
          const newKbStatus = anyDeferred ? 'merged_with_review' : 'merged';
          for (const prefix of ['Reading/Papers', 'Reading/Threads']) {
            const candidate = path.join(vaultPath, prefix, `${sourceSlug}.md`);
            if (fs.existsSync(candidate)) {
              frontmatterFieldUpdate(candidate, 'kb_status', newKbStatus, vaultPath);
              break;
            }
          }
        }

        log.info('kb_apply_advance', { target: slug, state, mappingStatus: newStatus });
        return JSON.stringify({
          status: state,
          target: slug,
          mappingStatus: newStatus,
          remainingPending: anyPending ? allTargets.filter(t => t.state === 'pending').length : 0,
          message: anyPending
            ? `Target [[${slug}]] marked ${state}. Call kb_apply again to process the next pending target.`
            : `All targets processed. Mapping status: ${newStatus}. kb_status updated.`,
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_apply_direct (Mode 2)
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_apply_direct',
        description:
          'Load a single source note and a specific target Knowledge note for a direct (ad-hoc) update. Does NOT change kb_status on reading notes — use the full kb_suggest → kb_apply pipeline for systematic processing. After calling this tool, propose the update via vault_write, then optionally call this tool again with update_log to record the Update Log.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Relative vault path to source note (reading or experiment)' },
            target: { type: 'string', description: 'Relative vault path to target Knowledge note' },
            update_log: {
              type: 'object',
              description: 'If provided, writes an Update Log. Omit to just load content.',
              properties: {
                updated: { type: 'array', items: { type: 'string' } },
                created: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
              },
            },
          },
          required: ['source', 'target'],
        },
      },
      execute: async (args) => {
        let sourcePath: string, targetPath: string;
        try {
          sourcePath = resolveVaultPath(vaultPath, args.source as string);
          targetPath = resolveVaultPath(vaultPath, args.target as string);
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message });
        }
        const targetRel = path.posix.normalize((args.target as string).replace(/\\/g, '/'));
        const allowedPrefixes = ['Knowledge/Concepts/', 'Knowledge/Entities/', 'Knowledge/Methods/'];
        if (
          targetRel.startsWith('../') || targetRel === '..' || path.posix.isAbsolute(targetRel) ||
          !allowedPrefixes.some(p => targetRel.startsWith(p)) || !targetRel.endsWith('.md')
        ) {
          return JSON.stringify({ error: `Target must be a .md file under Knowledge/Concepts/, Knowledge/Entities/, or Knowledge/Methods/. Got: "${args.target}"` });
        }
        if (!fs.existsSync(sourcePath)) return JSON.stringify({ error: `Source not found: ${args.source}` });
        if (!fs.existsSync(targetPath)) return JSON.stringify({ error: `Target not found: ${args.target}` });

        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
        const targetContent = fs.readFileSync(targetPath, 'utf-8');

        // Write Update Log if provided
        const updateLog = args.update_log as { updated: string[]; created: string[]; notes: string } | undefined;
        let logPath = '';
        if (updateLog) {
          const sourceSlug = path.basename(sourcePath, '.md');
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          const timePart = now.toISOString().slice(11, 19).replace(/:/g, '-');
          const logContent = `---
type: update-log
source: [[${sourceSlug}]]
date: ${today}
mode: direct
---

# KB Update Log (direct) — ${sourceSlug}

## Updated
${(updateLog.updated || []).map(u => `- ${u}`).join('\n') || '(none)'}

## Created
${(updateLog.created || []).map(c => `- ${c}`).join('\n') || '(none)'}

## Notes
${updateLog.notes || ''}
`;
          logPath = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs', `${today}T${timePart}-${sourceSlug}.md`);
          autoWrite(logPath, logContent, vaultPath);
        }

        return JSON.stringify({
          sourceContent,
          targetContent,
          logWritten: logPath ? path.relative(vaultPath, logPath) : null,
          instruction: [
            `Update the target knowledge note using the source content.`,
            'Rules (same as kb_apply):',
            '  1. Every Key Claims bullet: - [supports|contradicts|extends] Text. [[source-slug]]',
            '  2. Never delete old claims — add contradiction tag instead.',
            '  3. Update compiled_from, last_updated, aliases.',
            '  4. kb_status on the source note is NOT changed by direct mode.',
            '',
            'Call vault_write with the updated target content.',
          ].join('\n'),
        });
      },
    },

    // -----------------------------------------------------------------------
    // kb_resolve_review
    // -----------------------------------------------------------------------
    {
      definition: {
        name: 'kb_resolve_review',
        description:
          'Load a Review-Queue item and its target Knowledge note. If resolution and resolution_summary are provided, marks the item resolved, clears needs_review on the target (if no other pending items target it), and updates kb_status on the source note if this was the last unresolved item.',
        parameters: {
          type: 'object',
          properties: {
            review_item: { type: 'string', description: 'Relative vault path to the Review-Queue note' },
            resolution: { type: 'string', enum: ['resolved', 'dismissed'], description: 'Outcome — provide after the user has decided' },
            resolution_summary: { type: 'string', description: 'One-line summary of the resolution decision' },
            confirmed_knowledge_write: {
              type: 'boolean',
              description: 'Set to true ONLY after the user has confirmed the vault_write diff for the Knowledge note update. Required when passing resolution.',
            },
          },
          required: ['review_item'],
        },
      },
      execute: async (args) => {
        let rqPath: string;
        try {
          rqPath = safeVaultJoin(vaultPath, args.review_item as string);
        } catch {
          return JSON.stringify({ error: `Invalid path: "${args.review_item}"` });
        }
        if (!fs.existsSync(rqPath)) {
          return JSON.stringify({ error: `Review-Queue note not found: ${args.review_item}` });
        }

        const raw = fs.readFileSync(rqPath, 'utf-8');
        const parsed = matter(raw);
        const fm = parsed.data as Record<string, unknown>;

        const rqTarget = String(fm['rq_target'] || '').replace(/^\[\[|\]\]$/g, '');
        const rqSource = String(fm['rq_source'] || '').replace(/^\[\[|\]\]$/g, '');

        if (!rqTarget || !isValidSlug(rqTarget)) {
          return JSON.stringify({ error: `Invalid or missing rq_target in Review-Queue note: "${rqTarget}"` });
        }
        if (!rqSource || !isValidSlug(rqSource)) {
          return JSON.stringify({ error: `Invalid or missing rq_source in Review-Queue note: "${rqSource}"` });
        }

        // Find target knowledge note
        let targetContent = '(not found)';
        let targetAbsPath = '';
        for (const kind of ['Concepts', 'Entities', 'Methods']) {
          const candidate = path.join(vaultPath, 'Knowledge', kind, `${rqTarget}.md`);
          if (fs.existsSync(candidate)) {
            targetContent = fs.readFileSync(candidate, 'utf-8');
            targetAbsPath = candidate;
            break;
          }
        }

        const resolution = args.resolution as string | undefined;
        const confirmedWrite = Boolean(args.confirmed_knowledge_write);

        if (resolution && resolution !== 'resolved' && resolution !== 'dismissed') {
          return JSON.stringify({ error: `Invalid resolution value: "${resolution}". Must be "resolved" or "dismissed".` });
        }

        if (resolution && !confirmedWrite) {
          return JSON.stringify({
            error: 'Safety guard: confirmed_knowledge_write must be true before resolving a Review-Queue item. Call vault_write to update the Knowledge note first, then call kb_resolve_review again after the user confirms the diff.',
          });
        }

        if (!resolution) {
          // First call — just load content for LLM review
          return JSON.stringify({
            reviewContent: raw,
            targetContent,
            rqTarget,
            rqSource,
            instruction: [
              `Review the conflict above and decide how to resolve it.`,
              `IMPORTANT: the workflow is:`,
              `  1. Call vault_write to update [[${rqTarget}]] in the Knowledge folder (required first)`,
              `  2. Wait for user confirmation of the diff`,
              `  3. THEN call kb_resolve_review again with resolution: "resolved" and resolution_summary`,
              `Calling kb_resolve_review with a resolution before vault_write confirmation violates the spec.`,
            ].join('\n'),
          });
        }

        // Mark the Review-Queue note resolved/dismissed
        const summary = (args.resolution_summary as string) || '';
        let newBody: string;
        if (/## Resolution\n/.test(parsed.content)) {
          newBody = parsed.content.replace(
            /## Resolution\n[\s\S]*/,
            `## Resolution\n${summary}\n`
          );
        } else {
          newBody = `${parsed.content.trimEnd()}\n\n## Resolution\n${summary}\n`;
        }
        const updatedRq = matter.stringify(newBody, { ...fm, status: resolution });
        autoWrite(rqPath, updatedRq, vaultPath);

        // Check if this is the last pending Review-Queue item for this source
        const rqDir = path.join(vaultPath, 'Knowledge', 'Review-Queue');
        const pendingForSource = fs.readdirSync(rqDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            try { return matter(fs.readFileSync(path.join(rqDir, f), 'utf-8')).data as Record<string, unknown>; }
            catch { return null; }
          })
          .filter(d => d && d['rq_source'] === rqSource && d['status'] === 'pending')
          .length;

        // If no more pending items for this target — clear needs_review
        const pendingForTarget = fs.readdirSync(rqDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            try { return matter(fs.readFileSync(path.join(rqDir, f), 'utf-8')).data as Record<string, unknown>; }
            catch { return null; }
          })
          .filter(d => d && d['rq_target'] === rqTarget && d['status'] === 'pending')
          .length;

        if (pendingForTarget === 0 && targetAbsPath) {
          frontmatterFieldUpdate(targetAbsPath, 'needs_review', false, vaultPath);
          frontmatterFieldUpdate(targetAbsPath, 'review_flagged_at', null, vaultPath);
        }

        // If last pending item for this source — advance kb_status merged_with_review → merged
        if (pendingForSource === 0) {
          for (const prefix of ['Reading/Papers', 'Reading/Threads']) {
            const candidate = path.join(vaultPath, prefix, `${rqSource}.md`);
            if (fs.existsSync(candidate)) {
              const srcFm = matter(fs.readFileSync(candidate, 'utf-8')).data as Record<string, unknown>;
              if (srcFm['kb_status'] === 'merged_with_review') {
                frontmatterFieldUpdate(candidate, 'kb_status', 'merged', vaultPath);
              }
              break;
            }
          }
        }

        // Update mapping artifact: change deferred row → applied for this rq_source/rq_target pair
        const rqSourceSlug = rqSource;
        function findMappingArtifact(rootDir: string): string | null {
          if (!fs.existsSync(rootDir)) return null;
          for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (entry.isDirectory()) { const r = findMappingArtifact(path.join(rootDir, entry.name)); if (r) return r; }
            else if (entry.name === `${rqSourceSlug}-mapping.md`) return path.join(rootDir, entry.name);
          }
          return null;
        }
        const mappingAbs = findMappingArtifact(path.join(vaultPath, 'Reading'))
          || findMappingArtifact(path.join(vaultPath, 'Projects'));
        if (mappingAbs) {
          const mappingRaw = fs.readFileSync(mappingAbs, 'utf-8');
          const mappingParsed = matter(mappingRaw);
          const { content: updatedBody, updated: rowUpdated } = updateMappingTargetState(mappingParsed.content, rqTarget, 'applied', `[[${path.basename(rqPath, '.md')}]]`);
          if (!rowUpdated) {
            log.warn('kb_resolve_review: target row not found in mapping artifact, skipping status update', { rqTarget, mappingAbs });
          } else {
            const allTargets = parseMappingTargets(updatedBody);
            const anyUnresolved = allTargets.some(t => t.state === 'pending' || t.state === 'deferred');
            const newMappingStatus = anyUnresolved ? 'confirmed' : 'applied';
            const updatedMapping = matter.stringify(updatedBody, { ...mappingParsed.data, status: newMappingStatus });
            autoWrite(mappingAbs, updatedMapping, vaultPath);
          }
        }

        return JSON.stringify({
          status: resolution,
          rqItem: args.review_item,
          needsReviewCleared: pendingForTarget === 0,
          kbStatusAdvanced: pendingForSource === 0,
          message: `Review-Queue item ${resolution}. Mapping artifact row updated (deferred → applied). ${pendingForTarget === 0 ? `needs_review cleared on [[${rqTarget}]].` : ''} ${pendingForSource === 0 ? `kb_status advanced to merged.` : ''}`,
        });
      },
    },
  ];
}
