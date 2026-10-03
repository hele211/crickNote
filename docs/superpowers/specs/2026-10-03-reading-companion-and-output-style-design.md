# CrickNote Spec: Reading Companion and Output-Style Contract

**Date:** 2026-10-03
**Status:** Draft — pending Codex review
**Scope:** Critical review of the "make LLM output easier to understand" advice (ASD-STE100 → diagrams → HTML → video) as it applies to CrickNote, plus a sliced plan. Slice 1 is skill text and docs only: a two-way reading session loop (Q&A that feeds the reading note), a writing-style contract, and Figure Map from real figures.
**Depends on:** Figure Map design (2026-06-13), Agent-Native Bridge design (2026-06-10), Knowledge Base Workflow design (2026-04-10)
**Does NOT touch (Slice 1):** any TypeScript, the KB pipeline code, DB schema, templates, or the indexer. Slice 2 items are candidates only and each needs its own go/no-go after real use.
**Reader note:** "you" in this document means the repository owner (a biology researcher using CrickNote with Obsidian), who supplied the requirements below.

---

## Context

Advice you quoted from Andrew Kapasi: make model output easier to understand by climbing a ladder —
controlled writing (ASD-STE100) → diagrams → HTML pages → explainer videos — and treat big,
discardable, custom artifacts as normal. You asked: what can CrickNote take from this, given that
notes live in Obsidian, especially while you read a paper, ingest it, and ask questions about it.

Your answers shaped this plan:

- You run the agent in the **Claude desktop app and ChatGPT desktop (Codex)**, and read in **Obsidian** too.
  So everything visual must be a **file**; I design for file-based output, not inline rendering.
- Plugins you have: **Mermaid (core), Canvas, Dataview, Excalidraw**.
- Rule you chose: **keep = vault (markdown), throwaway = outside the vault.**
- Q&A should reach the note **on request ("save that")**.
- Most important thing you said: you have *not used the reading flow for a long time* because reading in the
  browser is easier, and reading is a **two-way activity** — the agent gives a frame, you ask questions,
  and those questions must feed back into the reading note. You also want to fix the habit before deciding what you need most.

That last point reorders everything. **Output format is the second-order problem. The first-order problem
is that the reading flow is one-shot, and has no place for your questions.**

---

## 1. Critical review of the advice

### 1.1 What is right
- The goal (spend effort on oversight and understanding, not on generating) is correct for a lab notebook.
- "Large, custom, discardable artifacts" is a real unlock when generation is cheap.
- Matching the *form* of the output to the *reader's task* is correct.

### 1.2 What is weak or does not transfer
1. **The ladder is not monotonic.** "Even better" at each rung hides a trade: every step up gains richness and
   loses **verifiability**. A table or a sentence can be checked line by line. A video narration cannot.
   A notebook's main value is that you can trust and trace it. For a record, the right rung is the *lowest* one that works.
2. **Polish raises trust faster than it raises correctness.** A clean diagram or HTML page makes errors harder
   to notice (automation bias). A diagram also has no hedging: every edge reads as a causal claim. An LLM drawing
   "claim → figure → assumption" edges can invent them with full visual confidence.
3. **It is anecdote, not evidence.** "I've had success" is one person's experience. The ASD-STE100 claim in
   particular has no checker behind it: the standard has about 900 approved words and 53 rules (per its own site),
   an LLM cannot validate itself against that, and the author admits the fallback is "80% of the way".
4. **It assumes a rendering chat UI.** Your agents run in desktop apps that drive files. Mermaid, HTML and video
   do not appear inline in a text reply, so they must be written to disk and opened.
5. **It targets one-way comprehension.** It helps you read what the model said. It does not help you *talk back*
   and have the dialogue become knowledge, which is exactly your stated need.
6. **"Discardable" conflicts with "notebook".** CrickNote's vault is durable source of truth with provenance
   (`docs/superpowers/specs/2026-04-10-knowledge-base-workflow-design.md`: "every claim traces back to a reading note").
   Discardable artifacts are fine only if they never become source of truth.

