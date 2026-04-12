// tests/unit/kb-tools-lint.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

function setup(): { vaultPath: string; tools: ReturnType<typeof createKbTools> } {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kbl-test-'));
  for (const d of [
    'Knowledge/Concepts', 'Knowledge/Entities', 'Knowledge/Methods',
    'Knowledge/Review-Queue', 'Knowledge/_Ops/Lint-Reports',
    'Reading/Papers',
  ]) {
    fs.mkdirSync(path.join(vaultPath, d), { recursive: true });
  }
  const tools = createKbTools(vaultPath);
  return { vaultPath, tools };
}

describe('kb_lint — check 1: no compiled_from', () => {
  it('flags a knowledge note with no compiled_from', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'orphan.md'), `---
type: knowledge
knowledge_kind: concept
title: Orphan Concept
compiled_from: []
---
# Orphan
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('orphan') && i.includes('compiled_from'))).toBe(true);
  });
});

describe('kb_lint — check 2: unsourced claim bullet', () => {
  it('flags a claim bullet without a source link', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', 'concept.md'), `---
type: knowledge
knowledge_kind: concept
title: Test Concept
compiled_from: ["[[smith-2026]]"]
---
# Test
## Key Claims
- [supports] IL-42 suppresses CD8. <!-- no wikilink -->
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.urgent.some((i: string) => i.includes('concept') && i.includes('claim'))).toBe(true);
  });
});

describe('kb_lint — check 4: unfinished kb work', () => {
  it('flags reading note status:complete + kb_status:pending', async () => {
    const { vaultPath, tools } = setup();
    fs.writeFileSync(path.join(vaultPath, 'Reading', 'Papers', 'pending-paper.md'), `---
title: Pending Paper
status: complete
kb_status: pending
---
`);
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.needsAttention.some((i: string) => i.includes('pending-paper'))).toBe(true);
  });
});

describe('kb_lint — writes report to Lint-Reports/', () => {
  it('creates a dated lint report file', async () => {
    const { vaultPath, tools } = setup();
    const tool = tools.find(t => t.definition.name === 'kb_lint')!;
    await tool.execute({});
    const reports = fs.readdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Lint-Reports'));
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  });
});
