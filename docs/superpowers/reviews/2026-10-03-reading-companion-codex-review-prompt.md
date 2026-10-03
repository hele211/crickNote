# Codex review prompt — Reading Companion spec

Use with: `codex exec -s read-only -C <repo root> -o review-1.md "$(cat docs/superpowers/reviews/2026-10-03-reading-companion-codex-review-prompt.md)"`

Everything below the line is the prompt.

---

You are a senior engineer reviewing a design spec before anyone builds it. You have **read-only** access to the repository. Do not edit any file. Do not propose to rewrite the whole spec.

## What to review

`docs/superpowers/specs/2026-10-03-reading-companion-and-output-style-design.md`

CrickNote is a CLI that a coding agent (Claude Code or Codex) drives from inside an Obsidian vault. The spec proposes, first, a two-way "reading session" (the user asks questions about a paper, and saved answers feed the reading note), a writing-style contract, and a Figure Map filled from real figure images. These are Slice 1, skill text only. Slice 2 lists later options.

The owner is a biologist, not a programmer. Their stated needs: reading is two-way, Q&A must feed back into the reading note, and they want to change a habit (they read papers in a browser and stopped using this flow) before deciding what else they need.

## What a useful review looks like

**Be critical and be useful. Both.** Report only findings that would change a decision or prevent a real failure. A finding that does not survive this test must be left out:

- "Would the spec's author do something different after reading this?" If no, drop it.
- Style, wording, formatting, naming, and "consider adding tests/docs" are out of scope.
- Generic risks ("LLMs may hallucinate") are out of scope unless you show the exact place in this design where it bites and what to change.

For **every** finding give:
1. **Claim** — one sentence.
2. **Evidence** — file path and line numbers you actually opened, or a quote from the spec. If you did not verify it in the repo, say "unverified".
3. **Impact** — what goes wrong for the user, concretely.
4. **Fix** — the exact change to the spec or plan (new wording, a moved item, a deleted item). Not "think about X".

Rank findings by impact. **Maximum 7.** If fewer than 7 are real, report fewer.

## Questions to answer

1. **Is Slice 1 enough, and is it the right Slice 1?** Is skill-text-only genuinely safe for the append / carry-forward / fold loop, given `src/agent/tools/vault.ts` (`vault_append`, `vault_write`), `src/knowledge/reading-note.ts`, and `src/agent/tools/kb-tools.ts`? Is there something smaller or better that achieves "my questions feed the reading note"?
2. **Verify these claims in the code** and say true / false / partly for each: (a) `kb_suggest` hashes and passes the whole note, so appended Q&A changes `source_hash` and reaches the KB mapper; (b) `compile_reading_note` truncates by head-slice (10k tokens per source, 30k per call); (c) `src/ingestion/chunker.ts` does not skip code fences; (d) `fencedSectionUpdate` is limited to project index and series notes; (e) `vault_append` appends at end of file; (f) `source-loader.ts` reads at most 20 PDF pages, text only.
3. **Provenance.** The spec tags each saved answer with a Basis (paper / model-knowledge / my-note) and only folds paper and my-note entries into Claims/Evidence. Is that enough to stop unsourced model claims reaching the knowledge base? What failure remains?
4. **Writing-style contract.** Could the two registers and the shows / suggests / proposes verbs break anything that parses notes (CREATE headings, claim tags `[supports|contradicts|extends]`) or reduce scientific fidelity? Is there a cheaper or better way to get readable notes?
5. **Figure Map from images.** Is "vision says what is plotted, numbers come only from text, mark `(img)`" a sound guardrail? What failure would still get through?
6. **Slice 2 ordering and what is missing.** Is the order right? Is there something the spec dismissed ("Not recommended") that it should have kept, or kept that it should drop?
7. **Challenge the central thesis:** "output format is second-order; the reading loop is first-order." Does the evidence in the spec and repo support that, or is there a bigger lever the author missed?

## Required output format

Write plain markdown, in this order:

1. **Plain-English summary for a non-programmer** — at most 8 lines. What is good, what must change, and what you would do first.
2. **Verdict** — `approve`, `approve with changes`, or `major revision`, with one sentence of reasoning.
3. **Findings** — ranked, using the four-part format above.
4. **What is solid and should NOT change** — 3 to 6 bullets. This stops churn on the parts that already work.
5. **Claim check** — the six items from question 2 with true / false / partly and a file reference.
6. **The single biggest improvement** — if the author could only make one change to the plan, what is it and why.
