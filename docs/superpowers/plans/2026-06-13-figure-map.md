# Figure Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `## Figure Map` section (Figure | What it shows | Significance) at the top of every CREATE reading note, drafted by the LLM during compile using only the paper's own text.

**Architecture:** Three small changes — add a constant + two functions to `reading-note.ts`, update the test file for those functions, and expand the compile step instructions in the reading intake skill. The KB pipeline is untouched.

**Tech Stack:** TypeScript, Vitest, Obsidian markdown

**Spec:** `docs/superpowers/specs/2026-06-13-figure-map-design.md`

---

## File Map

| File | Change |
|------|--------|
| `src/knowledge/reading-note.ts` | Add `FIGURE_MAP_HEADING` constant, update `buildCreateReadingBody`, add `hasFigureMapHeading` |
| `tests/unit/reading-note.test.ts` | Add `hasFigureMapHeading` tests, update `buildCreateReadingBody` scaffold test |
| `skills/cricknote-reading-intake/SKILL.md` | Update compile step to instruct LLM to draft the Figure Map |

---

## Task 1: Add `FIGURE_MAP_HEADING` and `hasFigureMapHeading`

**Files:**
- Modify: `src/knowledge/reading-note.ts`
- Modify: `tests/unit/reading-note.test.ts`

- [ ] **Step 1: Write failing tests for `hasFigureMapHeading`**

In `tests/unit/reading-note.test.ts`, add `hasFigureMapHeading` to the import list and append a new describe block at the end of the file:

```ts
import {
  buildCreateReadingBody,
  buildReadingFrontmatter,
  hasFigureMapHeading,
  hasMeaningfulReadingBody,
  normalizeReadingSources,
  slugifyReadingTitle,
} from '../../src/knowledge/reading-note.js';
```

```ts
describe('hasFigureMapHeading', () => {
  it('returns true when ## Figure Map heading is present', () => {
    expect(hasFigureMapHeading('## Figure Map\n\n| Fig | What | Significance |\n')).toBe(true);
  });

  it('returns false when heading is absent', () => {
    expect(hasFigureMapHeading('## Claims\n## Reasoning\n## Evidence\n')).toBe(false);
  });

  it('does not match a heading that only starts with the words', () => {
    expect(hasFigureMapHeading('## Figure Mapping Strategy\n')).toBe(false);
  });

  it('matches with trailing whitespace on the heading line', () => {
    expect(hasFigureMapHeading('## Figure Map   \n')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm test -- --reporter=verbose tests/unit/reading-note.test.ts
```

Expected: 4 failures in `hasFigureMapHeading` block — `hasFigureMapHeading is not a function`.

- [ ] **Step 3: Add `FIGURE_MAP_HEADING` constant and `hasFigureMapHeading` to `reading-note.ts`**

After the `CREATE_SECTION_HEADINGS` const (line 36 area), add:

```ts
export const FIGURE_MAP_HEADING = 'Figure Map' as const;
```

After `hasMeaningfulReadingBody`, add:

```ts
export function hasFigureMapHeading(body: string): boolean {
  return new RegExp(`^## ${FIGURE_MAP_HEADING}\\s*$`, 'm').test(body);
}
```

- [ ] **Step 4: Run to confirm the 4 new tests pass**

```bash
npm test -- --reporter=verbose tests/unit/reading-note.test.ts
```

Expected: all 4 `hasFigureMapHeading` tests pass. The `buildCreateReadingBody` test at line 33 still passes (we haven't changed `buildCreateReadingBody` yet, so it doesn't contain `## Figure Map` — the test at line 33 doesn't assert for it yet either).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "feat(reading-note): add FIGURE_MAP_HEADING constant and hasFigureMapHeading"
```

---

## Task 2: Update `buildCreateReadingBody` to prepend Figure Map

**Files:**
- Modify: `src/knowledge/reading-note.ts`
- Modify: `tests/unit/reading-note.test.ts`

- [ ] **Step 1: Update the `buildCreateReadingBody` test to assert Figure Map is present and comes before Claims**

In `tests/unit/reading-note.test.ts`, replace the test at line 33:

```ts
// BEFORE
it('buildCreateReadingBody returns the CREATE scaffold without legacy sections', () => {
  const body = buildCreateReadingBody({ title: 'IL-42 mediated suppression' });
  expect(body).toContain('# IL-42 mediated suppression');
  expect(body).toContain('## Claims');
  expect(body).toContain('## Reasoning');
  expect(body).toContain('## Evidence');
  expect(body).toContain('## Assumptions');
  expect(body).toContain('## Takeaways');
  expect(body).toContain('## Extensions');
  expect(body).not.toContain('## Summary');
  expect(body).not.toContain('## Key Findings');
  expect(body).not.toContain('## Notes');
});
```

```ts
// AFTER
it('buildCreateReadingBody returns the CREATE scaffold with Figure Map before Claims', () => {
  const body = buildCreateReadingBody({ title: 'IL-42 mediated suppression' });
  expect(body).toContain('# IL-42 mediated suppression');
  expect(body).toContain('## Figure Map');
  expect(body).toContain('## Claims');
  expect(body).toContain('## Reasoning');
  expect(body).toContain('## Evidence');
  expect(body).toContain('## Assumptions');
  expect(body).toContain('## Takeaways');
  expect(body).toContain('## Extensions');
  // Figure Map must appear before Claims
  expect(body.indexOf('## Figure Map')).toBeLessThan(body.indexOf('## Claims'));
  expect(body).not.toContain('## Summary');
  expect(body).not.toContain('## Key Findings');
  expect(body).not.toContain('## Notes');
});
```

- [ ] **Step 2: Run to confirm this test now fails**

```bash
npm test -- --reporter=verbose tests/unit/reading-note.test.ts
```

Expected: the `buildCreateReadingBody` test fails — `## Figure Map` not found in body. All other tests still pass.

