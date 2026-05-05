// tests/unit/kb-tools-suggest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

const READING_NOTE = `---
title: IL-42 mediated suppression
authors: [Smith]
year: 2026
journal: Nature Immunology
read_date: 2026-04-06
status: complete
kb_status: pending
---

## Claims
IL-42 suppresses CD8 T-cells by 40% in Jurkat cells.

## Reasoning
Western blot assay used.
`;

const CONCEPT_INDEX = `---
type: index
folder: Knowledge/Concepts
last_updated: 2026-04-08
---

# Concepts

| Title | Aliases | Last Updated | Sources |
|-------|---------|--------------|---------|
| [[cd4-cd8-interaction]] | cd4 cd8 crosstalk | 2026-04-08 | 2 |
`;

describe('kb_suggest tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), READING_NOTE);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), CONCEPT_INDEX);
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Entities', '_index.md'), '---\ntype: index\n---\n\n# Entities\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|');
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Methods', '_index.md'), '---\ntype: index\n---\n\n# Methods\n\n| Title | Aliases | Last Updated | Sources |\n|-------|---------|--------------|---------|');
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('kb_suggest returns source content and all three indexes', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.sourceContent).toContain('IL-42 suppresses');
    expect(result.indexes.Concepts).toContain('cd4-cd8-interaction');
    expect(result.instruction).toContain('PROPOSED KNOWLEDGE UPDATES');
  });

  it('kb_suggest errors on missing file', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/missing.md' }));
    expect(result.error).toBeDefined();
  });

  it('kb_suggest instruction requires vault_search as STEP 1', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.instruction).toContain('vault_search');
    expect(result.instruction).toContain('STEP 1');
  });

  it('kb_suggest returns already_suggested when source_hash matches existing artifact', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_suggest')!;
    const sourcePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex');

    // Write an existing confirmed artifact with matching hash
    const artifactContent = `---\ntype: kb-mapping\nschema_version: 2\nsource: "[[smith-2026-il42]]"\nsource_hash: "${sourceHash}"\ncreated: 2026-04-08\nstatus: confirmed\ntargets: []\nrejected: []\n---\n`;
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      artifactContent
    );

    const result = JSON.parse(await tool.execute({ source: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.status).toBe('already_suggested');
    expect(result.mappingStatus).toBe('confirmed');
    expect(result.artifactPath).toContain('smith-2026-il42-mapping.md');
  });
});

describe('kb_write_mapping tool', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwm-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), READING_NOTE);
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('writes confirmed mapping artifact alongside source note', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const artifact = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    expect(fs.existsSync(artifact)).toBe(true);
    const content = fs.readFileSync(artifact, 'utf-8');
    expect(content).toContain('status: confirmed');
    expect(content).toContain('cd4-cd8-interaction');
  });

  it('sets kb_status to mapped on source reading note', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const updated = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(updated).toContain('kb_status: mapped');
  });

  it('sets kb_status to skipped when no targets confirmed', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [],
      rejected_targets: [{ slug: 'cd4-cd8-interaction', reason: 'no new insight' }],
    });
    const updated = fs.readFileSync(path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'), 'utf-8');
    expect(updated).toContain('kb_status: skipped');
    const artifact = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md');
    expect(fs.existsSync(artifact)).toBe(false);
  });

  it('confirmed collision returns already_in_progress', async () => {
    // Write a pre-existing confirmed (in-progress) mapping artifact
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      '---\nstatus: confirmed\n---\n\n## Targets\n'
    );
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    }));
    expect(result.status).toBe('already_in_progress');
  });
});

describe('kb_write_mapping — experiment note paths (no kb_status)', () => {
  let vaultPath: string;
  let tools: ReturnType<typeof createKbTools>;
  const EXPERIMENT_NOTE = `---
title: CM003-qpcr results
id: CM003
---

## Results
IL-42 suppresses CD8 by 40%.
`;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwm-exp-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CellMigration'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'),
      EXPERIMENT_NOTE
    );
    tools = createKbTools(vaultPath);
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('experiment source with confirmed targets writes mapping artifact but NOT kb_status', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    });
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    // kb_status must NOT be written at all — experiment notes don't use kb_status
    expect(updated).not.toContain('kb_status:');
    // Mapping artifact should still be created
    expect(fs.existsSync(path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'))).toBe(true);
  });

  it('experiment source with zero targets does not throw and does not write kb_status', async () => {
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [],
      rejected_targets: [],
    }));
    expect(result.status).toBe('skipped');
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    expect(updated).not.toContain('kb_status:');
  });

  it('applied collision returns needs_confirmation without rerun_confirmed', async () => {
    // Write a pre-existing applied mapping artifact
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      '---\nstatus: applied\n---\n\n## Targets\n'
    );
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
    }));
    expect(result.status).toBe('needs_confirmation');
  });

  it('rerun_confirmed creates timestamped artifact without touching experiment frontmatter', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr-mapping.md'),
      '---\nstatus: applied\n---\n\n## Targets\n'
    );
    const tool = tools.find(t => t.definition.name === 'kb_write_mapping')!;
    const result = JSON.parse(await tool.execute({
      source: 'Projects/P001-CellMigration/CM003-qpcr.md',
      confirmed_targets: [{ slug: 'cd4-cd8-interaction', action: 'update' }],
      rejected_targets: [],
      rerun_confirmed: true,
    }));
    expect(result.status).toBe('mapped');
    expect(result.artifactPath).toMatch(/CM003-qpcr-mapping-\d+/);
    const updated = fs.readFileSync(
      path.join(vaultPath, 'Projects', 'P001-CellMigration', 'CM003-qpcr.md'), 'utf-8'
    );
    expect(updated).not.toContain('kb_status: mapped');
  });
});
