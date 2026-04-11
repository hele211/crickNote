// tests/unit/parser-serial.test.ts
import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/ingestion/parser.js';

describe('parseNote — serial fields and note_kind-first classification', () => {
  it('uses note_kind frontmatter as primary classifier, not path', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ntitle: WB\nexperiment_type: western-blot\ncreated: 2026-04-11\nstatus: draft\n---\n\n# WB\n`;
    const r = parseNote('Projects/P001-CM/CM001-western-blot.md', content);
    expect(r.noteKind).toBe('experiment');
    expect(r.noteType).toBe('experiment');
  });

  it('populates date from created when date field absent', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.date).toBe('2026-04-11');
  });

  it('date field takes precedence over created when both present', () => {
    const content = `---\nnote_kind: experiment\ndate: 2026-03-01\ncreated: 2026-04-11\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.date).toBe('2026-03-01');
  });

  it('extracts noteId, projectId, series from frontmatter', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\nseries: CMS001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.noteId).toBe('CM001');
    expect(r.projectId).toBe('P001');
    expect(r.series).toBe('CMS001');
  });

  it('classifies _index.md as project-index via note_kind: project', () => {
    const content = `---\nnote_kind: project\nid: P001\nprefix: CM\ntitle: CM\ncreated: 2026-04-11\n---\n`;
    const r = parseNote('Projects/P001-CM/_index.md', content);
    expect(r.noteKind).toBe('project');
    expect(r.noteType).toBe('project-index');
    expect(r.noteId).toBe('P001');
  });

  it('extracts last_session from latest dated heading', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-08\n---\n\n## 2026-04-08 - Setup\n\n## 2026-04-09 - Run\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.lastSession).toBe('2026-04-09');
  });

  it('defaults last_session to created when no dated headings', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-08\n---\n\n# Notes\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    expect(r.lastSession).toBe('2026-04-08');
  });

  it('does not set noteId for reading notes', () => {
    const content = `---\ntitle: IL-42\nauthors: [Smith]\nyear: 2026\njournal: Nature\ndoi: 10.x/x\nread_date: 2026-04-06\nstatus: draft\nkb_status: pending\n---\n`;
    const r = parseNote('Reading/Papers/smith-2026-il42.md', content);
    expect(r.noteId).toBeUndefined();
  });

  it('does not emit validation warning for id on new serial experiment', () => {
    const content = `---\nnote_kind: experiment\nid: CM001\nproject_id: P001\ncreated: 2026-04-11\nstatus: draft\n---\n`;
    const r = parseNote('Projects/P001-CM/CM001-wb.md', content);
    const missingId = r.warnings.find((w: { field: string }) => w.field === 'id');
    expect(missingId).toBeUndefined();
  });
});
