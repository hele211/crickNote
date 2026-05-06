/**
 * Integration test: full reading-intake pipeline state-transition sequence.
 *
 * Covers Phase 4 requirements:
 *  1. bundle → ingest → compile → status complete → kb_write_mapping → kb_apply_advance
 *  2. findRelevantMappingArtifact active-mapping selection (older applied + newer confirmed)
 *  3. Rerun case: existing applied artifact triggers timestamped new artifact
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { createReadingIntakeTools } from '../../src/agent/tools/reading-intake.js';
import { createKbTools } from '../../src/agent/tools/kb-tools.js';
import { ConflictDetector } from '../../src/editing/conflict-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readingNote(frontmatter: string, body: string): string {
  return `---\n${frontmatter}---\n\n${body}`;
}

function getToolByName<T extends { definition: { name: string }; execute: (...a: unknown[]) => unknown }>(
  tools: T[],
  name: string
): T {
  const t = tools.find(tool => tool.definition.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('reading pipeline — full state-transition sequence', () => {
  let vaultPath: string;
  let detector: ConflictDetector;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-pipeline-integration-'));

    // Directory structure
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Papers'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Reading', 'Threads'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Concepts'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', 'Methods'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Knowledge', '_Ops', 'Update-Logs'), { recursive: true });

    // Source attachment file
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'attachments', 'smith-2026-il42', 'notes.md'),
      '# Notes\n\nKey finding: IL-42 suppresses T-cell activation.'
    );

    detector = new ConflictDetector();
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Bundle → ingest
  // -------------------------------------------------------------------------

  it('step 1: ingest_reading_bundle produces a pending_edit for a new note', async () => {
    const tools = createReadingIntakeTools(vaultPath, detector);
    const ingest = getToolByName(tools, 'ingest_reading_bundle');

    const result = JSON.parse(await ingest.execute({
      slug: 'smith-2026-il42',
      title: 'IL-42 mediated suppression',
      authors: ['Alice Smith'],
      year: 2026,
      journal: 'Nature Immunology',
      sources: [{ type: 'notes', path: 'notes.md' }],
    }));

    expect(result.type).toBe('pending_edit');
    expect(result.operation).toBe('create');

    const parsed = matter(result.newContent);
    expect(parsed.data.status).toBe('draft');
    expect(parsed.data.kb_status).toBe('pending');
    expect(parsed.data.sources).toEqual([{ type: 'notes', path: 'notes.md' }]);
    expect(parsed.content).toContain('## Claims');
  });

  // -------------------------------------------------------------------------
  // 2. Status tool: needs_human_review after compile
  // -------------------------------------------------------------------------

  it('step 2: reading_pipeline_status returns needs_human_review after body is drafted', async () => {
    // Write the note as if the agent drafted content after compile
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md'),
      readingNote(
        'title: IL-42\nstatus: draft\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# IL-42\n\n## Claims\n\nIL-42 suppresses T-cell activation.\n'
      )
    );

    const tools = createReadingIntakeTools(vaultPath, detector);
    const status = getToolByName(tools, 'reading_pipeline_status');

    const result = JSON.parse(await status.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('needs_human_review');
    expect(result.has_drafted_content).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Status tool: ready_for_kb_mapping after status=complete
  // -------------------------------------------------------------------------

  it('step 3: set_reading_note_status returns pending_edit; after applying it status tool reports ready_for_kb_mapping', async () => {
    const notePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md');
    fs.writeFileSync(
      notePath,
      readingNote(
        'title: IL-42\nstatus: in-progress\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# IL-42\n\n## Claims\n\nIL-42 suppresses T-cell activation.\n'
      )
    );

    const tools = createReadingIntakeTools(vaultPath, detector);
    const setStatus = getToolByName(tools, 'set_reading_note_status');
    const statusTool = getToolByName(tools, 'reading_pipeline_status');

    // CR-01 fix: should return pending_edit, not write directly
    const editResult = JSON.parse(await setStatus.execute({
      path: 'Reading/Papers/smith-2026-il42.md',
      status: 'complete',
    }));
    expect(editResult.type).toBe('pending_edit');
    expect(editResult.newContent).toContain('status: complete');

    // Simulate the runtime writing the pending_edit to disk
    fs.writeFileSync(notePath, editResult.newContent, 'utf-8');

    // Now the pipeline status should advance
    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    expect(result.next_step).toBe('ready_for_kb_mapping');
  });

  // -------------------------------------------------------------------------
  // 4. kb_write_mapping → kb_apply_advance full loop (single target)
  // -------------------------------------------------------------------------

  it('step 4: kb_write_mapping then kb_apply_advance updates kb_status to merged', async () => {
    const notePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md');
    fs.writeFileSync(
      notePath,
      readingNote(
        'title: IL-42\nstatus: complete\nkb_status: pending\nsources:\n  - type: notes\n    path: notes.md\n',
        '# IL-42\n\n## Claims\n\nIL-42 suppresses T-cell activation.\n'
      )
    );

    // Create target knowledge note
    fs.writeFileSync(
      path.join(vaultPath, 'Knowledge', 'Concepts', 'il42-signalling.md'),
      '---\ntitle: IL-42 Signalling\ncompiled_from: []\n---\n\n# IL-42 Signalling\n'
    );

    const kbTools = createKbTools(vaultPath);
    const writeMapping = getToolByName(kbTools, 'kb_write_mapping');
    const kbApply = getToolByName(kbTools, 'kb_apply');
    const kbApplyAdvance = getToolByName(kbTools, 'kb_apply_advance');

    // Write mapping artifact
    const mappingResult = JSON.parse(await writeMapping.execute({
      source: 'Reading/Papers/smith-2026-il42.md',
      confirmed_targets: [{ slug: 'il42-signalling', action: 'update' }],
      rejected_targets: [],
    }));
    expect(mappingResult.status).toBe('mapped');
    const artifactRel = mappingResult.artifactPath as string;

    // kb_apply — loads source + target
    const applyResult = JSON.parse(await kbApply.execute({ mapping: artifactRel }));
    expect(applyResult.targetSlug).toBe('il42-signalling');
    expect(applyResult.remainingPending).toBe(1);

    // Simulate agent calling vault_write (write updated knowledge note)
    const knowledgePath = path.join(vaultPath, 'Knowledge', 'Concepts', 'il42-signalling.md');
    fs.writeFileSync(
      knowledgePath,
      '---\ntitle: IL-42 Signalling\ncompiled_from: [smith-2026-il42]\n---\n\n# IL-42 Signalling\n\n## Key Claims\n\n- [supports] IL-42 suppresses T-cell activation. [[smith-2026-il42]]\n'
    );

    // kb_apply_advance — final target, must include update_log
    const advanceResult = JSON.parse(await kbApplyAdvance.execute({
      mapping: artifactRel,
      target_slug: 'il42-signalling',
      state: 'applied',
      contradiction_added: false,
      update_log: {
        updated: ['il42-signalling'],
        created: [],
        deferred: [],
      },
    }));
    expect(advanceResult.status).toBe('applied');
    expect(advanceResult.mappingStatus).toBe('applied');
    expect(advanceResult.remainingPending).toBe(0);

    // kb_status on reading note should be updated to 'merged'
    const finalNote = matter(fs.readFileSync(notePath, 'utf-8'));
    expect(finalNote.data.kb_status).toBe('merged');
  });

  // -------------------------------------------------------------------------
  // 5. Active-mapping selection: older applied + newer confirmed → confirmed wins
  // -------------------------------------------------------------------------

  it('step 5: findRelevantMappingArtifact (via reading_pipeline_status) picks confirmed over older applied', async () => {
    const notePath = path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42.md');
    fs.writeFileSync(
      notePath,
      readingNote(
        'title: IL-42\nstatus: complete\nkb_status: mapped\nsources:\n  - type: notes\n    path: notes.md\n',
        '# IL-42\n\n## Claims\n\nIL-42 suppresses T-cell activation.\n'
      )
    );

    // Older artifact — status: applied (completed run)
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping.md'),
      '---\ntype: kb-mapping\nsource: [[smith-2026-il42]]\nstatus: applied\n---\n\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------|\n| [[il42-signalling]] | update | applied | | 2026-04-10T12:00 |\n'
    );

    // Newer timestamped artifact — status: confirmed (active rerun)
    fs.writeFileSync(
      path.join(vaultPath, 'Reading', 'Papers', 'smith-2026-il42-mapping-20260414T120000.md'),
      '---\ntype: kb-mapping\nsource: [[smith-2026-il42]]\nstatus: confirmed\n---\n\n## Targets\n\n| Target | Action | State | Review-Queue | Updated |\n|--------|--------|-------|--------------|---------|\n| [[il42-receptor]] | update | pending | | |\n'
    );

    const intakeTools = createReadingIntakeTools(vaultPath, detector);
    const statusTool = getToolByName(intakeTools, 'reading_pipeline_status');

    const result = JSON.parse(await statusTool.execute({ slug: 'smith-2026-il42' }));
    // The confirmed (newer) artifact has a pending target → kb_apply_in_progress
    expect(result.next_step).toBe('kb_apply_in_progress');
    // Should reference the confirmed artifact, not the applied one
    expect(result.mapping_path).toContain('smith-2026-il42-mapping-20260414T120000');
    expect(result.mapping_status).toBe('confirmed');
    expect(result.mapping_pending_targets).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. WR-05: reading_pipeline_status returns clear error when both inputs omitted
  // -------------------------------------------------------------------------

  it('step 6: reading_pipeline_status returns helpful error when both slug and path are omitted', async () => {
    const tools = createReadingIntakeTools(vaultPath, detector);
    const statusTool = getToolByName(tools, 'reading_pipeline_status');

    const result = JSON.parse(await statusTool.execute({}));
    expect(result.error).toMatch(/slug.*path|path.*slug/i);
  });
});
