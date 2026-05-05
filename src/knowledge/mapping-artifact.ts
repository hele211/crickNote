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
