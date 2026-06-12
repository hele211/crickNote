import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskTools } from '../../src/agent/tools/tasks.js';

describe('task tools — window and deadline', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'task-'));
    fs.mkdirSync(path.join(vault, 'Memory', 'Daily'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

  function writeDiary(date: string, body: string) {
    fs.writeFileSync(path.join(vault, 'Memory', 'Daily', `${date}.md`), `---\ndate: ${date}\ntype: daily-diary\n---\n\n## Tasks\n${body}\n`);
  }

  it('task_list window actually controls how far back it scans', async () => {
    // Write 15 NEWER files (days 0–14) with no open tasks.
    for (let i = 0; i < 15; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      writeDiary(d, '- [x] already done');
    }
    // Write the target file at day 30 with an open task.
    const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeDiary(old, '- [ ] old but open task');

    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_list')!;

    // Default 90-day window: MUST find it.
    const resWide = JSON.parse(await tool.execute({ status: 'pending' }));
    expect(resWide.some((t: { text: string }) => t.text.includes('old but open task'))).toBe(true);

    // 10-day window: MUST NOT find it (proves the `days` param limits scanning).
    const resNarrow = JSON.parse(await tool.execute({ status: 'pending', days: 10 }));
    expect(resNarrow.some((t: { text: string }) => t.text.includes('old but open task'))).toBe(false);
  });

  it('task_add normalizes an ISO deadline', async () => {
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_add')!;
    const out = JSON.parse(await tool.execute({ description: 'order substrate', deadline: '2026-12-12' }));
    expect(out.type).toBe('pending_edit');
    expect(out.newContent).toContain('(due: 2026-12-12)');
  });

  it('task_add normalizes a natural-language deadline to ISO', async () => {
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_add')!;
    const out = JSON.parse(await tool.execute({ description: 'order substrate', deadline: 'December 12 2026' }));
    expect(out.newContent).toContain('(due: 2026-12-12)');
  });

  it('task_complete can complete a 30-day-old task', async () => {
    const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeDiary(d, '- [ ] finish the old assay');
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_complete')!;
    const out = JSON.parse(await tool.execute({ task_description: 'finish the old assay' }));
    expect(out.type).toBe('pending_edit');
    expect(out.newContent).toContain('- [x] finish the old assay');
  });
});
