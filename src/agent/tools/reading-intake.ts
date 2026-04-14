import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import type { ToolHandler } from './registry.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import {
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasCreateHeadings,
  hasMeaningfulReadingBody,
  inferReadingPipelineStep,
  normalizeReadingSourcePath,
  normalizeReadingSources,
  readingSourcesEqual,
  slugifyReadingTitle,
  syncReadingBodyTitle,
  type ReadingSourceInput,
  type ReadingPipelineStep,
  type ReadingSourceType,
} from '../../knowledge/reading-note.js';
import { resolveVaultPath } from '../../utils/paths.js';

interface DiscoveredBundleFile {
  path: string;
  type: ReadingSourceType;
  readable: boolean;
}

interface BundleDiscoveryResult {
  slug: string;
  folderExists: boolean;
  bundlePath: string;
  discoveredFiles: DiscoveredBundleFile[];
  recommendedSources: ReadingSourceInput[];
  warnings: string[];
}

interface MappingArtifactSummary {
  path?: string;
  status?: string;
  pendingTargets: number;
  needsCleanup?: boolean;
  cleanupCandidates?: string[];
}

const TEXT_SOURCE_EXTENSIONS = new Set(['.md', '.txt']);
const IGNORED_BUNDLE_FILES = new Set(['.ds_store']);

function normalizeBundleSlug(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('slug is required.');
  }
  return slugifyReadingTitle(value);
}

function classifyBundleFile(fileName: string): { type: ReadingSourceType; readable: boolean } {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);

  if (ext === '.pdf') {
    return { type: 'pdf', readable: true };
  }

  if (TEXT_SOURCE_EXTENSIONS.has(ext)) {
    if (lower.includes('notebooklm')) {
      return { type: 'notebooklm', readable: true };
    }
    if (lower.includes('web')) {
      return { type: 'web', readable: true };
    }
    return { type: 'notes', readable: true };
  }

  return { type: 'other', readable: false };
}

function discoverBundle(vaultPath: string, slug: string): BundleDiscoveryResult {
  const bundlePath = resolveVaultPath(vaultPath, path.join('Reading', 'attachments', slug));
  const warnings: string[] = [];

  if (!fs.existsSync(bundlePath) || !fs.statSync(bundlePath).isDirectory()) {
    return {
      slug,
      folderExists: false,
      bundlePath,
      discoveredFiles: [],
      recommendedSources: [],
      warnings: [`Reading bundle not found: Reading/attachments/${slug}`],
    };
  }

  const discoveredFiles: DiscoveredBundleFile[] = [];

  for (const entry of fs.readdirSync(bundlePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_BUNDLE_FILES.has(entry.name.toLowerCase())) {
      continue;
    }

    if (!entry.isFile()) {
      warnings.push(`Skipping non-file bundle entry "${entry.name}".`);
      continue;
    }

    const relativePath = normalizeReadingSourcePath(entry.name);
    const classified = classifyBundleFile(relativePath);
    discoveredFiles.push({
      path: relativePath,
      type: classified.type,
      readable: classified.readable,
    });

    if (!classified.readable) {
      warnings.push(`Unsupported bundle file "${relativePath}" — only .pdf, .md, and .txt are used for reading intake.`);
    }
  }

  const recommendedSources = normalizeReadingSources(
    discoveredFiles
      .filter((file) => file.readable)
      .map((file) => ({ type: file.type, path: file.path }))
  );

  const pdfCount = discoveredFiles.filter((file) => file.type === 'pdf' && file.readable).length;
  if (pdfCount > 1) {
    warnings.push(`Multiple PDF files found in Reading/attachments/${slug}; review the recommended sources before ingesting.`);
  }

  if (recommendedSources.length === 0) {
    warnings.push(`Reading bundle "${slug}" has no readable source files yet.`);
  }

  return {
    slug,
    folderExists: true,
    bundlePath,
    discoveredFiles,
    recommendedSources,
    warnings,
  };
}

function normalizeExcludedPaths(paths: unknown): Set<string> {
  if (!Array.isArray(paths)) {
    return new Set<string>();
  }

  const normalized = new Set<string>();
  for (const value of paths) {
    if (typeof value !== 'string') {
      continue;
    }
    normalized.add(normalizeReadingSourcePath(value));
  }
  return normalized;
}

function preserveExistingBody(title: string, existingBody: string): string {
  return hasMeaningfulReadingBody(existingBody)
    ? syncReadingBodyTitle(existingBody, title)
    : buildCreateReadingBody({ title });
}

