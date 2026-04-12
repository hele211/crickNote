---
name: "pclaude-coder-codex-reviewer"
description: "Use when the user wants `pclaude` (Claude Code) to implement code changes while Codex runs the code, checks tests, inspects diffs, and performs the final code review."
---

# pclaude Writes, Codex Reviews

Use this skill when the user wants a two-agent workflow:

1. `pclaude` writes or edits the code.
2. Codex runs the code, checks results, and performs the review.

This skill is for implementation and review handoff, not for blind delegation. Codex remains responsible for verification, risk checking, and the final judgment.

## Prerequisite check

Before using this workflow, verify that `pclaude` exists:

```bash
command -v pclaude
```

If it is missing, stop and tell the user that the Claude Code CLI is not installed or not on PATH.

## Default workflow

1. Read the task and inspect the relevant code locally first.
2. Form a short implementation brief for `pclaude`:
   - goal
   - relevant files
   - constraints from the repo or specs
   - tests to update or run
3. Run `pclaude` to implement the change.
4. Review the resulting diff yourself.
5. Run the relevant tests or verification commands yourself.
6. Report findings in Codex review style:
   - bugs and regressions first
   - then open questions
   - then a brief summary

## What Codex should own

Codex should always do these parts personally:

- inspect the current repo state before handoff
- choose or refine the implementation brief
- run tests, linters, or app verification
- review the actual diff and behavior
- decide whether the change matches the spec

Do not treat `pclaude` output as trusted just because it ran.

## What to send to pclaude

Keep the prompt concrete and bounded. Include:

- the exact task
- the files or modules likely involved
- any relevant spec excerpts or behavioral rules
- a request to make the change directly
- a request to summarize changed files at the end

Good handoff shape:

```text
Implement this change in the current repo:
- Goal: ...
- Touch these files if needed: ...
- Follow these constraints: ...
- Update tests if behavior changes.
- At the end, list the files you changed and any tests you ran.
```

## Example command pattern

Use the installed `pclaude` command directly with a quoted task:

```bash
pclaude "Implement this change in the current repo. Goal: ... Constraints: ... Update tests if needed. At the end list changed files."
```

If the task depends on a spec file, mention the path in the prompt.

## Review checklist for Codex

After `pclaude` finishes, Codex should check:

- does the diff actually satisfy the request?
- does it match the spec, not just the test fixtures?
- are edge cases covered?
- are there missing tests?
- did it accidentally break naming, path, or schema conventions?
- are there unrelated changes that should be called out?

## Output style

If the user asked for a review, lead with findings, not a narrative.

Preferred structure:

1. Findings with file references
2. Open questions or assumptions
3. Short summary of what was verified

If no issues are found, say so clearly and mention residual risk or missing test coverage.

## Guardrails

- Never let `pclaude` be the only verifier of its own work.
- Do not skip local inspection before handoff on risky changes.
- Do not skip tests after handoff when tests are available.
- Prefer small, well-scoped `pclaude` tasks over vague "fix the repo" prompts.
- When a request is purely a code review, do not call `pclaude` at all unless the user explicitly wants review comments addressed.
