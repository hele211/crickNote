import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler, ToolContext } from './registry.js';
import { getDatabase } from '../../storage/database.js';
import { validatePrefix, getNextSerial } from '../../storage/serial.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { fencedSectionUpdate } from '../../editing/auto-writer.js';
import { logger } from '../../utils/logger.js';
import { renderNoteTemplate, type RenderResult } from '../../templates/template-loader.js';

const log = logger.child('serial-tools');
const RESERVED_PREFIXES = new Set(['PR', 'P']);
const RESERVATION_TTL_MS = 30 * 60 * 1000;

function checkPrefixCollision(prefix: string, excludeProjectId: string | null, db: Database.Database): string | undefined {
  if (RESERVED_PREFIXES.has(prefix)) return `Prefix "${prefix}" is permanently reserved.`;

  const now = Date.now();
  const excl = excludeProjectId ?? '__none__';

  const cntSuffix = db.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(prefix + 'S') as { project_id: string | null } | undefined;
  if (cntSuffix && cntSuffix.project_id !== excludeProjectId) return `Prefix collision: "${prefix}" collides with registered series prefix "${prefix}S".`;

  const resSuffix = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(prefix + 'S', now) as { project_id: string } | undefined;
  if (resSuffix && resSuffix.project_id !== excl) return `Prefix collision: "${prefix}" collides with reserved series prefix "${prefix}S".`;

  if (prefix.length > 2 && prefix.endsWith('S')) {
    const parent = prefix.slice(0, -1);
    const cntParent = db.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(parent) as { project_id: string | null } | undefined;
    if (cntParent && cntParent.project_id !== excludeProjectId) return `Prefix "${prefix}" collides with registered prefix "${parent}".`;
    const resParent = db.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(parent, now) as { project_id: string } | undefined;
    if (resParent && resParent.project_id !== excl) return `Prefix "${prefix}" collides with reserved prefix "${parent}".`;
  }

  return undefined;
}