- [ ] **Step 3: Update `buildCreateReadingBody` in `reading-note.ts`**

Replace the existing function:

```ts
// BEFORE
export function buildCreateReadingBody(meta: Pick<ReadingNoteMeta, 'title'>): string {
  const sections = CREATE_SECTION_HEADINGS.map((heading) => `## ${heading}\n`).join('\n');
  return `\n# ${meta.title}\n\n${sections}`;
}
```

```ts
// AFTER
export function buildCreateReadingBody(meta: Pick<ReadingNoteMeta, 'title'>): string {
  const figureMapSection = `## ${FIGURE_MAP_HEADING}\n`;
  const sections = CREATE_SECTION_HEADINGS.map((heading) => `## ${heading}\n`).join('\n');
  return `\n# ${meta.title}\n\n${figureMapSection}\n${sections}`;
}
```

Note: no table rows in the scaffold — just the heading. This ensures `hasMeaningfulReadingBody` still returns `false` for a fresh uncompiled note (the heading alone contains no trimmed content).

- [ ] **Step 4: Add integration test for `hasFigureMapHeading` against the updated scaffold**

In `tests/unit/reading-note.test.ts`, add one test inside the existing `hasFigureMapHeading` describe block (after the 4 existing tests):

```ts
it('returns true for the scaffold produced by buildCreateReadingBody', () => {
  expect(hasFigureMapHeading(buildCreateReadingBody({ title: 'Test Paper' }))).toBe(true);
});
```

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all tests pass. Pay attention to:
- `buildCreateReadingBody returns the CREATE scaffold with Figure Map before Claims` — now passes
- `hasFigureMapHeading > returns true for the scaffold produced by buildCreateReadingBody` — now passes (couldn't pass before Task 2 updated `buildCreateReadingBody`)
- `hasMeaningfulReadingBody distinguishes a blank CREATE scaffold from filled content` (line 79) — still passes because `## Figure Map\n` with no table rows is empty content, same as the other CREATE headings
- `returns false for a note with only the 6 CREATE headings and no content` (line 86) — still passes (manually constructed body without Figure Map; `hasMeaningfulReadingBody` doesn't require it)

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/reading-note.ts tests/unit/reading-note.test.ts
git commit -m "feat(reading-note): prepend Figure Map section to CREATE reading note scaffold"
```

---

## Task 3: Update reading intake skill with Figure Map compile instructions

**Files:**
- Modify: `skills/cricknote-reading-intake/SKILL.md`

- [ ] **Step 1: Replace the "Analyze the paper" section**

In `skills/cricknote-reading-intake/SKILL.md`, replace the existing "Analyze the paper" block:

```markdown
## Analyze the paper
1. `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md"}'`
   — returns source text.
2. Draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions,
   Takeaways, Extensions). Show the draft to the user.
3. Write it: `cricknote tool vault_write '{"path":"Reading/Papers/<slug>.md","content":"<full note>"}'`.
```

with:

```markdown
## Analyze the paper
1. `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md"}'`
   — returns source text.
2. Draft the **Figure Map** AND the CREATE sections. Show both to the user.

   **Figure Map rules** (goes at the top, before `## Claims`):
   - One row per figure, table, or supplementary panel referenced in the compiled text
   - **Figure**: exact label as it appears in the paper (Fig 1, Fig 2A, Table 2, Suppl. S1, etc.)
   - **What it shows**: one factual sentence — what experiment was done and what data it produced
   - **Significance**: one sentence on which conclusion of THIS paper this figure proves or challenges.
     Draw only from the paper's own abstract, results, and discussion — no cross-paper comparisons
     unless the paper explicitly states them. Write `?` if the paper does not explain the figure's role.
   - Mark any cell `?` where the caption text was too unclear to fill accurately
   - Order: main figures by label number (Fig 1, Fig 2...), then supplementary panels (Suppl. S1...)
   - Where panel labels are separate experiments (Fig 2A vs Fig 2B), use one row per panel
   - If no figures are found (review, theory, or methods paper): leave `## Figure Map` with a single line:
     `<!-- No data figures found in compiled sources -->`

3. Write it: `cricknote tool vault_write '{"path":"Reading/Papers/<slug>.md","content":"<full note>"}'`.
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

```bash
npm test
```

Expected: all tests pass (no TypeScript changes in this task).

- [ ] **Step 3: Commit**

```bash
git add skills/cricknote-reading-intake/SKILL.md
git commit -m "feat(skill): add Figure Map drafting instructions to reading intake compile step"
```

---

## Done

The Figure Map is now part of every new reading note scaffold and the LLM knows how to draft it during compile. Existing notes are unaffected — Figure Map only appears in notes created or recompiled after this change.
