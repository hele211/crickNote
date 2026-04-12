import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { autoWrite } from '../editing/auto-writer.js';
import { utcDateString, localDateString } from '../utils/date.js';

type KnowledgeKind = 'Concepts' | 'Entities' | 'Methods';

interface KnowledgeEntry {
  slug: string;
  title: string;
  aliases: string;
  lastUpdated: string;
  sourceCount: number;
}

function parseKnowledgeNote(absPath: string): KnowledgeEntry | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    const slug = path.basename(absPath, '.md');
    const title = typeof fm['title'] === 'string' ? fm['title'] : slug;
    const aliasesRaw = fm['aliases'];
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.join(', ') : '';
    const lastUpdated = typeof fm['last_updated'] === 'string'
      ? fm['last_updated']
      : fm['last_updated'] instanceof Date
        ? utcDateString(fm['last_updated'] as Date)
        : '';
    const compiledFrom = fm['compiled_from'];
    const sourceCount = Array.isArray(compiledFrom) ? compiledFrom.length : 0;
    return { slug, title, aliases, lastUpdated, sourceCount };
  } catch {
    return null;
  }
}

export function rebuildKnowledgeIndex(kind: KnowledgeKind, vaultPath: string): void {
  const dirPath = path.join(vaultPath, 'Knowledge', kind);
  fs.mkdirSync(dirPath, { recursive: true });

  const entries: KnowledgeEntry[] = [];
  for (const fname of fs.readdirSync(dirPath)) {
    if (!fname.endsWith('.md') || fname === '_index.md') continue;
    const entry = parseKnowledgeNote(path.join(dirPath, fname));
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const today = localDateString();
  const rows = entries.map(e => {
    const safeAliases = e.aliases.replace(/\|/g, '\\|');
    return `| [[${e.slug}|${e.title}]] | ${safeAliases} | ${e.lastUpdated} | ${e.sourceCount} |`;
  }).join('\n');

  const content = `---
type: index
folder: Knowledge/${kind}
last_updated: ${today}
---

# ${kind}

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
${rows}
`;

  const indexPath = path.join(vaultPath, 'Knowledge', kind, '_index.md');
  autoWrite(indexPath, content, vaultPath);
}
