// tests/unit/kb-tools-apply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';
import { readMappingArtifact } from '../../src/knowledge/mapping-artifact.js';

const SOURCE_NOTE = `---
title: IL-42 mediated suppression
kb_status: mapped
status: complete
---

## Claims
IL-42 suppresses CD8 by 40%.
`;

const CONCEPT_NOTE = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk]
last_updated: 2026-04-01
compiled_from: []
needs_review: false
---

## Current View
Some prior synthesis.

## Key Claims

## Contradictions and Caveats
`;

const MAPPING = (targetState = 'pending') => `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | ${targetState} | | |

## Rejected
(none)
`;

describe('kb_apply tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kba-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), SOURCE_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), MAPPING());
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_apply returns source content + first pending target', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
    expect(result.targetSlug).toBe('cd4-cd8-interaction');
  });

  it('kb_apply reports all_done when no pending targets remain', async () => {
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'), MAPPING('applied'));
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({ mapping: 'Reading/Papers/smith-2026-il42-mapping.md' }));
    expect(result.status).toBe('all_done');
  });

  it('kb_apply finds experiment source note in Projects/ subdirectory', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'),
      SOURCE_NOTE
    );
    const expMapping = `---
type: kb-mapping
source: [[CM003-qpcr]]
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
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      expMapping
    );
    const tool = tools.find(t => t.definition.name === 'kb_apply')!;
    const result = JSON.parse(await tool.execute({
      mapping: 'Projects/P001-CellMigration/CM003-qpcr-mapping.md',
    }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetSlug).toBe('cd4-cd8-interaction');
  });

  it('kb_apply_advance marks target applied in mapping artifact', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: false,
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
    });
    const updated = readMappingArtifact(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'));
    expect(updated.targets[0].slug).toBe('cd4-cd8-interaction');
    expect(updated.targets[0].state).toBe('applied');
    expect(updated.schemaVersion).toBe(2);
  });

  it('kb_apply_advance sets kb_status=merged when all targets done', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: false,
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
    });
    const source = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(source).toContain('kb_status: merged');
  });

  it('kb_apply_advance creates Review-Queue note on deferred state', async () => {
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'deferred',
      contradiction_added: false,
      review_queue_title: 'IL-42 suppression conflict',
      review_queue_reason: 'ambiguous-relationship',
      review_queue_body: 'Smith 2026 reports 40% suppression...',
      update_log: { updated: [], created: [], deferred: ['[[cd4-cd8-interaction]]'] },
    });
    const rqFiles = fs.readdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'));
    expect(rqFiles.length).toBe(1);
    expect(rqFiles[0]).toContain('cd4-cd8-interaction');
  });

  it('kb_apply_advance sets needs_review=true when contradiction_added', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    await tool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: true,
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
    });
    const concept = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), 'utf-8');
    expect(concept).toContain('needs_review: true');
  });

  it('kb_apply_advance migrates v1 artifact to v2 on write', async () => {
    const advanceTool = tools.find(t => t.definition.name === 'kb_apply_advance')!;
    const result = JSON.parse(await advanceTool.execute({
      mapping: 'Reading/Papers/smith-2026-il42-mapping.md',
      target_slug: 'cd4-cd8-interaction',
      state: 'applied',
      contradiction_added: false,
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], deferred: [] },
    }));

    expect(result.status).toBe('applied');
    const written = readMappingArtifact(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'));
    expect(written.schemaVersion).toBe(2);
    expect(written.targets[0].slug).toBe('cd4-cd8-interaction');
    expect(written.targets[0].state).toBe('applied');
  });
});

describe('kb_apply_direct tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbad-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), SOURCE_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'), CONCEPT_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_apply_direct returns source and target content', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    const result = JSON.parse(await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
    }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
  });

  it('kb_apply_direct does NOT change kb_status on reading notes', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], notes: '' },
    });
    // kb_status must remain 'mapped' (not changed to merged)
    const source = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(source).toContain('kb_status: mapped');
  });

  it('kb_apply_direct writes an Update Log', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_apply_direct')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      target: 'Knowledge/Concepts/cd4-cd8-interaction.md',
      update_log: { updated: ['[[cd4-cd8-interaction]]'], created: [], notes: 'added claim' },
    });
    const logs = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'));
    expect(logs.length).toBe(1);
  });
});

describe('kb_resolve_review tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbrr-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Review-Queue'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      SOURCE_NOTE.replace('kb_status: mapped', 'kb_status: merged_with_review')
    );
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'),
      CONCEPT_NOTE.replace('needs_review: false', 'needs_review: true')
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', '2026-04-08-cd4-cd8-interaction.md'),
      `---
type: review-queue
source: [[smith-2026-il42]]
target_concept: [[cd4-cd8-interaction]]
reason: ambiguous-relationship
created: 2026-04-08
status: pending
rq_source: smith-2026-il42
rq_target: cd4-cd8-interaction
---

# IL-42 conflict
`
    );
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_resolve_review returns the Review-Queue note and target for LLM', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    const result = JSON.parse(await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
    }));
    expect(result.reviewContent).toContain('IL-42 conflict');
    expect(result.targetContent).toContain('CD4-CD8 Interaction');
  });

  it('kb_resolve_review returns error if resolution given without confirmed_knowledge_write', async () => {
    // Safety guard: resolution must not be applied before user confirms the vault_write diff
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    const result = JSON.parse(await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
      // confirmed_knowledge_write intentionally omitted — should return error
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain('confirmed_knowledge_write');
  });

  it('kb_resolve_review marks item resolved and clears needs_review when last item', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
      confirmed_knowledge_write: true,
    });
    const rq = fs.readFileSync(
      path.join(vaultPath, 'Knowledge', 'Review-Queue', '2026-04-08-cd4-cd8-interaction.md'),
      'utf-8'
    );
    expect(rq).toContain('status: resolved');

    const concept = fs.readFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'cd4-cd8-interaction.md'),
      'utf-8'
    );
    expect(concept).toContain('needs_review: false');
  });

  it('kb_resolve_review updates mapping artifact row from deferred to applied', async () => {
    // Set up a mapping artifact with a deferred row for this target
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      `---
type: kb-mapping
source: [[smith-2026-il42]]
created: 2026-04-08
status: confirmed
---

## Targets

| Target | Action | State | Review-Queue | Updated |
|--------|--------|-------|--------------|---------|
| [[cd4-cd8-interaction]] | update | deferred | [[2026-04-08-cd4-cd8-interaction]] | |

## Rejected
(none)
`
    );
    const tool = tools.find(t => t.definition.name === 'kb_resolve_review')!;
    await tool.execute({
      review_item: 'Knowledge/Review-Queue/2026-04-08-cd4-cd8-interaction.md',
      resolution: 'resolved',
      resolution_summary: 'Cell-line effect confirmed.',
      confirmed_knowledge_write: true,
    });
    const mapping = readMappingArtifact(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md')
    );
    expect(mapping.schemaVersion).toBe(2);
    expect(mapping.targets[0].slug).toBe('cd4-cd8-interaction');
    expect(mapping.targets[0].state).toBe('applied');
  });
});
