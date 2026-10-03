import fs from 'node:fs';
import matter from 'gray-matter';

import type { ToolHandler } from './registry.js';
import { lintReadingNote } from '../../knowledge/reading-note-lint.js';
import { resolveVaultPath } from '../../utils/paths.js';

const READING_NOTE_PATH = /^Reading\/(?:Papers|Threads)\/[^/]+\.md$/;
const NOT_A_NOTE = /(?:^|\/)_[^/]*\.md$|-mapping(?:-\d{8}T\d{6})?\.md$/;

// gray-matter runs "---js" frontmatter as code by default, and caches by content so a repeated malformed
// input silently parses to {}. A read-only checker must do neither: block the JS engines, and pass an
// options object (which also bypasses the cache).
const BLOCKED_ENGINE = {
  parse(): never {
    throw new Error('JavaScript frontmatter is not supported');
  },
};
const SAFE_MATTER_OPTIONS = { engines: { js: BLOCKED_ENGINE, javascript: BLOCKED_ENGINE } };

function sourcePaths(data: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(data.sources)) return undefined;
  return (data.sources as unknown[])
    .map((s) => (s && typeof s === 'object' ? (s as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === 'string');
}

function result(content: string, relPath?: string): string {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content, SAFE_MATTER_OPTIONS);
  } catch (err) {
    return JSON.stringify({ error: `Frontmatter could not be parsed: ${(err as Error).message}` });
  }
  const lint = lintReadingNote(parsed.content, { sources: sourcePaths(parsed.data) });
  const counts = {
    warn: lint.findings.filter((f) => f.severity === 'warn').length,
    info: lint.findings.filter((f) => f.severity === 'info').length,
  };
  return JSON.stringify({ ...(relPath ? { path: relPath } : {}), ok: lint.ok, counts, findings: lint.findings, stats: lint.stats });
}

export function createStyleLintTools(vaultPath: string): ToolHandler[] {
  return [
    {
      definition: {
        name: 'lint_reading_note',
        description:
          'Advisory, read-only style and structure check for a reading note (layout v2: TL;DR callout, Claims with C-IDs and locators, Reasoning, Evidence, Figure Map, ' +
          'Assumptions, Takeaways, Extensions). Returns findings (severity warn|info, line, message, fix) and stats. ' +
          'Fix `warn` findings in at most one corrective write; `info` findings are suggestions. A locator or ID that exists does not prove it supports the claim. ' +
          'Pass `path` (Reading/Papers or Reading/Threads note, checked on disk — call it after writing) or `body` (draft text), not both.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Reading note path under Reading/Papers/ or Reading/Threads/' },
            body: { type: 'string', description: 'Draft note text to lint instead of a file (frontmatter optional)' },
          },
        },
      },
      execute: async (args) => {
        const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
        const hasBody = typeof args.body === 'string';
        if (hasPath === hasBody) {
          return JSON.stringify({ error: 'Provide exactly one of path or body.' });
        }
        if (hasBody) return result(args.body as string);

        const relPath = (args.path as string).replace(/\\/g, '/').trim();
        if (!READING_NOTE_PATH.test(relPath) || NOT_A_NOTE.test(relPath)) {
          return JSON.stringify({ error: 'path must be a reading note under Reading/Papers/ or Reading/Threads/ (not a mapping artifact or _housekeeping file).' });
        }
        let absPath: string;
        try {
          absPath = resolveVaultPath(vaultPath, relPath);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
        if (!fs.existsSync(absPath)) {
          return JSON.stringify({ error: `File not found: ${relPath}` });
        }
        return result(fs.readFileSync(absPath, 'utf-8'), relPath);
      },
    },
  ];
}
