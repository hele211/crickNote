import matter from 'gray-matter';
import { utcDateString } from '../utils/date.js';

/** Note type classifications based on vault folder structure or note_kind frontmatter. */
export type NoteType = 'experiment' | 'protocol' | 'reading' | 'diary' | 'agent' | 'series' | 'project-index' | 'knowledge' | 'review-queue' | 'folder-readme' | 'unknown';

/** Top-level folder name in the vault. */
export type VaultFolder = 'Projects' | 'Protocols' | 'Reading' | 'Memory' | 'Agent';

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ParsedNote {
  /** Relative path within the vault */
  filePath: string;
  /** Top-level vault folder */
  folder: string;
  /** Classified note type */
  noteType: NoteType;
  /** Parsed frontmatter data */
  frontmatter: Record<string, unknown>;
  /** Markdown body content (without frontmatter) */
  body: string;
  /** Validation warnings for missing/invalid required fields */
  warnings: ValidationWarning[];
  /** Whether all required fields are present and valid */
  isValid: boolean;

  // Extracted metadata fields (may be undefined if not present)
  date?: string;
  project?: string;
  experimentType?: string;
  protocolRef?: string;
  status?: string;
  tags?: string[];
  resultSummary?: string;

  // Serial numbering system fields
  noteId?: string;
  series?: string;
  projectId?: string;
  lastSession?: string;
  noteKind?: string;
  // Knowledge base fields
  kbStatus?: string;
  knowledgeKind?: string;
  needsReview?: boolean;
  reviewFlaggedAt?: string;
  aliases?: string[];
  rqSource?: string;
  rqTarget?: string;
}

/** Required fields per note type (legacy path-based classification). */
const REQUIRED_FIELDS: Record<NoteType, string[]> = {
  experiment: [],
  series: [],
  'project-index': [],
  protocol: ['title', 'version', 'last_updated', 'category'],
  reading: ['title', 'authors', 'year', 'journal', 'read_date'],
  diary: ['date', 'type'],
  agent: [],
  knowledge: [],
  'review-queue': [],
  'folder-readme': [],
  unknown: [],
};

/** Mapping from note_kind frontmatter value to NoteType. */
const NOTE_KIND_MAP: Record<string, NoteType> = {
  experiment: 'experiment',
  series: 'series',
  project: 'project-index',
  protocol: 'protocol',
  reading: 'reading',
  'folder-readme': 'folder-readme',
};

/**
 * Classify a note by its relative file path within the vault.
 * When noteKind is provided, it takes precedence over path-based classification.
 */
export function classifyNote(filePath: string, noteKind?: string): { folder: string; noteType: NoteType } {
  const normalized = filePath.replace(/\\/g, '/');
  const firstSegment = normalized.split('/')[0];

  // _README.md anywhere in the vault is a folder-readme, regardless of parent folder or frontmatter.
  if ((normalized.split('/').pop() ?? '') === '_README.md') {
    return { folder: firstSegment || 'root', noteType: 'folder-readme' };
  }

  // note_kind frontmatter takes precedence for non-README notes
  if (noteKind && NOTE_KIND_MAP[noteKind]) {
    const noteType = NOTE_KIND_MAP[noteKind];
    const folder = firstSegment || 'root';
    return { folder, noteType };
  }

  // Path-based classification
  switch (firstSegment) {
    case 'Projects': {
      // Determine sub-type within Projects
      if (normalized.endsWith('/_index.md')) {
        return { folder: 'Projects', noteType: 'project-index' };
      }
      const basename = normalized.split('/').pop() ?? '';
      if (/^[A-Z]+S\d+/.test(basename)) {
        return { folder: 'Projects', noteType: 'series' };
      }
      return { folder: 'Projects', noteType: 'experiment' };
    }
    case 'Protocols':
      return { folder: 'Protocols', noteType: 'protocol' };
    case 'Reading':
      return { folder: 'Reading', noteType: 'reading' };
    case 'Memory':
      return { folder: 'Memory', noteType: 'diary' };
    case 'Agent':
      return { folder: 'Agent', noteType: 'agent' };
    case 'Knowledge': {
      const segments = normalized.split('/');
      if (segments[1] === 'Review-Queue') return { folder: 'Knowledge', noteType: 'review-queue' };
      if (segments[1] === '_Ops') return { folder: 'Knowledge', noteType: 'unknown' };
      return { folder: 'Knowledge', noteType: 'knowledge' };
    }
    default:
      return { folder: firstSegment || 'root', noteType: 'unknown' };
  }
}

/**
 * Validate frontmatter fields against required fields for the note type.
 */
function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  noteType: NoteType,
  noteKind?: string
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // note_kind-aware validation for serial notes
  if (noteKind === 'experiment' || noteKind === 'series' || noteKind === 'project') {
    if (!frontmatter['id']) {
      warnings.push({ field: 'id', message: `Required field "id" is missing for ${noteKind} note.` });
    }
    if (!frontmatter['created'] && !frontmatter['date']) {
      warnings.push({ field: 'created', message: `Field "created" or "date" is required for ${noteKind} note.` });
    }
  } else {
    // Legacy required-fields validation
    const requiredFields = REQUIRED_FIELDS[noteType] ?? [];
    for (const field of requiredFields) {
      const value = frontmatter[field];
      if (value === undefined || value === null || value === '') {
        warnings.push({
          field,
          message: `Required field "${field}" is missing for ${noteType} note.`,
        });
      }
    }
  }

  // Validate specific field formats
  if (frontmatter['date'] && typeof frontmatter['date'] === 'string') {
    const dateStr = frontmatter['date'];
    if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      warnings.push({
        field: 'date',
        message: `Field "date" should be in ISO format (YYYY-MM-DD), got "${dateStr}".`,
      });
    }
  }

  if (frontmatter['status'] && typeof frontmatter['status'] === 'string'
      && noteType !== 'folder-readme' && noteType !== 'knowledge' && noteType !== 'unknown') {
    const validStatuses = ['draft', 'in-progress', 'complete'];
    const reviewQueueStatuses = ['pending', 'resolved', 'dismissed'];
    const allValid = noteType === 'review-queue'
      ? reviewQueueStatuses
      : validStatuses;
    if (!allValid.includes(frontmatter['status'])) {
      warnings.push({
        field: 'status',
        message: `Field "status" should be one of: ${allValid.join(', ')}. Got "${frontmatter['status']}".`,
      });
    }
  }

  return warnings;
}

