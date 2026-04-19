import path from 'node:path';

export const READING_SOURCE_TYPES = ['pdf', 'notes', 'notebooklm', 'web', 'other'] as const;

export type ReadingSourceType = (typeof READING_SOURCE_TYPES)[number];

export interface ReadingSourceInput {
  type: ReadingSourceType;
  path: string;
}

export interface ReadingNoteMeta {
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi?: string;
  citekey?: string;
  zotero_key?: string;
  read_date?: string;
  related_projects?: string[];
  status?: string;
  kb_status?: string;
  tags?: string[];
}

export type ReadingPipelineStep =
  | 'missing_bundle'
  | 'ready_to_ingest'
  | 'needs_sources'
  | 'ready_to_compile'
  | 'needs_human_review'
  | 'ready_for_kb_mapping'
  | 'kb_apply_in_progress'
  | 'needs_mapping_cleanup'
  | 'done';

export const CREATE_SECTION_HEADINGS = [
  'Claims',
  'Reasoning',
  'Evidence',
  'Assumptions',
  'Takeaways',
  'Extensions',
] as const;

const DEFAULT_READING_TAG = 'reading';

export function isReadingSourceType(value: unknown): value is ReadingSourceType {
  return typeof value === 'string'
    && (READING_SOURCE_TYPES as readonly string[]).includes(value);
}

export function slugifyReadingTitle(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'reading-note';
}

export function normalizeReadingSourcePath(sourcePath: string): string {
  const slashNormalized = sourcePath.replace(/\\/g, '/').trim();
  const normalized = path.posix.normalize(slashNormalized).replace(/^\.\/+/, '');

  if (!normalized || normalized === '.') {
    throw new Error('source path is required.');
  }
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('source paths must be relative to the attachment folder.');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('source paths must be relative to the attachment folder.');
  }

  return normalized;
}

export function normalizeReadingSources(sources: ReadingSourceInput[]): ReadingSourceInput[] {
  const normalized: ReadingSourceInput[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!isReadingSourceType(source.type)) {
      throw new Error(`Unsupported reading source type "${String(source.type)}".`);
    }

    const normalizedPath = normalizeReadingSourcePath(source.path);
    const dedupeKey = `${source.type}:${normalizedPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ type: source.type, path: normalizedPath });
  }

  return normalized;
}

export function buildCreateReadingBody(meta: Pick<ReadingNoteMeta, 'title'>): string {
  const sections = CREATE_SECTION_HEADINGS.map((heading) => `## ${heading}\n`).join('\n');
  return `\n# ${meta.title}\n\n${sections}`;
}

export function hasCreateHeadings(body: string): boolean {
  return CREATE_SECTION_HEADINGS.every((heading) =>
    new RegExp(`^## ${heading}\\s*$`, 'm').test(body)
  );
}

