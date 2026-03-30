import fs from 'node:fs';
import path from 'node:path';
import type { ToolHandler } from './registry.js';
import { localDateString } from '../../utils/date.js';

export function createTemplateTools(vaultPath: string): ToolHandler[] {
  return [
    {
      definition: {
        name: 'create_experiment',
        description: 'Create a new experiment note from template with structured frontmatter. Triggers safe edit flow.',
        parameters: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project folder name (e.g., "ProjectA-CellMigration")' },
            title: { type: 'string', description: 'Experiment title' },
            experiment_type: { type: 'string', description: 'Type of experiment (e.g., "western-blot", "pcr")' },
            protocol: { type: 'string', description: 'Protocol name to link (e.g., "western-blot-protocol")' },
            samples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  condition: { type: 'string' },
                },
              },
              description: 'List of samples with names and conditions',
            },
            reagents: { type: 'array', items: { type: 'string' }, description: 'Optional list of reagents' },
            objective: { type: 'string', description: 'Experiment objective' },
          },
          required: ['project', 'title', 'experiment_type', 'protocol', 'samples'],
        },
      },
      execute: async (args) => {
        const today = localDateString();
        const slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const fileName = `${today}-${slug}.md`;
        const notePath = `Projects/${args.project}/${fileName}`;

        // Ensure project directory exists
        const projectDir = path.join(vaultPath, 'Projects', args.project as string);
        fs.mkdirSync(path.join(projectDir, 'attachments'), { recursive: true });

        const samples = args.samples as Array<{ name: string; condition: string }>;
        const samplesYaml = samples.map(s => `  - name: "${s.name}"\n    condition: "${s.condition}"`).join('\n');

        const reagents = (args.reagents as string[] | undefined) ?? [];
        const reagentsYaml = reagents.length > 0
          ? `reagents:\n${reagents.map(r => `  - ${r}`).join('\n')}`
          : 'reagents: []';

        const content = `---
date: ${today}
project: ${args.project}
experiment_type: ${args.experiment_type}
protocol: "[[${args.protocol}]]"
samples:
${samplesYaml}
${reagentsYaml}
result_summary: ""
attachments: []
status: draft
tags: [${args.experiment_type}]
---

# ${args.title}

## Objective
${args.objective ?? 'TODO: Describe the objective of this experiment.'}

## Methods
Following [[${args.protocol}]] with the following modifications:
- TODO: List any modifications to the protocol

## Results
TODO: Record results here.

## Notes
TODO: Additional observations.
`;

        return JSON.stringify({
          type: 'pending_edit',
          path: notePath,
          newContent: content,
          operation: 'create',
        });
      },
    },
    {
      definition: {
        name: 'create_reading_note',
        description: 'Create a new literature/reading note from template. Triggers safe edit flow.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Paper title' },
            authors: { type: 'array', items: { type: 'string' }, description: 'Author names' },
            year: { type: 'number', description: 'Publication year' },
            journal: { type: 'string', description: 'Journal name' },
            doi: { type: 'string', description: 'DOI' },
            relevance: { type: 'string', description: 'Which project this is relevant to' },
            key_findings: { type: 'array', items: { type: 'string' }, description: 'Key findings from the paper' },
          },
          required: ['title', 'authors', 'year', 'journal'],
        },
      },
      execute: async (args) => {
        const today = localDateString();
        const firstAuthor = (args.authors as string[])[0].split(' ').pop()?.toLowerCase() ?? 'unknown';
        const slug = `${firstAuthor}-${args.year}-${(args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
        const notePath = `Reading/${slug}.md`;

        const authors = (args.authors as string[]).map(a => `"${a}"`).join(', ');
        const findings = (args.key_findings as string[] | undefined) ?? [];
        const findingsYaml = findings.length > 0
          ? `key_findings:\n${findings.map(f => `  - "${f}"`).join('\n')}`
          : 'key_findings: []';

        const content = `---
title: "${args.title}"
authors: [${authors}]
year: ${args.year}
journal: "${args.journal}"
doi: "${args.doi ?? ''}"
read_date: ${today}
relevance: "${args.relevance ?? ''}"
${findingsYaml}
tags: [reading]
---

# ${args.title}

**Authors:** ${(args.authors as string[]).join(', ')}
**Journal:** ${args.journal} (${args.year})
${args.doi ? `**DOI:** ${args.doi}` : ''}

## Summary
TODO: Write a brief summary of the paper.

## Key Findings
${findings.length > 0 ? findings.map(f => `- ${f}`).join('\n') : 'TODO: List key findings.'}

## Methods
TODO: Note relevant methods.

## Relevance to My Work
${args.relevance ? `Relevant to ${args.relevance}.` : 'TODO: How does this relate to your projects?'}

## Notes
TODO: Additional thoughts.
`;

        return JSON.stringify({
          type: 'pending_edit',
          path: notePath,
          newContent: content,
          operation: 'create',
        });
      },
    },
  ];
}
