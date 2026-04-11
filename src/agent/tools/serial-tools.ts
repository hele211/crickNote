import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { ToolHandler, ToolContext } from './registry.js';
import { getDatabase } from '../../storage/database.js';
import { validatePrefix, getNextSerial } from '../../storage/serial.js';
import { resolveVaultPath } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

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
    if (!counter) return { error: `Project ${projectId} counters not registered. Call register_project_counters(project_id="${projectId}", prefix="${prefix}") first.` };

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

        const collision = checkPrefixCollision(rawPrefix, null, database);
        if (collision) return JSON.stringify({ error: collision });

        const existingRes = database.prepare('SELECT project_id FROM prefix_reservations WHERE prefix = ?').get(rawPrefix) as { project_id: string } | undefined;
        if (existingRes) return JSON.stringify({ error: `Prefix "${rawPrefix}" is temporarily reserved by project ${existingRes.project_id}.` });

        let projectId = '';
        database.transaction(() => {
          const serial = getNextSerial('project', database);
          projectId = `P${serial}`;
          database.prepare('INSERT INTO prefix_reservations (prefix, project_id, expires_at) VALUES (?, ?, ?)').run(rawPrefix, projectId, Date.now() + RESERVATION_TTL_MS);
        })();

        const folderName = `${projectId}-${title.replace(/[^a-zA-Z0-9]+/g, '')}`;
        const today = new Date().toISOString().slice(0, 10);
        const fmData: Record<string, unknown> = { note_kind: 'project', id: projectId, prefix: rawPrefix, title, status: 'active', created: today };
        if (args.description) fmData.description = args.description as string;
        const body = `\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n`;
        const newContent = matter.stringify(body, fmData);
        const absPath = resolveVaultPath(vaultPath, path.join('Projects', folderName, '_index.md'));
        return JSON.stringify({ type: 'pending_edit', operation: 'create_project', path: absPath, newContent, reservation: { project_id: projectId, prefix: rawPrefix } });
      },
    },
  ];
}