function normalizeReadingNotePath(value: unknown, vaultPath: string): { absPath: string; relPath: string; slug: string } {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('path is required.');
  }

  const normalized = value.replace(/\\/g, '/').trim();
  if (!/^Reading\/(Papers|Threads)\/[^/]+\.md$/.test(normalized)) {
    throw new Error('Reading note path must live under Reading/Papers/ or Reading/Threads/.');
  }

  return {
    absPath: resolveVaultPath(vaultPath, normalized),
    relPath: normalized,
    slug: path.basename(normalized, '.md'),
  };
}

function findReadingNoteBySlug(vaultPath: string, slug: string): { absPath: string; relPath: string } | null {
  for (const relPath of [
    path.posix.join('Reading', 'Papers', `${slug}.md`),
    path.posix.join('Reading', 'Threads', `${slug}.md`),
  ]) {
    const absPath = resolveVaultPath(vaultPath, relPath);
    if (fs.existsSync(absPath)) {
      return { absPath, relPath };
    }
  }

  return null;
}

function countPendingMappingTargets(body: string): number {
  const sectionMatch = body.match(/## Targets\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!sectionMatch) {
    return 0;
  }

  return sectionMatch[1]
    .split('\n')
    .filter((line) => /\|\s*(pending|deferred)\s*\|/.test(line))
    .length;
}

