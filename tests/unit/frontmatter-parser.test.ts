import { describe, it, expect } from 'vitest';
import { parseNote, classifyNote } from '../../src/ingestion/parser.js';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = path.resolve(__dirname, '../fixtures/sample-vault');

describe('parseNote', () => {
  it('parses a valid experiment note with all fields', () => {
    const filePath = 'Projects/ProjectA-CellMigration/2026-03-24-western-blot.md';
    const content = fs.readFileSync(path.join(FIXTURES, filePath), 'utf-8');

    const result = parseNote(filePath, content);

    expect(result.noteType).toBe('experiment');
    expect(result.folder).toBe('Projects');
    expect(result.date).toBe('2026-03-24');
    expect(result.project).toBe('ProjectA-CellMigration');
    expect(result.experimentType).toBe('western-blot');
    expect(result.status).toBe('complete');
    expect(result.tags).toContain('western-blot');
    expect(result.tags).toContain('p53');
    expect(result.resultSummary).toBeDefined();
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.body).toContain('# Western Blot');
  });

  it('logs a validation warning when required field (date) is missing', () => {
    const content = [
      '---',
      'project: ProjectA',
      'experiment_type: pcr',
      'status: draft',
      '---',
      '# Some Experiment',
    ].join('\n');

    const result = parseNote('Projects/ProjectA/missing-date.md', content);

    expect(result.isValid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    const dateWarning = result.warnings.find(w => w.field === 'date');
    expect(dateWarning).toBeDefined();
    expect(dateWarning!.message).toContain('date');
  });

  it('parses a valid protocol note with correct type', () => {
    const filePath = 'Protocols/western-blot-protocol.md';
    const content = fs.readFileSync(path.join(FIXTURES, filePath), 'utf-8');

    const result = parseNote(filePath, content);

    expect(result.noteType).toBe('protocol');
    expect(result.folder).toBe('Protocols');
    expect(result.frontmatter['title']).toBe('Western Blot Protocol');
    expect(result.frontmatter['version']).toBe(2.1);
    expect(result.isValid).toBe(true);
  });

  it('handles malformed YAML gracefully', () => {
    const content = [
      '---',
      'date: [invalid yaml',
      'this is: not: valid: yaml:',
      '---',
      '# Body Content',
    ].join('\n');

    // Should not throw
    const result = parseNote('Projects/ProjectA/malformed.md', content);
    expect(result.body).toBeDefined();
    expect(result.noteType).toBe('experiment');
  });

  it('returns an empty warnings array for unknown note type', () => {
    const content = [
      '---',
      'title: Random Note',
      '---',
      'Some content.',
    ].join('\n');

    const result = parseNote('Other/random.md', content);
    expect(result.noteType).toBe('unknown');
    expect(result.warnings).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });
});

describe('classifyNote', () => {
  it('classifies Projects/ as experiment', () => {
    expect(classifyNote('Projects/A/note.md').noteType).toBe('experiment');
  });

  it('classifies Protocols/ as protocol', () => {
    expect(classifyNote('Protocols/my-protocol.md').noteType).toBe('protocol');
  });

  it('classifies Reading/ as reading', () => {
    expect(classifyNote('Reading/paper.md').noteType).toBe('reading');
  });

  it('classifies Memory/ as diary', () => {
    expect(classifyNote('Memory/Daily/2026-03-29.md').noteType).toBe('diary');
  });

  it('classifies Agent/ as agent', () => {
    expect(classifyNote('Agent/agent.md').noteType).toBe('agent');
  });

  it('classifies unknown folder as unknown', () => {
    const result = classifyNote('Misc/something.md');
    expect(result.noteType).toBe('unknown');
    expect(result.folder).toBe('Misc');
  });
});
