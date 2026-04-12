import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildKnowledgeIndex } from '../../src/knowledge/index-builder.js';

const CONCEPT_A = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk]
last_updated: 2026-04-08
compiled_from:
  - "[[smith-2026]]"
  - "[[CM003]]"
---
`;

const CONCEPT_B = `---
type: knowledge
knowledge_kind: concept
title: T-cell Suppression
aliases: [T cell inhibition]
last_updated: 2026-04-05
compiled_from:
  - "[[jones-2025]]"
---
`;

describe('rebuildKnowledgeIndex', () => {
  let vaultPath: string;
  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_A);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 't-cell-suppression.md'), CONCEPT_B);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('creates _index.md with correct frontmatter', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    expect(idx).toContain('type: index');
    expect(idx).toContain('folder: Knowledge/Concepts');
  });

  it('includes all concept notes sorted by title (case-insensitive)', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    const cdPos = idx.indexOf('cd4-cd8-interaction');
    const tPos = idx.indexOf('t-cell-suppression');
    expect(cdPos).toBeLessThan(tPos);
  });

  it('includes alias and source count columns', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    expect(idx).toContain('cd4 cd8 crosstalk');
    expect(idx).toContain('| 2 |');
  });

  it('excludes _index.md itself from the table', () => {
    rebuildKnowledgeIndex('Concepts', vaultPath);
    const idx = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
    const occurrences = (idx.match(/_index/g) || []).length;
    expect(occurrences).toBe(0);
  });
});
