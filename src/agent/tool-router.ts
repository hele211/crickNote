const BUNDLES = {
  search: ['vault_search', 'vault_read', 'vault_list'],
  write:  ['vault_read', 'vault_write', 'vault_append'],
  tasks:  ['task_list', 'task_add', 'task_complete'],
  reading: [
    'create_reading_note', 'discover_reading_bundle', 'ingest_reading_bundle',
    'reading_pipeline_status', 'set_reading_note_status', 'compile_reading_note',
    'vault_read', 'vault_write', 'vault_append',
  ],
  kb: [
    'kb_suggest', 'kb_write_mapping', 'kb_apply', 'kb_apply_advance',
    'kb_apply_direct', 'kb_resolve_review', 'kb_lint',
    'vault_search', 'vault_read', 'vault_write',
  ],
  project: [
    'reserve_prefix', 'register_project_counters', 'create_project',
    'create_experiment', 'create_series', 'create_protocol', 'update_project_index',
    'vault_read', 'vault_write', 'vault_append', 'vault_list',
  ],
  // Diary and week-plan are separate so asking about one does not inject the other.
  diary:    ['get_today_diary'],
  weekplan: ['get_week_plan'],
} as const;

type BundleKey = keyof typeof BUNDLES;

export const SEARCH_BUNDLE: readonly string[] = BUNDLES.search;
export const WRITE_BUNDLE: readonly string[] = BUNDLES.write;
// Full write bundle for the retry path — includes project creation tools so the
// agent can complete project/experiment/series workflows even when the initial
// routing didn't select the project bundle.
export const FULL_WRITE_BUNDLE: readonly string[] = [
  ...new Set([...BUNDLES.write, ...BUNDLES.project]),
];

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function addBundle(selected: Set<string>, key: BundleKey): void {
  for (const tool of BUNDLES[key]) selected.add(tool);
}

function isTutorialQuestion(text: string): boolean {
  return has(text, /^(how do i|how can i|what is|what are|why does|why do|explain|tell me about|recommend)\b/);
}