### 1.3 Rung-by-rung verdict for CrickNote

| Rung | Fit | Verdict |
|---|---|---|
| **ASD-STE100** | Strong for **procedures** (protocols, experiment steps, checklists). Risky for **reading notes**: scientific hedges ("suggests", "may") carry meaning; short flat sentences can turn "suggests" into "shows". Consistent terminology also helps BM25 search, which is now the *only* retrieval (embeddings were removed). | **Adopt a "STE-lite" contract, not the name.** Two registers, hedges kept as fixed evidence verbs. Do not ask for "STE" — nothing can verify compliance. |
| **Diagrams** | Good where CrickNote already has structure (mapping artifacts, `compiled_from`, `see_also`, claim tags, lineage). Poor if the LLM freehands them. | **Adopt, but deterministic-first.** Generate from data, not from the model's imagination. LLM-drawn argument maps only with a source anchor per edge. |
| **HTML pages** | Obsidian sanitizes HTML and never runs scripts, and `.html` is not one of its accepted formats (it opens in a browser). Fine as a throwaway, wrong as a note. | **Adopt only as on-demand, outside the vault.** Every claim carries a source anchor; banner says "generated, unverified". |
| **Explainer video** | Needs an ElevenLabs key (CrickNote's README promises "needs no API key of its own"), a Manim/LaTeX/ffmpeg toolchain, and narration errors are undetectable. Cannot be indexed, diffed, or linked. 3b1b style fits maths, not wet-lab biology. | **Do not build.** At most a one-off personal prompt. |

### 1.4 Answer to "output must be MD in Obsidian, right?"
Yes for what you *keep* — but "MD" is less limiting than it sounds. Obsidian renders tables, callouts, **Mermaid**
(built in, though its bundled version lags upstream releases), **Canvas** (`.canvas` JSON that can embed notes, images
and PDFs), image/SVG embeds, and PDF embeds with `![[paper.pdf#page=3]]`. You also have Dataview (live queries) and
Excalidraw (manual drawing). The real rule is:

> **Durable output = deterministic or user-approved, stored in the vault. Disposable output = free-form, stored outside the vault, never indexed.**

---

## 2. What the code says (verified, with refs)

- **No figure ever reaches the model.** `src/knowledge/source-loader.ts:42-48` reads PDFs with `pdf-parse`, `max: 20` pages, text only.
  Images are rejected (`:18`, `:100-104`). The Figure Map can only use caption text that happens to be in the text layer.
- **Compile truncates the tail.** `src/agent/tools/kb-tools.ts:14-40`: 10k tokens/source, 30k/call, head slice. Discussion,
  limitations, figure legends and supplements are what get cut. For Q&A this is worse: ask about Fig 6, get a guess.
- **The flow has no home for your questions.** `compile_reading_note` → agent drafts CREATE sections → `vault_write` of the whole note.
- **Writes are opaque to review.** The approval prompt shows `vault_write '{"path":…,"content":"<escaped note>"}'`.
  `generateDiff` exists (`src/editing/diff-generator.ts:11`) but the CLI apply path discards it (`src/cli/apply-edit.ts:61-62`).
- **`vault_append` appends at end of file** (`src/agent/tools/vault.ts:129`). A Q&A section only works if it is the **last** heading.
- **`vault_write` overwrites.** A later full-note rewrite will erase Q&A unless the agent re-reads and carries it forward.
- **`kb_suggest` hashes and passes the whole note** (`kb-tools.ts:141-145,186`). Anything you append changes the hash
  (re-opens a finished mapping) and the Q&A text is fed to the KB mapper as if it were paper content.
  The apply rules (`kb-tools.ts:522-533`) do not separate paper claims from model-knowledge claims. **That is a contamination risk.**
- **The chunker does not skip code fences** (`src/ingestion/chunker.ts`). A Mermaid block inside an indexed note becomes BM25 noise.
  Ignored paths already exist (`src/ingestion/ignore.ts`: `attachments/`, `-mapping.md`, `Knowledge/_Ops/`, `_index.md`, `_changelog.md`).
- **`fencedSectionUpdate` only works on project index and series notes** (`src/editing/auto-writer.ts:21-26`). It cannot hold generated blocks in reading or knowledge notes without widening the allow-list.
- **Writing-style guidance is nearly absent.** Only "one factual sentence" for Figure Map cells and "lead with what is overdue".
  Every human-facing summary is unconstrained chat text.
- **Obsidian features in use:** wikilinks, frontmatter, tables, checkboxes, HTML-comment fences. No Mermaid, callouts, Canvas, or Dataview anywhere.
- **Adding a skill needs no code.** `src/cli/install-agent-assets.ts:11-16` copies the entire `skills/` tree into `.claude/skills/` and `.agents/skills/`.

---

## 3. Recommended plan, in slices

Principle: **change the habit first, then let real use decide the rest.** Slice 1 is almost all skill text.
Later slices happen only if Slice 1 shows the need.

### Slice 1 — "Reading companion" (do now; skill text + docs, no TypeScript)

**1. New skill `skills/cricknote-reading-session/SKILL.md`** — the two-way loop.
- *Start fast.* From a citekey/DOI/file: run the existing intake steps in one go, compile, then give a **pre-read brief in chat**
  (≤15 lines: what question the paper asks, what the authors claim, 3 things to check while reading, figure list).
  You may keep reading in the browser. The agent is a companion, not a replacement for your PDF viewer.
- *Full-text access.* Do not rely on `compile_reading_note` alone (head-sliced). Read the PDF with the agent's own file reader, page by page,
  to answer questions and to see figures. If a needed passage is missing, say so. Never guess.
- *Answer rule.* Every answer states its basis: `paper p.X / Fig Y` or `model knowledge — not from this paper`.
- *"Save that".* Append one entry to `## Reading Q&A` with `vault_append`, in a fixed shape:
  `**Q:** … / **A:** … / **Basis:** paper p.5 Fig 3B | model-knowledge (unverified) | my-note`.
  If the heading is missing, append it as the last section first.
- *Never clobber.* Before any full-note `vault_write`, `vault_read` the note and carry `## Reading Q&A` over verbatim.
- *Fold step.* At session end, propose edits to Claims/Reasoning/Evidence/Assumptions using only entries whose Basis is `paper` or `my-note`.
  You approve. `model-knowledge` entries are never promoted unless you re-tag them.
- *KB warning.* Tell you once: appending Q&A after KB mapping changes the source hash, so `kb_suggest` will treat the note as changed.

**2. Style contract in `templates/agent-docs/CLAUDE.md` and `AGENTS.md`**, and referenced from the "Present" steps of the skills.
Explicit rules, not the name "ASD-STE100":
- *Procedure register* (protocols, experiment steps, close-out lists): one action per sentence, imperative, ≤20 words, value + unit, one term per thing.
- *Explanation register* (reading notes, answers): answer first, ≤25 words per sentence, one idea per sentence, active voice, ≤6 sentences per paragraph, define an abbreviation once.
- *Terminology:* use the paper's term and the KB alias for the same entity every time (helps BM25 search).
- *Do not flatten hedges.* Fixed evidence verbs: **shows** (direct data), **suggests** (indirect/correlative), **proposes** (authors' untested interpretation). Never upgrade one to another.
- *Keep numbers:* n, units, effect size and statistic as the paper reports them.
- Also fix the drift: `AGENTS.md` claims to be identical to `CLAUDE.md` but is missing the workflow list and the freeform-notes rule.

**3. Figure Map from the real figures (skill text in `skills/cricknote-reading-intake/SKILL.md`).**
When a caption cell would be `?`, or a source is `truncated: true`, the agent opens the PDF figure page itself.
Vision may identify *what is plotted* (axes, groups, direction of effect). **Numbers come only from text.** Mark vision-derived cells `(img)` so you know to check them.
(Works for Claude Code; Codex image support is unverified.)

**Try it:** run this on the fixture paper (`tests/fixtures/reading-kb-dataset/`) and on 2 real papers you actually need to read.

### Slice 2 — only after you have read 3–5 papers with Slice 1

Pick by evidence of what you missed.

| Item | What | Why / risk |
|---|---|---|
| **A. Dataview dashboard** | One vault note with Dataview queries over existing frontmatter: reading pipeline (`status`, `kb_status`), KB notes with `needs_review`, in-progress experiments. | Zero generation, never stale, replaces the improvised daily-review summary. Prereq: check that unquoted `[[x]]` in frontmatter (written at `kb-tools.ts:637-639, 705-708`) behaves in Dataview; quote them if not. |
| **B. Deterministic Mermaid from data** | Source→targets graph from the mapping artifact (`src/knowledge/mapping-artifact.ts`, `readMappingArtifact`), with kind/confidence/state. Written into the **`-mapping.md` body**, which is already excluded from the index. Knowledge-note neighborhoods go to `Knowledge/_Ops/Views/` (already ignored). | Testable with vitest, no hallucinated edges. Cap ~25 nodes. Needs a link scan (no edge table exists). Do **not** put Mermaid in indexed note bodies unless the chunker is taught to skip code fences. |
| **C. Create-once reading Canvas** | `Reading/Canvases/<slug>.canvas`: PDF node, Figure Map rows as nodes, Claims as nodes. Written once, then yours. Never regenerated, so no layout clobber. | Fits your Canvas habit and moves reading *into* Obsidian. Auto-layout is crude; build only if the table is not enough. |
| **D. Readable approval step** | `--no-apply --diff` prints a plain unified diff (reuse `generateDiff`, `diff-generator.ts:11`; hook in `src/cli.ts` and `src/cli/tool-dispatch.ts`). Skill: show diff, then apply. | Fixes the escaped-JSON approval prompt. ~50 lines + test. You did not pick this pain point, so wait for evidence. |
| **E. `## Reading Q&A` in the scaffold** | Add as the last heading in `buildCreateReadingBody` and both default reading templates; same pattern as Figure Map (not in `CREATE_SECTION_HEADINGS`, not in `requiredHeadings`, no contract bump). | Only after Slice 1 proves the section shape. Existing installs keep old templates (same known limitation as Figure Map). |
| **F. On-demand HTML explainer** | Skill-only recipe: single-file HTML to `~/.cricknote/views/<date>-<slug>.html`, no CDN, banner "generated, unverified, delete freely", every claim with a source anchor. | Cheap to try, easy to discard. Outside the vault by your rule, so never indexed. |

### Not recommended
- **Explainer videos** (cost, key, toolchain, unverifiable narration, off-vault).
- **Auto-generating Excalidraw files** (compressed JSON, plugin-version coupling). Keep Excalidraw for hand sketches.
- **Strict STE on reading notes** (flattens hedges, hurts fidelity).
- **LLM-freehand diagrams inside durable notes** (confident invented edges, search noise).
- **Auto-append of every Q&A** (you chose on-request; it also means approval prompts and unreviewed model text in the note).

---

## 4. Critical files

Slice 1 touches only:
- `skills/cricknote-reading-session/SKILL.md` (new)
- `skills/cricknote-reading-intake/SKILL.md` (Figure Map vision + truncation rule)
- `templates/agent-docs/CLAUDE.md`, `templates/agent-docs/AGENTS.md` (style contract; fix drift)

Reused as-is: `vault_append`/`vault_read`/`vault_write` (`src/agent/tools/vault.ts`), `compile_reading_note` (`kb-tools.ts:46`),
the skill installer (`src/cli/install-agent-assets.ts`).

Slice 2 candidates touch: `src/knowledge/mapping-artifact.ts` (consume), `src/ingestion/ignore.ts` (maybe add a views path),
`src/ingestion/chunker.ts` (only if Mermaid goes into indexed bodies), `src/knowledge/reading-note.ts` + `src/templates/template-loader.ts` (item E),
`src/cli.ts` + `src/cli/tool-dispatch.ts` + `src/editing/diff-generator.ts` (item D).

## 5. Verification

Slice 1 (no TypeScript changes, so `npm test` must stay green as a regression check):
1. `npm test` and `npm run build` pass unchanged.
2. `npm run setup` into a scratch vault: confirm the new skill appears under `.claude/skills/` and `.agents/skills/`.
3. Manual run on the fixture paper: pre-read brief appears; ask 3 questions (one answerable from the paper, one not in the text, one needing general knowledge);
   check each answer carries a Basis tag and the unanswerable one is declined, not guessed.
4. Say "save that" twice: entries land under `## Reading Q&A` in the fixed format. Then trigger a full-note rewrite and confirm Q&A survives.
5. Run `kb_suggest`; confirm the agent flags the changed hash and does not promote `model-knowledge` entries.
6. Style A/B on one real paper (before/after contract): compare median sentence length, whether "suggests/shows/proposes" survived, and *your* preference. Keep the contract only if you prefer it.
7. Figure Map: on a paper whose captions are missing from the text layer, check `(img)` cells are present and no numbers come from vision.

Slice 2 items get their own tests when chosen (Mermaid output is deterministic, so snapshot-testable; diff output likewise).

## 6. Noticed along the way (out of scope, not changed)

- `get_workflow_events` is called by the daily-review skill but nothing in `src/` writes `workflow_events`, so it always returns empty.
- `see_also` appears in specs and fixtures, but no code or apply rule maintains it.
- `vault_append`/`vault_write` descriptions still promise "diff preview, user confirmation" from the retired runtime; this misleads the agent.
- Logger info lines go to stdout, which may mix with the JSON the CLI prints (read from code, not run).
- `_index.md` writes `[[slug|Title]]` unescaped inside a table cell (not verified in Obsidian).

## 7. Open assumptions

- "Desktop" means the Claude desktop app and ChatGPT desktop (Codex), both driving the vault by files.
- Claude Code can open PDF pages as images; Codex may not. Slice 1 item 3 degrades to text-only there.
- You are the only reader of the notes, so style rules are tuned to you, not to non-native readers or a team.

## 8. Review brief for Codex

Challenge the plan on these points, citing file paths you verified in the repo:
1. **Is "skill-text-only" for Slice 1 enough?** Does anything in `src/agent/tools/kb-tools.ts`, `src/knowledge/reading-note.ts`, or `src/agent/tools/vault.ts` make the `## Reading Q&A` append / carry-forward / fold loop unsafe or fragile?
2. **Q&A hash and KB contamination.** Is the claim right that `kb_suggest` hashes and passes the whole note, so appended Q&A changes `source_hash` and reaches the KB mapper? Is the Basis-tag mitigation sufficient?
3. **Style contract risk.** Do the two registers and the shows/suggests/proposes verbs risk degrading reading-note fidelity or breaking anything that parses CREATE sections or claim tags (`[supports|contradicts|extends]`)?
4. **Vision for Figure Map.** Is "vision identifies what is plotted, numbers only from text, mark `(img)`" a sound guardrail? What would you add?
5. **Deterministic-first diagrams.** Is the Slice 2 ordering right (Dataview dashboard, mapping-artifact Mermaid, Canvas, `--diff`)? Anything missing, or anything that should move to Slice 1?
6. **Claims to double-check:** chunker does not skip code fences; `fencedSectionUpdate` is limited to project index/series notes; `vault_append` appends at EOF; compile truncates by head-slice.
7. **What did the plan miss** about the user's stated need (reading is two-way; Q&A must feed the reading note; habit change first)?

Reply with: verdict (approve / approve with changes / major revision), a ranked list of findings with evidence, and any claim in this plan that you found to be wrong.

Sources checked: [ASD-STE100 overview](https://asd-ste100.org/about_STE.html), [Obsidian accepted formats](https://obsidian.md/help/file-formats), [Obsidian embed files](https://obsidian.md/help/Linking+notes+and+files/Embed+files), [Obsidian URI](https://obsidian.md/help/Extending+Obsidian/Obsidian+URI), [Obsidian HTML content](https://obsidian.md/help/html).
