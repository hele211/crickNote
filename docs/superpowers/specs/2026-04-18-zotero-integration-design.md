# CrickNote Spec 3: Zotero Integration

**Date:** 2026-04-18
**Status:** Draft (Rev 29 — human review round 22)
**Scope:** Zotero → CrickNote reading workflow. Fetch item metadata from Zotero local API, copy attached PDF into vault, AI-summarize into a CREATE-structured reading note, store in `Reading/Papers/`.
**Depends on:** Spec 1 (serial numbering), Spec 2 reading-intake pipeline (vault-native bundle ingest)
**Followed by:** Implementation planning

---

## 1. Overview

The current reading-intake pipeline expects files to already be inside the vault at `Reading/attachments/<slug>/`. This spec adds an upstream intake path: the user provides a Zotero item identifier (DOI, citekey, or item key), CrickNote fetches bibliographic metadata and the attached PDF from Zotero via Better BibTeX JSON-RPC, copies the PDF into the vault, and then uses the existing two-step pipeline to produce a fully formed reading note in `Reading/Papers/`.

### Goals

- Zero manual copy-paste: title, authors, year, DOI, journal auto-fill from Zotero
- PDF summarized via existing `compile_reading_note` flow
- Output is a normal CrickNote reading note — downstream KB tools (`kb_suggest`, `kb_apply`) work unchanged
- Zotero provenance (citekey, item key) stored in frontmatter for traceability

### Non-goals

- Keeping the PDF exclusively in Zotero storage (PDF is copied into vault to reuse the existing pipeline safely)
- Syncing annotations or highlights from Zotero to CrickNote
- Batch import of the whole Zotero library
- Network/web PDF fetching (only locally attached PDFs in Zotero storage)
- Requiring the "Zotero Integration" Obsidian plugin (optional complement, not a dependency)

### Design choices

**Copy PDF into vault:** Copies the selected PDF into `Reading/attachments/<slug>/paper.pdf` before ingestion. This reuses the existing pipeline without any changes to vault boundary enforcement or source-loader.

**Two-step flow:** `ingest_reading_bundle` creates the note scaffold (pending_edit → user confirms → note on disk), then `compile_reading_note` reads the PDF and returns CREATE content to the agent, which calls `vault_write` (second pending_edit → user confirms). This matches the existing pipeline pattern.

---

## 2. Integration Strategy

### Primary: Zotero Local API via Better BibTeX

Zotero exposes a local JSON-RPC API at `http://localhost:23119` when it is running. The Better BibTeX (BBT) plugin adds `/better-bibtex/json-rpc` endpoints. All requests use JSON-RPC 2.0 format.

**Important:** `item.search(string)` is Zotero quick-search (Title/Creator/Year) — it does NOT search by citekey. Citekey is used directly as a primary key for BBT's dedicated endpoints.

**Resolution paths by identifier type:**

#### Path A — citekey provided (fastest)
```
api.ready
item.export([citekey], "Better CSL JSON", library?)  → metadata (title, authors, year, journal, doi, abstract)
item.attachments(citekey, library?)                  → PDF paths
```

`item.export` returns a **JSON string** (not a parsed object). The implementation must call `JSON.parse(exportResult)` and validate the result is a non-empty array before reading `title`, `author`, `issued`, `container-title`, `DOI`, and `abstract` fields. `zotero_key` (the raw Zotero item key, e.g. `ABCD1234`) is not returned by `item.export` or `item.attachments` and is therefore **absent** from the output when Path A is used. The frontmatter field is optional.

#### Path B — DOI provided

**DOI normalization (`normalizeDoi`):** lowercase the input and strip any `https://doi.org/` or `http://doi.org/` prefix. Apply this function at ingress before any use of the DOI value — Path B search, fallback DOI lookup, and collision checks all operate on the normalized form. The stored `doi` frontmatter field also uses the normalized value.

```
api.ready
item.search([["DOI", "is", normalizeDoi(doi)]], library?)  → [{itemKey, libraryID, ...}]
  → if multiple matches: surface top 3 for user disambiguation (do not silently take first)
  → if exactly one match: extract itemKey and libraryID
  → assemble key: if libraryID == 1 (personal library) use bare "itemKey"; otherwise use "libraryID:itemKey"
item.citationkey([assembledKey])                     → { assembledKey: "smith2026il42" }
  → extract citekey from map value
  → store assembled key as zotero_key in output
item.export([citekey], "Better CSL JSON", library?)  → metadata
item.attachments(citekey, library?)                  → PDF paths
```

Note: BBT `item.search` advanced-search terms use the shape `[["field", "operator", "value"]]` — an array of condition tuples. Triple-nesting (`[[["DOI", ...]]]`) is wrong and will produce unexpected results.

#### Path C — Zotero item key provided

`item.citationkey` takes an array of item key strings. For My Library items, the key is bare (`ABCD1234`). For group library items, the key is prefixed with the library ID (`12345:ABCD1234`). The library ID is embedded in the key string, not passed as a separate parameter.

```
api.ready
item.citationkey(["ABCD1234"])                              → { "ABCD1234": "smith2026il42" }         # My Library
item.citationkey(["12345:ABCD1234"])                        → { "12345:ABCD1234": "smith2026il42" }   # group library
  → extract citekey from map value
item.export([citekey], "Better CSL JSON", library_id?)      → metadata
item.attachments(citekey, library_id?)                      → PDF paths
```

**Library parameter for `item.export` and `item.attachments`:** omit for My Library. For group libraries, pass the numeric library ID as the last param. The library ID should be extracted from the `12345:ABCD1234` key prefix supplied by the user.

