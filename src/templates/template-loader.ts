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
  | 'reading-thread'
  | 'folder-readme';

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
  'folder-readme':  'folder-readme.md',
};

const PROTECTED_FIELDS: Record<TemplateKind, string[]> = {
  'experiment':     ['note_kind', 'id', 'project_id', 'title', 'experiment_type', 'samples', 'reagents', 'status', 'created', 'attachments', 'protocol', 'series'],
  'project-index':  ['note_kind', 'id', 'prefix', 'title', 'status', 'created', 'description'],
  'series':         ['note_kind', 'id', 'project_id', 'title', 'objective', 'status', 'created'],
  'protocol':       ['note_kind', 'id', 'title', 'version', 'category', 'created', 'last_updated', 'derived_from'],
  'reading-paper':  ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
  'reading-thread': ['title', 'authors', 'year', 'journal', 'read_date', 'status', 'kb_status', 'related_projects', 'tags', 'doi', 'sources'],
  'folder-readme':  ['note_kind', 'created'],
};

interface TemplateContract {
  requiredBodyMarkers?: string[];
  requiredHeadings?: string[];
}

const TEMPLATE_CONTRACTS: Record<TemplateKind, TemplateContract> = {
  'experiment':     {},
  'folder-readme':  {},
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
  'folder-readme': (ctx) => {
    const title = ctx.title ?? '';
    return `\n# ${title}\n\n## Goal\n\n## Hypothesis\n\n## Current Status\n\n## Key Findings\n\n## Open Questions\n`;
  },
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

export interface LoadResult {
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

// Step 2: Validate

function validateTemplate(
  kind: TemplateKind,
  templateFrontmatter: Record<string, unknown>,
  templateBody: string,
  warnings: string[],
): Error | null {
  const contract = TEMPLATE_CONTRACTS[kind];
  const protectedFields = PROTECTED_FIELDS[kind];

  // template_version checks
  if (templateFrontmatter.template_version === undefined || templateFrontmatter.template_version === null) {
    warnings.push('Template has no version; may be outdated');
  } else if (
    typeof templateFrontmatter.template_version === 'number'
    && templateFrontmatter.template_version < CURRENT_CONTRACT_VERSION
  ) {
    warnings.push(`Template version ${templateFrontmatter.template_version} may be missing required sections`);
  }

  // Protected field collision warnings
  for (const field of protectedFields) {
    if (field in templateFrontmatter) {
      warnings.push(`Template field '${field}' was ignored - CrickNote owns it.`);
    }
  }

  // Required AUTO-GENERATED markers
  if (contract.requiredBodyMarkers) {
    for (const marker of contract.requiredBodyMarkers) {
      if (!templateBody.includes(marker)) {
        return new Error(`Template for '${kind}' is missing required marker: ${marker}`);
      }
    }
  }

  // Required headings
  if (contract.requiredHeadings) {
    for (const heading of contract.requiredHeadings) {
      if (!new RegExp(`^## ${heading}\\s*$`, 'm').test(templateBody)) {
        return new Error(`Template for '${kind}' is missing required heading: ## ${heading}`);
      }
    }
  }

  return null;
}

// Step 3: Merge

function mergeTemplate(
  kind: TemplateKind,
  templateFrontmatter: Record<string, unknown>,
  protectedFrontmatter: Record<string, unknown>,
): Record<string, unknown> {
  const protectedFields = PROTECTED_FIELDS[kind];

  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(templateFrontmatter)) {
    if (key === 'template_version') continue;
    if (key === 'cricknote_template') continue; // loader-managed; never taken from template
    if (!protectedFields.includes(key)) {
      customFields[key] = value;
    }
  }

  const merged: Record<string, unknown> = { ...customFields, ...protectedFrontmatter };

  if (kind === 'reading-paper' || kind === 'reading-thread') {
    merged.cricknote_template = kind;
  }

  return merged;
}

// Step 4: Substitute

function substituteBody(
  body: string,
  context: Record<string, string>,
  warnings: string[],
): string {
  const warned = new Set<string>();
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (Object.hasOwn(context, key)) return context[key];
    if (!warned.has(key)) {
      warned.add(key);
      warnings.push(`Template contains unknown placeholder {{${key}}} - left unchanged.`);
    }
    return match;
  });
}

// Public API

export function loadAndValidateTemplate(
  vaultPath: string,
  kind: TemplateKind,
  placeholderContext: Record<string, string>,
): LoadResult | Error {
  const loadResult = loadTemplate(vaultPath, kind, placeholderContext);
  if (loadResult instanceof Error) return loadResult;
  if (loadResult.templateUsed === 'file') {
    const err = validateTemplate(kind, loadResult.templateFrontmatter, loadResult.templateBody, loadResult.warnings);
    if (err) return err;
  }
  return loadResult;
}

