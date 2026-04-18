import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';

describe('compile_reading_note', () => {
  let vaultPath: string;
  let tool: ReturnType<typeof createKbTools>[0];

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tools-test-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    tool = createKbTools(vaultPath)[0];
  });

  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('returns error for non-existent note', async () => {
    const result = JSON.parse(await tool.execute({ path: 'Reading/Papers/missing.md' }));
    expect(result.error).toContain('not found');
  });

  it('returns warning when note has no sources', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\ntitle: IL-42\n---\n\nBody content.\n'
    );
    const result = JSON.parse(await tool.execute({ path: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.warnings[0]).toContain('No sources');
    expect(result.sources).toHaveLength(0);
    expect(result.sources_missing).toBe(true);
    expect(result.next_step).toBe('needs_sources');
  });

  it('loads sources and returns status hints when sources present', async () => {
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      'IL-42 suppresses CD8 by 40%.'
    );
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      '---\ntitle: IL-42\nstatus: draft\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n---\n\n# IL-42\n\n## Claims\n\n## Reasoning\n\n## Evidence\n\n## Assumptions\n\n## Takeaways\n\n## Extensions\n'
    );
    const result = JSON.parse(await tool.execute({ path: 'Reading/Papers/smith-2026-il42.md' }));
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toContain('IL-42 suppresses');
    expect(result.status).toBe('draft');
    expect(result.kb_status).toBe('pending');
    expect(result.has_create_headings).toBe(true);
    expect(result.sources_missing).toBe(false);
    expect(result.next_step).toBe('ready_to_compile');
    expect(result.instruction).toContain('CREATE sections');
  });

  it('returns error for invalid/traversal path', async () => {
    const result = JSON.parse(await tool.execute({ path: '../../../etc/passwd' }));
    expect(result.error).toBeDefined();
  });
});