export function hasMeaningfulReadingBody(body: string): boolean {
  const stripped = body
    .replace(/^# .+$/gm, '')
    .replace(/<!--[\s\S]*?-->/gm, '');
  return stripped.split(/^## .+$/gm).some(section => section.trim().length > 0);
}

export function syncReadingBodyTitle(body: string, title: string): string {
  if (!body.trim()) {
    return buildCreateReadingBody({ title });
  }

  if (/^\s*#\s+.+$/m.test(body)) {
    return body.replace(/^\s*#\s+.+$/m, `# ${title}`);
  }

  return `# ${title}\n\n${body.trimStart()}`;
}

export function readingSourcesEqual(
  left: ReadingSourceInput[] | undefined,
  right: ReadingSourceInput[] | undefined
): boolean {
  const normalizedLeft = left ? normalizeReadingSources(left) : [];
  const normalizedRight = right ? normalizeReadingSources(right) : [];

  if (normalizedLeft.length !== normalizedRight.length) return false;

  const makeKey = (s: ReadingSourceInput) => `${s.type}:${s.path}`;
  const leftKeys = new Set(normalizedLeft.map(makeKey));
  return normalizedRight.every(s => leftKeys.has(makeKey(s)));
}

function normalizeFrontmatterString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function inferReadingPipelineStep(
  frontmatter: Record<string, unknown>,
  body: string
): Exclude<ReadingPipelineStep, 'missing_bundle' | 'ready_to_ingest'> {
  const sources = Array.isArray(frontmatter.sources)
    ? frontmatter.sources as ReadingSourceInput[]
    : [];
  if (sources.length === 0) {
    return 'needs_sources';
  }

  if (!hasMeaningfulReadingBody(body)) {
    return 'ready_to_compile';
  }

  const status = normalizeFrontmatterString(frontmatter.status);
  if (status !== 'complete') {
    return 'needs_human_review';
  }

  const kbStatus = normalizeFrontmatterString(frontmatter.kb_status);
  if (!kbStatus || kbStatus === 'pending') {
    return 'ready_for_kb_mapping';
  }

  if (kbStatus === 'mapped' || kbStatus === 'merged_with_review') {
    return 'kb_apply_in_progress';
  }

  return 'done';
}

function uniqueStringArray(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function existingStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStringArray(value) : [];
}

function existingString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function chooseString(primary: string | undefined, fallback: unknown, defaultValue: string): string {
  return existingString(primary) ?? existingString(fallback) ?? defaultValue;
}

const DOI_RESOLVER_HOSTS = new Set(['doi.org', 'dx.doi.org']);

export function normalizeDoi(doi: string): string {
  const trimmed = doi.trim().toLowerCase();
  if (!trimmed) return '';

  // Handle URL form: https://doi.org/... or https://dx.doi.org/...
  try {
    const url = new URL(trimmed);
    if ((url.protocol === 'http:' || url.protocol === 'https:')
        && DOI_RESOLVER_HOSTS.has(url.hostname)) {
      return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    }
  } catch {
    // Not a valid URL — fall through to string-based stripping
  }

  // Handle doi: prefix (e.g. "doi:10.1016/j.cell")
  return trimmed.replace(/^doi:\s*/, '');
}

export function buildReadingFrontmatter(
  meta: ReadingNoteMeta,
  sources?: ReadingSourceInput[],
  existingFrontmatter: Record<string, unknown> = {}
): Record<string, unknown> {
  const normalizedSources = sources === undefined
    ? Array.isArray(existingFrontmatter.sources)
      ? normalizeReadingSources(existingFrontmatter.sources as ReadingSourceInput[])
      : undefined
    : normalizeReadingSources(sources);

  const relatedProjects = uniqueStringArray([
    ...existingStringArray(existingFrontmatter.related_projects),
    ...(meta.related_projects ?? []),
  ]);

  const tags = uniqueStringArray([
    DEFAULT_READING_TAG,
    ...existingStringArray(existingFrontmatter.tags),
    ...(meta.tags ?? []),
  ]);

  const frontmatter: Record<string, unknown> = {
    ...existingFrontmatter,
    title: meta.title,
    authors: meta.authors,
    year: meta.year,
    journal: meta.journal,
    read_date: chooseString(meta.read_date, existingFrontmatter.read_date, new Date().toISOString().slice(0, 10)),
    status: chooseString(meta.status, existingFrontmatter.status, 'draft'),
    kb_status: chooseString(meta.kb_status, existingFrontmatter.kb_status, 'pending'),
    related_projects: relatedProjects,
    tags,
  };

  const rawDoi = existingString(meta.doi) ?? existingString(existingFrontmatter.doi);
  const doi = rawDoi ? normalizeDoi(rawDoi) : undefined;
  if (doi) {
    frontmatter.doi = doi;
  } else {
    delete frontmatter.doi;
  }

  const citekey = existingString(meta.citekey) ?? existingString(existingFrontmatter.citekey);
  if (citekey) {
    frontmatter.citekey = citekey;
  } else {
    delete frontmatter.citekey;
  }

  const zoteroKey = existingString(meta.zotero_key) ?? existingString(existingFrontmatter.zotero_key);
  if (zoteroKey) {
    frontmatter.zotero_key = zoteroKey;
  } else {
    delete frontmatter.zotero_key;
  }

  if (normalizedSources && normalizedSources.length > 0) {
    frontmatter.sources = normalizedSources;
  } else {
    delete frontmatter.sources;
  }

  return frontmatter;
}
