---
name: cricknote-reading-intake
description: Use when the user wants to import a paper (from Zotero or files), create a reading note, or analyze a paper into structured CREATE sections in their CrickNote vault.
---

# Reading intake in CrickNote

One paper at a time. All writes go through `cricknote tool`.

## From Zotero
1. `cricknote tool zotero_fetch_item '{"citekey":"<key>"}'` (or `{"doi":"..."}`).
2. `cricknote tool zotero_prepare_bundle '{...}'` to copy the PDF into
   `Reading/attachments/<slug>/`.
3. `cricknote tool ingest_reading_bundle '{"slug":"<slug>","title":"<t>","authors":["..."],"year":2026,"journal":"<j>","doi":"<doi>"}'`
   — discovers the copied PDF and registers it as a source, so the note compiles.

## From local files (no Zotero)
1. Put files under `Reading/attachments/<slug>/`.
2. `cricknote tool discover_reading_bundle '{"slug":"<slug>"}'`.
3. `cricknote tool ingest_reading_bundle '{...}'` — registers the discovered files
   as sources. (Use `create_reading_note` only for a note with no files yet.)

## Analyze the paper
1. `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md"}'`
   — returns source text, with `--- page N ---` markers between PDF pages
   (use them to note which page each figure is on).
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

## Check status
`cricknote tool reading_pipeline_status '{"path":"Reading/Papers/<slug>.md"}'`
reports the deterministic next step. When compiled, offer KB mapping
(skill: cricknote-kb-update).
