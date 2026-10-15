import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import { getDatabase } from '../../storage/database.js';
import { localDateString } from '../../utils/date.js';
import { resolveVaultPath } from '../../utils/paths.js';
import type { ToolHandler } from './registry.js';

const DEFAULT_DAILY_DIR = 'Memory/Daily';
const DEFAULT_CANDIDATE_LIMIT = 50;
const MAX_CANDIDATE_LIMIT = 100;
const VOICE_BEGIN = /^<!-- voice2note:([a-f0-9]{16}) -->$/;
const VOICE_END = /^\^voice2note-([a-f0-9]{16})$/;
const VOICE_BEGIN_PREFIX = /^<!-- voice2note:/;
const VOICE_END_PREFIX = /^\^voice2note-/;
const ROUTE_MARKER = /^<!-- cricknote-diary-route:([a-f0-9]{64}) -->[ \t]*\r?$/gm;

type VoiceEntry = {
  block_id: string;
  transcript: string;
};

type ManualEntry = {
  content: string;
};

type DiaryParts = {
  voiceEntries: VoiceEntry[];
  manualEntries: ManualEntry[];
  malformedVoiceBlocks: number;
};

type Candidate = {
  path: string;
  note_type: string;
  note_id: string | null;
  project_id: string | null;
  project: string | null;
  experiment_type: string | null;
  status: string | null;
  content_hash: string;
};

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function error(message: string): string {
  return JSON.stringify({ error: message });
}

