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

The compiled paper is large (often 20–30k+ tokens). Run this whole block in a
**subagent** so that text lives in the subagent's context and never persists into
the rest of the pipeline — KB mapping reads the drafted note, not the raw paper, so
the parent has no reason to keep the source text resident and re-billed on every
later turn. The parent gets back only the drafted body + a short summary.

In Claude Code, dispatch the **general-purpose** agent via the `Task` tool (other
runtimes: your equivalent isolated-context mechanism). The subagent starts cold, so
its prompt must be **self-contained**: include the note path, the steps below, and
the Figure Map rules verbatim, and tell it to read the shared guide and layout
first (it cannot see this skill's folder). Instruct the subagent to:

0. Read `.claude/skills/_shared/readable-output.md` and
   `.claude/skills/_shared/reading-note-layout.md` (under Codex:
   `.agents/skills/_shared/`) before drafting. They define the note layout, the
   claim, locator and diagram formats, and the checker. A complete example is
   `.claude/skills/_shared/examples/reading-note-v2.md`.

1. `cricknote tool inspect_reading_note_sources '{"path":"Reading/Papers/<slug>.md"}'`
   - returns source size, PDF page count, extracted caption locations, extraction
   quality warnings, supplementary-source coverage, and safe page ranges without
   returning the paper text. Treat missing supplements and extraction warnings as
   explicit limitations; do not infer unseen supplementary panels.
2. Compile each recommended PDF range separately:
   `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md","source_path":"paper.pdf","page_start":1,"page_end":8,"max_tokens":8000}'`
   - repeat for every recommended range. Page markers retain the PDF's original
   page numbers. For non-PDF sources, compile one `source_path` at a time with
   `max_tokens` at or below 8000. If any response still has
   `transport_truncation_risk: true` or `truncated: true`, use a smaller range.
3. Draft the note in the layout from `reading-note-layout.md`: a
   `> [!abstract] TL;DR` callout (with a `**Source:** <primary attachment filename>`
   line), then `## Claims`, `## Reasoning`, `## Evidence`, `## Figure Map`,
   `## Assumptions`, `## Takeaways` and `## Extensions`, in that order. Follow the
   Figure Map rules below. Keep every qualifier the paper states.
4. Write it: `cricknote tool vault_write_body '{"path":"Reading/Papers/<slug>.md","body":"<note body>"}'`
   — preserves the frontmatter (authors, sources, etc.); supply only the body
   (TL;DR callout + the seven sections). Use `vault_write` only when creating a file from scratch.
5. Check it: `cricknote tool lint_reading_note '{"path":"Reading/Papers/<slug>.md"}'`.
   Fix the `warn` findings in at most one corrective write (`vault_write_body`
   again), then stop. Do not loop. `info` findings are suggestions. The checker
   cannot tell whether a locator really supports its claim: that stays a human review.
6. Return ONLY: the note path, the drafted body, a 2–3 line summary (figure count,
   claim count, any `?` cells or warnings), and the remaining warnings from the
   checker. Do NOT return the compiled paper text — that is the whole point of the
   isolation.

**Figure Map rules** (placed after `## Evidence` and before `## Assumptions`):
- Keep every row. For more than 40 rows, split the table under `### Main figures`
  and `### Supplementary`. Do not truncate, and do not merge distinct experiments
  to shorten it.
- One row per figure, table, or supplementary panel whose caption or experimental
  description is present in an attached source. A citation to an unavailable
  supplement is a warning, not enough evidence to create a row.
- **Figure**: exact label as it appears in the paper (Fig 1, Fig 2A, Table 2, Suppl. S1, etc.)
- **What it shows**: one factual sentence — what experiment was done and what data it produced
- **Significance**: one sentence on which conclusion of THIS paper this figure proves or challenges.
  Draw only from the paper's own abstract, results, and discussion — no cross-paper comparisons
  unless the paper explicitly states them. Write `?` if the paper does not explain the figure's role.
- Mark any cell `?` where the caption text was too unclear to fill accurately
- Never reconstruct a missing supplementary caption from scattered main-text
  references. Record the missing supplement in the summary instead.
- Order: main figures by label number (Fig 1, Fig 2...), then supplementary panels (Suppl. S1...)
- Where panel labels are separate experiments (Fig 2A vs Fig 2B), use one row per panel
- If no figures are found (review, theory, or methods paper): leave `## Figure Map` with a single line:
  `<!-- No data figures found in compiled sources -->`

When the subagent returns, show the drafted note (TL;DR, claims and diagrams first)
and the remaining checker warnings to the user for review. The note stays `draft` until the user confirms — minor edits go through
`vault_write_body` on the (small) note; only "re-read the paper" warrants
re-dispatching the subagent. The raw paper never enters this (parent) context.

If your runtime has no subagent mechanism, run steps 1–4 inline instead — you lose
the context isolation but the written note is identical.

## Check status
`cricknote tool reading_pipeline_status '{"path":"Reading/Papers/<slug>.md"}'`
reports the deterministic next step. When compiled, offer KB mapping
(skill: cricknote-kb-update).
