import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import type { ToolHandler } from '../../src/agent/tools/registry.js';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';
import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';
import { createSerialTools } from '../../src/agent/tools/serial-tools.js';
import { createVaultTools } from '../../src/agent/tools/vault.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';
import { runMigrations } from '../../src/storage/migrations/001-initial.js';

function tool(tools: ToolHandler[], name: string): ToolHandler {
  const found = tools.find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

function applyPendingEdit(edit: { path: string; newContent: string }): void {
  fs.mkdirSync(path.dirname(edit.path), { recursive: true });
  fs.writeFileSync(edit.path, edit.newContent, 'utf-8');
}

function relPath(vaultPath: string, absPath: string): string {
  const realVaultPath = fs.realpathSync(vaultPath);
  const realAbsPath = fs.existsSync(absPath) ? fs.realpathSync(absPath) : path.resolve(absPath);
  return path.relative(realVaultPath, realAbsPath).replace(/\\/g, '/');
}

function setupExistingProject(vaultPath: string, db: Database.Database): void {
  fs.mkdirSync(path.join(vaultPath, 'Projects', 'P001-CM'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, 'Projects', 'P001-CM', '_index.md'),
    matter.stringify('\n# Cell Migration\n', {
      note_kind: 'project',
      id: 'P001',
      prefix: 'CM',
      title: 'Cell Migration',
      status: 'active',
      created: '2026-05-06',
    })
  );
  db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM', 'P001');
  db.prepare('INSERT INTO serial_counters (scope, next_val, project_id) VALUES (?, 1, ?)').run('CM-S', 'P001');
}

function setupKnowledgeFolders(vaultPath: string): void {
  for (const folder of ['Concepts', 'Entities', 'Methods']) {
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', folder), { recursive: true });
  }
}

function setupExperimentSource(vaultPath: string, db: Database.Database): string {
  setupExistingProject(vaultPath, db);
  const sourcePath = path.join(vaultPath, 'Projects', 'P001-CM', 'CM001-scratch-assay.md');
  fs.writeFileSync(
    sourcePath,
    matter.stringify(
      '\n# Scratch Assay\n\n## Results\n\nWound closure increased after CXCL12 treatment.\n',
      {
        note_kind: 'experiment',
        id: 'CM001',
        project_id: 'P001',
        title: 'Scratch Assay',
        experiment_type: 'scratch-assay',
        status: 'complete',
        created: '2026-05-06',
      }
    )
  );
  return 'Projects/P001-CM/CM001-scratch-assay.md';
}

describe('CrickNote workflow scenarios', () => {
  let vaultPath: string;
  let db: Database.Database;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-workflow-'));
    fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
    db = new Database(':memory:');
    runMigrations(db);
    detector = new ConflictDetector();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  describe('project and experiment recording', () => {
    it('case 1: creates a project note with project metadata', async () => {
      const createProject = tool(createSerialTools(vaultPath, db), 'create_project');

      const result = JSON.parse(await createProject.execute({
        title: 'Cell Migration',
        prefix: 'CM',
        description: 'Track migration experiments and related readings.',
      }));

      expect(result.type).toBe('pending_edits');
      expect(result.edits).toHaveLength(2);

      const indexEdit = result.edits.find((edit: { operation: string }) => edit.operation === 'create_project');
      const readmeEdit = result.edits.find((edit: { operation: string }) => edit.operation === 'create_readme');
      expect(indexEdit.path).toMatch(/Projects\/P001-CellMigration\/_index\.md$/);
      expect(readmeEdit.path).toMatch(/Projects\/P001-CellMigration\/_README\.md$/);

      applyPendingEdit(indexEdit);
      applyPendingEdit(readmeEdit);

      const parsed = matter(fs.readFileSync(indexEdit.path, 'utf-8'));
      expect(parsed.data.note_kind).toBe('project');
      expect(parsed.data.id).toBe('P001');
      expect(parsed.data.prefix).toBe('CM');
      expect(parsed.data.description).toBe('Track migration experiments and related readings.');
      expect(parsed.content).toContain('## Experiment Log');
      expect(fs.existsSync(readmeEdit.path)).toBe(true);
    });

    it('case 2: creates an experiment note and appends a result observation', async () => {
      setupExistingProject(vaultPath, db);
      const createExperiment = tool(createSerialTools(vaultPath, db), 'create_experiment');

      const created = JSON.parse(await createExperiment.execute({
        project_id: 'P001',
        title: 'Scratch Assay Day 1',
        experiment_type: 'scratch-assay',
        samples: [
          { name: 'A549 control', condition: 'untreated' },
          { name: 'A549 CXCL12', condition: 'stimulated' },
        ],
        reagents: ['fibronectin', 'crystal violet'],
      }));

      expect(created.type).toBe('pending_edit');
      expect(created.operation).toBe('create_experiment');
      expect(created.path).toMatch(/Projects\/P001-CM\/CM001-scratch-assay-day-1\.md$/);
      applyPendingEdit(created);

      const append = tool(createVaultTools(vaultPath, detector), 'vault_append');
      const appended = JSON.parse(await append.execute({
        path: relPath(vaultPath, created.path),
        content: '## 2026-05-06 - Results\n\nWound closure reached 42% after 8 hours.',
      }));

      expect(appended.type).toBe('pending_edit');
      expect(appended.operation).toBe('append');
      expect(appended.newContent).toContain('Wound closure reached 42%');
      applyPendingEdit(appended);

      const parsed = matter(fs.readFileSync(created.path, 'utf-8'));
      expect(parsed.data.note_kind).toBe('experiment');
      expect(parsed.data.id).toBe('CM001');
      expect(parsed.data.project_id).toBe('P001');
      expect(parsed.data.samples).toHaveLength(2);
      expect(parsed.content).toContain('## 2026-05-06 - Results');
    });
  });

  describe('reading workflow', () => {
    it('case 1: discovers and ingests a reading bundle', async () => {
      const bundleDir = path.join(vaultPath, 'Reading', 'attachments', 'lee-2026-cd8');
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'notes.md'), 'Main finding: IL-42 reduced CD8 activation.');
      fs.writeFileSync(path.join(bundleDir, 'notebooklm-summary.md'), 'NotebookLM summary: suppression was dose dependent.');
      fs.writeFileSync(path.join(bundleDir, 'raw-data.csv'), 'condition,response\ncontrol,1.0\n');

      const tools = createReadingIntakeTools(vaultPath, detector);
      const discover = tool(tools, 'discover_reading_bundle');
      const ingest = tool(tools, 'ingest_reading_bundle');

      const discovery = JSON.parse(await discover.execute({ slug: 'lee-2026-cd8' }));
      expect(discovery.folder_exists).toBe(true);
      expect(discovery.recommended_sources).toEqual(expect.arrayContaining([
        { type: 'notes', path: 'notes.md' },
        { type: 'notebooklm', path: 'notebooklm-summary.md' },
      ]));
      expect(discovery.recommended_sources).toHaveLength(2);
      expect(discovery.warnings[0]).toContain('Unsupported bundle file');

      const ingested = JSON.parse(await ingest.execute({
        slug: 'lee-2026-cd8',
        title: 'CD8 response after IL-42 exposure',
        authors: ['A. Lee'],
        year: 2026,
        journal: 'Journal of Experimental Immunology',
        related_projects: ['P001'],
        sources: discovery.recommended_sources,
      }));

      expect(ingested.type).toBe('pending_edit');
      expect(ingested.operation).toBe('create');
      applyPendingEdit(ingested);

      const parsed = matter(fs.readFileSync(ingested.path, 'utf-8'));
      expect(parsed.data.status).toBe('draft');
      expect(parsed.data.kb_status).toBe('pending');
      expect(parsed.data.related_projects).toEqual(['P001']);
      expect(parsed.data.sources).toHaveLength(2);
      expect(parsed.content).toContain('## Claims');
      expect(parsed.content).toContain('## Evidence');
    });

    it('case 2: compiles a reading note by loading its source files', async () => {
      fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
      fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'lee-2026-cd8'), { recursive: true });
      fs.writeFileSync(
        path.join(vaultPath, 'Reading', 'attachments', 'lee-2026-cd8', 'notes.md'),
        'IL-42 reduced CD8 activation by 35% in the high-dose group.'
      );
      fs.writeFileSync(
        path.join(vaultPath, 'Reading', 'Papers', 'lee-2026-cd8.md'),
        matter.stringify(
          '\n# CD8 response after IL-42 exposure\n\n## Claims\n\n## Reasoning\n\n## Evidence\n\n## Assumptions\n\n## Takeaways\n\n## Extensions\n',
          {
            title: 'CD8 response after IL-42 exposure',
            status: 'draft',
            kb_status: 'pending',
            sources: [{ type: 'notes', path: 'notes.md' }],
          }
        )
      );

      const compile = tool(createKbTools(vaultPath), 'compile_reading_note');
      const result = JSON.parse(await compile.execute({ path: 'Reading/Papers/lee-2026-cd8.md' }));

      expect(result.sources_missing).toBe(false);
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].content).toContain('IL-42 reduced CD8 activation');
      expect(result.status).toBe('draft');
      expect(result.kb_status).toBe('pending');
      expect(result.next_step).toBe('ready_to_compile');
      expect(result.instruction).toContain('Draft the CREATE sections');
    });
  });

  describe('knowledge base creation', () => {
    it('case 1: creates a confirmed KB mapping from an experiment source', async () => {
      const source = setupExperimentSource(vaultPath, db);
      setupKnowledgeFolders(vaultPath);
      const kbTools = createKbTools(vaultPath);
      const writeMapping = tool(kbTools, 'kb_write_mapping');
      const apply = tool(kbTools, 'kb_apply');

      const mapping = JSON.parse(await writeMapping.execute({
        source,
        confirmed_targets: [{
          slug: 'cell-migration-speed',
          title: 'Cell Migration Speed',
          kind: 'Concepts',
          action: 'create',
          confidence: 'high',
          reason: 'The experiment reports a migration-speed result.',
        }],
        rejected_targets: [],
        source_hash: 'test-source-hash',
      }));

      expect(mapping.status).toBe('mapped');
      expect(mapping.targetCount).toBe(1);
      expect(fs.existsSync(path.join(vaultPath, mapping.artifactPath))).toBe(true);

      const nextTarget = JSON.parse(await apply.execute({ mapping: mapping.artifactPath }));
      expect(nextTarget.targetSlug).toBe('cell-migration-speed');
      expect(nextTarget.targetAction).toBe('create');
      expect(nextTarget.sourceContent).toContain('Wound closure increased');
      expect(nextTarget.targetContent).toContain('will be created');
    });

    it('case 2: finalizes a created KB note and rebuilds the KB index', async () => {
      const source = setupExperimentSource(vaultPath, db);
      setupKnowledgeFolders(vaultPath);
      const kbTools = createKbTools(vaultPath);
      const writeMapping = tool(kbTools, 'kb_write_mapping');
      const advance = tool(kbTools, 'kb_apply_advance');

      const mapping = JSON.parse(await writeMapping.execute({
        source,
        confirmed_targets: [{
          slug: 'cell-migration-speed',
          title: 'Cell Migration Speed',
          kind: 'Concepts',
          action: 'create',
          confidence: 'high',
          reason: 'The experiment reports a migration-speed result.',
        }],
        rejected_targets: [],
        source_hash: 'test-source-hash',
      }));

      fs.writeFileSync(
        path.join(vaultPath, 'Knowledge', 'Concepts', 'cell-migration-speed.md'),
        matter.stringify(
          '\n# Cell Migration Speed\n\n## Key Claims\n\n- [supports] CXCL12 increased wound closure in a scratch assay. [[CM001-scratch-assay]]\n',
          {
            title: 'Cell Migration Speed',
            aliases: ['motility rate'],
            compiled_from: ['CM001-scratch-assay'],
            last_updated: '2026-05-06',
          }
        )
      );

      const result = JSON.parse(await advance.execute({
        mapping: mapping.artifactPath,
        target_slug: 'cell-migration-speed',
        state: 'applied',
        contradiction_added: false,
        update_log: {
          updated: [],
          created: ['cell-migration-speed'],
          deferred: [],
        },
      }));

      expect(result.status).toBe('applied');
      expect(result.mappingStatus).toBe('applied');
      expect(result.remainingPending).toBe(0);

      const indexContent = fs.readFileSync(path.join(vaultPath, 'Knowledge', 'Concepts', '_index.md'), 'utf-8');
      expect(indexContent).toContain('[[cell-migration-speed|Cell Migration Speed]]');
      expect(indexContent).toContain('motility rate');

      const updateLogDir = path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs');
      const updateLogs = fs.readdirSync(updateLogDir).filter((file) => file.endsWith('.md'));
      expect(updateLogs).toHaveLength(1);
      expect(fs.readFileSync(path.join(updateLogDir, updateLogs[0]), 'utf-8')).toContain('- cell-migration-speed');
    });
  });
});
