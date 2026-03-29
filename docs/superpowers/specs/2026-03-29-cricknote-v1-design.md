# CrickNote V1 — Design Specification

## Context

CrickNote is a scientific research assistant for biology/life sciences researchers who use Obsidian as their primary knowledge base. The core problem: experiment records, protocols, literature notes, and daily planning are scattered and hard to retrieve reliably. Researchers need a conversational interface that can record structured experiment data into Obsidian and retrieve it accurately — especially under time pressure in the lab.

V1 focuses on **trustworthy local retrieval and safe vault editing** via an Obsidian chat panel. External channels (Slack, Telegram) are deferred to V2/V3 — the hard part is getting local scientific retrieval right first.

Architecture is inspired by [OpenClaw](https://ppaolo.substack.com/p/openclaw-system-architecture-overview) — a gateway + agent runtime + channel adapter pattern — but scoped to a single channel (Obsidian plugin) for V1.

---

## V1 Scope

### In Scope
- Obsidian sidebar chat panel (plugin)
- Local agent service (manual start via CLI)
- WebSocket communication (localhost, token + version handshake)
- Multi-provider LLM (Claude + GPT)
- Vault ingestion with background indexing
- Structured-first, semantic-second retrieval
- Safe editing: conflict detection → diff preview → user confirmation → audit log → atomic write → undo
- Note templates: experiment, protocol, reading, daily diary
- Manual task management (read/add/complete tasks in diary notes)
- CLI: `cricknote setup`, `cricknote start`, `cricknote reindex`, `cricknote rotate-token`

### Deferred
- **V1.5**: Auto-start (LaunchAgent / plugin-spawned), scheduler (morning digest, reminders, daily summary, weekly review)
- **V2**: Slack adapter, gateway upgrade, privacy/trust model
- **V3**: Telegram adapter, multi-channel routing

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     OBSIDIAN PLUGIN                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Chat Panel (sidebar leaf)                                    │   │
│  │  • Conversation with agent                                    │   │
│  │  • Diff preview + conflict resolution before writes           │   │
│  │  • [Apply] [Edit] [Cancel] confirmations                      │   │
│  │  • Indexing progress indicator                                │   │
│  └──────────────────────┬───────────────────────────────────────┘   │
│                          │ WebSocket (127.0.0.1, token + version)    │
├──────────────────────────┼──────────────────────────────────────────┤
│                          ▼                                           │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │           LOCAL AGENT SERVICE (single Node.js process)          │ │
│  │                                                                │ │
│  │  ┌──────────────┐   ┌──────────────┐                          │ │
│  │  │  Agent        │   │  Tool        │                          │ │
│  │  │  Runtime      │   │  Executor    │                          │ │
│  │  │  (main thread)│   │              │                          │ │
│  │  └───────────────┘   └──────────────┘                          │ │
│  │                                                                │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │  Background Ingestion (worker thread or async queue)      │ │ │
│  │  │  • File watcher (chokidar, 1.5s debounce)               │ │ │
│  │  │  • Frontmatter parser + validator                        │ │ │
│  │  │  • Chunker + embedding generator (async, non-blocking)   │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  │                                                                │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │  WebSocket Server (127.0.0.1:18789)                       │ │ │
│  │  │  Loopback-only + token auth + version handshake           │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                      │
├──────────────────────────────┼─────────────────────────────────────┤
│                              ▼                                      │
│  ┌────────────────────────────────┐  ┌────────────────────────────┐ │
│  │     OBSIDIAN VAULT              │  │  SQLite Database            │ │
│  │     (Source of Truth)           │  │  (~/.cricknote/db.sqlite)  │ │
│  │                                 │  │                             │ │
│  │  Projects/                      │  │  DERIVED (rebuildable):     │ │
│  │  Protocols/                     │  │  • note_metadata            │ │
│  │  Reading/                       │  │  • note_chunks              │ │
│  │  Memory/                        │  │  • chunk_embeddings         │ │
│  │  Agent/                         │  │  • bm25_index (FTS5)       │ │
│  │                                 │  │  • experiment_types         │ │
│  │                                 │  │                             │ │
│  │                                 │  │  DURABLE (app-owned):       │ │
│  │                                 │  │  • chat_sessions            │ │
│  │                                 │  │  • chat_messages            │ │
│  │                                 │  │  • edit_audit_log           │ │
│  │                                 │  │  • indexing_status          │ │
│  │                                 │  │  • schema_version           │ │
│  └────────────────────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket Authentication & Version Handshake

### Token Lifecycle
- Generated during `cricknote setup`, stored at `~/.cricknote/auth-token` (file permissions 0600)
- Rotatable via `cricknote rotate-token`
- Plugin reads token from `~/.cricknote/auth-token` or vault plugin config

### Connection Handshake
1. Server binds `127.0.0.1:18789` only — rejects non-loopback connections
2. Client connects and sends within 5s:
   ```json
   { "type": "auth", "token": "abc...", "protocolVersion": 1, "pluginVersion": "1.0.0" }
   ```
3. Server validates token AND protocol version:
   - Match: `{ "type": "auth_ok", "protocolVersion": 1, "serviceVersion": "1.0.0" }`
   - Token mismatch: disconnect
   - Version mismatch: `{ "type": "auth_error", "reason": "version_mismatch", "required": 1 }`

### Why Both Loopback + Token
- Loopback: no remote access
- Token: no rogue local processes (e.g., malicious browser JS on localhost)
- 0600: only the user can read the token file

---

## Obsidian Vault Structure

```
CrickNote-Vault/
├── Projects/                    # Per-project experiment notes + attachments
│   └── ProjectA-CellMigration/
│       ├── 2026-03-24-western-blot.md
│       └── attachments/
├── Protocols/                   # Lab protocols / SOPs
│   └── western-blot-protocol.md
├── Reading/                     # Literature notes
│   └── smith-2025-cell-migration.md
├── Memory/                      # Human notes: diaries, plans
│   ├── Daily/
│   ├── Weekly/
│   └── Monthly/
└── Agent/                       # Agent configuration
    ├── agent.md                 # Core rules & behavior
    ├── soul.md                  # Personality & tone
    ├── experiment-types.yml     # Seed list of known experiment types
    └── skills/                  # Skill-specific instructions
```

---

## Experiment Frontmatter Schema

### Experiment Notes (Projects/)
```yaml
---
date: 2026-03-24                          # REQUIRED - ISO date
project: ProjectA-CellMigration           # REQUIRED - project folder name
experiment_type: western-blot             # REQUIRED - from experiment-types registry
protocol: "[[western-blot-protocol]]"     # REQUIRED - link to protocol
samples:                                   # REQUIRED
  - name: Sample 1
    condition: control
  - name: Sample 2
    condition: treated-24h
reagents:                                  # RECOMMENDED
  - anti-GAPDH (1:5000)
result_summary: >                          # REQUIRED - brief for index
  Bands at 50kDa and 75kDa.
attachments:                               # RECOMMENDED
  - attachments/gel-image-001.png
status: complete                           # REQUIRED - draft/in-progress/complete
tags: [western-blot, p53]                  # RECOMMENDED
---
```

### Other Note Types
- **Protocol**: title, version, last_updated, category, tags
- **Reading**: title, authors, year, journal, doi, read_date, relevance, key_findings, tags
- **Daily Diary**: date, type (daily-diary)

---

## Experiment Types Registry

The parser needs to match user queries like "Western Blot" to standardized types. This registry has two sources:

### Seed File (`Agent/experiment-types.yml`)
User-defined, always available — even before indexing completes:
```yaml
- name: western-blot
  aliases: ["Western Blot", "WB", "western blotting"]
- name: pcr
  aliases: ["PCR", "polymerase chain reaction", "qPCR", "RT-PCR"]
- name: cell-culture
  aliases: ["cell culture", "passage", "plating"]
```

### Index-Augmented (`experiment_types` table)
During ingestion, new types discovered in frontmatter are added to the SQLite table. The parser merges seed + discovered types at query time.

### Before Indexing Completes
Parser uses **seed file only**. No dependency on index state. If a query references a type not in the seed, the parser returns null and the agent asks the user to clarify.

---

## Retrieval Pipeline: Deterministic Parse → Structured Filter → Semantic Rank

### Step 1: Deterministic Parsing (no LLM)
- **Date extraction**: `chrono-node` — "last Tuesday" → `2026-03-24`, "2 weeks ago" → date range
- **Type matching**: fuzzy match against experiment_types registry (seed + discovered)
- **Project extraction**: match against known project folder names
- **Keywords**: remaining tokens after entity extraction

The parser **never guesses**. If uncertain, returns null. The agent then asks the user to clarify.

### Step 2: Structured SQL Filter
Build parameterized SQL from parsed filters:
```sql
SELECT * FROM note_metadata
WHERE date = ?
  AND experiment_type = ?
  -- omit null filters
```

### Step 3: Semantic Rank (if candidates > 5)
- Embed query → vector
- Cosine similarity against `chunk_embeddings` for candidate note chunks
- Return top-k ranked
- If candidates ≤ 5: skip ranking, use all

### Step 4: Context Assembly
For top results, load:
- Full markdown body
- Linked protocols via `[[wikilinks]]`
- Attachment references
- Related notes (same project ± 7 days)

### Step 5: LLM Response
Grounded answer citing specific data from retrieved notes.

### Fallback Chain
1. Broaden: drop date, keep type
2. Broaden: drop type, keep date range ±7d
3. Pure semantic search (full vault)
4. Tell user: "No matching notes found. Would you like to search more broadly?"

---

## Safe Editing Protocol

Every vault write follows this pipeline. No silent writes, ever.

### Step 0: Conflict Check
- **Fast path**: compare file mtime with mtime when agent last read it
- **If mtime changed**: compute SHA-256 of current file content
  - Hash match → no real conflict (mtime changed from touch/backup, content unchanged)
  - Hash mismatch → **REAL CONFLICT**: show 3-way diff (original / current / proposed)
    - Options: [Merge] [Re-read & Retry] [Force Apply] [Cancel]

### Step 1: Generate Diff
- New files: show full proposed content
- Edits: unified diff format, rendered in chat panel

### Step 2: User Confirms
- [Apply] — write as proposed
- [Edit] — modify proposed content before writing
- [Cancel] — discard

### Step 3: Final Hash Check
Re-hash file immediately before writing (race condition guard). If changed → back to Step 0.

### Step 4: Audit Log
```sql
INSERT INTO edit_audit_log
  (timestamp, file_path, operation, before_content, after_content,
   before_hash, after_hash, trigger_query, session_id)
```

### Step 5: Atomic Write
Write to `.tmp` file, then `rename()` (atomic on most filesystems). Ingestion worker detects change and re-indexes.

### Step 6: Undo
"Undo last edit" reads previous content from audit log, shows rollback diff, requires confirmation, follows same conflict check path.

---

## SQLite Schema

### Derived Tables (rebuildable — `cricknote reindex`)

```sql
-- Parsed frontmatter metadata
CREATE TABLE note_metadata (
  path TEXT PRIMARY KEY,
  folder TEXT,           -- Projects, Protocols, Reading, Memory, Agent
  note_type TEXT,        -- experiment, protocol, reading, diary
  date TEXT,
  project TEXT,
  experiment_type TEXT,
  protocol_ref TEXT,
  status TEXT,
  tags JSON,
  result_summary TEXT,
  content_hash TEXT,     -- SHA-256
  mtime INTEGER,
  last_indexed INTEGER
);

-- Note content split into ~512-token chunks
CREATE TABLE note_chunks (
  id INTEGER PRIMARY KEY,
  path TEXT REFERENCES note_metadata(path) ON DELETE CASCADE,
  chunk_index INTEGER,   -- 0-based position
  start_offset INTEGER,
  end_offset INTEGER,
  content TEXT
);

-- Embeddings per chunk (same granularity as BM25)
CREATE TABLE chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES note_chunks(id) ON DELETE CASCADE,
  embedding BLOB         -- float32 vector
);

-- Full-text search at chunk level (aligned with semantic search)
CREATE VIRTUAL TABLE bm25_index USING fts5(
  chunk_id,
  content,
  content='note_chunks',
  content_rowid='id'
);

-- Known experiment types (seed + discovered)
CREATE TABLE experiment_types (
  name TEXT PRIMARY KEY,
  aliases JSON,
  count INTEGER DEFAULT 0
);
```

### Durable Tables (app-owned — NOT rebuildable)

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  last_active INTEGER,
  metadata JSON          -- provider, config snapshot
);

