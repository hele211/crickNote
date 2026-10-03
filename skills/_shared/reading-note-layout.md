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
| Reasoning | How the paper gets from data to claims: up to 2 optional diagrams and numbered steps | 6 steps, 2 diagrams |
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
if it shows something the text cannot show quickly. Then add up to 6 numbered steps
that cite claims in parentheses: `(C1)`, `(C2, C4)` or `(C1–C3)`. References are read
everywhere in the note, including diagram labels, and each one must point at a claim
that exists. See "Writing a scientific symbol that looks like an ID" below.

There are two kinds of diagram. Use at most one of each.

- **Argument or pathway diagram:** the paper states a direction of 3 or more steps,
  for example data to inference, or a route through compartments.
- **Interaction diagram:** the paper states how named molecules and cells act on each
  other: binding, activation, inhibition, secretion, uptake. See the next section.

Do not draw a diagram of what things look like or where they sit: Mermaid has no
geometry, so anatomy, membranes, 3D structures and tissue layouts come out
cluttered and misleading. Describe those in words.

Diagram rules (both kinds):

- `flowchart TB`. A left-to-right chart shrinks to an unreadable size in Obsidian's
  narrow note column.
- A **solid** line means the paper observed the link that the edge label names. It
  does not prove the whole mechanism. A **dashed** line (`-.->`, `-.-x`) means the
  paper inferred, proposed or only discussed it. Say so in the sentence above the
  diagram.
- Put qualifiers on the edges: `-->|"observed: tracer beside arteries (C1)"|`.
  Name the tracer, assay or group when the observation holds only for it.
- If the paper reconstructed a path from fixed tissue at different times, say that
  in the sentence above the diagram: the dashed lines alone are easy to miss.
- Quote every label. Keep edge labels to about 10 words; claim IDs in a label do
  not count. Use at most 12 nodes (subgraph boxes do not count) and at most 2
  diagrams per note.
- Never use the double-square-bracket node shape (a subroutine node): the vault's
  link checker reads it as a wikilink. The shapes listed below are safe.
- Every fact in the diagram must also appear in the text.

### Interaction diagrams

Draw only interactions that the paper states.

A solid line claims only what its label says: the exact labelled predicate. "Aqp4
deletion lowers clearance by about 55%" is solid because the deletion and the
readout were both measured. It does not make the mechanism between them observed:
draw that part dashed, with its own label ("inferred: acts through bulk flow").
Label each dashed line individually as inferred, proposed or discussed.

| Draw | With |
|---|---|
| A cell | a stadium node `T(["CD8 T cell"])`, or a `subgraph` box when you need to show what is inside it |
| A molecule, protein, receptor, readout or experimental perturbation | a rectangle `IL["IL-42"]`, `KO["Aqp4 deletion (Aqp4-null vs wild type)"]` |
| Binds, activates, produces, moves | `-->` |
| Lowers or blocks the named readout or molecule | `--x` (the line ends in a cross) |
| Inferred, proposed or only discussed | the dashed form: `-.->`, `-.-x` |

Rules for reading and writing the symbols:

- `--x` is a local convention for "lowers". The label must say what is lowered.
  "lowers the fraction of granzyme B-positive cells" states a measured decrease in a
  readout. "inhibits kinase K" states molecular inhibition, and needs the paper to
  say so.
- A receptor is a molecule, not a cell: use a rectangle.
- Write a null result in the readout's own box ("CD69: changed by less than 5%").
  Do not draw it as a line: a negative assay does not prove that there is no link.
- Add a node called "(not identified)" only when the paper explicitly posits an
  unidentified partner, for example "a receptor we did not identify". When the paper
  simply names no partner, draw nothing.
- Label each edge with a verb, the condition if it matters, and the claim that backs
  it: `IL --x|"lowers the fraction (C1)"| GZB`. When the order of events matters,
  number the labels: `"1 binds (C2)"`, `"2 activates (C3)"`.
- A percentage that describes one perturbation does not split a process into shares.
  "Clearance fell 55% without AQP4" does not mean that 55% of clearance uses AQP4.
- Write one sentence above the diagram that explains the line styles, as in
  `examples/reading-note-v2.md`.

## Evidence

One bullet per observation, each with a locator. Plain bullets are enough. Give a
bullet an ID (`- **E1** (Fig 3A) …`) only when two or more claims reuse it, and
then cite it in a parenthesis with the locator: `(Fig 2B, E1)`. A cited ID must exist.

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

## Writing a scientific symbol that looks like an ID

The checker reads `(C1)`, `(C2, C4)` and `(Fig 2B, E1)` as references to claims and
evidence in this note, wherever they appear. Some scientific symbols look the same:
complement component 3 (`C3`), an E3 ubiquitin ligase (`E3`), estradiol (`E2`). Write
such a symbol in backticks, as `C3`, or spell it out without parentheses ("complement
C3", "the E3 ligase"). Inline code is skipped. Do not put a bare C3 or E3 in
parentheses.

## Checking a note

After writing, run `cricknote tool lint_reading_note '{"path":"Reading/Papers/<slug>.md"}'`.
Fix `warn` findings in at most one corrective write and report what remains. The
tool is advisory: it never blocks a write and it cannot judge the science.
