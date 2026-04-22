import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { buildCreateReadingBody } from '../knowledge/reading-note.js';

// Public types

export type TemplateKind =
  | 'experiment'
  | 'project-index'
  | 'series'
  | 'protocol'
  | 'reading-paper'
  | 'reading-thread';

export interface RenderResult {
  frontmatter: Record<string, unknown>;
  body: string;
  warnings: string[];
  templateUsed: 'file' | 'builtin';
}

// Internal constants

const TEMPLATE_FILE_BY_KIND: Record<TemplateKind, string> = {
  'experiment':     'experiment.md',
  'project-index':  'project-index.md',
  'series':         'series.md',
  'protocol':       'protocol.md',
  'reading-paper':  'reading-paper.md',
  'reading-thread': 'reading-thread.md',
};

const PROTECTED_FIELDS: Record<TemplateKind, string[]> = {
  'experiment':     ['note_kind', 'id', 'project_id', 'title', 'experiment_type', 'samples', 'reagents', 'status', 'created', 'attachments', 'protocol', 'series'],
  'project-index':  ['note_kind', 'id', 'prefix', 'title', 'status', 'created', 'description'],
  'series':         ['note_kind', 'id', 'project_id', 'title', 'objective', 'status', 'created'],
  'protocol':       ['note_kind', 'id', 'title', 'version', 'category', 'created', 'last_updated', 'derived_from'],
  'reading-paper':  ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
  'reading-thread': ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
};

interface TemplateContract {
  requiredBodyMarkers?: string[];
  requiredHeadings?: string[];
}

const TEMPLATE_CONTRACTS: Record<TemplateKind, TemplateContract> = {
  'experiment':     {},
  'project-index':  {
    requiredBodyMarkers: [
      '<!-- AUTO-GENERATED: experiment-log -->',
      '<!-- END AUTO-GENERATED: experiment-log -->',
      '<!-- AUTO-GENERATED: project-summary -->',
      '<!-- END AUTO-GENERATED: project-summary -->',
    ],
  },
  'series':         {
    requiredBodyMarkers: [
      '<!-- AUTO-GENERATED: experiment-list -->',
      '<!-- END AUTO-GENERATED: experiment-list -->',
    ],
  },
  'protocol':       {},
  'reading-paper':  {
    requiredHeadings: ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions'],
  },
  'reading-thread': {
    requiredHeadings: ['Claims', 'Reasoning', 'Evidence', 'Assumptions', 'Takeaways', 'Extensions'],
  },
};

const CURRENT_CONTRACT_VERSION = 1;

const DEFAULT_BODY_RENDERERS: Record<TemplateKind, (ctx: Record<string, string>) => string> = {
  'experiment': (ctx) => {
    const today = ctx.date ?? new Date().toISOString().slice(0, 10);
    const title = ctx.title ?? '';
    return `\n# ${title}\n\n## ${today} - Initial Setup\n\nTODO: Record experiment here.\n`;
  },
  'project-index': (_ctx) =>
    '\n<!-- AUTO-GENERATED: experiment-log -->\n## Experiment Log\n| Series | ID | Name | Status | Created |\n|--------|-----|------|--------|----------|\n<!-- END AUTO-GENERATED: experiment-log -->\n\n<!-- AUTO-GENERATED: project-summary -->\n## Project Summary\n(auto-updated)\n<!-- END AUTO-GENERATED: project-summary -->\n\n## Related Knowledge Concepts\n\n## Related Reading\n\n## Related Protocols\n\n## Open Questions\n',
  'series': (ctx) => {
    const title = ctx.title ?? '';
    const objective = ctx.objective ?? 'TODO';
    return `\n# ${title}\n\n## Objective\n${objective}\n\n<!-- AUTO-GENERATED: experiment-list -->\n## Experiments\n| ID | Name | Status | Created |\n|----|------|--------|----------|\n\n<!-- END AUTO-GENERATED: experiment-list -->\n\n## Summary\n`;
  },
  'protocol': (ctx) => {
    const title = ctx.title ?? '';
    return `\n# ${title}\n\n## Materials\n\n## Procedure\n\n## Notes\n`;
  },
  // Delegate to the canonical scaffold builder — single source of truth for the 6-heading structure
  'reading-paper':  (ctx) => buildCreateReadingBody({ title: ctx.title ?? '' }),
  'reading-thread': (ctx) => buildCreateReadingBody({ title: ctx.title ?? '' }),
};

// Step 1: Load

const MISSING_TEMPLATES_WARNING =
  "Editable templates are missing; built-in template used. Re-run setup or wait for 'cricknote templates init' in a later release.";

interface LoadResult {
  templateFrontmatter: Record<string, unknown>;
  templateBody: string;
  templateUsed: 'file' | 'builtin';
  warnings: string[];
}

function loadTemplate(
  vaultPath: string,
  kind: TemplateKind,
  context: Record<string, string>,
): LoadResult | Error {
  const templatesDir = path.join(vaultPath, 'Agent', 'templates');

  if (!fs.existsSync(templatesDir)) {
    const builtinKind = kind === 'reading-thread' ? 'reading-paper' : kind;
    return {
      templateFrontmatter: {},
      templateBody: DEFAULT_BODY_RENDERERS[builtinKind](context),
      templateUsed: 'builtin',
      warnings: [MISSING_TEMPLATES_WARNING],
    };
  }

  // Build candidate list — reading-thread falls back to reading-paper.md
  const candidates: string[] = [TEMPLATE_FILE_BY_KIND[kind]];
  if (kind === 'reading-thread') {
    candidates.push(TEMPLATE_FILE_BY_KIND['reading-paper']);
  }

  let chosenPath: string | null = null;
  for (const candidate of candidates) {
    const p = path.join(templatesDir, candidate);
    if (fs.existsSync(p)) {
      chosenPath = p;
      break;
    }
  }

  if (!chosenPath) {
    const builtinKind = kind === 'reading-thread' ? 'reading-paper' : kind;
    return {
      templateFrontmatter: {},
      templateBody: DEFAULT_BODY_RENDERERS[builtinKind](context),
      templateUsed: 'builtin',
      warnings: [MISSING_TEMPLATES_WARNING],
    };
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(chosenPath, 'utf-8');
  } catch (err) {
    return new Error(
      `Failed to read template ${path.basename(chosenPath)}: ${(err as Error).message}`,
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawContent);
  } catch (err) {
    return new Error(
      `Template ${path.basename(chosenPath)} has invalid YAML frontmatter: ${(err as Error).message}`,
    );
  }

  return {
    templateFrontmatter: parsed.data as Record<string, unknown>,
    templateBody: parsed.content,
    templateUsed: 'file',
    warnings: [],
  };
}

// Public API (Validate/Merge/Substitute added in later tasks)

export async function renderNoteTemplate({
  vaultPath,
  kind,
  protectedFrontmatter,
  context,
}: {
  vaultPath: string;
  kind: TemplateKind;
  protectedFrontmatter: Record<string, unknown>;
  context: Record<string, string>;
}): Promise<RenderResult> {
  // Step 1: Load
  const loadResult = loadTemplate(vaultPath, kind, context);
  if (loadResult instanceof Error) throw loadResult;

  const { templateBody, templateUsed, warnings } = loadResult;

  // Steps 2-4 (Validate, Merge, Substitute) wired in Tasks 3 and 4
  return {
    frontmatter: { ...protectedFrontmatter },
    body: templateBody,
    warnings,
    templateUsed,
  };
}