-- One row per message (normalized, not JSON blob)
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT REFERENCES chat_sessions(id),
  role TEXT,             -- user, assistant, tool
  content TEXT,
  tool_calls JSON,       -- if role=assistant with tool use
  tool_call_id TEXT,     -- if role=tool
  timestamp INTEGER
);

CREATE TABLE edit_audit_log (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER,
  file_path TEXT,
  operation TEXT,        -- create, update, delete
  before_content TEXT,
  after_content TEXT,
  before_hash TEXT,
  after_hash TEXT,
  trigger_query TEXT,
  session_id TEXT
);

CREATE TABLE indexing_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  state TEXT,            -- idle, indexing, error
  total_files INTEGER,
  indexed_files INTEGER,
  last_full_index INTEGER,
  last_error TEXT,
  updated_at INTEGER
);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER
);
```

---

## Indexing Status & Partial Results

### First Start / Reindex
`indexing_status.state = "indexing"`. Plugin shows progress bar: "Indexing vault... (42/150 notes) 28%"

### Queries During Indexing
- Search runs against whatever's indexed so far
- Response includes: "Vault indexing is 28% complete. These results may be incomplete."
- Deterministic parser uses seed experiment types (no dependency on index)

### Indexing Complete
`state = "idle"`. Progress indicator disappears. Full results available.

### Incremental Updates
After initial index, file watcher handles single-file re-indexing. State stays "idle".

---

## Ingestion Pipeline (Background Worker)

Runs as a worker thread or async queue, separate from the interactive chat path.

1. **File change detected** (chokidar, 1.5s debounce)
2. **Classify** by folder: Projects → experiment, Protocols → protocol, etc.
3. **Parse frontmatter** (gray-matter) + validate required fields per type. Log warnings for missing fields.
4. **Upsert** `note_metadata` table
5. **Chunk** note into ~512-token segments → upsert `note_chunks`
6. **Embed** each chunk (async, `@xenova/transformers`) → upsert `chunk_embeddings`
7. **Update BM25** FTS5 index at chunk level
8. **Track attachments** — verify existence, store metadata
9. **Update `indexing_status`** progress
10. **Notify main thread** via event bus when a note is indexed

---

## Agent Runtime

### Per-Message Flow
1. **Session resolution** — map to session, load history from `chat_messages`
2. **Context assembly** — layer system prompt:
   - Base instructions (built-in)
   - `Agent/agent.md` (user's core rules)
   - `Agent/soul.md` (personality/tone)
   - Relevant `Agent/skills/*.md` files
   - Today's `Memory/Daily/` note (task context)
   - Current week's `Memory/Weekly/` note
   - Tool definitions (auto-generated)
3. **LLM invocation** — streaming via provider abstraction (Claude default, GPT fallback)
4. **Tool execution loop** — if LLM calls tools, execute and return results. For vault writes, pause for user confirmation (safe edit flow).
5. **Response & persistence** — stream response to plugin, save messages to `chat_messages`

### Multi-Provider Abstraction
```
interface LLMProvider {
  chat(messages, tools, options): AsyncIterable<StreamChunk>
}
```
Implementations: `AnthropicProvider` (`@anthropic-ai/sdk`), `OpenAIProvider` (`openai`). Configurable in `~/.cricknote/config.json` and overridable in `Agent/agent.md`.

---

## Agent Tools

All vault-writing tools are annotated `[SAFE EDIT]` — they trigger the conflict check → diff → confirm → audit → write pipeline.

| Tool | Description | Safe Edit |
|------|-------------|-----------|
| `vault_read(path)` | Read note content + frontmatter | No |
| `vault_list(folder, filters?)` | List notes by metadata | No |
| `vault_search(query, filters?)` | Structured + semantic search | No |
| `vault_write(path, content, frontmatter)` | Create or overwrite a note | Yes |
| `vault_append(path, content)` | Append to existing note | Yes |
| `create_experiment(project, title, type, protocol, samples)` | Generate experiment note from template | Yes |
| `create_reading_note(title, authors, ...)` | Generate reading note from template | Yes |
| `task_list(status?, project?)` | List tasks from diary notes | No |
| `task_add(desc, deadline?, project?)` | Add task to diary | Yes |
| `task_complete(task_desc)` | Mark task done | Yes |
| `get_today_diary()` | Read today's diary note | No |
| `get_week_plan()` | Read this week's planning note | No |

---

## Install & Startup

### First-Time Setup (3 steps)
```
Step 1: $ npm install -g cricknote

Step 2: $ cricknote setup
  → Prompts: vault path, LLM provider, API key
  → Downloads embedding model (all-MiniLM-L6-v2) with progress bar
    (or use CRICKNOTE_EMBEDDING_MODEL_PATH for pre-downloaded)
  → Generates auth token → ~/.cricknote/auth-token (0600)
  → Saves config → ~/.cricknote/config.json
  → Initializes SQLite → ~/.cricknote/db.sqlite
  → Installs Obsidian plugin → vault/.obsidian/plugins/cricknote/

Step 3: Enable CrickNote in Obsidian → Settings → Community Plugins
```

### Daily Use
```
$ cricknote start
  → Starts WebSocket server on 127.0.0.1:18789
  → Starts background ingestion worker
  → Runs initial index if needed (shows progress)
  → Open Obsidian → chat panel auto-connects
  → Ctrl+C to stop
```

### Updating
```
$ npm update -g cricknote
  → Updates service + plugin automatically
  → Runs new DB migrations on next start
```

---

## Project Structure

```
crickNote/
├── package.json              # "cricknote" CLI bin entry
├── tsconfig.json
├── src/
│   ├── cli.ts                # CLI: setup, start, reindex, rotate-token
│   ├── service.ts            # Start WS server + ingestion worker
│   ├── agent/
│   │   ├── runtime.ts        # Agent loop
│   │   ├── context.ts        # System prompt assembly
│   │   ├── providers/
│   │   │   ├── base.ts       # LLMProvider interface
│   │   │   ├── anthropic.ts
│   │   │   └── openai.ts
│   │   └── tools/
│   │       ├── registry.ts   # Tool registration & dispatch
│   │       ├── vault.ts      # vault_read, vault_write, vault_append, vault_list
│   │       ├── search.ts     # vault_search (orchestrates retrieval pipeline)
│   │       ├── tasks.ts      # task_list, task_add, task_complete
│   │       ├── templates.ts  # create_experiment, create_reading_note
│   │       └── context.ts    # get_today_diary, get_week_plan
│   ├── retrieval/
│   │   ├── query-parser.ts   # Deterministic: chrono-node + fuzzy type match
│   │   ├── structured-filter.ts  # Parameterized SQL builder
│   │   ├── semantic-ranker.ts    # Chunk-level vector similarity
│   │   └── context-assembler.ts  # Load full notes + linked content
│   ├── ingestion/
│   │   ├── worker.ts         # Background worker thread
│   │   ├── watcher.ts        # chokidar file watcher
│   │   ├── parser.ts         # gray-matter + validation
│   │   ├── chunker.ts        # Split notes into ~512-token chunks
│   │   ├── embedder.ts       # @xenova/transformers embedding
│   │   └── indexer.ts        # SQLite upserts
│   ├── editing/
│   │   ├── conflict-detector.ts  # mtime fast-path + SHA-256 authority
│   │   ├── diff-generator.ts
│   │   └── safe-writer.ts       # Atomic write (tmp + rename)
│   ├── storage/
│   │   ├── database.ts       # SQLite init, WAL mode, connection
│   │   ├── migrations/
│   │   │   └── 001-initial.ts
│   │   └── audit.ts          # Edit audit log
│   ├── server/
│   │   ├── websocket.ts      # WS server + message routing
│   │   └── auth.ts           # Token gen/validate/rotate + version handshake
│   └── config/
│       └── config.ts         # Load ~/.cricknote/ + Agent/
│
├── obsidian-plugin/
│   ├── manifest.json
│   ├── main.ts               # Plugin entry, register views
│   ├── chat-view.ts          # Sidebar chat panel
│   ├── diff-view.ts          # Diff preview + conflict resolution UI
│   ├── status-bar.ts         # Indexing progress, connection status
│   ├── websocket-client.ts   # Connect with token + version handshake
│   └── styles.css
│
├── tests/
│   ├── unit/
│   │   ├── query-parser.test.ts
│   │   ├── frontmatter-parser.test.ts
│   │   ├── structured-filter.test.ts
│   │   ├── conflict-detector.test.ts
│   │   ├── chunker.test.ts
│   │   └── safe-writer.test.ts
│   ├── integration/
│   │   ├── search-pipeline.test.ts
│   │   ├── ingestion-pipeline.test.ts
│   │   ├── edit-pipeline.test.ts
│   │   └── migrations.test.ts
│   ├── e2e/
│   │   └── plugin-service.test.ts  # Real WS server + mock plugin client
│   └── fixtures/
│       ├── sample-vault/           # Test vault with representative notes
│       └── sample-queries.json     # Query → expected parse results
│
└── scripts/
    └── build-plugin.sh             # Build + package obsidian plugin
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+, TypeScript |
| WebSocket | `ws` |
| Database | `better-sqlite3` (WAL mode) |
| Embeddings | `@xenova/transformers` + `all-MiniLM-L6-v2` |
| LLM Providers | `@anthropic-ai/sdk` + `openai` |
| File Watching | `chokidar` |
| Frontmatter | `gray-matter` |
| Date Parsing | `chrono-node` |
| CLI | `commander` + `inquirer` |
| Testing | `vitest` |
| Plugin Build | `esbuild` |

---

## Test Strategy

### Unit Tests
- **query-parser**: date extraction ("last Tuesday", "2 weeks ago", relative dates), type matching (exact, fuzzy, alias), project extraction, ambiguity → null
- **frontmatter-parser**: valid notes, missing required fields, malformed YAML, unknown note types
- **structured-filter**: SQL generation from filters, null filter omission, date ranges, parameterization (SQL injection prevention)
- **conflict-detector**: unchanged file, mtime-only change (no content change), real content change, deleted file, new file
- **chunker**: short notes (1 chunk), long notes (multiple chunks), chunk boundary correctness
- **safe-writer**: atomic write success, atomic write failure/rollback

### Integration Tests
- **search-pipeline**: full query → parse → filter → rank against sample vault
- **ingestion-pipeline**: file create/modify/delete → metadata + chunks + embeddings updated
- **edit-pipeline**: conflict detection → diff → write → audit log entry
- **migrations**: fresh DB, existing DB with older schema, migration idempotency

### E2E Tests
- **plugin-service**: start real WS server → mock plugin connects → auth handshake → version check → send query → receive response → verify search results

### Test Fixtures
- `tests/fixtures/sample-vault/`: representative vault with experiment notes, protocols, reading notes, diary entries
- `tests/fixtures/sample-queries.json`: query strings → expected parser output mappings

---

## Version Roadmap

| Phase | Scope | Key Deliverables |
|-------|-------|------------------|
| **V1** | Obsidian plugin + local agent (manual start) | Chat panel, ingestion, structured+semantic retrieval, safe editing with conflict detection + audit, templates, manual tasks, CLI |
| **V1.5** | Auto-start + scheduler | LaunchAgent or plugin-spawned service, morning digest, task reminders, daily summary, weekly review |
| **V2** | + Slack | Gateway upgrade, Slack Bolt adapter, privacy/trust model, channel permissions |
| **V3** | + Telegram | Telegram grammY adapter, multi-channel routing |