/**
 * Extract the latest session date from dated headings (## YYYY-MM-DD ...) in body text.
 */
function extractLastSession(body: string): string | undefined {
  const matches: string[] = [];
  const regex = /^##\s+(\d{4}-\d{2}-\d{2})/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    matches.push(match[1]);
  }
  if (matches.length === 0) return undefined;
  return matches.sort().pop();
}

/**
 * Parse a markdown file's content, extracting frontmatter and body.
 * Validates required fields based on note type (derived from note_kind frontmatter or file path).
 */
export function parseNote(filePath: string, content: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let body: string = content;

  try {
    const parsed = matter(content);
    frontmatter = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // If frontmatter parsing fails, treat entire content as body
  }

  // Normalize date values (gray-matter converts YAML dates to Date objects at midnight UTC).
  // Use UTC getters so the calendar date is preserved in all timezones.
  if (frontmatter['date'] instanceof Date) {
    frontmatter['date'] = utcDateString(frontmatter['date'] as Date);
  }
  if (frontmatter['last_updated'] instanceof Date) {
    frontmatter['last_updated'] = utcDateString(frontmatter['last_updated'] as Date);
  }
  if (frontmatter['read_date'] instanceof Date) {
    frontmatter['read_date'] = utcDateString(frontmatter['read_date'] as Date);
  }
  if (frontmatter['created'] instanceof Date) {
    frontmatter['created'] = utcDateString(frontmatter['created'] as Date);
  }

  // Extract note_kind as primary classifier
  const noteKind = normalizeString(frontmatter['note_kind']) || undefined;

  const { folder, noteType } = classifyNote(filePath, noteKind);

  const createdDate = normalizeString(frontmatter['created']);
  const rawDate = normalizeString(frontmatter['date']) || createdDate || undefined;

  const warnings = validateFrontmatter(frontmatter, noteType, noteKind);

  // Extract common metadata fields
  const tags = extractTags(frontmatter['tags']);

  // Extract serial numbering fields (only for serial notes)
  const noteId = normalizeString(frontmatter['id']) || undefined;
  const seriesField = normalizeString(frontmatter['series']) || undefined;
  const projectId = normalizeString(frontmatter['project_id']) || undefined;

  // Knowledge base fields
  const kbStatus = normalizeString(frontmatter['kb_status']) || undefined;
  const knowledgeKind = normalizeString(frontmatter['knowledge_kind'])
    || (noteType === 'review-queue' ? 'review' : undefined);
  const needsReview = normalizeBool(frontmatter['needs_review']);
  const reviewFlaggedAt = normalizeString(frontmatter['review_flagged_at']) || undefined;

  const aliasesRaw = frontmatter['aliases'];
  const aliases: string[] | undefined = Array.isArray(aliasesRaw)
    ? aliasesRaw.map(String)
    : typeof aliasesRaw === 'string' && aliasesRaw.trim()
      ? [aliasesRaw.trim()]
      : undefined;

  const rqSource = normalizeString(frontmatter['rq_source'])
    || extractWikilinkTarget(frontmatter['source'])
    || undefined;
  const rqTarget = normalizeString(frontmatter['rq_target'])
    || extractWikilinkTarget(frontmatter['target_concept'])
    || undefined;

  // Compute lastSession for experiment notes
  let lastSession: string | undefined;
  if (noteType === 'experiment' || noteType === 'series' || noteType === 'project-index') {
    lastSession = extractLastSession(body) || createdDate || undefined;
  }

  return {
    filePath,
    folder,
    noteType,
    frontmatter,
    body,
    warnings,
    isValid: warnings.length === 0,
    date: rawDate,
    project: normalizeString(frontmatter['project']),
    experimentType: normalizeString(frontmatter['experiment_type']),
    protocolRef: normalizeString(frontmatter['protocol']),
    status: normalizeString(frontmatter['status']),
    tags,
    resultSummary: normalizeString(frontmatter['result_summary']),
    noteId,
    series: seriesField,
    projectId,
    noteKind,
    lastSession,
    kbStatus,
    knowledgeKind,
    needsReview,
    reviewFlaggedAt,
    aliases,
    rqSource,
    rqTarget,
  };
}

/**
 * Normalize a frontmatter value to a string or undefined.
 */
function normalizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

/**
 * Normalize a frontmatter value to a boolean or undefined.
 * Handles boolean, 0/1, and string representations of true/false.
 */
function normalizeBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  const s = String(value).toLowerCase().trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return undefined;
}

/**
 * Extract the inner target from a wikilink like [[target]] or [[target|alias]].
 * Returns undefined if the value is not a wikilink.
 */
function extractWikilinkTarget(value: unknown): string | undefined {
  const str = normalizeString(value);
  if (!str) return undefined;
  const match = str.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return match ? match[1].trim() : undefined;
}

/**
 * Extract tags from a frontmatter value (may be array or comma-separated string).
 */
function extractTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    return value.map(v => String(v).trim());
  }

  if (typeof value === 'string') {
    return value.split(',').map(t => t.trim()).filter(t => t.length > 0);
  }

  return undefined;
}
