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
3. `cricknote tool create_reading_note '{"slug":"<slug>","title":"<t>","authors":["..."],"year":2026,"journal":"<j>","doi":"<doi>"}'`.

## From local files (no Zotero)
1. Put files under `Reading/attachments/<slug>/`.
2. `cricknote tool discover_reading_bundle '{"slug":"<slug>"}'`.
3. `cricknote tool create_reading_note '{...}'`.

## Analyze the paper
1. `cricknote tool compile_reading_note '{"path":"Reading/Papers/<slug>.md"}'`
   — returns source text.
2. Draft the CREATE sections (Claims, Reasoning, Evidence, Assumptions,
   Takeaways, Extensions). Show the draft to the user.
3. Write it: `cricknote tool vault_write '{"path":"Reading/Papers/<slug>.md","content":"<full note>"}'`.

## Check status
`cricknote tool reading_pipeline_status '{"path":"Reading/Papers/<slug>.md"}'`
reports the deterministic next step. When compiled, offer KB mapping
(skill: cricknote-kb-update).