export function routeTools(message: string): string[] {
  const text = normalizeMessage(message);
  const selected = new Set<string>();

  const mentionsVault = has(text, /\b(my|your|the)?\s*(vault|obsidian|notes|files)\b/);
  const possessiveNote = has(text, /\b(my|the|this|that)\s+[\w/-]+(?:\s+[\w/-]+)*\s+(note|file|diary|protocol)\b/);
  const writeTarget = has(text, /\b(to|in|into|inside)\s+(my\s+|the\s+)?(vault|obsidian|notes|files)\b/);
  const commandPrefix = has(text, /^(please\s+)?(can you|could you|would you|please|i want you to|let's|lets)?\s*/);

  // Serial project file identifier pattern: kb001, exp001, prot001, ser001
  const serialFileRef = /\b(?:kb|exp|prot|ser)\d{3,}\b/;

  // Search/read: vault-framed lookup and recall requests. Routing these on the
  // first pass avoids the slow "no tools, then retry with search" path.
  if (
    has(text, /\b(search|find|lookup|look up|read|open|get|show|list)\b.*\b(my\s+)?(vault|obsidian|notes|files)\b/) ||
    has(text, /\b(in my vault|in my notes|my notes on|notes on)\b/) ||
    has(text, /\b(do i have|have i got|any)\s+(notes|files|records)\b/) ||
    has(text, /\bwhat (did i write|have i written|have i recorded|have i documented|did i record|did i document)\b/) ||
    has(text, /\b(recall|remember|retrieve|pull up)\s+(my\s+)?(work|notes|records|experiments)\b/) ||
    has(text, /\bexperiment results\b/) ||
    // Reading (not updating) a specific project file, e.g. "read KB001", "show KB001"
    (has(text, serialFileRef) && has(text, /\b(read|open|show|get|check|look at|content of)\b/))
  ) {
    addBundle(selected, 'search');
  }

  // Write/create generic vault notes/files. Tutorial questions such as
  // "how do I create a file in Obsidian" must remain plain chat.
  if (!isTutorialQuestion(text) && (
    has(text, /\b(edit|update|modify|revise|overwrite|rename)\b.*\b(note|file|diary|protocol|vault|obsidian|notes)\b/) ||
    has(text, /\bappend\b.*\b(to|in|into)\b.*\b(note|file|diary|vault|obsidian|notes)\b/) ||
    has(text, /\b(write|save|record|put|add)\b.*\b(to|in|into|inside)\b.*\b(my\s+|the\s+)?(vault|obsidian|notes|files)\b/) ||
    (commandPrefix && has(text, /\b(create|make)\s+(a\s+|an\s+)?(new\s+|now\s+)?(note|file)\b/) && (mentionsVault || writeTarget || !has(text, /\?$/))) ||
    possessiveNote && has(text, /\b(edit|update|modify|append|write|save|record)\b/) ||
    // Recognize project file serial identifiers (kb001, exp001, prot001, ser001) with write verbs
    (has(text, serialFileRef) && has(text, /\b(update|edit|modify|revise|overwrite|append|write|save|record|add)\b/))
  )) {
    addBundle(selected, 'write');
  }

  // Tasks.
  if (has(text, /\b(add|create|new)\s+(a\s+)?(task|todo|to-do)\b|\b(show|list|my)\s+(a\s+)?(tasks?|todos?|to-dos?)\b|\bmark\s+.*\b(done|complete|completed)\b/)) {
    addBundle(selected, 'tasks');
  }

  // Reading workflow.
  if (has(text, /\b(my paper|reading note|ingest|compile\s+(the\s+)?reading|source bundle|paper bundle|add my paper)\b/)) {
    addBundle(selected, 'reading');
  }

  // Knowledge-base workflow.
  if (has(text, /\bkb\s+(lint|suggest|apply|write|resolve|mapping)\b|\bknowledge\s+base\b|\b(add|write)\s+a\s+claim\s+to\s+my\s+notes\b|\bmap\s+.*\b(to|into)\s+(my\s+)?knowledge\b/)) {
    addBundle(selected, 'kb');
  }

  // Project tools. Include common command verbs and the user's typo "now" for
  // "new"; exclude general "how do I..." advice questions.
  if (!isTutorialQuestion(text) && (
    has(text, /\b(create|add|make|start|open|set up|setup)\s+(a\s+|an\s+|the\s+|my\s+)?(new\s+|now\s+)?(project|experiment|series|protocol)\b/) ||
    has(text, /\bnew\s+(project|experiment|series|protocol)\b/) ||
    has(text, /\bwrite\s+(a\s+|an\s+)?(new\s+|now\s+)protocol\b/)
  )) {
    addBundle(selected, 'project');
  }

  // Context tools.
  if (has(text, /\bmy\s+diary\b|\btoday's\s+diary\b/)) {
    addBundle(selected, 'diary');
  }
  if (has(text, /\bmy\s+week\s*plan\b|\bmy\s+weekly\s+plan\b/)) {
    addBundle(selected, 'weekplan');
  }

  return [...selected];
}

export function needsVaultAccess(text: string): boolean {
  const vaultObj = '(vault|notes|files|diary|obsidian)';
  return new RegExp(
    `(?:do not|don['']?t) have access to your ${vaultObj}` +
    `|cannot (search|read|look|access) your ${vaultObj}` +
    `|no access to your ${vaultObj}` +
    `|need vault access` +
    `|unable to (search|read|access) your ${vaultObj}` +
    `|can['']?t (search|read|access) your ${vaultObj}` +
    `|without access to your ${vaultObj}`,
    'i'
  ).test(text);
}

export function needsVaultWriteAccess(text: string): boolean {
  const vaultObj = '(vault|notes|files|diary|obsidian)';
  return new RegExp(
    `(?:cannot|can['']?t|unable to) (create|write|save|record|modify|edit|update|append).*\\b${vaultObj}\\b` +
    `|(?:do not|don['']?t) have (write|create|file) access to your ${vaultObj}` +
    `|without (write|create|file) access to your ${vaultObj}`,
    'i'
  ).test(text);
}
