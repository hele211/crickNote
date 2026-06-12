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

  it('task_list finds a task 30 days old (beyond the old 14-day window)', async () => {
    const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeDiary(d, '- [ ] old but open task');
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_list')!;
    const res = JSON.parse(await tool.execute({ status: 'pending' }));
    expect(res.some((t: { text: string }) => t.text.includes('old but open task'))).toBe(true);
  });

  it('task_add normalizes a natural-language deadline to ISO', async () => {
    const tools = createTaskTools(vault);
    const tool = tools.find(t => t.definition.name === 'task_add')!;
    const out = JSON.parse(await tool.execute({ description: 'order substrate', deadline: '2026-12-12' }));
    expect(out.type).toBe('pending_edit');
    expect(out.newContent).toContain('(due: 2026-12-12)');
  });
});
