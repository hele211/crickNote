import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMappingSource, readMappingArtifact } from '../../src/knowledge/mapping-artifact.js';

describe('normalizeMappingSource', () => {
  it('handles clean [[slug]] wikilink', () => {
    expect(normalizeMappingSource('[[smith-2026-il42]]')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles plain string slug', () => {
    expect(normalizeMappingSource('smith-2026-il42')).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles nested array [["slug"]] (malformed old format)', () => {
    expect(normalizeMappingSource([['smith-2026-il42']])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('handles single-level array ["slug"]', () => {
    expect(normalizeMappingSource(['smith-2026-il42'])).toEqual({
      source: '[[smith-2026-il42]]',
      sourceSlug: 'smith-2026-il42',
    });
  });

  it('returns empty strings for null/undefined', () => {
    expect(normalizeMappingSource(null)).toEqual({ source: '', sourceSlug: '' });
    expect(normalizeMappingSource(undefined)).toEqual({ source: '', sourceSlug: '' });
  });
});

const V1_ARTIFACT = `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | pending | | |

## Rejected
(none)
`;

const V2_ARTIFACT = `---
type: kb-mapping
schema_version: 2
source: "[[smith-2026-il42]]"
source_hash: "sha256abc"
created: 2026-04-08
status: confirmed
targets:
  - slug: tirtl-seq
    kind: Methods
    action: create
    state: pending
    confidence: high
    reason: Main method
rejected: []
---

## Targets

| Target | Kind | Action | State | Confidence | Reason | Review-Queue | Updated |
|--------|------|--------|-------|------------|--------|--------------|---------|
| [[WRONG-TABLE]] | Methods | create | pending | high | Wrong | | |
`;

describe('readMappingArtifact', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads schema v1 table-only artifact and returns schemaVersion 1', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V1_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.sourceSlug).toBe('smith-2026-il42');
    expect(artifact.targets).toHaveLength(1);
    expect(artifact.targets[0].slug).toBe('cd4-cd8-interaction');
    expect(artifact.targets[0].state).toBe('pending');
    expect(artifact.created).toBe('2026-04-08');
  });

  it('reads schema v2 frontmatter as canonical, ignores table content', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V2_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.sourceHash).toBe('sha256abc');
    expect(artifact.targets).toHaveLength(1);
    expect(artifact.targets[0].slug).toBe('tirtl-seq');
    expect(artifact.targets[0].kind).toBe('Methods');
    expect(artifact.targets[0].confidence).toBe('high');
  });

  it('schema v2 frontmatter wins when table disagrees', () => {
    const p = path.join(tmpDir, 'test-mapping.md');
    fs.writeFileSync(p, V2_ARTIFACT);
    const artifact = readMappingArtifact(p);
    expect(artifact.targets.every(t => t.slug !== 'WRONG-TABLE')).toBe(true);
    expect(artifact.targets[0].slug).toBe('tirtl-seq');
  });

  it('reads schema v2 with empty targets array (valid draft)', () => {
    const content = `---\ntype: kb-mapping\nschema_version: 2\nsource: "[[slug]]"\ncreated: 2026-05-05\nstatus: draft\ntargets: []\nrejected: []\n---\n\n## Targets\n`;
    const p = path.join(tmpDir, 'empty-mapping.md');
    fs.writeFileSync(p, content);
    const artifact = readMappingArtifact(p);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.targets).toHaveLength(0);
  });

  it('throws if file does not exist', () => {
    expect(() => readMappingArtifact('/nonexistent/path.md')).toThrow();
  });
});