function normalizeRelativeDirectory(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (
    !normalized
    || path.isAbsolute(raw)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeRelativeFile(value: unknown, label: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const normalized = raw.replace(/\\/g, '/');
  if (
    !normalized
    || path.isAbsolute(raw)
    || normalized.startsWith('/')
    || normalized.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function resolveDate(value: unknown): string | undefined {
  if (value === undefined) return localDateString();
  return validDate(value) ? value : undefined;
}

/** Undo only the literal escaping used by voice2note, exactly once. */
function decodeVoiceLiteral(value: string): string {
  return value
    .replace(/\\([\\`*_{}\[\]()#+\-.!|~])/g, '$1')
    .replace(/&(amp|lt|gt);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity]!);
}

/**
 * Parse only complete importer blocks. Exclude malformed importer ranges from
 * manual routing so a damaged voice marker cannot be used to file fabricated
 * transcript text; the full source stays available to a human for repair.
 */
function parseDiary(content: string): DiaryParts {
  const lines = content.split(/\r?\n/);
  const voiceEntries: VoiceEntry[] = [];
  const manualEntries: ManualEntry[] = [];
  let malformedVoiceBlocks = 0;
  let manualLines: string[] = [];

  const flushManual = () => {
    const manualContent = manualLines.join('\n');
    if (manualContent) manualEntries.push({ content: manualContent });
    manualLines = [];
  };

  for (let index = 0; index < lines.length;) {
    const begin = lines[index].match(VOICE_BEGIN);
    if (!begin) {
      if (VOICE_BEGIN_PREFIX.test(lines[index])) {
        flushManual();
        malformedVoiceBlocks += 1;
        index += 1;
        while (index < lines.length && lines[index].startsWith('>')) index += 1;
        if (index < lines.length && VOICE_END_PREFIX.test(lines[index])) index += 1;
        continue;
      }
      if (VOICE_END_PREFIX.test(lines[index])) {
        flushManual();
        malformedVoiceBlocks += 1;
        index += 1;
        continue;
      }
      manualLines.push(lines[index]);
      index += 1;
      continue;
    }

    const transcriptLines: string[] = [];
    let endIndex = index + 1;
    let valid = false;
    while (endIndex < lines.length) {
      const end = lines[endIndex].match(VOICE_END);
      if (end) {
        valid = end[1] === begin[1];
        break;
      }
      if (!lines[endIndex].startsWith('>')) break;
      transcriptLines.push(lines[endIndex].replace(/^> ?/, ''));
      endIndex += 1;
    }

    if (valid) {
      flushManual();
      // Real importer entries have quoted metadata followed by this unescaped
      // label. Dictated label-shaped text is escaped and cannot match it.
      // Legacy minimal blocks lack the label and remain verbatim-compatible.
      const transcriptStart = transcriptLines.indexOf('**Transcript:**');
      const sourceLines = transcriptStart >= 0
        ? transcriptLines.slice(transcriptStart + 1).map(decodeVoiceLiteral)
        : transcriptLines;
      voiceEntries.push({
        block_id: `voice2note-${begin[1]}`,
        transcript: sourceLines.join('\n'),
      });
      index = endIndex + 1;
      continue;
    }

    flushManual();
    malformedVoiceBlocks += 1;
    index += 1;
    while (index < lines.length && lines[index].startsWith('>')) index += 1;
    if (index < lines.length && VOICE_END_PREFIX.test(lines[index])) index += 1;
  }

  flushManual();

  return { voiceEntries, manualEntries, malformedVoiceBlocks };
}

function quoteIsInManualText(quote: string, entries: ManualEntry[]): boolean {
  return entries.some(entry => entry.content.includes(quote));
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function routeMarker(sourcePath: string, blockId: string, targetPath: string, quote: string): string {
  // Deliberately use the stable, vault-relative source/target paths. The source
  // content hash is a freshness check, not part of the marker, so adding a new
  // unrelated diary line does not create a duplicate filing.
  return sha256(sourcePath + blockId + targetPath + quote);
}

function hasRouteMarker(targetContent: string, marker: string): boolean {
  let match: RegExpExecArray | null;
  ROUTE_MARKER.lastIndex = 0;
  while ((match = ROUTE_MARKER.exec(targetContent)) !== null) {
    if (match[1] === marker) return true;
  }
  return false;
}

function toVaultRelative(vaultPath: string, absolutePath: string): string {
  const vault = fs.realpathSync(vaultPath);
  return path.relative(vault, absolutePath).replace(/\\/g, '/');
}

function blockquote(text: string): string {
  // Keep source text literal in the target, without interpreting dictated HTML,
  // links or Markdown commands. Decimal points and hyphens remain readable.
  return text.split(/\r?\n/).map(line => {
    const literal = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[\\`*_{}\[\]()#+!|~]/g, character => `\\${character}`);
    return line ? `> ${literal}` : '>';
  }).join('\n');
}

function isDiaryTarget(
  targetPath: string,
  dailyDir: string,
  database: Database.Database,
): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  if (
    normalized === dailyDir
    || normalized.startsWith(`${dailyDir}/`)
    || normalized === DEFAULT_DAILY_DIR
    || normalized.startsWith(`${DEFAULT_DAILY_DIR}/`)
  ) {
    return true;
  }
  const indexed = database.prepare('SELECT note_type FROM note_metadata WHERE path = ?').get(normalized) as { note_type?: string } | undefined;
  return indexed?.note_type === 'diary';
}

function resolveDiaryPath(vaultPath: string, dailyDir: string, date: string): string {
  return resolveVaultPath(vaultPath, `${dailyDir}/${date}.md`);
}

function readDiary(vaultPath: string, dailyDir: string, date: string): { absolutePath: string; relativePath: string; content: string } | undefined {
  const absolutePath = resolveDiaryPath(vaultPath, dailyDir, date);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return undefined;
  return { absolutePath, relativePath: toVaultRelative(vaultPath, absolutePath), content: fs.readFileSync(absolutePath, 'utf8') };
}

function parsePagination(args: Record<string, unknown>): { limit: number; offset: number } | undefined {
  const rawLimit = args.candidate_limit ?? DEFAULT_CANDIDATE_LIMIT;
  const rawOffset = args.candidate_offset ?? 0;
  if (!Number.isInteger(rawLimit) || !Number.isInteger(rawOffset)) return undefined;
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (limit < 1 || limit > MAX_CANDIDATE_LIMIT || offset < 0) return undefined;
  return { limit, offset };
}

export function createDiaryReviewTools(
  vaultPath: string,
  conflictDetector?: ConflictDetector,
  injectedDb?: Database.Database,
): ToolHandler[] {
  const database = injectedDb ?? getDatabase();

  return [
    {
      definition: {
        name: 'diary_review_context',
        description: 'Read one daily diary without modifying it. Returns its SHA-256, full content, parsed voice2note transcripts, manual text, and a paginated list of existing non-diary indexed notes that may be reviewed as routing candidates.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Optional local diary date in real-calendar YYYY-MM-DD form; defaults to today.' },
            daily_dir: { type: 'string', description: 'Optional vault-relative daily diary folder; defaults to Memory/Daily.' },
            candidate_limit: { type: 'integer', description: 'Candidate page size, 1–100; defaults to 50.' },
            candidate_offset: { type: 'integer', description: 'Zero-based candidate offset; defaults to 0.' },
          },
        },
      },
      execute: async (args) => {
        const date = resolveDate(args.date);
        if (!date) return error('date must be a real calendar date in YYYY-MM-DD form');
        const dailyDir = args.daily_dir === undefined ? DEFAULT_DAILY_DIR : normalizeRelativeDirectory(args.daily_dir, 'daily_dir');
        if (!dailyDir) return error('daily_dir must be a non-empty vault-relative folder path without traversal');
        const pagination = parsePagination(args);
        if (!pagination) return error('candidate_limit must be an integer from 1 to 100 and candidate_offset must be a non-negative integer');

        let diary;
        try {
          diary = readDiary(vaultPath, dailyDir, date);
        } catch {
          return error('daily_dir escapes vault boundary');
        }
        if (!diary) return error(`Diary not found: ${dailyDir}/${date}.md`);

        const parts = parseDiary(diary.content);
        conflictDetector?.recordFileRead(diary.absolutePath, diary.content);
        const eligible = database.prepare(
          `SELECT path, note_type, note_id, project_id, project, experiment_type, status, content_hash
           FROM note_metadata
           WHERE note_type != 'diary' AND path != ?
           ORDER BY CASE WHEN note_id IS NULL THEN 1 ELSE 0 END, note_id, path
           LIMIT ? OFFSET ?`,
        ).all(diary.relativePath, pagination.limit, pagination.offset) as Candidate[];
        const totalRow = database.prepare(
          'SELECT COUNT(*) AS count FROM note_metadata WHERE note_type != \'diary\' AND path != ?',
        ).get(diary.relativePath) as { count: number };

        return JSON.stringify({
          date,
          daily_dir: dailyDir,
          source_path: diary.relativePath,
          source_hash: sha256(diary.content),
          content: diary.content,
          voice_entries: parts.voiceEntries,
          manual_entries: parts.manualEntries,
          malformed_voice_blocks: parts.malformedVoiceBlocks,
          indexed_candidates: eligible,
          pagination: {
            candidate_offset: pagination.offset,
            candidate_limit: pagination.limit,
            returned: eligible.length,
            total: totalRow.count,
            has_more: pagination.offset + eligible.length < totalRow.count,
            next_offset: pagination.offset + eligible.length < totalRow.count ? pagination.offset + eligible.length : null,
          },
          filing_audit: 'Diary source files are never marked or changed. A successful route is auditable only by its standalone cricknote-diary-route marker in the destination note.',
        });
      },
    },
    {
      definition: {
        name: 'route_diary_excerpt',
        description: 'Propose filing one exact diary excerpt into one existing non-diary Markdown note. First preview the pending edit, show the user the exact quote and destination mapping, and obtain approval before applying. This tool never changes the diary or creates a target note.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Optional local diary date in real-calendar YYYY-MM-DD form; defaults to today.' },
            daily_dir: { type: 'string', description: 'Optional vault-relative daily diary folder; defaults to Memory/Daily.' },
            source_block_id: { type: 'string', description: 'Optional voice entry block ID returned by diary_review_context (voice2note-<16 lowercase hex>). Omit only for manual diary text.' },
            source_quote: { type: 'string', description: 'Required exact text copied from the selected voice transcript or one manual diary segment. No inference or correction is allowed.' },
            target_path: { type: 'string', description: 'Required existing vault-relative .md note path. It must not be the source or any diary note.' },
            source_hash: { type: 'string', description: 'Required current SHA-256 from diary_review_context.' },
            target_hash: { type: 'string', description: 'Required current SHA-256 from vault_read for target_path.' },
          },
          required: ['source_quote', 'target_path', 'source_hash', 'target_hash'],
        },
      },
      execute: async (args) => {
        const date = resolveDate(args.date);
        if (!date) return error('date must be a real calendar date in YYYY-MM-DD form');
        const dailyDir = args.daily_dir === undefined ? DEFAULT_DAILY_DIR : normalizeRelativeDirectory(args.daily_dir, 'daily_dir');
        if (!dailyDir) return error('daily_dir must be a non-empty vault-relative folder path without traversal');
        if (typeof args.source_quote !== 'string' || args.source_quote.length === 0) return error('source_quote must be a non-empty exact diary excerpt');
        if (!isHash(args.source_hash)) return error('source_hash must be a SHA-256 hex digest');
        if (!isHash(args.target_hash)) return error('target_hash must be a SHA-256 hex digest');
        const targetRelativePath = normalizeRelativeFile(args.target_path, 'target_path');
        if (!targetRelativePath || !targetRelativePath.endsWith('.md')) return error('target_path must be an existing vault-relative .md file without traversal');

        let diary;
        let targetAbsolutePath: string;
        try {
          diary = readDiary(vaultPath, dailyDir, date);
          targetAbsolutePath = resolveVaultPath(vaultPath, targetRelativePath);
        } catch {
          return error('source or target path escapes vault boundary');
        }
        if (!diary) return error(`Diary not found: ${dailyDir}/${date}.md`);
        if (!fs.existsSync(targetAbsolutePath) || !fs.statSync(targetAbsolutePath).isFile()) return error(`Target note not found: ${targetRelativePath}`);

        const targetContent = fs.readFileSync(targetAbsolutePath, 'utf8');
        const targetPath = toVaultRelative(vaultPath, targetAbsolutePath);
        const sourceRealPath = fs.realpathSync(diary.absolutePath);
        const targetRealPath = fs.realpathSync(targetAbsolutePath);
        const targetRealRelativePath = toVaultRelative(vaultPath, targetRealPath);
        if (
          targetRealPath === sourceRealPath
          || targetPath === diary.relativePath
          || isDiaryTarget(targetPath, dailyDir, database)
          || isDiaryTarget(targetRealRelativePath, dailyDir, database)
        ) {
          return error('target_path must be an existing non-diary note and cannot be the source diary');
        }
        if (sha256(diary.content) !== args.source_hash) return error('source_hash is stale; re-run diary_review_context before routing');
        if (sha256(targetContent) !== args.target_hash) return error('target_hash is stale; re-read the target before routing');

        const parts = parseDiary(diary.content);
        const requestedBlockId = args.source_block_id;
        let sourceBlockId = 'manual';
        if (requestedBlockId !== undefined) {
          if (typeof requestedBlockId !== 'string' || !/^voice2note-[a-f0-9]{16}$/.test(requestedBlockId)) {
            return error('source_block_id must be a voice block ID returned by diary_review_context');
          }
          const entry = parts.voiceEntries.find(candidate => candidate.block_id === requestedBlockId);
          if (!entry) return error(`Voice source block not found: ${requestedBlockId}`);
          if (!entry.transcript.includes(args.source_quote)) return error('source_quote does not occur exactly within the selected voice transcript');
          sourceBlockId = entry.block_id;
        } else if (!quoteIsInManualText(args.source_quote, parts.manualEntries)) {
          return error('source_quote does not occur exactly within manual diary text; supply a valid voice source_block_id for imported transcripts');
        }

        const marker = routeMarker(diary.relativePath, sourceBlockId, targetPath, args.source_quote);
        if (hasRouteMarker(targetContent, marker)) {
          return JSON.stringify({
            status: 'already_filed',
            source_path: diary.relativePath,
            source_block_id: sourceBlockId,
            target_path: targetPath,
            route_marker: marker,
          });
        }

        const backlink = sourceBlockId === 'manual'
          ? `[[${diary.relativePath}]]`
          : `[[${diary.relativePath}#^${sourceBlockId}]]`;
        const routeBlock = [
          `<!-- cricknote-diary-route:${marker} -->`,
          `> Source: ${backlink}`,
          '>',
          blockquote(args.source_quote),
        ].join('\n');
        const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
        const newContent = `${targetContent}${separator}${routeBlock}\n`;

        // Capture both files for long-lived runtimes. CLI application also
        // enforces expectedBeforeHash immediately before proposing the write.
        conflictDetector?.recordFileRead(diary.absolutePath, diary.content);
        conflictDetector?.recordFileRead(targetAbsolutePath, targetContent);
        return JSON.stringify({
          type: 'pending_edit',
          operation: 'route_diary_excerpt',
          path: targetAbsolutePath,
          newContent,
          expectedBeforeHash: args.target_hash,
          meta: {
            source_path: diary.relativePath,
            source_block_id: sourceBlockId,
            source_hash: args.source_hash,
            target_hash: args.target_hash,
            route_marker: marker,
          },
        });
      },
    },
  ];
}
