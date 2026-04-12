import { describe, it, expect } from 'vitest';
import { parseNote } from '../../src/ingestion/parser.js';

const CONCEPT_NOTE = `---
type: knowledge
knowledge_kind: concept
title: CD4-CD8 Interaction
aliases: [cd4 cd8 crosstalk, helper-cytotoxic interaction]
last_updated: 2026-04-08
compiled_from:
  - "[[smith-2026-il42-signalling]]"
needs_review: false
---

# CD4-CD8 Interaction

## Current View
Some synthesis.
`;

const REVIEW_QUEUE_NOTE = `---
type: review-queue
source: "[[smith-2026-il42-signalling]]"
target_concept: "[[cd4-cd8-interaction]]"
reason: ambiguous-relationship
created: 2026-04-08
status: pending
rq_source: smith-2026-il42-signalling
rq_target: cd4-cd8-interaction
---

# IL-42 suppression magnitude — context conflict
`;

const REVIEW_QUEUE_NOTE_WIKILINK_ONLY = `---
type: review-queue
source: "[[smith-2026-il42-signalling]]"
target_concept: "[[cd4-cd8-interaction]]"
reason: ambiguous-relationship
created: 2026-04-08
status: pending
---

# Conflict note without rq_source/rq_target fields
`;

const READING_NOTE = `---
title: IL-42 mediated suppression
authors: [Smith]
year: 2026
journal: Nature Immunology
read_date: 2026-04-06
status: complete
kb_status: pending
---

# IL-42 mediated suppression
`;

describe('parseNote — knowledge notes', () => {
  it('classifies Knowledge/Concepts note as knowledge noteType', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.noteType).toBe('knowledge');
    expect(parsed.folder).toBe('Knowledge');
  });

  it('extracts knowledge_kind, aliases, needs_review', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.knowledgeKind).toBe('concept');
    expect(parsed.aliases).toEqual(['cd4 cd8 crosstalk', 'helper-cytotoxic interaction']);
    expect(parsed.needsReview).toBe(false);
  });

  it('classifies Knowledge/Review-Queue note as review-queue noteType', () => {
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', REVIEW_QUEUE_NOTE);
    expect(parsed.noteType).toBe('review-queue');
    expect(parsed.rqSource).toBe('smith-2026-il42-signalling');
    expect(parsed.rqTarget).toBe('cd4-cd8-interaction');
  });

  it('extracts kb_status from reading notes', () => {
    const parsed = parseNote('Reading/Papers/smith-2026-il42-signalling.md', READING_NOTE);
    expect(parsed.noteType).toBe('reading');
    expect(parsed.kbStatus).toBe('pending');
  });

  it('isValid is true for a well-formed knowledge note', () => {
    const parsed = parseNote('Knowledge/Concepts/cd4-cd8-interaction.md', CONCEPT_NOTE);
    expect(parsed.isValid).toBe(true);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('review-queue note with status:pending is valid (not flagged as bad status)', () => {
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', REVIEW_QUEUE_NOTE);
    expect(parsed.isValid).toBe(true);
    expect(parsed.warnings.every(w => !w.message.includes('status'))).toBe(true);
  });

  it('review-queue note with status:resolved is valid', () => {
    const resolvedNote = REVIEW_QUEUE_NOTE.replace('status: pending', 'status: resolved');
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', resolvedNote);
    expect(parsed.warnings.every(w => !w.message.includes('status'))).toBe(true);
  });

  it('review-queue note with status:dismissed is valid', () => {
    const dismissedNote = REVIEW_QUEUE_NOTE.replace('status: pending', 'status: dismissed');
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', dismissedNote);
    expect(parsed.warnings.every(w => !w.message.includes('status'))).toBe(true);
  });

  it('extracts rq_source and rq_target from wikilinks when direct fields absent', () => {
    const parsed = parseNote('Knowledge/Review-Queue/2026-04-08-conflict.md', REVIEW_QUEUE_NOTE_WIKILINK_ONLY);
    expect(parsed.rqSource).toBe('smith-2026-il42-signalling');
    expect(parsed.rqTarget).toBe('cd4-cd8-interaction');
  });
});
