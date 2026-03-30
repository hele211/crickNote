import matter from 'gray-matter';
import { utcDateString } from '../utils/date.js';

/** Note type classifications based on vault folder structure. */
export type NoteType = 'experiment' | 'protocol' | 'reading' | 'diary' | 'agent' | 'unknown';

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
}

/** Required fields per note type. */
const REQUIRED_FIELDS: Record<NoteType, string[]> = {
  experiment: ['date', 'project', 'experiment_type', 'protocol', 'samples', 'result_summary', 'status'],
  protocol: ['title', 'version', 'last_updated', 'category'],
  reading: ['title', 'authors', 'year', 'journal', 'doi', 'read_date'],
  diary: ['date', 'type'],
  agent: [],
  unknown: [],
};

/**
 * Classify a note by its relative file path within the vault.
 */
export function classifyNote(filePath: string): { folder: string; noteType: NoteType } {
  const normalized = filePath.replace(/\\/g, '/');
  const firstSegment = normalized.split('/')[0];

  switch (firstSegment) {
    case 'Projects':
      return { folder: 'Projects', noteType: 'experiment' };
    case 'Protocols':
      return { folder: 'Protocols', noteType: 'protocol' };
    case 'Reading':
      return { folder: 'Reading', noteType: 'reading' };
    case 'Memory':
      return { folder: 'Memory', noteType: 'diary' };
    case 'Agent':
      return { folder: 'Agent', noteType: 'agent' };
    default:
      return { folder: firstSegment || 'root', noteType: 'unknown' };
  }
}

/**
 * Validate frontmatter fields against required fields for the note type.
 */
function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  noteType: NoteType
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
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

  if (frontmatter['status'] && typeof frontmatter['status'] === 'string') {
    const validStatuses = ['draft', 'in-progress', 'complete'];
    if (!validStatuses.includes(frontmatter['status'])) {
      warnings.push({
        field: 'status',
        message: `Field "status" should be one of: ${validStatuses.join(', ')}. Got "${frontmatter['status']}".`,
      });
    }
  }

  return warnings;
}

/**
 * Parse a markdown file's content, extracting frontmatter and body.
 * Validates required fields based on note type (derived from file path).
 */
export function parseNote(filePath: string, content: string): ParsedNote {
  const { folder, noteType } = classifyNote(filePath);

  let frontmatter: Record<string, unknown> = {};
  let body: string = content;

  try {
    const parsed = matter(content);
    frontmatter = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // If frontmatter parsing fails, treat entire content as body
    // gray-matter handles Date objects in YAML — normalize them back to strings
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

  const warnings = validateFrontmatter(frontmatter, noteType);

  // Extract common metadata fields
  const tags = extractTags(frontmatter['tags']);

  return {
    filePath,
    folder,
    noteType,
    frontmatter,
    body,
    warnings,
    isValid: warnings.length === 0,
    date: normalizeString(frontmatter['date']),
    project: normalizeString(frontmatter['project']),
    experimentType: normalizeString(frontmatter['experiment_type']),
    protocolRef: normalizeString(frontmatter['protocol']),
    status: normalizeString(frontmatter['status']),
    tags,
    resultSummary: normalizeString(frontmatter['result_summary']),
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
