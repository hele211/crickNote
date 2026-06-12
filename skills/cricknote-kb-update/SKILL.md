---
name: cricknote-kb-update
description: Use when the user wants to map a reading note, experiment, or series into the CrickNote knowledge base (suggest, confirm, and apply knowledge note updates).
---

# Knowledge-base mapping in CrickNote

A three-stage pipeline with a confirmation gate. Never skip the gate.

## 1. Suggest
`cricknote tool kb_suggest '{"source":"<rel path to source note>"}'`
Returns proposed targets (UPDATE existing / CREATE new Knowledge notes).
Present them to the user and WAIT for confirmation.

## 2. Write the mapping (only after the user confirms)
`cricknote tool kb_write_mapping '{"source":"<src>","confirmed_targets":[{"slug":"<s>","action":"update"}]}'`
If the user confirmed nothing, pass `"confirmed_targets":[]` — this marks the
source `kb_status: skipped`.

## 3. Apply each target
Loop until done:
1. `cricknote tool kb_apply '{"mapping":"<rel path to *-mapping.md>"}'`
   — returns the next pending target + source content.
2. Draft the Knowledge note edit; show it; write with `vault_write`.
3. `cricknote tool kb_apply_advance '{...}'` to record the target as done.

## Housekeeping
- `cricknote tool kb_lint '{...}'` checks for inconsistencies.
- `cricknote tool kb_resolve_review '{...}'` handles review-flagged targets.

The mapping artifact persists progress: if you stop halfway, resume from step 3
later — `kb_apply` returns the next still-pending target.