function findRelevantMappingArtifact(vaultPath: string, noteRelPath: string, slug: string): MappingArtifactSummary {
  const noteDir = path.dirname(noteRelPath);
  const absDir = resolveVaultPath(vaultPath, noteDir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return { pendingTargets: 0 };
  }

  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-mapping(?:-\\d{8}T\\d{6})?\\.md$`);
  const candidates = fs.readdirSync(absDir)
    .filter((entry) => pattern.test(entry))
    .map((entry) => {
      const relPath = path.posix.join(noteDir, entry);
      const absPath = resolveVaultPath(vaultPath, relPath);
      const raw = fs.readFileSync(absPath, 'utf-8');
      const parsed = matter(raw);
      return {
        relPath,
        status: typeof parsed.data.status === 'string' ? parsed.data.status : undefined,
        pendingTargets: countPendingMappingTargets(parsed.content),
        mtime: fs.statSync(absPath).mtimeMs,
      };
    })
    .sort((a, b) => {
      const aExact = a.relPath.endsWith(`/${slug}-mapping.md`) ? 1 : 0;
      const bExact = b.relPath.endsWith(`/${slug}-mapping.md`) ? 1 : 0;
      if (aExact !== bExact) {
        return bExact - aExact;
      }
      return b.mtime - a.mtime;
    });

  const confirmedCandidates = candidates.filter((c) => c.status === 'confirmed');
  if (confirmedCandidates.length > 1) {
    return {
      pendingTargets: 0,
      needsCleanup: true,
      cleanupCandidates: confirmedCandidates.map((c) => c.relPath),
    };
  }

  const active = confirmedCandidates[0] ?? candidates[0];

  if (!active) {
    return { pendingTargets: 0 };
  }

  return {
    path: active.relPath,
    status: active.status,
    pendingTargets: active.pendingTargets,
  };
}

function determinePipelineStep(
  frontmatter: Record<string, unknown>,
  body: string,
  mapping: MappingArtifactSummary
): Exclude<ReadingPipelineStep, 'missing_bundle' | 'ready_to_ingest'> {
  if (mapping.needsCleanup) {
    return 'needs_mapping_cleanup';
  }

  const baseStep = inferReadingPipelineStep(frontmatter, body);
  if (baseStep === 'kb_apply_in_progress') {
    return 'kb_apply_in_progress';
  }

  if (baseStep === 'done' && (mapping.pendingTargets > 0 || frontmatter.kb_status === 'merged_with_review')) {
    return 'kb_apply_in_progress';
  }

  if (baseStep === 'ready_for_kb_mapping' && mapping.pendingTargets > 0) {
    return 'kb_apply_in_progress';
  }

  return baseStep;
}

export function createReadingIntakeTools(
  vaultPath: string,
  conflictDetector?: ConflictDetector
): ToolHandler[] {
  return [
    {
      definition: {
        name: 'discover_reading_bundle',
        description: 'Inspect Reading/attachments/<slug>/ and recommend readable source files for a new reading note.',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Reading bundle slug under Reading/attachments/' },
          },
          required: ['slug'],
        },
      },
      execute: async (args) => {
        let slug: string;
        try {
          slug = normalizeBundleSlug(args.slug);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        const discovery = discoverBundle(vaultPath, slug);
        return JSON.stringify({
          slug: discovery.slug,
          folder_exists: discovery.folderExists,
          bundle_path: discovery.bundlePath,
          discovered_files: discovery.discoveredFiles,
          recommended_sources: discovery.recommendedSources,
          warnings: discovery.warnings,
        });
      },
    },
    {
      definition: {
        name: 'ingest_reading_bundle',
        description: 'Create or update a reading note from files already stored under Reading/attachments/<slug>/.',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Reading bundle slug under Reading/attachments/' },
            title: { type: 'string', description: 'Paper title' },
            authors: { type: 'array', items: { type: 'string' }, description: 'Author names' },
            year: { type: 'number', description: 'Publication year' },
            journal: { type: 'string', description: 'Journal name' },
            doi: { type: 'string', description: 'DOI (optional)' },
            related_projects: { type: 'array', items: { type: 'string' }, description: 'Optional related project IDs' },
            sources: {
              type: 'array',
              description: 'Optional explicit source list relative to Reading/attachments/<slug>/',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['pdf', 'notes', 'notebooklm', 'web', 'other'] },
                  path: { type: 'string' },
                },
                required: ['type', 'path'],
              },
            },
            exclude_paths: {
              type: 'array',
              description: 'Optional source paths to exclude from the discovered bundle',
              items: { type: 'string' },
            },
          },
          required: ['slug', 'title', 'authors', 'year', 'journal'],
        },
      },
      execute: async (args) => {
        let slug: string;
        try {
          slug = normalizeBundleSlug(args.slug);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        const discovery = discoverBundle(vaultPath, slug);

        if (!discovery.folderExists) {
          return JSON.stringify({ error: `Reading bundle not found: Reading/attachments/${slug}` });
        }

        let excludedPaths: Set<string>;
        try {
          excludedPaths = normalizeExcludedPaths(args.exclude_paths);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        let selectedSources: ReadingSourceInput[];
        try {
          if (Array.isArray(args.sources)) {
            selectedSources = normalizeReadingSources(args.sources as ReadingSourceInput[]);
          } else {
            selectedSources = discovery.recommendedSources;
          }
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        selectedSources = selectedSources.filter((source) => !excludedPaths.has(source.path));

        if (selectedSources.length === 0) {
          return JSON.stringify({ error: `No readable sources selected for Reading/attachments/${slug}` });
        }

        for (const source of selectedSources) {
          let sourcePath: string;
          try {
            sourcePath = resolveVaultPath(vaultPath, path.join('Reading', 'attachments', slug, source.path));
          } catch {
            return JSON.stringify({ error: `Selected source resolves outside the vault: "${source.path}"` });
          }

          if (!fs.existsSync(sourcePath)) {
            return JSON.stringify({ error: `Selected source file not found: "${source.path}"` });
          }
        }

        let notePath: string;
        try {
          notePath = resolveVaultPath(vaultPath, path.join('Reading', 'Papers', `${slug}.md`));
        } catch {
          return JSON.stringify({ error: 'Resolved reading note path is outside the vault.' });
        }

        const exists = fs.existsSync(notePath);
        let existingFrontmatter: Record<string, unknown> = {};
        let existingBody = '';

        if (exists) {
          const existingContent = fs.readFileSync(notePath, 'utf-8');
          conflictDetector?.recordFileRead(notePath, existingContent);
          const parsed = matter(existingContent);
          existingFrontmatter = parsed.data as Record<string, unknown>;
          existingBody = parsed.content;
        }

        let existingSources: ReadingSourceInput[] | undefined;
        try {
          existingSources = Array.isArray(existingFrontmatter.sources)
            ? normalizeReadingSources(existingFrontmatter.sources as ReadingSourceInput[])
            : undefined;
        } catch {
          existingSources = undefined;
        }

        const sourcesChanged = exists && !readingSourcesEqual(existingSources, selectedSources);
        const shouldResetWorkflowState = !hasMeaningfulReadingBody(existingBody) || sourcesChanged;

        let frontmatter: Record<string, unknown>;
        try {
          frontmatter = buildReadingFrontmatter(
            {
              title: args.title as string,
              authors: args.authors as string[],
              year: args.year as number,
              journal: args.journal as string,
              doi: args.doi as string | undefined,
              related_projects: args.related_projects as string[] | undefined,
              status: shouldResetWorkflowState ? 'draft' : undefined,
              kb_status: shouldResetWorkflowState ? 'pending' : undefined,
            },
            selectedSources,
            existingFrontmatter
          );
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        const body = preserveExistingBody(args.title as string, existingBody);
        const newContent = matter.stringify(body, frontmatter);

        return JSON.stringify({
          type: 'pending_edit',
          operation: exists ? 'update' : 'create',
          path: notePath,
          newContent,
        });
      },
    },
    {
      definition: {
        name: 'reading_pipeline_status',
        description: 'Inspect a reading bundle or reading note and report the deterministic next step in the reading pipeline.',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Reading bundle slug under Reading/attachments/' },
            path: { type: 'string', description: 'Optional existing reading note path under Reading/Papers/ or Reading/Threads/' },
          },
        },
      },
      execute: async (args) => {
        let noteRef: { absPath: string; relPath: string; slug: string } | null = null;
        let slug: string;

        if (args.path !== undefined) {
          try {
            noteRef = normalizeReadingNotePath(args.path, vaultPath);
            slug = noteRef.slug;
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }
        } else {
          try {
            slug = normalizeBundleSlug(args.slug);
          } catch (err) {
            return JSON.stringify({ error: (err as Error).message });
          }

          const existingNote = findReadingNoteBySlug(vaultPath, slug);
          if (existingNote) {
            noteRef = { ...existingNote, slug };
          }
        }

        const discovery = discoverBundle(vaultPath, slug);

        if (!noteRef || !fs.existsSync(noteRef.absPath)) {
          return JSON.stringify({
            slug,
            note_exists: false,
            bundle_exists: discovery.folderExists,
            bundle_path: discovery.bundlePath,
            discovered_files: discovery.discoveredFiles,
            recommended_sources: discovery.recommendedSources,
            required_metadata: ['title', 'authors', 'year', 'journal'],
            next_step: discovery.folderExists ? 'ready_to_ingest' : 'missing_bundle',
            warnings: discovery.warnings,
          });
        }

        const raw = fs.readFileSync(noteRef.absPath, 'utf-8');
        const parsed = matter(raw);
        const frontmatter = parsed.data as Record<string, unknown>;
        const body = parsed.content;
        const mapping = findRelevantMappingArtifact(vaultPath, noteRef.relPath, slug);
        const nextStep = determinePipelineStep(frontmatter, body, mapping);

        return JSON.stringify({
          slug,
          path: noteRef.relPath,
          note_exists: true,
          bundle_exists: discovery.folderExists,
          bundle_path: discovery.bundlePath,
          discovered_files: discovery.discoveredFiles,
          recommended_sources: discovery.recommendedSources,
          status: typeof frontmatter.status === 'string' ? frontmatter.status : undefined,
          kb_status: typeof frontmatter.kb_status === 'string' ? frontmatter.kb_status : undefined,
          has_sources: Array.isArray(frontmatter.sources) && frontmatter.sources.length > 0,
          has_create_headings: hasCreateHeadings(body),
          has_drafted_content: hasMeaningfulReadingBody(body),
          mapping_path: mapping.path,
          mapping_status: mapping.status,
          mapping_pending_targets: mapping.pendingTargets,
          mapping_cleanup_candidates: mapping.cleanupCandidates,
          next_step: nextStep,
          warnings: discovery.warnings,
        });
      },
    },
    {
      definition: {
        name: 'set_reading_note_status',
        description: 'Update only the status field on a reading note under Reading/Papers/ or Reading/Threads/.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Reading note path under Reading/Papers/ or Reading/Threads/' },
            status: { type: 'string', enum: ['draft', 'in-progress', 'complete'], description: 'New reading-note workflow status' },
          },
          required: ['path', 'status'],
        },
      },
      execute: async (args) => {
        let noteRef: { absPath: string; relPath: string; slug: string };
        try {
          noteRef = normalizeReadingNotePath(args.path, vaultPath);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }

        if (!fs.existsSync(noteRef.absPath)) {
          return JSON.stringify({ error: `File not found: ${noteRef.relPath}` });
        }

        const existing = fs.readFileSync(noteRef.absPath, 'utf-8');
        conflictDetector?.recordFileRead(noteRef.absPath, existing);
        const parsed = matter(existing);
        parsed.data.status = args.status as string;
        const newContent = matter.stringify(parsed.content, parsed.data);

        return JSON.stringify({
          type: 'pending_edit',
          operation: 'update',
          path: noteRef.absPath,
          newContent,
        });
      },
    },
  ];
}
