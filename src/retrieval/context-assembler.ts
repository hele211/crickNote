import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// --- Types ---

export interface AssembledContext {
  /** The primary note's path */
  notePath: string;
  /** Full markdown body of the note */
  body: string;
  /** Resolved linked protocol contents (from [[wikilinks]]) */
  linkedProtocols: LinkedProtocol[];
  /** Attachment file paths referenced in frontmatter */
  attachments: string[];
  /** Related notes from the same project within +/-7 days */
  relatedNotes: RelatedNote[];
}

export interface LinkedProtocol {
  /** The wikilink reference (e.g. "western-blot-protocol") */
  ref: string;
  /** Resolved file path */
  path: string;
  /** Content of the protocol file, or null if not found */
  content: string | null;
}

export interface RelatedNote {
  path: string;
  date: string;
  experimentType: string | null;
  resultSummary: string | null;
}

export interface ContextAssemblerOptions {
  /** The vault root path on disk */
  vaultPath: string;
  /** Maximum number of related notes to include */
  maxRelatedNotes?: number;
}

// --- Wikilink extraction ---

const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Extract all [[wikilink]] references from markdown content.
 * Handles display aliases like [[target|display text]].
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  WIKILINK_REGEX.lastIndex = 0;
  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    links.push(match[1].trim());
  }

  return [...new Set(links)];
}

/**
 * Extract attachment paths from frontmatter content.
 * Looks for an "attachments:" YAML key and extracts the list items.
 */
export function extractAttachments(content: string): string[] {
  const attachments: string[] = [];
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return attachments;

  const frontmatter = frontmatterMatch[1];
  const lines = frontmatter.split('\n');
  let inAttachments = false;

  for (const line of lines) {
    if (/^attachments:\s*$/.test(line) || /^attachments:/.test(line)) {
      inAttachments = true;
      // Check for inline list: attachments: [a, b]
      const inlineMatch = line.match(/^attachments:\s*\[(.+)\]/);
      if (inlineMatch) {
        const items = inlineMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        attachments.push(...items);
        inAttachments = false;
      }
      continue;
    }

    if (inAttachments) {
      const itemMatch = line.match(/^\s+-\s+(.+)/);
      if (itemMatch) {
        attachments.push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
      } else if (/^\S/.test(line)) {
        // New top-level key, stop collecting
        inAttachments = false;
      }
    }
  }

  return attachments;
}

// --- Protocol resolution ---

/**
 * Resolve a wikilink to a file path within the vault.
 * Searches the Protocols/ folder first, then the entire vault.
 */
