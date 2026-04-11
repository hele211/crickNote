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
});
