import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemplateTools } from '../../src/agent/tools/templates.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';

describe('template tools', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-template-tools-'));
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('create_reading_note uses an absolute path and tracks overwrites', async () => {
    const realVaultPath = fs.realpathSync(vaultPath);
    const existingPath = path.join(realVaultPath, 'Reading', 'Papers', 'migration-paper.md');
    fs.writeFileSync(existingPath, '# Existing note\n', 'utf-8');

    const createReadingTool = createTemplateTools(vaultPath, detector)
      .find(tool => tool.definition.name === 'create_reading_note');
    const result = JSON.parse(await createReadingTool!.execute({
      title: 'Migration Paper',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2026,
      journal: 'Nature',
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.path).toBe(existingPath);
    expect(result.operation).toBe('update');
    expect(detector.getSnapshot(existingPath)?.content).toBe('# Existing note\n');
  });
});