export async function renderNoteTemplate({
  vaultPath,
  kind,
  protectedFrontmatter,
  context,
  preloadedTemplate,
}: {
  vaultPath: string;
  kind: TemplateKind;
  protectedFrontmatter: Record<string, unknown>;
  context: Record<string, string>;
  preloadedTemplate?: LoadResult;
}): Promise<RenderResult> {
  let templateFrontmatter: Record<string, unknown>;
  let templateBody: string;
  let templateUsed: 'file' | 'builtin';
  const warnings: string[] = [];

  if (preloadedTemplate) {
    ({ templateFrontmatter, templateBody, templateUsed } = preloadedTemplate);
    // Structural warnings (version, protected-field collisions, missing-templates) were already
    // collected by loadAndValidateTemplate; copy them directly to avoid emitting them twice.
    warnings.push(...preloadedTemplate.warnings);
  } else {
    const loadResult = loadTemplate(vaultPath, kind, context);
    if (loadResult instanceof Error) throw loadResult;
    ({ templateFrontmatter, templateBody, templateUsed } = loadResult);
    warnings.push(...loadResult.warnings);
    if (templateUsed === 'file') {
      const err = validateTemplate(kind, templateFrontmatter, templateBody, warnings);
      if (err) throw err;
    }
  }

  const frontmatter = mergeTemplate(kind, templateFrontmatter, protectedFrontmatter);
  const body = substituteBody(templateBody, context, warnings);
  return { frontmatter, body, warnings, templateUsed };
}

// Default template content (used by setup scaffolding)

export const DEFAULT_TEMPLATE_FILES: Record<string, string> = {
  'experiment.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, project_id, title, experiment_type,
# samples, reagents, status, created, attachments,
# protocol (if provided), series (if provided)

# Add your own fields below:
cell_line:
passage_number:
linked_paper:
---

# {{title}}

## {{date}} - Initial Setup

## Hypothesis

## Materials

## Protocol Steps

## Observations

## Results

## Next Steps
`,

  'project-index.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, prefix, title, status, created,
# description (if provided)

# Add your own fields below:
pi_name:
grant_id:
---

<!-- AUTO-GENERATED: experiment-log -->
## Experiment Log
| Series | ID | Name | Status | Created |
|--------|-----|------|--------|---------|
<!-- END AUTO-GENERATED: experiment-log -->

<!-- AUTO-GENERATED: project-summary -->
## Project Summary
(auto-updated)
<!-- END AUTO-GENERATED: project-summary -->

## Related Knowledge Concepts

## Related Reading

## Related Protocols

## Open Questions
`,

  'series.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, project_id, title, objective, status, created

# Add your own fields below:
---

# {{title}}

## Objective
{{objective}}

<!-- AUTO-GENERATED: experiment-list -->
## Experiments
| ID | Name | Status | Created |
|----|------|--------|---------|
<!-- END AUTO-GENERATED: experiment-list -->

## Summary
`,

  'protocol.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, id, title, version, category, created, last_updated,
# derived_from (if provided)

# Add your own fields below:
equipment:
safety_notes:
---

# {{title}}

## Materials

## Procedure

## Notes

## Troubleshooting
`,

  'reading-paper.md': `---
template_version: 1

# CrickNote automatically adds:
# title, authors, year, journal, read_date,
# status, kb_status, tags, doi, sources,
# cricknote_template

# Add your own fields below:
lab_relevance:
---

# {{title}}

## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
`,

  'reading-thread.md': `---
template_version: 1

# CrickNote automatically adds:
# title, authors, year, journal, read_date,
# status, kb_status, tags, doi, sources,
# cricknote_template

# Add your own fields below:
thread_topic:
---

# {{title}}

## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
`,

  'folder-readme.md': `---
template_version: 1

# CrickNote automatically adds:
# note_kind, created

# Add your own fields below:
status: active
pi_name:
---

# {{title}}

## Goal

## Hypothesis

## Current Status

## Key Findings

## Open Questions
`,

  'README.md': `# CrickNote Templates

Edit these files to customize note layout for your lab.

## What you control

- **Body:** Add, rename, or reorder sections. Keep the sections CrickNote requires (see below).
- **Custom frontmatter fields:** Add any YAML fields below the comment line in each template. They appear in every note of that type.

## What CrickNote controls

Each template has a comment block listing fields CrickNote writes automatically.
Do not add these as YAML keys - they will be ignored.

## Required sections (do not remove)

### \`project-index.md\` and \`series.md\`
These comment markers must stay in the body - CrickNote uses them for automated updates:
- \`<!-- AUTO-GENERATED: experiment-log -->\` / \`<!-- END AUTO-GENERATED: experiment-log -->\`
- \`<!-- AUTO-GENERATED: project-summary -->\` / \`<!-- END AUTO-GENERATED: project-summary -->\`
- \`<!-- AUTO-GENERATED: experiment-list -->\` / \`<!-- END AUTO-GENERATED: experiment-list -->\`

### \`reading-paper.md\` and \`reading-thread.md\`
These six headings must stay - they drive the KB pipeline:
\`\`\`
## Claims
## Reasoning
## Evidence
## Assumptions
## Takeaways
## Extensions
\`\`\`

## Placeholders

| Placeholder | Available in |
|-------------|-------------|
| \`{{title}}\` | All kinds |
| \`{{date}}\` | experiment, project-index |
| \`{{id}}\` | experiment, project-index, series, protocol |
| \`{{prefix}}\` | project-index |
| \`{{project_id}}\` | experiment, series |
| \`{{objective}}\` | series |

## What happens when templates have problems

| Situation | Behaviour |
|-----------|-----------|
| \`Agent/templates/\` folder missing | Built-in template used; warning shown |
| Template file absent | Built-in template used; warning shown |
| Template file has invalid YAML | Note creation stops; error reported |
| Template defines a CrickNote-owned field | Field ignored; warning shown |
| Required section missing | Note creation stops; error reported |
| Unknown placeholder \`{{xyz}}\` | Left as-is; warning shown |
`,
};
