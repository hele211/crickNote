import { describe, it, expect } from 'vitest';
import { classifyNote, parseNote } from '../../src/ingestion/parser.js';

describe('classifyNote — folder-readme', () => {
  it('classifies _README.md in a Projects subfolder as folder-readme', () => {
    const result = classifyNote('Projects/P001-CM/_README.md');
    expect(result.noteType).toBe('folder-readme');
    expect(result.folder).toBe('Projects');
  });

  it('classifies _README.md directly under Projects/ root as folder-readme', () => {
    const result = classifyNote('Projects/_README.md');
    expect(result.noteType).toBe('folder-readme');
    expect(result.folder).toBe('Projects');
  });

  it('classifies _README.md in a Reading subfolder as folder-readme', () => {
    const result = classifyNote('Reading/Papers/_README.md');
    expect(result.noteType).toBe('folder-readme');
    expect(result.folder).toBe('Reading');
  });

  it('classifies _README.md in a Knowledge subfolder as folder-readme', () => {
    const result = classifyNote('Knowledge/Concepts/_README.md');
    expect(result.noteType).toBe('folder-readme');
    expect(result.folder).toBe('Knowledge');
  });

  it('classifies _README.md in Knowledge/Review-Queue/ as folder-readme (basename check wins over path switch)', () => {
    const result = classifyNote('Knowledge/Review-Queue/_README.md');
    expect(result.noteType).toBe('folder-readme');
  });

  it('does not classify _README.md as experiment', () => {
    const result = classifyNote('Projects/P001-CM/_README.md');
    expect(result.noteType).not.toBe('experiment');
    expect(result.noteType).not.toBe('project-index');
  });

  it('still classifies a normal experiment file correctly', () => {
    const result = classifyNote('Projects/P001-CM/CM001-western-blot.md');
    expect(result.noteType).toBe('experiment');
  });

  it('classifies _README.md via note_kind frontmatter as folder-readme', () => {
    const result = classifyNote('Projects/P001-CM/_README.md', 'folder-readme');
    expect(result.noteType).toBe('folder-readme');
  });

  it('classifyNote with conflicting note_kind (experiment) still returns folder-readme — basename wins', () => {
    const result = classifyNote('Projects/P001-CM/_README.md', 'experiment');
    expect(result.noteType).toBe('folder-readme');
  });
});

describe('parseNote — folder-readme', () => {
  it('parseNote produces noteType folder-readme for _README.md', () => {
    const content = `---\nnote_kind: folder-readme\nstatus: active\n---\n# My Project\n`;
    const result = parseNote('Projects/P001-CM/_README.md', content);
    expect(result.noteType).toBe('folder-readme');
    expect(result.folder).toBe('Projects');
    expect(result.isValid).toBe(true);
  });

  it('parseNote path-classifies _README.md without frontmatter note_kind', () => {
    const content = `---\nstatus: active\n---\n# My Project\n`;
    const result = parseNote('Projects/P001-CM/_README.md', content);
    expect(result.noteType).toBe('folder-readme');
  });

  it('parseNote with conflicting note_kind frontmatter still classifies as folder-readme — basename wins', () => {
    const content = `---\nnote_kind: experiment\nstatus: active\n---\n# My Project\n`;
    const result = parseNote('Projects/P001-CM/_README.md', content);
    expect(result.noteType).toBe('folder-readme');
  });
});