**BBT installation check:** If `api.ready` returns connection refused or 404:
> Zotero is not running, or Better BibTeX is not installed. Please open Zotero and install the Better BibTeX plugin (https://retorque.re/zotero-better-bibtex/).

**JSON-RPC 2.0 format example:**
```json
POST http://localhost:23119/better-bibtex/json-rpc
{"jsonrpc":"2.0","method":"item.attachments","params":["smith2026il42"],"id":3}
```

### Fallback: BBT CSL JSON AutoExport (metadata-only)

If the user has set up a BBT auto-export to a `.json` file, CrickNote can parse that file to resolve metadata (title, authors, year, journal, DOI, abstract) when the live API is unavailable.

**Important limitation:** BBT auto-exports do not include attachment file paths. The fallback therefore supports metadata lookup only — PDF ingestion is not possible without the live API. In fallback mode, `zotero_fetch_item` returns metadata with `pdf_path: undefined` and the agent proceeds to abstract-only mode (§5), **but only if an abstract is present in the export**. If the export has metadata but no abstract, `zotero_fetch_item` must return a hard error:

> "No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry."

This prevents a dead-end at `ingest_reading_bundle`, which requires at least one readable source.

Configuration:
```json
{ "zotero": { "bbt_export_path": "/Users/le211/Zotero/library.json" } }
```

Fallback is opt-in and secondary — the live API is preferred. If neither is available, the tool fails with a clear error.

---

## 3. New Tools

### `zotero_fetch_item`

Queries the Zotero local API (or BBT export) for a single item. Returns validated metadata + PDF path.

**All tool errors return `{ error: string }`. Exceptions are not used for user-facing error conditions.**

**Input:**
```typescript
citekey?: string
doi?: string
zotero_key?: string           // Zotero item key; group libraries must use "12345:ABCD1234" format (library ID embedded — no separate library_id param)
selected_attachment_id?: string  // used on disambiguation re-call to select a specific attachment
```
At least one of `citekey`, `doi`, or `zotero_key` required. When re-calling after `needs_attachment_selection`, include both the original identifier and `selected_attachment_id`.

**Behavior:**
1. Call `api.ready`. If unavailable:
   - If `bbt_export_path` is configured → fall through to BBT export fallback (step 9)
   - Otherwise → fail with: "Zotero is not running, or Better BibTeX is not installed."
2. Dispatch to resolution path A, B, or C per §2 to resolve the citekey
3. If multiple items match DOI search: return `{ status: "needs_item_selection", candidates: [{zotero_key, title, year, journal}, ...] }` (up to 3), where `zotero_key` is already in `"12345:ABCD1234"` format for group-library items (library ID embedded in key — no separate `library_id` field). The agent presents these to the user and re-calls `zotero_fetch_item` with the chosen `zotero_key`. Never silently take the first match.
4. Call `item.export([citekey], "Better CSL JSON", library?)` → parse JSON string result → validate non-empty array
5. Call `item.attachments(citekey, library?)` to get PDF paths
6. Apply PDF selection logic (see §5); if `selected_attachment_id` is set, re-fetch `item.attachments` for the resolved item, verify the ID appears in the filtered PDF candidate set, then proceed — if not found or not a PDF for this item, return error: `"Selected attachment <id> is not a valid PDF for this item."`
7. Validate the selected PDF path (see §7)
8. Return resolved metadata + `pdf_path`
9. **BBT export fallback** (only reached when live API unavailable and `bbt_export_path` configured): if only `zotero_key` was provided (no citekey, no DOI), return error: `"Fallback mode requires citekey or DOI; item-key lookup requires a live Zotero connection."` Otherwise parse export file, resolve by citekey/DOI. If DOI lookup finds multiple matching entries, return error: `"Multiple entries match DOI in export; re-run with citekey to disambiguate."` Return metadata with `pdf_path: undefined`. If no abstract found, return hard error.

**Output:**
```typescript
{
  title: string
  authors: string[]
  year: number
  journal: string
  doi?: string
  abstract?: string
  pdf_path?: string        // validated absolute path; absent if no PDF attached
  citekey: string          // always resolved by this point
  zotero_key?: string      // present in Path B (from item.search) and Path C (from user input); group keys include library prefix ("12345:ABCD1234"); personal library keys are bare ("ABCD1234"); absent in Path A and fallback
  slug_prefix: string      // slugifyReadingTitle(author[0].family ?? author[0].literal) from raw CSL — pre-computed here so slug derivation uses the canonical family name (or literal name when family is absent, e.g. institutional authors like "WHO"), not the formatted authors[] string
}
```

**CSL field normalization** (applied inside `zotero_fetch_item` before returning output):

| Output field | CSL source | Rule |
|---|---|---|
| `title` | `title` | Required string; if missing or empty → error: `"Item has no title."` |
| `authors` | `author[]` | Map each entry: use `family` if present (`"family"` + `" " + initials(given)`), else use `literal`; filter empty strings; if resulting array is empty → error: `"Item has no author."` `initials(given)`: split `given` on whitespace and hyphens, take the first character of each part uppercased, join without separator (e.g. `"John" → "J"`, `"John Paul" → "JP"`, `"J." → "J"`); if `given` is absent or empty, omit the initials portion and use `family` alone. |
| `year` | `issued.date-parts[0][0]` | Required integer; if `issued` absent or `date-parts[0][0]` not a number → error: `"Item has no publication year."` |
| `journal` | `container-title` | Required string; if missing or empty → error: `"Item has no journal/container title."` |
| `doi` | `DOI` | Optional; omit if absent |
| `abstract` | `abstract` | Optional; omit if absent |

All four required fields (`title`, `authors`, `year`, `journal`) must be present and non-empty; any missing field is a hard error naming the field.

### `zotero_prepare_bundle`

Prepares the vault attachment directory and copies the PDF. This runs in the same agent turn as the narration — the runtime executes tool calls immediately, so the user cannot intervene between the "Copying PDF…" message and the actual write. The first real user-consent checkpoint is the `pending_edit` returned by `ingest_reading_bundle` (step 6). The narration is informational only.

**Input:**
```typescript
slug: string             // follows Spec 1 naming: first-author-year-title-kebab
pdf_path?: string        // validated absolute path from zotero_fetch_item
abstract?: string        // used only if no pdf_path (abstract-only mode)
```

**Behavior:**
0. Validate `slug` matches `/^[a-z0-9][a-z0-9-]*$/` before constructing any path. If not, return `{ error: "Invalid slug format." }`.
   If both `pdf_path` and `abstract` are provided, prefer PDF — proceed as PDF mode and ignore `abstract`.
1. If `Reading/attachments/<slug>/` already exists and has **no** `.zotero-bundle` marker: return error — a pre-existing manual bundle is present; refuse to proceed. User must remove or rename the directory first.
2. If `Reading/attachments/<slug>/` already exists and **has** a `.zotero-bundle` marker: this is an idempotent retry of a previous Zotero prepare; continue to step 3 (directory already exists — step 3 is a no-op; the marker is merged rather than replaced in step 6).
3. If `Reading/attachments/<slug>/` does not exist: create the directory (empty — no marker yet).
4. If `pdf_path` provided:
   - If `Reading/attachments/<slug>/paper.pdf` already exists: compute its SHA-256 and compare to the source file.
     - Matches: skip write; do **not** add to `files_created_this_run`
     - Differs: return error — do not overwrite silently; user must delete or rename the existing file before re-running
   - If not present: write PDF to a temp file, then atomically rename to `Reading/attachments/<slug>/paper.pdf`; compute SHA-256; add `"paper.pdf"` to `files_created_this_run`
5. If no `pdf_path` (abstract-only mode):
   - If `Reading/attachments/<slug>/abstract.md` already exists: compute its SHA-256 and compare to the source text.
     - Matches: skip write; do **not** add to `files_created_this_run`
     - Differs: return error — do not overwrite silently
   - If not present: write abstract text to `Reading/attachments/<slug>/abstract.md` as Markdown: a level-1 heading `# Abstract` followed by a blank line and the abstract text as a paragraph; compute SHA-256; add `"abstract.md"` to `files_created_this_run`
6. Write `.zotero-bundle` JSON marker (after all files are successfully written and hashed):
   ```json
   { "created_by": "zotero_prepare_bundle", "files": { "<filename>": "<sha256>" } }
   ```
   **On retry (step 2 path):** read the existing marker, merge new file hashes in, and write back atomically — never replace the whole marker (prevents forgetting files written in a prior partial run). **On fresh create (step 3 path):** write a new marker with only the files written in this call. **If the marker write fails:** delete any files written by this call (the PDF or `abstract.md`), then remove the directory if this call created it and it is now empty; return an error.
7. Return shape depends on mode:
   - PDF branch: `{ source_type: "pdf", source_path: "paper.pdf", files_created_this_run: string[] }`
   - Abstract-only branch: `{ source_type: "notes", source_path: "abstract.md", files_created_this_run: string[] }`
   `files_created_this_run` lists every file written by this call. It is **empty** when all files already existed with matching hashes — no files were written this run. This value alone does not determine whether cleanup is needed; the full cancel-flow decision is in agent orchestration step 7 below.
8. **Cleanup note:** If the user cancels the scaffold step, the agent follows the cancel-flow rule in orchestration step 7 (§3). Cleanup depends on `zotero_files_created` **and** a vault check — not solely on this tool's return value.

### `zotero_cleanup_bundle`

Removes the vault attachment directory created by `zotero_prepare_bundle` when the user cancels the ingestion.

**Input:**
```typescript
slug: string
files?: string[]  // optional: files to consider for deletion (files_created_this_run from zotero_prepare_bundle).
                  // If omitted, all marker entries are candidates — full manual/admin cleanup mode.
```

**Behavior:**
- Reads `.zotero-bundle` JSON marker. If absent, refuses to operate.
- **If `files` is provided (scoped cancel cleanup):** For each file in `files`: if also in `marker.files`, compute its SHA-256 and delete only if the hash matches. Files in `marker.files` but absent from `files` are never touched — this scopes deletion to what the current run created.
- **If `files` is omitted (full manual/admin cleanup):** For each file in `marker.files`: compute its SHA-256 and delete if the hash matches.
- After deletion: rebuild `marker.files` keeping only entries that are still on disk and were not deleted — specifically: `out-of-scope` entries (in `marker.files` but not in `files` parameter) and `hash-mismatch` entries (file exists but hash changed — user-modified). Drop `deleted` entries and `not-found` entries (file already gone — no ownership to preserve). If any tracked entries remain, rewrite `.zotero-bundle` with the updated map. Delete `.zotero-bundle` only when no tracked files remain.
- If the directory is now empty, remove it. If other files remain, leave the directory.
- Returns a summary listing what was deleted, what was skipped, and whether the directory was removed.

**Rationale:** Hash-gated scoped deletion prevents cleanup from destroying user-modified files during a retry, while still cleaning up all unmodified Zotero-created files.

### Agent orchestration (no `zotero_ingest` tool)

There is no `zotero_ingest` facade tool. The agent calls the three Zotero tools directly in sequence, then hands off to the existing reading pipeline. This keeps each tool's contract clean and avoids an orchestrator whose "agent steps after calling this tool" description was not a real tool contract.

**Agent steps (triggered by user command):**
1. `zotero_fetch_item` → metadata + validated `pdf_path` (or `needs_item_selection` / `needs_attachment_selection` — handle disambiguation first)
2. Derive slug: `{slug_prefix}-{year}-{slugifyReadingTitle(title)}` where `slug_prefix` comes from `zotero_fetch_item` output. Never derive from citekey.
3. **Collision check:** first check whether the slug exists in both `Reading/Papers/<slug>.md` **and** `Reading/Threads/<slug>.md`. If both exist, stop immediately: return error `"Slug '<slug>' found in both Reading/Papers/ and Reading/Threads/. Resolve the duplicate manually before proceeding."` Do not attempt an update. If a note exists in exactly one location, apply this decision table in order (stop at first matching row):

   The table is organized around the **strongest identifier shared by both sides** (i.e. present in the existing note AND returned by the current fetch). Evaluate tiers in order; stop at the first tier where both sides have the identifier.

   | Shared identifier tier | Both sides agree | Sides disagree |
   |---|---|---|
   | **`zotero_key`** (both existing note and fetched item have it) | Same paper — proceed silently. If citekey also differs, refresh it. | Different paper — stop and ask user. |
   | **DOI** (either side lacks `zotero_key`, but both have a DOI) | Same paper (`normalizeDoi()` match) — proceed silently. If citekey also differs, refresh it. | Different paper — stop and ask user. |
   | **`citekey`** (neither side has `zotero_key` or DOI, but both have a citekey) | Weak identity confirmed — proceed silently. | Ambiguous (no stronger ID to confirm) — stop and ask user. |
   | **No shared identifier** (existing note has none of `zotero_key`/DOI/`citekey`) | — | Slug match only — stop and ask user. |

   **Key clarification:** if the existing note has a `zotero_key` but the fetched item does not (Path A / fallback cannot retrieve the item key), `zotero_key` is not a shared identifier — skip that tier and evaluate DOI next. The stored `zotero_key` is preserved in the note per the optional-identifier rule regardless of which tier resolves the check.

   Note: "stop and ask user" means return an error describing the conflict; do not proceed with the update.
   - **On silent proceed (update):** `ingest_reading_bundle` must:
     - **Body:** preserve the existing body unchanged.
     - **Required fields:** refresh `title`, `authors`, `year`, `journal`, `citekey` from fetched metadata.
     - **Optional identifiers (`doi`, `zotero_key`):** overwrite only when the new fetch provides a non-empty value; otherwise keep the existing value. Never clear a stored identifier because the current lookup path did not return it.
     - **Sources — determine `effective_sources`:**
       - If the existing sources include a `pdf` entry and the incoming sources include only a `notes` entry (downgrade attempt): `effective_sources = existing sources`; include `message: "Existing PDF source preserved; abstract-only rerun would downgrade it. Provide a PDF to upgrade."` in the `pending_edit` payload. The runtime must pass this `message` field through in the `pending_confirmation` response. Do not error.
       - Otherwise (same, upgrade, or new sources): `effective_sources = incoming sources`.
     - **Workflow state and body** — compare `effective_sources` to the existing sources using **order-insensitive set equality**: two source lists are equal if and only if, after normalizing each entry via `normalizeReadingSources`, they contain the same set of `{type, path}` pairs (duplicates already removed by normalization). Position in the array is irrelevant.
       - `effective_sources` unchanged: preserve `status`, `kb_status`; preserve body content but apply `syncReadingBodyTitle(body, title)` to sync the H1 heading to the refreshed title.
       - `effective_sources` changed: reset `status: draft`, `kb_status: pending`, and the body to the placeholder scaffold.
     - **Always preserve:** `related_projects`, `tags`, `read_date`.
     - **Implementation note:** when the slug already exists, `ingest_reading_bundle` reads the existing note's frontmatter and body before computing `effective_sources` and applying update rules. The agent does not need to pass existing state — the tool performs the read internally.
4. Narrate (informational — no consent pause; write happens in the same turn):
   - If `pdf_path` present: "Copying PDF to vault at `Reading/attachments/<slug>/paper.pdf`…"
   - If no `pdf_path` (abstract-only): "Writing abstract to vault at `Reading/attachments/<slug>/abstract.md`…"
5. `zotero_prepare_bundle` → creates attachment dir + copies PDF (or writes `abstract.md`) → capture `files_created_this_run` from the response (empty list means all files already existed with matching hashes — no new files written this run; does **not** imply the bundle is committed)
6. `ingest_reading_bundle` with metadata (including `citekey`, `zotero_key`) + source from step 5 + `zotero_managed: true` + `zotero_files_created: <files_created_this_run from step 5>`
   → returns `pending_edit` for scaffold note, with `zotero_slug`, `zotero_files_created`, and `note_rel_path` encoded in its meta only when `zotero_managed: true` is set. `note_rel_path` is the vault-relative path of the scaffold note (derived by stripping the vault root from `pending_edit.path`, e.g. `Reading/Papers/<slug>.md`). It is emitted by `ingest_reading_bundle` — not extracted by the runtime — because only the tool knows the vault root needed to strip the absolute path.
7. **Cancel flow:** `ingest_reading_bundle` includes `{ zotero_slug, zotero_files_created, note_rel_path }` in the `pending_edit` meta. The runtime preserves all three via the generic `parsed.meta` passthrough. On cancel, `get_workflow_events` returns an event carrying these fields. The agent applies this rule:
   - **`zotero_files_created` non-empty:** call `zotero_cleanup_bundle(slug: zotero_slug, files: zotero_files_created)` — current run created files that need cleaning.
   - **`zotero_files_created` empty:** call `vault_read(note_rel_path)` to check vault state.
     - Note exists → bundle belongs to a confirmed prior note; skip cleanup.
     - Note does not exist → abandoned prior run (files existed but note was never confirmed); call `zotero_cleanup_bundle(slug)` with `files` omitted (full marker-based cleanup).
   An empty `files_created_this_run` alone is not proof the bundle is committed — it only means no new files were written this run. After step 8 (scaffold confirmed), the bundle is committed; no cleanup on later cancels.
   - Cleanup is best-effort: requires the user to click Continue after cancel. If the session is abandoned, the bundle persists and the user removes it manually.
   - The agent prompt (`context.ts`) must encode this rule and prompt the user to click Continue after a scaffold cancel.
8. User confirms scaffold → note on disk. Use `note_rel_path` from the `pending_edit` meta for all follow-up tool calls (vault-relative, e.g. `Reading/Papers/<slug>.md` or `Reading/Threads/<slug>.md` — do not hardcode, do not use the absolute `pending_edit.path`).
9. **Summarize decision:** if `auto_summarize: true` (default) or the user explicitly requested summarization, proceed: `compile_reading_note({ path: note_rel_path })` → returns CREATE content to agent → agent calls `vault_write` → second `pending_edit`. If `auto_summarize: false` and no explicit user request, stop here — report the scaffold note path and offer to summarize on demand. Explicit user commands always override `auto_summarize`. This decision is enforced in the agent context prompt (`context.ts`).
10. User confirms → final note on disk

---

## 4. Workflow

User command in Obsidian chat:
```
> ingest smith2026 from zotero
> summarise 10.1016/j.cell.2026.01.001 from my zotero
```

Agent flow:
```
zotero_fetch_item(citekey="smith2026")
→ item.export → item.attachments
→ { title: "IL-42 Mediated Suppression...", authors: ["Smith J", ...], year: 2026,
    pdf_path (validated), citekey: "smith2026", slug_prefix: "smith" }  // zotero_key absent — Path A cannot retrieve it

slug = "smith-2026-il42-mediated-suppression"   ← slug_prefix-year-slugifyReadingTitle(title)

[agent informs user: "Copying PDF to Reading/attachments/smith-2026-il42-mediated-suppression/paper.pdf"]

zotero_prepare_bundle(slug, pdf_path)
→ copies PDF → Reading/attachments/smith-2026-il42-mediated-suppression/paper.pdf
→ { source_type: "pdf", source_path: "paper.pdf", files_created_this_run: ["paper.pdf"] }

ingest_reading_bundle({
  slug: "smith-2026-il42-mediated-suppression",
  title: "IL-42 Mediated Suppression...",
  authors: ["Smith J", ...], year: 2026,
  journal: "Cell", doi: "10.1016/j.cell.2026.01.001",
  citekey: "smith2026",
  sources: [{ type: "pdf", path: "paper.pdf" }],
  zotero_managed: true,
  zotero_files_created: ["paper.pdf"]
})
→ pending_edit: {
    note_rel_path: "Reading/Papers/smith-2026-il42-mediated-suppression.md",  // vault-relative — use for all tool calls
    path: "/abs/vault/Reading/Papers/smith-2026-il42-mediated-suppression.md",  // runtime-internal absolute — do not pass to tools
    ...
  }
  (or Reading/Threads/... if a thread note already exists for this slug)

[user cancels (first run — files_created non-empty)?
  → zotero_cleanup_bundle(slug, files: ["paper.pdf"]) removes only newly created files; marker rewritten or deleted depending on surviving entries]
[user cancels (retry — files_created empty)?
  → vault_read(note_rel_path): note found → skip cleanup; note absent → zotero_cleanup_bundle(slug) full cleanup]
[user confirms → scaffold on disk at note_rel_path]

compile_reading_note({ path: note_rel_path })
→ reads paper.pdf (within vault), returns CREATE content to agent
→ agent calls vault_write with drafted note → pending_edit: filled note

[user confirms — final note]
```

---

## 5. PDF Selection Logic

When `item.attachments` returns multiple attachments:
1. Prefer `contentType: "application/pdf"` with `parentItem` matching resolved item key
2. If multiple PDFs match: return `{ status: "needs_attachment_selection", attachments: [{id, filename, size}, ...] }`. The agent presents the list and re-calls `zotero_fetch_item` with `selected_attachment_id`. (Same structured multi-turn pattern as item disambiguation.)
3. If no PDF: use abstract-only mode only if `abstract` is present in the metadata — otherwise return the same hard error as the fallback path:
   > "No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry."

---

## 6. Reading Note Output Format

The frontmatter uses existing `buildReadingFrontmatter` fields plus two new Zotero fields (`citekey`, `zotero_key`) added via schema extension (see §9):

**PDF mode** (PDF attached):
```yaml
---
title: "IL-42 Mediated Suppression of CD8+ T Cells"
authors: ["Smith J", "Lee K"]
year: 2026
journal: "Cell"
doi: "10.1016/j.cell.2026.01.001"
citekey: "smith2026"
zotero_key: "ABCD1234"   # optional — present only when item key was known (Path B, C)
read_date: 2026-04-18
status: draft
sources:
  - type: pdf
    path: "paper.pdf"
---
```

**Abstract-only mode** (no PDF attached, abstract present):
```yaml
---
title: "IL-42 Mediated Suppression of CD8+ T Cells"
authors: ["Smith J", "Lee K"]
year: 2026
journal: "Cell"
doi: "10.1016/j.cell.2026.01.001"
citekey: "smith2026"
zotero_key: "ABCD1234"
read_date: 2026-04-18
status: draft
sources:
  - type: notes
    path: "abstract.md"
---
```

**Status:** `draft` (valid per `parser.ts`).
**Source paths:** attachment-relative, exactly as `ingest_reading_bundle` and `source-loader` expect: `paper.pdf` for PDF mode, `abstract.md` for abstract-only mode.
**No serial:** Reading notes carry no `PR{NNN}` serial per Spec 1.

---

## 7. Security: PDF Validation

`validateZoteroAttachment(pdfPath, storageRootConfig)` — called by both `zotero_fetch_item` (before returning `pdf_path`) and again inside `zotero_prepare_bundle` immediately before the copy, to guard against TOCTOU races. The copy itself is done via a temp file plus atomic rename to prevent partial writes.

**Storage root validation:** reject `storage_root` values that resolve to `/`, a home directory root (`~`), or any path that is a prefix of the vault root — these would make the path-escape check ineffective. The `api_port` must be a numeric value in the range 1–65535; `127.0.0.1` is hardcoded as the host (no configurable host to prevent SSRF).

```typescript
const realRoot = realpathSync(storageRootConfig);       // resolve storage root first
const lstatResult = lstatSync(pdfPath);                 // lstat on ORIGINAL path
if (lstatResult.isSymbolicLink()) throw new Error("symlink rejected");
const realPdf = realpathSync(pdfPath);                  // follow to real path
if (realPdf !== realRoot && !realPdf.startsWith(realRoot + path.sep))
  throw new Error("path outside Zotero storage root");
const statResult = statSync(realPdf);
if (!statResult.isFile()) throw new Error("not a regular file");
if (!realPdf.toLowerCase().endsWith(".pdf")) throw new Error("not a .pdf");
const magic = readFirstBytes(realPdf, 4);
if (magic.toString() !== "%PDF") throw new Error("not a PDF (magic bytes)");
if (statResult.size > 100 * 1024 * 1024) throw new Error("PDF exceeds 100MB limit");
```

---

## 8. Long PDF Behavior

The existing `extractPdf` in `source-loader.ts` caps extraction at **20 pages** and **10,000 tokens**. This spec does not change `source-loader.ts`, so the agent cannot know the actual page count. The agent therefore appends this note unconditionally after every Zotero PDF summary:

> Note: PDF extraction is capped at 20 pages. If this paper is longer, review and expand the summary manually.

---

## 9. Settings

New optional block extends `CrickNoteConfig` in `src/config/config.ts`:

```typescript
zotero?: {
  enabled: boolean           // default false
  api_port: number           // default 23119
  storage_root: string       // default ~/Zotero/storage — used in validateZoteroAttachment
  bbt_export_path?: string   // fallback BBT JSON export path
  auto_summarize: boolean    // default true
}
```

**`enabled` behavior:** when `false` (default), all Zotero tools return `{ error: "Zotero integration is not enabled. Set zotero.enabled: true in your CrickNote config." }`. Tools are registered regardless; the check occurs at call time.

**`auto_summarize` behavior:** when `true` (default), the agent proceeds to `compile_reading_note` automatically after scaffold confirmation. When `false`, the agent stops after scaffold and offers to summarize on demand. Explicit user commands always override this flag. `assembleSystemPrompt` (in `context.ts`) reads the resolved `zotero.auto_summarize` value from `CrickNoteConfig` and injects it as a named rule into the system prompt — the agent reads this from the prompt, it is not re-fetched per turn, and it is not passed as a tool argument.

Server-side tools read `CrickNoteConfig` directly. No WebSocket config endpoint is added by this spec.

---

## 10. Implementation Scope

| Area | Change |
|------|--------|
| `src/agent/tools/zotero-tools.ts` | New: `zotero_fetch_item`, `zotero_prepare_bundle`, `zotero_cleanup_bundle`, `validateZoteroAttachment` (no `zotero_ingest` — agent orchestrates directly) |
| `src/config/config.ts` | Extend `CrickNoteConfig` with optional `zotero` block; add config normalization for nested defaults (`enabled`, `api_port`, `storage_root`, `auto_summarize`), `~` expansion, port range validation, and storage root safety check |
| `src/agent/runtime.ts` | Register new Zotero tools; extend pending-edit meta passthrough via a generic `parsed.meta` object (not field-by-field hardcoding) so `zotero_slug`, `zotero_files_created`, `note_rel_path`, and any future fields flow into workflow event payloads without runtime changes; pass `parsed.message` through in the `pending_confirmation` response so downgrade-protection notices reach the agent |
| `src/agent/context.ts` | Teach agent the Zotero workflow order; encode cancel-cleanup rule: after any scaffold `edit_cancelled` event, proactively call `get_workflow_events` — if `zotero_slug` is present: (a) if `zotero_files_created` non-empty → `zotero_cleanup_bundle(slug, files)`; (b) if empty → `vault_read(note_rel_path from event)`: note exists → skip, note absent → `zotero_cleanup_bundle(slug)` full cleanup; prompt user to click Continue after scaffold cancel so the cleanup turn executes; inject resolved `zotero.auto_summarize` value from `CrickNoteConfig` into the assembled system prompt as a named rule (agent reads from prompt, not from a tool call). `assembleSystemPrompt` gains an optional third argument `config?: CrickNoteConfig`; `AgentRuntime` passes `this.config` when calling it. |
| `src/knowledge/reading-note.ts` | Extend reading metadata type + `buildReadingFrontmatter` for optional `citekey`, `zotero_key` |
| `src/agent/tools/reading-intake.ts` | Accept optional `citekey`, `zotero_key`, `zotero_managed: boolean`, `zotero_files_created: string[]` in tool schema; pass `citekey`, `zotero_key` through to frontmatter builder; when `zotero_managed` is true, emit `zotero_slug`, `zotero_files_created`, and `note_rel_path` (vault-relative note path, computed by stripping `vaultPath` prefix from the absolute `pending_edit.path`) in the `pending_edit` meta; add `.zotero-bundle` to `IGNORED_BUNDLE_FILES` (`reading-intake.ts:48`); on silent-proceed update: compute `effective_sources`, apply downgrade-protection rule, reset body/status/kb_status when `effective_sources` changed, sync H1 via `syncReadingBodyTitle` when unchanged, preserve optional identifiers (`doi`, `zotero_key`) from existing note when new fetch omits them |
| `tests/zotero-tools.test.ts` | Unit tests with mocked Zotero API responses |

**No changes to:**
- `source-loader.ts` — vault boundary stays intact; PDF is copied in before ingestion
- `auto-writer.ts` — Zotero notes use `pending_edit` / `vault_write`, not `autoWrite`

---

## 11. Test Coverage

- `api.ready` success and failure (connection refused, 404)
- Path A (citekey): `item.export` + `item.attachments` → metadata + PDF
- Path B (DOI): `item.search` condition → `item.citationkey` map → `item.export` + `item.attachments`
- Path C (item key): `item.citationkey` map → `item.export` + `item.attachments`
- `item.attachments` — single PDF, multiple PDFs, no PDF, non-PDF attachment only
- Multiple items returned by DOI search (disambiguation)
- Group library support: Path C with `12345:ABCD1234` key format; library ID extracted for subsequent `item.export`/`item.attachments` calls
- Zotero not running → BBT export fallback (metadata-only, no pdf_path)
- BBT fallback: confirms `pdf_path` is absent and agent enters abstract-only mode
- Malformed BBT export JSON
- Abstract-only mode: `abstract.md` written, ingested as `notes` source
- `validateZoteroAttachment`: rejects symlinks (lstat check), wrong extension, non-PDF magic bytes, path outside storage root (separator-aware check), files exceeding 100MB; `storage_root` with `~` expanded before `realpathSync`
- `zotero_prepare_bundle`: collision with existing `paper.pdf` → error, not silent overwrite
- `zotero_prepare_bundle`: directory created first, file written via temp+atomic rename, SHA-256 computed, marker written last — pre-existing markerless dir triggers error; idempotent retry on already-stamped dir; file already exists with matching SHA-256 → skipped, not added to `files_created_this_run`
- `zotero_cleanup_bundle`: deletes dir only when `.zotero-bundle` marker present; refuses when marker absent; only deletes files listed in `files` parameter that also hash-match the marker — files in marker but not in `files` are untouched
- `.zotero-bundle` file ignored by `discoverBundle` — no "unsupported file" warnings on Zotero-imported bundles
- Path A (citekey): `zotero_key` absent from output; frontmatter field is optional
- Path B/C: `zotero_key` present (from `item.search` response / user input respectively)
- Cancel flow (scaffold step, first run): `ingest_reading_bundle` pending_edit meta includes `zotero_slug` and non-empty `zotero_files_created`; `get_workflow_events` returns `edit_cancelled` with both set; agent calls `zotero_cleanup_bundle(slug, files: [...])` with the per-run list; hash-matched files deleted; marker rewritten with surviving entries or deleted if none remain; dir removed if empty
- Cancel flow (scaffold step, mixed-mode retry — e.g. abstract-only then PDF): only PDF in `files_created_this_run`; cleanup deletes PDF; `abstract.md` in marker but not in `files` → untouched; marker rewritten with `abstract.md` entry
- Cancel flow (rerun, note confirmed): `files_created_this_run: []`; cancel event has empty `zotero_files_created`; agent calls `vault_read(note_rel_path)` → note found → cleanup skipped; bundle untouched
- Cancel flow (rerun, note NOT confirmed — abandoned prior run): `files_created_this_run: []`; agent calls `vault_read(note_rel_path)` → not found → `zotero_cleanup_bundle(slug)` with `files` omitted; all hash-matched entries deleted; marker deleted when none remain
- Cancel flow (summary step): no `zotero_slug` in compile/vault_write event → no cleanup called
- Cancel flow (session abandoned): bundle dir persists; user calls `zotero_cleanup_bundle(slug)` with `files` omitted → full marker-based cleanup; all hash-matched entries deleted; marker deleted when no entries remain
- `compile_reading_note` → agent gets CREATE content → `vault_write` → second `pending_edit` (not direct `pending_edit` from `compile_reading_note`)
- `item.export` returns JSON string → `JSON.parse` → validate array shape before reading fields
- DOI search multiple matches → `needs_item_selection` response with up to 3 candidates; resolved by re-call with `zotero_key`
- Multiple PDFs → `needs_attachment_selection` response; resolved by re-call with `selected_attachment_id`
- No-PDF + no-abstract (live Zotero): hard error, not abstract-only mode
- Slug collision, stronger-ID (`zotero_key` or DOI) contradiction → error, not silent overwrite
- Slug collision, citekey-only drift with `zotero_key` or DOI agreeing → proceed silently; stored citekey refreshed to new value; no error
- Config normalization: missing nested Zotero defaults filled in; `~` expanded; port out of range rejected; storage root resolving to `/` or vault root rejected
- `validateZoteroAttachment` called twice (fetch + before copy); atomic rename copy
- Cleanup hash mismatch: user-modified file skipped (kept in rewritten marker), unmodified files deleted, summary returned
- Cleanup: tracked file manually removed before cleanup runs → entry dropped from rewritten marker (no ghost ownership); other entries processed normally
- Fallback metadata with no abstract → `zotero_fetch_item` returns hard error, not dead-end at `ingest_reading_bundle`
- Path B (DOI) multiple matches → surfaces up to 3 candidates for user disambiguation; does not silently take first match
- `item.search` condition shape: `[["DOI", "is", normalizeDoi(doi)]]` (double-nested tuple array, normalized value); triple-nesting is wrong; raw un-normalized DOI input (e.g. `"https://doi.org/10.1016/J.Cell"`) must be normalized before the call
- Slug derived from `slug_prefix-year-slugifyReadingTitle(title)` where `slug_prefix` comes from `zotero_fetch_item` output; not derived from citekey or formatted `authors[]` string
- `effective_sources` equality is order-insensitive: `[{type:"pdf",path:"paper.pdf"},{type:"notes",path:"abstract.md"}]` equals `[{type:"notes",path:"abstract.md"},{type:"pdf",path:"paper.pdf"}]` — body and workflow state preserved, not reset
- `ingest_reading_bundle` result path used for `compile_reading_note` — covers both `Reading/Papers/` and `Reading/Threads/` cases
- `ingest_reading_bundle` (with `zotero_managed: true`) emits `note_rel_path` in `pending_edit.meta`; assert field present and non-empty in the workflow event payload
- `note_rel_path` is vault-relative (no leading `/`, does not contain the vault root prefix); `pending_edit.path` is absolute and runtime-internal — assert they differ and that tools are never called with `pending_edit.path`
- Follow-up tools receive `note_rel_path`, not `pending_edit.path`: `vault_read(note_rel_path)` in cancel-flow check and `compile_reading_note({ path: note_rel_path })` after confirmation both succeed; same calls with `pending_edit.path` produce a path-boundary error
- Preservation of existing reading-note content on update
- `zotero.enabled: false` → all Zotero tools return the disabled error message; assert no tool proceeds past the guard check
- `zotero.enabled: true` → tools proceed normally (sanity check that guard does not fire)
- `auto_summarize: true` (default) → agent calls `compile_reading_note` automatically after scaffold confirmation without waiting for user request
- `auto_summarize: false` → agent stops after scaffold confirmation, reports note path, offers to summarize; `compile_reading_note` is NOT called unless user explicitly requests it
- `selected_attachment_id` valid (in candidate set for resolved item) → proceeds to copy; invalid (different item, non-PDF, or absent from attachment list) → deterministic error with the ID named
- Fallback mode with `zotero_key` only (no citekey, no DOI) → error: "Fallback mode requires citekey or DOI; item-key lookup requires a live Zotero connection."
- Section 6 output shape: PDF mode produces `sources: [{ type: pdf, path: "paper.pdf" }]`; abstract-only mode produces `sources: [{ type: notes, path: "abstract.md" }]`
- CSL normalization: missing `title` → error naming field; empty `author[]` → error; `issued` absent → error; missing `container-title` → error
- CSL normalization: `author[0] = { family: "Smith", given: "John" }` → `authors[0] = "Smith J"`; `author[0] = { literal: "WHO" }` → `authors[0] = "WHO"`
- BBT fallback duplicate DOI → error: "Multiple entries match DOI in export; re-run with citekey to disambiguate."
- Existing-note update, `effective_sources` unchanged: body preserved except H1 synced via `syncReadingBodyTitle`; `status`/`kb_status` preserved; `related_projects`/`tags`/`read_date` preserved
- Existing-note update, `effective_sources` changed (e.g. abstract→PDF upgrade): body reset to placeholder scaffold; `status: draft`; `kb_status: pending`
- Existing-note update, abstract-only rerun against existing PDF source (downgrade blocked): `effective_sources = existing sources`; `pending_edit` payload includes `message` field; runtime passes `message` through in `pending_confirmation`; agent surfaces it to user; no error; body/status/kb_status unchanged (effective_sources unchanged)
- Existing-note update, optional id (`doi`/`zotero_key`) absent from new fetch: existing stored value preserved; not cleared
- `auto_summarize` value injected into system prompt by `assembleSystemPrompt`: agent reads it from prompt, not from a tool call
- Collision check: `zotero_key` matches → proceed silently; citekey drift refreshed
- Collision check: `zotero_key` contradicts → stop and ask user
- Collision check: no `zotero_key` on either side; DOI matches via `normalizeDoi()` → proceed silently; citekey drift refreshed
- Collision check: no `zotero_key`; DOI contradicts → stop and ask user
- Collision check: no `zotero_key`, no DOI on either side; citekey matches → proceed silently (weak identity)
- Collision check: no `zotero_key`, no DOI on either side; citekey mismatches → stop and ask user (ambiguous)
- Collision check: existing note has none of `zotero_key`/DOI/`citekey` → stop and ask user (slug-match only)
- `needs_item_selection` candidate shape has no `library_id` field; library ID embedded in `zotero_key` string
- `zotero_prepare_bundle`: both `pdf_path` and `abstract` provided → PDF mode used; `abstract` ignored
- CSL `initials("John Paul")` → `"JP"`; `initials("J.")` → `"J"`; `given` absent → use `family` alone
- DOI normalization: `normalizeDoi("https://doi.org/10.1016/J.Cell")` → `"10.1016/j.cell"`; same result for `http://` prefix and mixed-case input; used in Path B search, fallback lookup, collision check, and stored `doi` field
- `assembleSystemPrompt` accepts optional third `config?: CrickNoteConfig` argument; `AgentRuntime` passes `this.config`
- `slug_prefix` in `zotero_fetch_item` output: `author[0].family = "de Bruijn"` → `slug_prefix = "de-bruijn"`; `author[0].family = "Smith"` → `slug_prefix = "smith"`; slug derivation uses `slug_prefix`, not `authors[0]` formatted string
- Path B personal library item (libraryID=1): assembled key is bare `"ABCD1234"`, not `"1:ABCD1234"`; group library (libraryID>1): `"12345:ABCD1234"`; stored `zotero_key` matches this format
- `abstract.md` content format: `# Abstract\n\n<abstract text as paragraph>`; source-loader reads it as a notes source
- `zotero_prepare_bundle` slug validation: `"smith-2026-il42"` passes; `"../evil"` or `"Smith_2026"` return `{ error: "Invalid slug format." }`
- Tool errors use `{ error: string }` shape consistently; no exceptions for user-facing conditions
- Collision check: existing note has `zotero_key`, fetched item has no `zotero_key` (Path A / fallback) → skip key comparison; fall through to DOI row
- `slug_prefix` for literal-only author: `author[0] = { literal: "WHO" }` → `slug_prefix = "who"`; `author[0] = { literal: "World Health Organization" }` → `slug_prefix = "world-health-organization"`
- Duplicate slug: both `Reading/Papers/<slug>.md` and `Reading/Threads/<slug>.md` exist → error naming both paths; no update attempted

---

## 12. Open Questions

1. **Overwrite behavior:** When `paper.pdf` already exists and differs, the tool errors with instructions. An interactive confirmation flow could be added in a future iteration.

2. **Group libraries:** Library ID is embedded in `zotero_key` using the `"12345:ABCD1234"` format — there is no separate `library_id` parameter. Auto-discovery of group library IDs is deferred to a future spec.

3. **Zero-copy future:** If users want to avoid copying PDFs into the vault, that requires adding an external-source model throughout the pipeline. Explicitly deferred.
