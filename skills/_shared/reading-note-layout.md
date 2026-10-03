# Reading-note layout (v2)

For notes in `Reading/Papers/` and `Reading/Threads/`. Read `readable-output.md`
first. A complete, lint-clean example is `examples/reading-note-v2.md`: copy its
shape.

## Order

1. TL;DR callout, before the first heading.
2. `## Claims`
3. `## Reasoning`
4. `## Evidence`
5. `## Figure Map`
6. `## Assumptions`
7. `## Takeaways`
8. `## Extensions`
9. Optional `## Appraisal: <topic>` sections, after Extensions only.

Write each heading exactly as shown, once, with no numbering and no emoji. Do not
add a top-level `#` heading or any other `##` section.

CrickNote's template code requires six of these headings (Claims, Reasoning,
Evidence, Assumptions, Takeaways, Extensions). This layout adds Figure Map as the
seventh, and the checker requires it too.

## What goes in each section

| Section | Holds | Budget |
|---|---|---|
| TL;DR | Did · Found · Trust · Why it matters here · Source | 5 fields, 160 words |
| Claims | What the paper says it found, one claim per bullet | 8 claims |
| Reasoning | How the paper gets from data to claims: one optional diagram and numbered steps | 6 steps, 1 diagram |
| Evidence | The observations behind the claims, with locators | group under `###` beyond 15 bullets |
| Figure Map | One row per figure, table or supplementary panel | no limit; split under `###` beyond 40 rows |
| Assumptions | Limits of the evidence (analyst layer) | 10 bullets |
| Takeaways | Plain-language summary (5 sentences), what the paper does not prove, related notes | — |
| Extensions | Testable next steps (analyst layer) | 8 bullets |
| Appraisal | External comparison or separate critical analysis, each item sourced or "not verified" | — |

## TL;DR

```
> [!abstract] TL;DR
> **Did:** … **Found:** … **Trust:** … **Why it matters here:** … **Source:** paper.pdf
```

Put each field on its own `>` line. Define abbreviations here at first use.
**Source** names the primary attachment by filename. Locators without a file name refer to that file. Do not rely on the
order of `sources` in the frontmatter: it is alphabetical and changes when the
note is re-ingested.

## Claims

```
- **C1** [measured] Claim text with its qualifiers. (Fig 2A–E)
```

- **Support type** says how the paper supports the claim. It is not a reliability
  score. Put reliability limits in the claim text and in Assumptions.
  - `measured`: the paper's own data show it directly.
  - `inferred`: the paper concludes it from measured data; nobody observed it.
  - `proposed`: a model or hypothesis that the paper states but does not test.
- **One claim has one support type.** When a result mixes an observation with an
  interpretation, write two claims: the observation (`measured`), then the
  interpretation (`inferred`). A claim about a fraction or a mechanism that was
  worked out from tracers, not observed, is `inferred`.
- **Before you write a claim, check what you must keep:** the species and system;
  the condition and the time point; the comparator ("versus wild type"); the tracer,
  assay or reagent; and whether the paper observed the thing or reconstructed it.
  Copy the paper's hedge words ("suggests", "consistent with").
- **Locator** names where the claim comes from: `Fig 2A–E`, `Table 1`,
  `Suppl. S3`, `PDF p. 7`, `§Methods`, `Box 1`. Name another attachment first when
  the locator is not in the Source file: `(supp1.pdf, Suppl. S3)`.
- Write PDF page numbers as `PDF p. 7` (they match the `--- page N ---` markers the
  compiler emits) and printed pages as `printed p. 7`. Do not write a bare `p. 7`.
- A statement that appears only in the text, or that cites a supplementary figure
  that is not attached, gets a page locator and says so:
  `(PDF p. 5, text citing Suppl. S8B; the supplementary figure is not attached)`.
  Never turn that into a figure row or a figure locator.
- Number claims `C1`, `C2`… Never renumber a claim after anything cites it.

## Reasoning

Write one sentence that says how the paper's argument is built. Add a diagram only
if the paper states a direction of 3 or more steps. Then add up to 6 numbered steps
that cite claims in parentheses: `(C1)`, `(C2, C4)` or `(C1–C3)`.

Diagram rules:

- `flowchart TB`. A left-to-right chart shrinks to an unreadable size in Obsidian's
  narrow note column.
- Solid arrow `-->` means the paper observed the movement or link that the edge
  label names. It does not prove the whole mechanism. Dashed arrow `-.->` means the
  paper inferred or proposed it. Say so in the sentence above the diagram.
- Put qualifiers on the edges: `-->|"observed: tracer beside arteries (C1)"|`.
  Name the tracer, assay or group when the observation holds only for it.
- If the paper reconstructed a path from fixed tissue at different times, say that
  in the sentence above the diagram: the dashed arrows alone are easy to miss.
- Quote every label. Keep edge labels to about 10 words; claim IDs in a label do
  not count. Use at most 12 nodes and at most 2 diagrams per note.
- Use plain rectangles only. Do not use double-bracket or other special node
  shapes: the vault's link checker reads them as links.
- Every fact in the diagram must also appear in the text.

## Evidence

One bullet per observation, each with a locator. Plain bullets are enough. Give a
bullet an ID (`- **E1** (Fig 3A) …`) only when two or more claims reuse it, and
then cite it from those claims: `(Fig 2B, E1)`. A cited ID must exist.

## Figure Map

Keep the table `| Figure | What it shows | Significance |`. The rules for rows are in
the reading-intake skill: one row per figure, table or supplementary panel whose
caption is present in an attached source; separate rows for separate experiments;
`?` where the caption is unclear; never reconstruct a missing supplementary caption
from scattered text.

- Keep every row. For more than 40 rows, split the table under `### Main figures`
  and `### Supplementary`. Do not truncate.
- Keep each cell to about one sentence (30 words at most).
- With no data figures, leave the single line
  `<!-- No data figures found in compiled sources -->`.

## Assumptions, Takeaways, Extensions

These are the analyst's layer. Where an item only restates a limit that the
authors state, write "The authors note…". Takeaways holds three parts: a
plain-language summary of at most 5 sentences, a short "What the paper does not
prove", and related notes.

## Appraisal

Use `## Appraisal: <topic>` for substantial outside comparison or a separate
critical analysis. Each factual item cites its source. When you cannot name a
source, end the item with "Not verified: no source recorded." Put a
`> [!warning] Not verified` callout around claims that nobody has checked. Label a
closing interpretation "Analyst synthesis".

## Checking a note

After writing, run `cricknote tool lint_reading_note '{"path":"Reading/Papers/<slug>.md"}'`.
Fix `warn` findings in at most one corrective write and report what remains. The
tool is advisory: it never blocks a write and it cannot judge the science.