function resolveWikilinkPath(
  ref: string,
  vaultPath: string,
): string | null {
  // Strip any .md extension that might be in the ref
  const baseName = ref.replace(/\.md$/, '');

  // Try Protocols/ folder first (most likely for protocol links)
  const protocolPath = path.join(vaultPath, 'Protocols', `${baseName}.md`);
  if (fs.existsSync(protocolPath)) return protocolPath;

  // Try vault root
  const rootPath = path.join(vaultPath, `${baseName}.md`);
  if (fs.existsSync(rootPath)) return rootPath;

  // Try common subfolders
  const folders = ['Projects', 'Reading', 'Memory', 'Agent'];
  for (const folder of folders) {
    const folderPath = path.join(vaultPath, folder);
    if (!fs.existsSync(folderPath)) continue;

    // Direct child
    const directPath = path.join(folderPath, `${baseName}.md`);
    if (fs.existsSync(directPath)) return directPath;

    // Search subdirectories (one level deep)
    try {
      const subDirs = fs.readdirSync(folderPath, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const sub of subDirs) {
        const subPath = path.join(folderPath, sub.name, `${baseName}.md`);
        if (fs.existsSync(subPath)) return subPath;
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

/**
 * Resolve linked protocols from wikilinks found in the note content.
 * Only resolves links that point to files in the Protocols/ folder
 * or contain "protocol" in their name.
 */
function resolveLinkedProtocols(
  content: string,
  vaultPath: string,
): LinkedProtocol[] {
  const wikilinks = extractWikilinks(content);
  const protocols: LinkedProtocol[] = [];

  for (const ref of wikilinks) {
    const resolvedPath = resolveWikilinkPath(ref, vaultPath);
    if (resolvedPath === null) {
      protocols.push({ ref, path: '', content: null });
      continue;
    }

    // Only include as linked protocol if it's in Protocols/ or has "protocol" in name
    const isProtocol =
      resolvedPath.includes(`${path.sep}Protocols${path.sep}`) ||
      ref.toLowerCase().includes('protocol');

    if (!isProtocol) continue;

    try {
      const protocolContent = fs.readFileSync(resolvedPath, 'utf-8');
      protocols.push({ ref, path: resolvedPath, content: protocolContent });
    } catch {
      protocols.push({ ref, path: resolvedPath, content: null });
    }
  }

  return protocols;
}

// --- Related notes ---

/**
 * Find related notes: same project, within +/-7 days of the given date.
 */
function findRelatedNotes(
  db: Database.Database,
  notePath: string,
  project: string | null,
  date: string | null,
  maxResults: number,
): RelatedNote[] {
  if (project === null || date === null) return [];

  const stmt = db.prepare(`
    SELECT path, date, experiment_type, result_summary
    FROM note_metadata
    WHERE project = ?
      AND date BETWEEN date(?, '-7 days') AND date(?, '+7 days')
      AND path != ?
    ORDER BY ABS(julianday(date) - julianday(?))
    LIMIT ?
  `);

  const rows = stmt.all(project, date, date, notePath, date, maxResults) as Array<{
    path: string;
    date: string;
    experiment_type: string | null;
    result_summary: string | null;
  }>;

  return rows.map(row => ({
    path: row.path,
    date: row.date,
    experimentType: row.experiment_type,
    resultSummary: row.result_summary,
  }));
}

// --- Main assembler ---

/**
 * Assemble context for a single note path.
 * Loads the full markdown body, resolves linked protocols,
 * extracts attachment references, and finds related notes.
 */
export function assembleNoteContext(
  db: Database.Database,
  notePath: string,
  options: ContextAssemblerOptions,
): AssembledContext | null {
  const { vaultPath, maxRelatedNotes = 5 } = options;

  // Read the note from disk (vault is source of truth)
  const fullPath = path.isAbsolute(notePath)
    ? notePath
    : path.join(vaultPath, notePath);

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  let body: string;
  try {
    body = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }

  // Get metadata from DB for project/date info
  const meta = db.prepare(
    'SELECT project, date FROM note_metadata WHERE path = ?',
  ).get(notePath) as { project: string | null; date: string | null } | undefined;

  // Resolve linked protocols
  const linkedProtocols = resolveLinkedProtocols(body, vaultPath);

  // Extract attachments from frontmatter
  const attachments = extractAttachments(body);

  // Find related notes
  const relatedNotes = findRelatedNotes(
    db,
    notePath,
    meta?.project ?? null,
    meta?.date ?? null,
    maxRelatedNotes,
  );

  return {
    notePath,
    body,
    linkedProtocols,
    attachments,
    relatedNotes,
  };
}

/**
 * Assemble context for multiple note paths and format for LLM consumption.
 *
 * Returns a single string with all assembled context, structured with
 * clear section headers for the LLM to parse.
 */
export function assembleContext(
  db: Database.Database,
  notePaths: string[],
  options: ContextAssemblerOptions,
): string {
  const sections: string[] = [];

  for (const notePath of notePaths) {
    const ctx = assembleNoteContext(db, notePath, options);
    if (ctx === null) continue;

    const noteSection: string[] = [];

    // --- Primary note ---
    noteSection.push(`## Note: ${ctx.notePath}`);
    noteSection.push('');
    noteSection.push(ctx.body);

    // --- Linked protocols ---
    if (ctx.linkedProtocols.length > 0) {
      noteSection.push('');
      noteSection.push('### Linked Protocols');
      for (const protocol of ctx.linkedProtocols) {
        if (protocol.content !== null) {
          noteSection.push('');
          noteSection.push(`#### Protocol: ${protocol.ref}`);
          noteSection.push(protocol.content);
        } else {
          noteSection.push(`- [[${protocol.ref}]] (not found)`);
        }
      }
    }

    // --- Attachments ---
    if (ctx.attachments.length > 0) {
      noteSection.push('');
      noteSection.push('### Attachments');
      for (const att of ctx.attachments) {
        noteSection.push(`- ${att}`);
      }
    }

    // --- Related notes ---
    if (ctx.relatedNotes.length > 0) {
      noteSection.push('');
      noteSection.push('### Related Notes (same project, nearby dates)');
      for (const related of ctx.relatedNotes) {
        const parts = [related.path, related.date];
        if (related.experimentType) parts.push(related.experimentType);
        if (related.resultSummary) parts.push(related.resultSummary);
        noteSection.push(`- ${parts.join(' | ')}`);
      }
    }

    sections.push(noteSection.join('\n'));
  }

  if (sections.length === 0) {
    return 'No matching notes found.';
  }

  return sections.join('\n\n---\n\n');
}
