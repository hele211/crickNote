import fs from 'node:fs';
import matter from 'gray-matter';
import { autoWrite } from '../editing/auto-writer.js';

export type MappingTargetState = 'pending' | 'applied' | 'skipped' | 'deferred';
export type MappingTargetKind = 'Concepts' | 'Entities' | 'Methods';
export type MappingTargetAction = 'create' | 'update';
export type MappingTargetConfidence = 'high' | 'medium' | 'low';

export interface MappingArtifactTarget {
  slug: string;
  title?: string;
  kind?: MappingTargetKind;
  action: MappingTargetAction;
  state: MappingTargetState;
  confidence?: MappingTargetConfidence;
  reason?: string;
  reviewQueue?: string;
  updated?: string;
}

export interface MappingArtifact {
  schemaVersion: 1 | 2;
  source: string;
  sourceSlug: string;
  sourcePath?: string;
  sourceHash?: string;
  created: string;
  status: 'draft' | 'confirmed' | 'applied';
  targets: MappingArtifactTarget[];
  rejected: Array<{ slug: string; reason?: string }>;
  warnings?: string[];
}

export function normalizeMappingSource(value: unknown): { source: string; sourceSlug: string } {
  let raw: string;
  if (Array.isArray(value)) {
    const inner = value[0];
    raw = Array.isArray(inner) ? String(inner[0] ?? '') : String(inner ?? '');
  } else {
    raw = String(value ?? '');
  }
  const slug = raw.replace(/^\[\[|\]\]$/g, '').trim();
  if (!slug) return { source: '', sourceSlug: '' };
  return { source: `[[${slug}]]`, sourceSlug: slug };
}

// Internal — used only by readMappingArtifact for schema v1 fallback.
// Not deleted until all fallback tests pass.
function parseMappingTargets(body: string): MappingArtifactTarget[] {
  const targets: MappingArtifactTarget[] = [];
  const sectionMatch = body.match(/## Targets\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!sectionMatch) return targets;
  for (const line of sectionMatch[1].split('\n')) {
    if (!line.includes('[[')) continue;
    const collapsed = line.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, '[[$1]]');
    const cells = collapsed.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 5) continue;
    const slugMatch = cells[0].match(/\[\[([^\]]+)\]\]/);
    if (!slugMatch) continue;
    const slug = slugMatch[1].trim();
    if (!slug) continue;
    targets.push({
      slug,
      action: cells[1].trim() as MappingTargetAction,
      state: cells[2].trim() as MappingTargetState,
      reviewQueue: cells[3].trim() || undefined,
      updated: cells[4].trim() || undefined,
    });
  }
  return targets;
}

export function readMappingArtifact(absPath: string): MappingArtifact {
  const raw = fs.readFileSync(absPath, 'utf-8');
  const parsed = matter(raw);
  const fm = parsed.data;

  const { source, sourceSlug } = normalizeMappingSource(fm['source']);
  const isV2 = fm['schema_version'] === 2 && Array.isArray(fm['targets']);

  let targets: MappingArtifactTarget[];
  const schemaVersion: 1 | 2 = isV2 ? 2 : 1;

  if (isV2) {
    targets = (fm['targets'] as unknown[]).map((t: unknown) => {
      const tgt = t as Record<string, unknown>;
      return {
        slug: String(tgt['slug'] ?? ''),
        title: tgt['title'] != null ? String(tgt['title']) : undefined,
        kind: tgt['kind'] as MappingTargetKind | undefined,
        action: String(tgt['action'] ?? 'update') as MappingTargetAction,
        state: String(tgt['state'] ?? 'pending') as MappingTargetState,
        confidence: tgt['confidence'] as MappingTargetConfidence | undefined,
        reason: tgt['reason'] != null ? String(tgt['reason']) : undefined,
        reviewQueue: tgt['review_queue'] != null ? String(tgt['review_queue']) : undefined,
        updated: tgt['updated'] != null ? String(tgt['updated']) : undefined,
      };
    });
  } else {
    targets = parseMappingTargets(parsed.content);
  }

  const fmRejected = fm['rejected'];
  const rejected: MappingArtifact['rejected'] = Array.isArray(fmRejected)
    ? (fmRejected as unknown[]).map((r: unknown) => {
        if (typeof r === 'object' && r !== null) {
          const obj = r as Record<string, unknown>;
          return { slug: String(obj['slug'] ?? ''), reason: obj['reason'] != null ? String(obj['reason']) : undefined };
        }
        return { slug: String(r) };
      })
    : [];

  return {
    schemaVersion,
    source,
    sourceSlug,
    sourcePath: fm['source_path'] != null ? String(fm['source_path']) : undefined,
    sourceHash: fm['source_hash'] != null ? String(fm['source_hash']) : undefined,
    created: String(fm['created'] ?? new Date().toISOString().slice(0, 10)),
    status: (fm['status'] as MappingArtifact['status']) ?? 'confirmed',
    targets,
    rejected,
    warnings: Array.isArray(fm['warnings']) ? (fm['warnings'] as unknown[]).map(String) : undefined,
  };
}