export function createSerialTools(vaultPath: string, injectedDb?: Database.Database): ToolHandler[] {
  const db = () => injectedDb ?? getDatabase();

  function resolveProject(projectId: string, database: Database.Database): { prefix: string; folderPath: string } | { error: string } {
    const projectsDir = path.join(vaultPath, 'Projects');
    let matches: string[] = [];
    try {
      matches = fs.readdirSync(projectsDir).filter(e => e.startsWith(projectId + '-'));
    } catch { return { error: `Project ${projectId} does not exist (Projects/ dir unreadable).` }; }
    if (matches.length === 0) return { error: `Project ${projectId} does not exist.` };
    if (matches.length > 1) return { error: `Duplicate project folders for ${projectId}: [${matches.join(', ')}]. Fix vault structure before continuing.` };

    const folderPath = path.join(projectsDir, matches[0]);
    let indexPath: string;
    try {
      indexPath = resolveVaultPath(vaultPath, path.join('Projects', matches[0], '_index.md'));
    } catch { return { error: `Project ${projectId} _index.md path is invalid.` }; }

    if (!fs.existsSync(indexPath)) return { error: `Project ${projectId} has no _index.md.` };
    const parsed = matter(fs.readFileSync(indexPath, 'utf-8'));
    const prefix = parsed.data.prefix as string | undefined;
    if (!prefix) return { error: `Project ${projectId} _index.md is missing the prefix field.` };

    const counter = database.prepare('SELECT scope FROM serial_counters WHERE scope = ?').get(prefix) as { scope: string } | undefined;
    if (!counter) {
      // Auto-heal: counters missing but _index.md exists — validate before registering inline
      const collisionMsg = checkPrefixCollision(prefix, projectId, database);
      if (collisionMsg) return { error: collisionMsg };

      const foreignReservation = database.prepare(
        'SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?'
      ).get(prefix, Date.now()) as { project_id: string } | undefined;
      if (foreignReservation && foreignReservation.project_id !== projectId) {
        return { error: `Prefix ${prefix} is reserved by another project — vault may be in an inconsistent state. Resolve manually.` };
      }

      const seriesCounter = database.prepare('SELECT scope FROM serial_counters WHERE scope = ?').get(prefix + '-S') as { scope: string } | undefined;
      if (seriesCounter) {
        return { error: `Prefix ${prefix}-S counter exists but ${prefix} counter is missing — vault may be in an inconsistent state. Run register_project_counters manually to resolve.` };
      }

      log.debug('Auto-registering missing counters for project', { projectId, prefix });
      database.transaction(() => {
        database.prepare('INSERT OR IGNORE INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(prefix, projectId);
        database.prepare('INSERT OR IGNORE INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(`${prefix}-S`, projectId);
        database.prepare('INSERT OR IGNORE INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, 9999999999999)').run(prefix, projectId);
      })();
    }

    return { prefix, folderPath };
  }

  return [
    {
      definition: {
        name: 'reserve_prefix',
        description: 'Temporarily reserve a project prefix (2–3 uppercase letters). Call before create_project to lock the prefix.',
        parameters: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: '2–3 uppercase letters (e.g. "CM")' },
            project_id: { type: 'string', description: 'Project ID that will own this prefix (e.g. "P001")' },
          },
          required: ['prefix', 'project_id'],
        },
      },
      execute: async (args) => {
        const rawPrefix = (args.prefix as string).toUpperCase();
        const projectId = args.project_id as string;
        try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
        const database = db();
        database.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());

        const existing = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
        if (existing) {
          if (existing.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is permanently registered to another project.` });
          return JSON.stringify({ reserved: true, permanent: true });
        }

        const collision = checkPrefixCollision(rawPrefix, projectId, database);
        if (collision) return JSON.stringify({ error: collision });

        const existingRes = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get(rawPrefix) as { project_id: string } | undefined;
        if (existingRes && existingRes.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is temporarily reserved by project ${existingRes.project_id}.` });

        const expiresAt = Date.now() + RESERVATION_TTL_MS;
        database.prepare(
          'INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(prefix) DO UPDATE SET expires_at = excluded.expires_at WHERE project_id = excluded.project_id'
        ).run(rawPrefix, projectId, expiresAt);
        return JSON.stringify({ reserved: true, expires_at: expiresAt });
      },
    },

    {
      definition: {
        name: 'register_project_counters',
        description: 'Finalize a project by registering prefix counters in serial_counters. Call after user confirms project _index.md.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            prefix: { type: 'string' },
          },
          required: ['project_id', 'prefix'],
        },
      },
      execute: async (args) => {
        const projectId = args.project_id as string;
        const rawPrefix = (args.prefix as string).toUpperCase();
        try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
        const database = db();

        const cnt = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
        const cntS = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(`${rawPrefix}-S`) as { project_id: string | null } | undefined;

        if (cnt && cnt.project_id !== projectId) return JSON.stringify({ error: `Prefix "${rawPrefix}" is already registered to project ${cnt.project_id}.` });
        if (cntS && cntS.project_id !== projectId) return JSON.stringify({ error: `Series prefix "${rawPrefix}-S" is already registered to project ${cntS.project_id}.` });

        // Fully idempotent case — both counters exist for same project, skip file check
        if (cnt && cntS) {
          return JSON.stringify({ registered: true, counters: [rawPrefix, `${rawPrefix}-S`] });
        }

        // All other paths require confirmed _index.md on disk
        const projectsDir = path.join(vaultPath, 'Projects');
        const matches: string[] = [];
        try {
          for (const entry of fs.readdirSync(projectsDir)) {
            if (!entry.startsWith(projectId + '-')) continue;
            try {
              const indexPath = resolveVaultPath(vaultPath, path.join('Projects', entry, '_index.md'));
              if (fs.existsSync(indexPath)) {
                const p = matter(fs.readFileSync(indexPath, 'utf-8'));
                if (p.data.id === projectId && p.data.prefix === rawPrefix) matches.push(entry);
              }
            } catch { /* skip invalid paths */ }
          }
        } catch { return JSON.stringify({ error: `Projects/ directory unreadable.` }); }
        if (matches.length > 1) return JSON.stringify({ error: `Duplicate project folders for ${projectId}: [${matches.join(', ')}]. Fix vault structure first.` });
        if (matches.length === 0) return JSON.stringify({ error: `No confirmed _index.md found for project ${projectId} with prefix "${rawPrefix}". Apply the pending project edit before calling register_project_counters.` });

        const res = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(rawPrefix, Date.now()) as { project_id: string } | undefined;
        if (res && res.project_id !== projectId) {
          return JSON.stringify({ error: `Reservation for "${rawPrefix}" is owned by project ${res.project_id}.` });
        }

        const collision = checkPrefixCollision(rawPrefix, projectId, database);
        if (collision) return JSON.stringify({ error: collision });

        database.transaction(() => {
          if (!cnt) database.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(rawPrefix, projectId);
          if (!cntS) database.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run(`${rawPrefix}-S`, projectId);
          database.prepare('DELETE FROM prefix_reservations WHERE prefix = ?').run(rawPrefix);
        })();
        const repaired = (cnt && !cntS) || (!cnt && cntS);
        return JSON.stringify({ registered: true, counters: [rawPrefix, `${rawPrefix}-S`], ...(repaired ? { repaired: true } : {}) });
      },
    },
    {
      definition: {
        name: 'create_project',
        description: 'Create a new project. Returns pending_edit for user confirmation. Allocates a serial P-ID and temporarily reserves the prefix.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            prefix: { type: 'string', description: '2–3 uppercase letters. Omit to get a suggestion.' },
            description: { type: 'string' },
          },
          required: ['title'],
        },
      },
      execute: async (args) => {
        const title = args.title as string;
        const database = db();

        if (!args.prefix) {
          const suggested = title.split(/\s+/).map(w => w[0]?.toUpperCase() ?? '').join('').replace(/[^A-Z]/g, '').slice(0, 3);
          return JSON.stringify({ type: 'prefix_suggestion', suggested_prefix: suggested || 'XX', message: `Suggested prefix: "${suggested || 'XX'}". Confirm or provide different prefix.` });
        }

        const rawPrefix = (args.prefix as string).toUpperCase();
        try { validatePrefix(rawPrefix); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }

        database.prepare('DELETE FROM prefix_reservations WHERE expires_at < ?').run(Date.now());

        const existingCounter = database.prepare('SELECT project_id FROM serial_counters WHERE scope = ?').get(rawPrefix) as { project_id: string | null } | undefined;
        if (existingCounter) return JSON.stringify({ error: `Prefix "${rawPrefix}" is already permanently registered to project ${existingCounter.project_id ?? 'unknown'}.` });

        let projectId = '';
        let collisionError: string | undefined;
        database.transaction(() => {
          const counterConflict = database.prepare('SELECT scope FROM serial_counters WHERE scope = ?').get(rawPrefix);
          if (counterConflict) { collisionError = `Prefix "${rawPrefix}" already has a permanent counter — it is already registered.`; return; }

          const existingRes = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ? AND expires_at > ?').get(rawPrefix, Date.now()) as { project_id: string } | undefined;
          if (existingRes) { collisionError = `Prefix "${rawPrefix}" is temporarily reserved by project ${existingRes.project_id}.`; return; }

          const collision = checkPrefixCollision(rawPrefix, null, database);
          if (collision) { collisionError = collision; return; }

          const serial = getNextSerial('project', database);
          projectId = `P${serial}`;
          database.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run(rawPrefix, projectId, Date.now() + RESERVATION_TTL_MS);
        })();
        if (collisionError) return JSON.stringify({ error: collisionError });

        const slug = title.replace(/[^a-zA-Z0-9]+/g, '') || 'Untitled';
        const folderName = `${projectId}-${slug}`;
        const today = new Date().toISOString().slice(0, 10);
        const fmData: Record<string, unknown> = { note_kind: 'project', id: projectId, prefix: rawPrefix, title, status: 'active', created: today };
        if (args.description) fmData.description = args.description as string;
        const body = `\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n`;
        const newContent = matter.stringify(body, fmData);
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Projects', folderName, '_index.md'));
        } catch {
          return JSON.stringify({ error: 'Resolved project path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_project', path: absPath, newContent, reservation: { project_id: projectId, prefix: rawPrefix } });
      },
    },

    // create_experiment
    {
      definition: {
        name: 'create_experiment',
        description: 'Create a new experiment note in a project using serial numbering. Validates protocol and series existence.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            title: { type: 'string' },
            experiment_type: { type: 'string' },
            protocol: { type: 'string', description: 'Protocol filename stem (e.g. "PR001-western-blot"). Must exist in Protocols/.' },
            samples: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, condition: { type: 'string' } } } },
            reagents: { type: 'array', items: { type: 'string' } },
            series: { type: 'string', description: 'Series ID to add experiment to (e.g. "CMS001"). Must exist in same project.' },
          },
          required: ['project_id', 'title', 'experiment_type'],
        },
      },
      execute: async (args) => {
        const database = db();
        const projectId = args.project_id as string;
        const resolved = resolveProject(projectId, database);
        if ('error' in resolved) return JSON.stringify({ error: resolved.error });
        const { prefix, folderPath } = resolved;

        if (args.protocol) {
          const protocolStem = args.protocol as string;
          if (protocolStem.includes('/') || protocolStem.includes('\\') || protocolStem.includes('..')) {
            return JSON.stringify({ error: `Protocol stem "${protocolStem}" contains invalid characters.` });
          }
          let protocolPath: string;
          try {
            protocolPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protocolStem}.md`));
          } catch {
            return JSON.stringify({ error: `Protocol path is invalid.` });
          }
          if (!fs.existsSync(protocolPath)) {
            return JSON.stringify({ error: `Protocol "${protocolStem}" not found in Protocols/. Create it first with create_protocol.` });
          }
        }

        if (args.series) {
          const seriesId = args.series as string;
          if (!/^[A-Z]{2,3}S\d{3,4}$/.test(seriesId)) {
            return JSON.stringify({ error: `Series ID "${seriesId}" has invalid format. Expected pattern: CMS001 (2–3 uppercase letters + "S" + 3–4 digits).` });
          }
          let seriesFiles: string[];
          try {
            seriesFiles = fs.readdirSync(folderPath);
          } catch {
            return JSON.stringify({ error: `Could not read project folder for ${projectId}.` });
          }
          const seriesMatches = seriesFiles.filter(f => f.startsWith(seriesId + '-'));
          if (seriesMatches.length > 1) return JSON.stringify({ error: `Ambiguous: multiple files found for ${seriesId} — fix vault structure before continuing.` });
          if (seriesMatches.length === 0) return JSON.stringify({ error: `Series ${seriesId} not found in project ${projectId}.` });
          const seriesFile = seriesMatches[0];
          let seriesPath: string;
          try {
            seriesPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), seriesFile));
          } catch {
            return JSON.stringify({ error: `Series file path is invalid.` });
          }
          const seriesFm = matter(fs.readFileSync(seriesPath, 'utf-8'));
          if (seriesFm.data.project_id !== projectId) return JSON.stringify({ error: `Series ${seriesId} belongs to project ${seriesFm.data.project_id}, not ${projectId}.` });
        }

        const serial = getNextSerial(prefix, database);
        const expId = `${prefix}${serial}`;
        const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const today = new Date().toISOString().slice(0, 10);
        const samples = (args.samples as Array<{ name: string; condition: string }> | undefined) ?? [];
        const reagents = (args.reagents as string[] | undefined) ?? [];

        const fmData: Record<string, unknown> = {
          note_kind: 'experiment', id: expId, project_id: projectId,
          title: args.title as string, experiment_type: args.experiment_type as string,
          samples, reagents, status: 'draft', created: today, attachments: [],
        };
        if (args.protocol) fmData.protocol = `[[${args.protocol as string}]]`;
        if (args.series) fmData.series = args.series as string;

        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'experiment',
            protectedFrontmatter: fmData,
            context: { title: args.title as string, date: today, id: expId, project_id: projectId },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        const newContent = matter.stringify(renderResult.body, renderResult.frontmatter);
        const fileName = `${expId}-${slug}.md`;
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
        } catch {
          return JSON.stringify({ error: 'Resolved experiment path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_experiment', path: absPath, newContent, warnings: renderResult.warnings });
      },
    },

    // create_series
    {
      definition: {
        name: 'create_series',
        description: 'Create an experiment series header. After user confirms, use update_series_table to assign experiments.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            title: { type: 'string' },
            objective: { type: 'string' },
            experiments: { type: 'array', items: { type: 'string' }, description: 'Optional list of existing experiment IDs to include in this series' },
          },
          required: ['project_id', 'title'],
        },
      },
      execute: async (args) => {
        const database = db();
        const projectId = args.project_id as string;
        const resolved = resolveProject(projectId, database);
        if ('error' in resolved) return JSON.stringify({ error: resolved.error });
        const { prefix, folderPath } = resolved;

        // Validate experiments if provided
        const experimentIds = (args.experiments as string[] | undefined) ?? [];
        const validatedExperimentIds: string[] = [];
        if (experimentIds.length > 0) {
          // Check for duplicates in input
          const seen = new Set<string>();
          for (const id of experimentIds) {
            if (seen.has(id)) return JSON.stringify({ error: `Duplicate experiment ID ${id} in input` });
            seen.add(id);
          }

          let folderEntries: string[];
          try {
            folderEntries = fs.readdirSync(folderPath);
          } catch {
            return JSON.stringify({ error: `Could not read project folder for ${projectId}.` });
          }

          for (const id of experimentIds) {
            const expMatches = folderEntries.filter(f => f.startsWith(id + '-') && f.endsWith('.md'));
            if (expMatches.length === 0) return JSON.stringify({ error: `Experiment ${id} not found` });
            if (expMatches.length > 1) return JSON.stringify({ error: `Ambiguous: multiple files found for experiment ${id}` });

            let expPath: string;
            try {
              expPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), expMatches[0]));
            } catch {
              return JSON.stringify({ error: `Experiment ${id} file path is invalid.` });
            }
            const expFm = matter(fs.readFileSync(expPath, 'utf-8'));
            if (expFm.data.project_id !== projectId) {
              return JSON.stringify({ error: `Experiment ${id} belongs to project ${expFm.data.project_id as string}, not ${projectId}` });
            }
            if (expFm.data.note_kind !== 'experiment') {
              return JSON.stringify({ error: `${id} is not an experiment note (note_kind: ${String(expFm.data.note_kind ?? 'unknown')})` });
            }
            if (expFm.data.series) {
              return JSON.stringify({ error: `Experiment ${id} is already in series ${expFm.data.series as string}. Remove it from that series first, or omit it from this list.` });
            }
            validatedExperimentIds.push(id);
          }
        }

        const serial = getNextSerial(`${prefix}-S`, database);
        const seriesId = `${prefix}S${serial}`;
        const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const today = new Date().toISOString().slice(0, 10);

        const fmData: Record<string, unknown> = {
          note_kind: 'series', id: seriesId, project_id: projectId,
          title: args.title as string, objective: (args.objective as string | undefined) ?? '',
          status: 'in-progress', created: today,
        };
        const experimentListRows = validatedExperimentIds.length > 0
          ? validatedExperimentIds.map(id => `| ${id} | (see note) | draft | ${today} |`).join('\n')
          : '';
        const body = `\n# ${args.title as string}\n\n## Objective\n${(args.objective as string | undefined) ?? 'TODO'}\n\n<!-- AUTO-GENERATED: experiment-list -->\n## Experiments\n| ID | Name | Status | Created |\n|----|------|--------|----------|\n${experimentListRows}\n<!-- END AUTO-GENERATED: experiment-list -->\n\n## Summary\n<!-- User-owned synthesis -->\n`;
        const newContent = matter.stringify(body, fmData);
        const fileName = `${seriesId}-${slug}.md`;
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Projects', path.basename(folderPath), fileName));
        } catch {
          return JSON.stringify({ error: 'Resolved series path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_series', path: absPath, newContent, series_id: seriesId });
      },
    },

    // create_protocol
    {
      definition: {
        name: 'create_protocol',
        description: 'Create a new protocol note with a PR-series serial ID.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            category: { type: 'string' },
            derived_from: { type: 'string' },
          },
          required: ['title', 'category'],
        },
      },
      execute: async (args) => {
        const database = db();
        const serial = getNextSerial('protocol', database);
        const protId = `PR${serial}`;
        const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const today = new Date().toISOString().slice(0, 10);
        const fmData: Record<string, unknown> = { note_kind: 'protocol', id: protId, title: args.title as string, version: 1, category: args.category as string, created: today, last_updated: today };
        if (args.derived_from) fmData.derived_from = `[[${args.derived_from as string}]]`;
        let renderResult: RenderResult;
        try {
          renderResult = await renderNoteTemplate({
            vaultPath,
            kind: 'protocol',
            protectedFrontmatter: fmData,
            context: { title: args.title as string, id: protId },
          });
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        const newContent = matter.stringify(renderResult.body, renderResult.frontmatter);
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, path.join('Protocols', `${protId}-${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved protocol path is outside the vault.' });
        }
        return JSON.stringify({ type: 'pending_edit', operation: 'create_protocol', path: absPath, newContent, warnings: renderResult.warnings });
      },
    },

    // get_workflow_events
    {
      definition: {
        name: 'get_workflow_events',
        description: 'Read edit confirmation/cancellation events for the current session. Use after "continue" to see what was applied.',
        parameters: { type: 'object', properties: { after_event_id: { type: 'number' } }, required: [] },
      },
      execute: async (args, context) => {
        const sessionId = context?.sessionId;
        if (!sessionId) return JSON.stringify({ error: 'No session context.' });
        const database = db();
        const afterId = typeof args.after_event_id === 'number' ? args.after_event_id : 0;
        const events = database.prepare(
          'SELECT id, event_type, payload, timestamp FROM workflow_events WHERE session_id = ? AND id > ? ORDER BY id ASC'
        ).all(sessionId, afterId) as Array<{ id: number; event_type: string; payload: string; timestamp: number }>;
        const cursor = events.length > 0 ? events[events.length - 1].id : null;
        const mapped = events.map(e => {
          let payload: unknown;
          try { payload = JSON.parse(e.payload); } catch { payload = e.payload; }
          return { id: e.id, event_type: e.event_type, payload, timestamp: e.timestamp };
        });
        return JSON.stringify({ events: mapped, cursor });
      },
    },

    // update_project_index
    {
      definition: {
        name: 'update_project_index',
        description: 'Update an auto-generated fenced section in a project _index.md. No user confirmation required — agent-owned sections only.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            section: { type: 'string', description: '"experiment-log" or "project-summary"' },
            content: { type: 'string' },
          },
          required: ['project_id', 'section', 'content'],
        },
      },
      execute: async (args) => {
        const database = db();
        const ALLOWED_SECTIONS = new Set(['experiment-log', 'project-summary']);
        const section = args.section as string;
        if (!ALLOWED_SECTIONS.has(section)) {
          return JSON.stringify({ error: `Section "${section}" is not allowed. Valid sections: experiment-log, project-summary.` });
        }
        const resolved = resolveProject(args.project_id as string, database);
        if ('error' in resolved) return JSON.stringify({ error: resolved.error });
        // resolveProject already confirmed folderPath is inside the vault via resolveVaultPath.
        const indexPath = path.join(resolved.folderPath, '_index.md');
        try {
          fencedSectionUpdate(indexPath, section, args.content as string, vaultPath);
          return JSON.stringify({ updated: true });
        } catch (err) { return JSON.stringify({ error: (err as Error).message }); }
      },
    },

    // update_series_table
    {
      definition: {
        name: 'update_series_table',
        description: 'Update the auto-generated experiment list in a series header file. No user confirmation required.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            series_id: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['project_id', 'series_id', 'content'],
        },
      },
      execute: async (args) => {
        const database = db();
        const seriesId = args.series_id as string;
        if (!/^[A-Z]{2,3}S\d{3,4}$/.test(seriesId)) {
          return JSON.stringify({ error: `Series ID "${seriesId}" has invalid format. Expected pattern: CMS001 (2–3 uppercase letters + "S" + 3–4 digits).` });
        }
        const resolved = resolveProject(args.project_id as string, database);
        if ('error' in resolved) return JSON.stringify({ error: resolved.error });
        let entries: string[];
        try {
          entries = fs.readdirSync(resolved.folderPath);
        } catch {
          return JSON.stringify({ error: `Could not read project folder for ${args.project_id as string}.` });
        }
        const seriesMatches = entries.filter(f => f.startsWith(seriesId + '-'));
        if (seriesMatches.length > 1) return JSON.stringify({ error: `Ambiguous: multiple files found for ${seriesId} — fix vault structure before continuing.` });
        if (seriesMatches.length === 0) return JSON.stringify({ error: `Series ${seriesId} not found in project ${args.project_id as string}.` });
        const seriesFile = seriesMatches[0];
        // Use path.join (not resolveVaultPath) so fencedSectionUpdate receives a
        // path in the same symlink-space as vaultPath, avoiding false traversal errors.
        // resolveProject already confirmed folderPath is inside the vault.
        const seriesPath = path.join(resolved.folderPath, seriesFile);
        const seriesFm = matter(fs.readFileSync(seriesPath, 'utf-8'));
        if (seriesFm.data.project_id !== (args.project_id as string)) {
          return JSON.stringify({ error: `Series ${seriesId} belongs to project ${String(seriesFm.data.project_id)}, not ${args.project_id as string}.` });
        }
        try {
          fencedSectionUpdate(seriesPath, 'experiment-list', args.content as string, vaultPath);
          return JSON.stringify({ updated: true });
        } catch (err) { return JSON.stringify({ error: (err as Error).message }); }
      },
    },
  ];
}
