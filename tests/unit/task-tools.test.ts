import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskTools } from '../../src/agent/tools/tasks.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';
import { localDateString } from '../../src/utils/date.js';

describe('task tools', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-task-tools-'));
    fs.mkdirSync(path.join(vaultPath, 'Memory', 'Daily'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('task_add returns an absolute pending edit path and records a snapshot for existing notes', async () => {
    const today = localDateString();
    const realVaultPath = fs.realpathSync(vaultPath);
    const diaryPath = path.join(realVaultPath, 'Memory', 'Daily', `${today}.md`);
    fs.writeFileSync(diaryPath, `# ${today}\n\n## Tasks\n- [ ] Existing task\n`, 'utf-8');

    const addTool = createTaskTools(vaultPath, detector).find(tool => tool.definition.name === 'task_add');
    const result = JSON.parse(await addTool!.execute({ description: 'Run gel electrophoresis' }));

    expect(result.type).toBe('pending_edit');
    expect(result.path).toBe(diaryPath);
    expect(result.operation).toBe('update');
    expect(result.newContent).toContain('Run gel electrophoresis');
    expect(detector.getSnapshot(diaryPath)?.content).toContain('Existing task');
  });

  it('task_complete returns an absolute pending edit path and records a snapshot', async () => {
    const today = localDateString();
    const realVaultPath = fs.realpathSync(vaultPath);
    const diaryPath = path.join(realVaultPath, 'Memory', 'Daily', `${today}.md`);
    fs.writeFileSync(diaryPath, `# ${today}\n\n## Tasks\n- [ ] Run PCR for ProjectB samples\n`, 'utf-8');

    const completeTool = createTaskTools(vaultPath, detector).find(tool => tool.definition.name === 'task_complete');
    const result = JSON.parse(await completeTool!.execute({ task_description: 'PCR' }));

    expect(result.type).toBe('pending_edit');
    expect(result.path).toBe(diaryPath);
    expect(result.operation).toBe('update');
    expect(result.newContent).toContain('- [x] Run PCR for ProjectB samples');
    expect(detector.getSnapshot(diaryPath)?.content).toContain('Run PCR for ProjectB samples');
  });

  function writeDiary(date: string, body: string): void {
    fs.writeFileSync(path.join(vaultPath, 'Memory', 'Daily', `${date}.md`), body, 'utf-8');
  }

  function isoOffset(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return localDateString(d);
  }

  it('task_agenda buckets pending tasks by deadline and ignores completed/beyond-horizon ones', async () => {
    const today = localDateString();
    writeDiary('2026-01-01', [
      '## Tasks',
      `- [ ] Overdue thing (due: ${isoOffset(-3)})`,
      `- [ ] Due today thing (due: ${today})`,
      `- [ ] Soon thing (due: ${isoOffset(3)})`,
      `- [ ] Far future thing (due: ${isoOffset(30)})`,
      '- [ ] Someday thing',
      `- [x] Done thing (due: ${isoOffset(-1)})`,
      '',
    ].join('\n'));

    const agendaTool = createTaskTools(vaultPath, detector).find(t => t.definition.name === 'task_agenda');
    const res = JSON.parse(await agendaTool!.execute({}));

    expect(res.date).toBe(today);
    expect(res.overdue.map((i: { text: string }) => i.text)).toEqual([expect.stringContaining('Overdue thing')]);
    expect(res.today.map((i: { text: string }) => i.text)).toEqual([expect.stringContaining('Due today thing')]);
    expect(res.soon.map((i: { text: string }) => i.text)).toEqual([expect.stringContaining('Soon thing')]);
    expect(res.no_deadline.map((i: { text: string }) => i.text)).toEqual([expect.stringContaining('Someday thing')]);
    // Far-future (beyond 7d) and completed tasks appear in no bucket.
    const allTexts = [...res.overdue, ...res.today, ...res.soon, ...res.no_deadline].map((i: { text: string }) => i.text).join('|');
    expect(allTexts).not.toContain('Far future thing');
    expect(allTexts).not.toContain('Done thing');
  });

  it('task_agenda write=true returns a pending edit for Memory/Agenda.md', async () => {
    const today = localDateString();
    const realVaultPath = fs.realpathSync(vaultPath);
    writeDiary('2026-01-01', `## Tasks\n- [ ] Ship the report (due: ${today})\n`);

    const agendaTool = createTaskTools(vaultPath, detector).find(t => t.definition.name === 'task_agenda');
    const res = JSON.parse(await agendaTool!.execute({ write: true }));

    expect(res.type).toBe('pending_edit');
    expect(res.path).toBe(path.join(realVaultPath, 'Memory', 'Agenda.md'));
    expect(res.operation).toBe('create');
    expect(res.newContent).toContain("# Today's Agenda");
    expect(res.newContent).toContain('## Due today');
    expect(res.newContent).toContain('Ship the report');
    // Agenda bullets must never be task checkboxes (would pollute task_list).
    expect(res.newContent).not.toContain('- [ ]');
  });

  it('task_agenda honors a custom horizon_days window', async () => {
    writeDiary('2026-01-01', `## Tasks\n- [ ] Two weeks out (due: ${isoOffset(10)})\n`);
    const agendaTool = createTaskTools(vaultPath, detector).find(t => t.definition.name === 'task_agenda');

    const narrow = JSON.parse(await agendaTool!.execute({ horizon_days: 7 }));
    expect(narrow.soon).toHaveLength(0);

    const wide = JSON.parse(await agendaTool!.execute({ horizon_days: 14 }));
    expect(wide.soon.map((i: { text: string }) => i.text)).toEqual([expect.stringContaining('Two weeks out')]);
  });
});
