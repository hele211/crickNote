# Reading -> Knowledge Test Dataset

This fixture is a small, synthetic end-to-end dataset for the current CrickNote workflow:

1. raw source files (`paper.md` + AI notes)
2. CREATE-based reading note generation
3. KB target suggestion
4. knowledge-note creation or update

It is designed for the **current code base**, which is vault-first:

- sources live under `Reading/attachments/<slug>/`
- the reading note lives under `Reading/Papers/`
- downstream KB notes live under `Knowledge/Concepts`, `Knowledge/Entities`, and `Knowledge/Methods`

## Layout

- `input-vault/`
  - starting state before compile + KB extraction
  - includes one existing knowledge entity note: `IL-42`
- `expected/compiled-reading-note.md`
  - expected CREATE-style reading note after compile + human review
- `expected/kb-targets.json`
  - expected KB mapping candidates
- `expected/Knowledge/...`
  - example target knowledge notes after extraction

## Main scenario

Source paper claim:

> IL-42 suppresses activated CD8 T-cell effector function by reducing granzyme B, and the effect does not require direct cell-cell contact.

Expected extraction:

- **Concepts**
  - `il-42-mediated-cd8-suppression`
- **Entities**
  - update existing `il-42`
  - create `granzyme-b`
  - create `jurkat-cells`
- **Methods**
  - create `flow-cytometry-activation-assay`

## Why `paper.md` instead of a PDF?

This dataset is meant to be easy to inspect in git and easy to use in tests.
`paper.md` acts as a stand-in for extracted paper text. You can later replace it with:

- `paper.pdf`
- `notebooklm-summary.md`
- `claude-notes.md`

without changing the intended knowledge outputs.

## Suggested manual test flow

1. Copy `input-vault/` into a temp vault.
2. Ask CrickNote to compile:
   - `Reading/Papers/lee-2026-il42-cd8-suppression.md`
3. Compare the result with:
   - `expected/compiled-reading-note.md`
4. Ask CrickNote to suggest KB updates from that completed note.
5. Compare the proposed targets with:
   - `expected/kb-targets.json`
6. Apply the KB updates and compare with the notes under:
   - `expected/Knowledge/`
