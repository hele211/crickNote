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
  // Zotero: fetch + prepare + cleanup + full reading pipeline (Zotero flow always feeds ingest_reading_bundle)
  zotero: [
    'zotero_fetch_item', 'zotero_prepare_bundle', 'zotero_cleanup_bundle',
    'ingest_reading_bundle', 'reading_pipeline_status', 'set_reading_note_status', 'compile_reading_note',
    'vault_read', 'vault_write', 'vault_append',
  ],
  // Diary and week-plan are separate so asking about one does not inject the other.
  diary:    ['get_today_diary'],
  weekplan: ['get_week_plan'],
} as const;

type BundleKey = keyof typeof BUNDLES;

// Each rule: if pattern matches the user message, add the listed bundles.
// Patterns require vault/possessive framing to avoid false-positives on
// informational questions that happen to share vocabulary.
const RULES: Array<{ pattern: RegExp; bundles: BundleKey[] }> = [
  // Search: vault-specific framing required
  {
    pattern: /\bfind\s+my\b|\bsearch\s+(my\s+)?(vault|notes)\b|\blook\s+up\s.*\bvault\b|\bwhat did i write\b|\bin my vault\b|\bmy notes\s+on\b|\bexperiment results\b/i,
    bundles: ['search'],
  },
  // Write: requires "my/the ... note" as the object of the edit verb
  {
    pattern: /\b(edit|update|modify)\s+(my|the)\s+[\w-]+(?:\s+[\w-]+)*\s+note\b|\bappend\s+to\s+(my|the)\s+[\w-]+(?:\s+[\w-]+)*\s+note\b/i,
    bundles: ['write'],
  },
  // Tasks: "add a task", "my task/todo", "mark done"
  {
    pattern: /\badd\s+a\s+task\b|\b(show|list|my)\s+(a\s+)?task\b|\btodo\b|\bto-do\b|\bmark\s+done\b/i,
    bundles: ['tasks'],
  },
  // Zotero: any mention of Zotero routes the full Zotero + reading bundle
  {
    pattern: /\bzotero\b/i,
    bundles: ['zotero'],
  },
  // Reading: possessive "my paper", or reading-specific workflow verbs
  {
    pattern: /\bmy paper\b|\breading note\b|\bingest\b|\bcompile\s+(the\s+)?reading\b|\bsource bundle\b/i,
    bundles: ['reading'],
  },
  // KB: explicit "kb <verb>", "knowledge base", or "add a claim to my notes"
  {
    pattern: /\bkb\s+(lint|suggest|apply|write|resolve|mapping)\b|\bknowledge\s+base\b|\badd\s+a\s+claim\s+to\s+my\s+notes\b/i,
    bundles: ['kb'],
  },
  // Project: "new/create experiment/project/series/protocol" or "write a new protocol"
  {
    pattern: /\bnew\s+experiment\b|\bcreate\s+(a\s+)?(new\s+)?(experiment|project|series|protocol)\b|\bnew\s+project\b|\bnew\s+protocol\b|\bnew\s+series\b|\bwrite\s+a\s+new\s+protocol\b/i,
    bundles: ['project'],
  },
  // Diary: possessive only — "my diary" or "today's diary"
  {
    pattern: /\bmy\s+diary\b|\btoday[''']?s\s+diary\b/i,
    bundles: ['diary'],
  },
  // Week plan: possessive only
  {
    pattern: /\bmy\s+week\s*plan\b|\bmy\s+weekly\s+plan\b/i,
    bundles: ['weekplan'],
  },
];

export const SEARCH_BUNDLE: readonly string[] = BUNDLES.search;

export function routeTools(message: string): string[] {
  const selected = new Set<string>();
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      for (const key of rule.bundles) {
        for (const tool of BUNDLES[key]) {
          selected.add(tool);
        }
      }
    }
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
