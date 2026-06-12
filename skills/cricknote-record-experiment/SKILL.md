---
name: cricknote-record-experiment
description: Use when the user wants to start a project, create or update an experiment, log bench steps, record results, group experiments into a series, or save a protocol in their CrickNote lab vault.
---

# Recording experiments in CrickNote

All writes go through `cricknote tool <name> '<json>'`. Never write note files
directly — the tools allocate serial IDs and keep the index/audit log correct.

## Start a project
1. `cricknote tool create_project '{"title":"<title>","prefix":"<2-3 LETTERS>"}'`
   - Omit `prefix` to get a suggestion, then re-call with the chosen prefix.
2. After it applies, finalize counters:
   `cricknote tool register_project_counters '{"project_id":"P###","prefix":"<PREFIX>"}'`

## Create an experiment
1. Check the protocol exists: `cricknote tool vault_list '{"folder":"Protocols"}'`.
2. `cricknote tool create_experiment '{"project_id":"P###","title":"<t>","experiment_type":"<type>","protocol":"PR###-<slug>","samples":[{"name":"ctrl","condition":"untreated"}]}'`
   - `protocol`, `samples`, `series` are optional.

## Log steps during the day
1. Read first: `cricknote tool vault_read '{"path":"<rel path>"}'`.
2. Append a timestamped line:
   `cricknote tool vault_append '{"path":"<rel path>","content":"\n- 14:32 transfer complete"}'`

## Record results and close out
1. Append results/analysis with `vault_append`.
2. When done, the experiment's `status` should be `complete` — use `vault_append`
   or the appropriate tool to set it, then offer to map findings into the
   knowledge base (skill: cricknote-kb-update).

## Series and protocols
- Series: `cricknote tool create_series '{"project_id":"P###","title":"<t>"}'`
  then `cricknote tool update_series_table '{...}'`.
- Protocol: `cricknote tool create_protocol '{"title":"<t>","category":"<cat>","derived_from":"PR###"}'`.

## After a batch of manual edits
Run `cricknote reindex` so search reflects the changes.
