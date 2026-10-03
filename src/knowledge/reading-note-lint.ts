import path from 'node:path';

/**
 * Advisory style/structure checker for reading notes (layout v2, see
 * skills/_shared/reading-note-layout.md). Pure and dependency-free: it never
 * blocks a write. These are style heuristics, not a Markdown or Mermaid
 * validator, and a locator or ID that exists does not prove it supports the
 * claim it is attached to.
 */

export type LintSeverity = 'warn' | 'info';

export interface LintFinding {
  code: string;
  severity: LintSeverity;
  /** 1-based line number relative to the body that was linted. */
  line: number;
  message: string;
  fix: string;
}

export interface LintStats {
  sentences: number;
  meanWords: number;
  pctOver25: number;
  claims: number;
  diagrams: number;
  tldrWords: number;
  figureMapRows: number;
}

export interface LintOptions {
  /** Paths from the note's frontmatter `sources`. When given, the declared TL;DR Source must be one of them. */
  sources?: string[];
}

export interface LintResult {
  /** True when there are no `warn` findings. `info` findings never flip it. */
  ok: boolean;
  findings: LintFinding[];
  stats: LintStats;
}

export const LAYOUT_HEADINGS = [
  'Claims',
  'Reasoning',
  'Evidence',
  'Figure Map',
  'Assumptions',
  'Takeaways',
  'Extensions',
] as const;

export const SUPPORT_TYPES = ['measured', 'inferred', 'proposed'] as const;

/** Numeric limits. Exported so tests can check that the shared docs quote the same numbers. */
export const LINT_LIMITS = {
  tldrMaxWords: 160,
  longSentenceWords: 25,
  longParagraphSentences: 7,
  mermaidMaxNodes: 12,
  mermaidMaxDiagrams: 2,
  figureMapMaxRows: 40,
  figureMapMaxCellWords: 30,
  maxFindingsPerCode: 8,
} as const;

const TLDR_MAX_WORDS = LINT_LIMITS.tldrMaxWords;
const LONG_SENTENCE_WORDS = LINT_LIMITS.longSentenceWords;
const LONG_PARAGRAPH_SENTENCES = LINT_LIMITS.longParagraphSentences;
const MERMAID_MAX_NODES = LINT_LIMITS.mermaidMaxNodes;
const MERMAID_MAX_DIAGRAMS = LINT_LIMITS.mermaidMaxDiagrams;
const FIGURE_MAP_MAX_ROWS = LINT_LIMITS.figureMapMaxRows;
const FIGURE_MAP_MAX_CELL_WORDS = LINT_LIMITS.figureMapMaxCellWords;
const MAX_FINDINGS_PER_CODE = LINT_LIMITS.maxFindingsPerCode;

type LineKind = 'prose' | 'fence-open' | 'fence-body' | 'fence-close' | 'comment';

interface ScannedLine {
  n: number;
  /** Text with HTML comments removed (prose lines only; empty for comment/fence delimiter lines). */
  text: string;
  kind: LineKind;
  lang?: string;
}

interface Heading {
  name: string;
  line: number;
}

interface MermaidBlock {
  startLine: number;
  lines: ScannedLine[];
}

const LOCATOR_PATTERNS: RegExp[] = [
  /\b(?:Fig(?:ure)?s?\.?|Tables?|Suppl(?:ementary)?\.?|Box|Movie|Video)\s*[A-Za-z]?\d+/,
  /\bSec(?:tion)?\.?\s*\d+/,
  /\bp\.\s*\d+/,
  /§\s*\S+/,
];

export function hasLocator(text: string): boolean {
  return LOCATOR_PATTERNS.some((re) => re.test(text));
}

const BARE_PAGE_LOCATOR = /(?<!PDF )(?<!printed )\bp\.\s*\d+/;

// Common HTML element names. Every tag only counts with an immediate ">" ("<br>", "<br />") or an attribute with
// "=", because "a<b and c>d", "t<time and n>3" and "P<0.05 and n>3" are ordinary prose. This is a heuristic, not an
// HTML parser: it catches the usual tags, not every possible construct (a bare boolean attribute such as
// "<p hidden>" slips through).
const HTML_TAG_NAMES =
  'abbr|address|area|article|aside|audio|base|bdi|bdo|big|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|'
  + 'data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|'
  + 'iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|picture|'
  + 'pre|progress|rp|rt|ruby|samp|script|section|select|slot|small|source|span|strike|strong|style|sub|summary|sup|svg|table|tbody|td|'
  + 'template|textarea|tfoot|th|thead|time|title|tr|track|tt|ul|var|video|wbr';
// At most one optional space before "/>": a "\\s*" after the attribute run would overlap it and backtrack quadratically.
// An attribute value is quoted, or has no whitespace and no quote characters at all. The alternatives are disjoint (a quoted
// value cannot also match as an unquoted one) and cannot overlap the whitespace before "/>", or matching backtracks exponentially.
const HTML_ATTRIBUTE = '\\s+[a-z-]+=(?:"[^"<>]*"|\'[^\'<>]*\'|[^\\s"\'<>]*)';
const HTML_TAG = new RegExp(`<\\/?(?:${HTML_TAG_NAMES}|a|b|i|p|q|s|u)(?:${HTML_ATTRIBUTE})*\\s*\\/?>`, 'i');

/**
 * Removes "<!-- ... -->" comments from one line. A scan with indexOf, not a lazy regex: a regex restarts at every
 * unterminated "<!--" and is quadratic on a line of repeated openers. `open` is true when the last comment never closes.
 */
function stripHtmlComments(text: string): { text: string; open: boolean; had: boolean } {
  let out = '';
  let pos = 0;
  let had = false;
  for (;;) {
    const start = text.indexOf('<!--', pos);
    if (start < 0) break;
    had = true;
    const end = text.indexOf('-->', start + 4);
    if (end < 0) return { text: out + text.slice(pos, start), open: true, had };
    out += text.slice(pos, start);
    pos = end + 3;
  }
  return { text: out + text.slice(pos), open: false, had };
}

function scan(body: string): { lines: ScannedLine[]; unclosedFenceLine: number | null } {
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  const lines: ScannedLine[] = [];
  let fence: { marker: string; lang: string; startLine: number } | null = null;
  let inComment = false;

  // Strip complete comments, then handle a comment that opens and does not close on this line.
  const pushProse = (text: string, n: number): void => {
    const r = stripHtmlComments(text);
    if (r.open) inComment = true;
    if (r.had && r.text.trim() === '') {
      lines.push({ n, text: '', kind: 'comment' });
    } else {
      lines.push({ n, text: r.text, kind: 'prose' });
    }
  };

  raw.forEach((text, i) => {
    const n = i + 1;
    if (fence) {
      const closer = new RegExp(`^\\s*${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`);
      if (closer.test(text)) {
        lines.push({ n, text: '', kind: 'fence-close' });
        fence = null;
      } else {
        lines.push({ n, text, kind: 'fence-body', lang: fence.lang });
      }
      return;
    }
    if (inComment) {
      const end = text.indexOf('-->');
      if (end < 0) {
        lines.push({ n, text: '', kind: 'comment' });
        return;
      }
      inComment = false;
      const rest = text.slice(end + 3);
      if (rest.trim() === '') {
        lines.push({ n, text: '', kind: 'comment' });
        return;
      }
      pushProse(rest, n); // visible text after "-->" is still note text
      return;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(text);
    if (open) {
      fence = { marker: open[1], lang: open[2].toLowerCase(), startLine: n };
      lines.push({ n, text: '', kind: 'fence-open', lang: open[2].toLowerCase() });
      return;
    }
    pushProse(text, n);
  });

  const unclosed = fence as { startLine: number } | null;
  return { lines, unclosedFenceLine: unclosed ? unclosed.startLine : null };
}

const TLDR_FIELD_MARKER = /\*\*(Did|Found|Trust|Why it matters here|Source):\*\*/gi;

/** Maps each TL;DR field label (lower case) to the text up to the next field marker. */
function tldrFields(joined: string): Map<string, string> {
  const fields = new Map<string, string>();
  const marks = [...joined.matchAll(TLDR_FIELD_MARKER)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? joined.length) : joined.length;
    const key = m[1].toLowerCase();
    if (!fields.has(key)) fields.set(key, joined.slice(start, end));
  });
  return fields;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

const ID_TOKEN = /^\s*[CE]\d+(?:\s*[–-]\s*[CE]?\d+)?\s*$/;

/** True for "C1", "C2, E3" or "C1–C3". Tokenised, not one big regex: a nested-quantifier pattern backtracks exponentially. */
function isIdList(inner: string): boolean {
  return inner.split(/[;,]/).every((token) => ID_TOKEN.test(token));
}

function stripLocatorGroups(text: string): string {
  return text.replace(/\(([^()]*)\)/g, (match, inner: string) => (hasLocator(inner) || isIdList(inner) ? '' : match));
}

/** "[[target|alias]]" becomes the alias and "[[target]]" the target. A single forward scan: unterminated openers stay linear. */
function replaceWikilinks(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('[[', pos);
    if (open < 0) break;
    const close = text.indexOf(']]', open + 2);
    if (close < 0) break;
    const inner = text.slice(open + 2, close);
    const bar = inner.indexOf('|');
    out += text.slice(pos, open) + (bar >= 0 ? inner.slice(bar + 1) : inner);
    pos = close + 2;
  }
  return out + text.slice(pos);
}

/** "[label](target)" becomes "label" (nested brackets and parentheses allowed). Single forward scan. */
function replaceMarkdownLinks(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('[', pos);
    if (open < 0) break;
    const close = labelEnd(text, open);
    if (close < 0) break; // unbalanced: keep the rest as it is and never rescan it
    if (text[close + 1] !== '(') {
      out += text.slice(pos, close + 1);
      pos = close + 1;
      continue;
    }
    const end = linkTargetEnd(text, close + 2);
    if (end < 0) break;
    out += text.slice(pos, open) + text.slice(open + 1, close);
    pos = end;
  }
  return out + text.slice(pos);
}

function cleanForSentences(text: string): string {
  return stripLocatorGroups(
    replaceMarkdownLinks(replaceWikilinks(
      text
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''),
    ))
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[(?:measured|inferred|proposed)\]/g, '')
      .replace(/\*+/g, '')
      .replace(/^(?:[CE]\d+)\s+/, '')
      .replace(/\b(?:et al|e\.g|i\.e|vs|cf|approx|Figs?|Suppl|No|Dr|Prof|ca)\./g, (m) => m.slice(0, -1))
      .trim(),
  ).replace(/\s{2,}/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 3);
}

/** Index of the quote that closes the title opened at `open`, or -1. Backslash escapes are honoured. */
function titleEnd(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i;
  }
  return -1;
}

/** Index just after the ")" that closes a link target starting at `from` (just after "("), or -1. Handles "\\(" escapes, "<...>" targets and quoted titles. */
function linkTargetEnd(text: string, from: number): number {
  if (text[from] === '<') {
    const gt = text.indexOf('>', from + 1);
    if (gt < 0) return -1;
    let i = gt + 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (text[i] === '"' || text[i] === "'") {
      const end = titleEnd(text, i);
      if (end >= 0) {
        let j = end + 1;
        while (text[j] === ' ' || text[j] === '\t') j += 1;
        if (text[j] === ')') return j + 1;
      }
    }
    const close = text.indexOf(')', gt + 1);
    return close < 0 ? -1 : close + 1;
  }
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if ((ch === '"' || ch === "'") && i > from && /\s/.test(text[i - 1])) {
      const end = titleEnd(text, i); // a title may hold unbalanced parentheses
      if (end >= 0) {
        i = end + 1;
        continue;
      }
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  return depth === 0 ? i : -1;
}

/** Index of the "]" that matches the "[" at `open` (nested brackets allowed), or -1. */
function labelEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Removes "[[target|alias]]" (keeping the alias) and "[[target]]". A scan, not a regex: unterminated openers stay linear. */
function stripWikilinks(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('[[', pos);
    if (open < 0) break;
    const close = text.indexOf(']]', open + 2);
    if (close < 0) break;
    const inner = text.slice(open + 2, close);
    const bar = inner.indexOf('|');
    out += text.slice(pos, open) + (bar >= 0 ? inner.slice(bar + 1) : '');
    pos = close + 2;
  }
  return out + text.slice(pos);
}

/** Removes the "(target)" of "[label](target)". An unbalanced target stops the scan, so the rest is never rescanned. */
function stripLinkTargets(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('](', pos);
    if (open < 0) break;
    const end = linkTargetEnd(text, open + 2);
    if (end < 0) break;
    out += text.slice(pos, open + 1);
    pos = end;
  }
  return out + text.slice(pos);
}

/** The part of a block that can hold note references: no inline code, links or link targets. (Source fields are removed per line.) */
function visibleForRefs(text: string): string {
  return stripLinkTargets(stripWikilinks(text.replace(/`[^`]*`/g, ''))); // inline code is the escape for scientific symbols
}

/** Drops the declared Source value from one line: "**Source:** x" to the end of that line, or a plain "Source:" line. Linear; literal text inside inline code is not a field. */
function stripSourceField(line: string): string {
  const s = line.trimStart();
  const rest = s.startsWith('>') ? s.slice(1).trimStart() : s;
  if (/^source:/i.test(rest)) return '';
  const outsideCode = line.replace(/`[^`]*`/g, '');
  const marker = outsideCode.search(/\*\*Source:\*\*/i);
  return marker >= 0 ? outsideCode.slice(0, marker) : line;
}

function claimRefNumbers(token: string): number[] | null {
  const m = /^C(\d+)(?:\s*[–-]\s*C?(\d+))?$/.exec(token);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (hi < lo || hi - lo > 50) return [lo];
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// Flowchart link operators, longest first so "--x" is not read as "--" plus a node called "x".
// "x--x" and "o--o" only count when set off by spaces: node IDs such as "Box" end in x or o.
const MERMAID_LINKS = /<-->|(?<=\s)x--x(?=\s)|(?<=\s)o--o(?=\s)|-\.->|-\.-[xo]|-->|==>|--[xo]|---|-\.-|--/;

const NODE_SHAPES: Array<[open: string, close: string]> = [['([', '])'], ['{{', '}}'], ['((', '))'], ['[', ']'], ['(', ')'], ['{', '}']];
const SPECIAL_LABEL_CHARS = /[(){}:;,/\\<>]/;
const SPECIAL_LABEL_CHAR_SCAN = /[(){}:;,/\\<>]/g;

/** True when an edge label or a node/subgraph label that is not in double quotes contains characters Mermaid may misparse. */
function hasUnquotedSpecialLabel(text: string): boolean {
  const labels = text.replace(/"[^"]*"/g, '""');
  for (const edge of labels.matchAll(/\|([^|"][^|]*)\|/g)) {
    if (SPECIAL_LABEL_CHARS.test(edge[1])) return true;
  }
  // Inline edge text: "A -- text --> B", "A == text ==> B", "A -. text .-> B".
  for (const label of inlineEdgeLabels(labels).labels) {
    if (SPECIAL_LABEL_CHARS.test(label)) return true;
  }
  // Openers appear in increasing order, so the nearest closer and the nearest special character can be cached:
  // searching to the end of the line again for every opener is quadratic on a line of unterminated openers.
  const closers = new Map<string, number>();
  const nearestCloser = (close: string, from: number): number => {
    let at = closers.get(close);
    if (at === undefined || (at !== -1 && at < from)) {
      at = labels.indexOf(close, from);
      closers.set(close, at);
    }
    return at;
  };
  let special = -2; // -2 = not searched yet, -1 = none left
  const nearestSpecial = (from: number): number => {
    if (special === -2 || (special !== -1 && special < from)) {
      SPECIAL_LABEL_CHAR_SCAN.lastIndex = from;
      special = SPECIAL_LABEL_CHAR_SCAN.exec(labels)?.index ?? -1;
    }
    return special;
  };
  for (const m of labels.matchAll(/\b[A-Za-z_]\w*(\(\[|\{\{|\(\(|\[|\(|\{)/g)) {
    const close = NODE_SHAPES.find(([open]) => open === m[1])![1];
    const start = (m.index ?? 0) + m[0].length;
    if (labels[start] === '"') continue;
    const end = nearestCloser(close, start);
    const at = nearestSpecial(start);
    if (at !== -1 && (end === -1 || at < end)) return true;
  }
  return false;
}

const INLINE_LABEL_OPEN = /\s(?:--|==|-\.)\s/g;
const INLINE_LABEL_CLOSE = /-->|==>|\.->|\.-(?!>)|--x|--o|---/g;
const FULL_OPERATOR: Record<string, string> = { '.->': '-.->', '.-': '-.-' };

/**
 * Splits "A -- text --> B" style edges into the text of each inline label and a copy of the line with each label
 * removed (the closing operator is kept, completed to a whole operator, so the target node is still seen).
 * One forward pass with sticky positions: never restarts a search from the beginning of the remaining text, and has
 * no overlapping whitespace quantifiers, so a long line stays linear.
 */
function inlineEdgeLabels(line: string): { stripped: string; labels: string[] } {
  const labels: string[] = [];
  let stripped = '';
  let pos = 0;
  for (;;) {
    INLINE_LABEL_OPEN.lastIndex = pos;
    const open = INLINE_LABEL_OPEN.exec(line);
    if (!open) break;
    const textStart = open.index + open[0].length;
    INLINE_LABEL_CLOSE.lastIndex = textStart;
    const close = INLINE_LABEL_CLOSE.exec(line);
    if (!close) break;
    labels.push(line.slice(textStart, close.index).trim());
    stripped += `${line.slice(pos, open.index)} ${FULL_OPERATOR[close[0]] ?? close[0]}`;
    pos = close.index + close[0].length;
  }
  return { stripped: stripped + line.slice(pos), labels };
}

function mermaidNodeCount(lines: ScannedLine[]): number {
  const ids = new Set<string>();
  const skip = /^\s*(?:flowchart|graph|subgraph|end\b|classDef|class\b|style\b|linkStyle|click\b|direction\b|%%)/;
  for (const l of lines) {
    if (skip.test(l.text) || l.text.trim() === '') continue;
    const bare = inlineEdgeLabels(l.text.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, '')).stripped;
    for (const segment of bare.split(MERMAID_LINKS)) {
      const m = /^\s*([A-Za-z_]\w*)/.exec(segment);
      if (m) ids.add(m[1]);
    }
  }
  return ids.size;
}

export function lintReadingNote(body: string, options: LintOptions = {}): LintResult {
  const { lines, unclosedFenceLine } = scan(body);
  const raw: LintFinding[] = [];
  const perCode = new Map<string, { count: number; overflowLine: number; overflow: number; severity: LintSeverity; fix: string }>();

  const add = (code: string, severity: LintSeverity, line: number, message: string, fix: string): void => {
    const entry = perCode.get(code) ?? { count: 0, overflowLine: 0, overflow: 0, severity, fix };
    perCode.set(code, entry);
    entry.count += 1;
    if (entry.count > MAX_FINDINGS_PER_CODE) {
      if (entry.overflow === 0) entry.overflowLine = line;
      entry.overflow += 1;
      return;
    }
    raw.push({ code, severity, line, message, fix });
  };

  if (unclosedFenceLine !== null) {
    add('fence-unclosed', 'warn', unclosedFenceLine, 'A code fence opened here is never closed.', 'Close the fence with a matching ``` line.');
  }

  const prose = lines.filter((l) => l.kind === 'prose');

  // ---- headings -----------------------------------------------------------
  const headings: Heading[] = [];
  for (const l of prose) {
    const m = /^##(?!#)\s+(\S.*)$/.exec(l.text); // trimmed below: a lazy ".*?" before "\s*$" is quadratic on a long whitespace run
    if (m) headings.push({ name: m[1].trimEnd(), line: l.n });
  }
  const firstH2Line = headings.length ? headings[0].line : Number.POSITIVE_INFINITY;

  const firstIndex = new Map<string, number>();
  for (const name of LAYOUT_HEADINGS) {
    const matches = headings.filter((h) => h.name === name);
    if (matches.length === 0) {
      add('missing-heading', 'warn', 1, `Layout heading "## ${name}" is missing.`,
        name === 'Figure Map'
          ? 'Add "## Figure Map" (use the no-figures HTML comment when the sources have no data figures).'
          : `Add "## ${name}" in layout order.`);
    } else {
      firstIndex.set(name, headings.indexOf(matches[0]));
      if (matches.length > 1) {
        add('duplicate-heading', 'warn', matches[1].line, `Heading "## ${name}" appears ${matches.length} times.`, 'Keep exactly one and merge the content.');
      }
    }
  }
  let lastIdx = -1;
  for (const name of LAYOUT_HEADINGS) {
    const idx = firstIndex.get(name);
    if (idx === undefined) continue;
    if (idx < lastIdx) {
      add('heading-order', 'warn', headings[idx].line, `"## ${name}" is out of order.`, `Layout order: ${LAYOUT_HEADINGS.join(' → ')}.`);
    }
    lastIdx = Math.max(lastIdx, idx);
  }
  const extensionsIdx = firstIndex.get('Extensions');
  headings.forEach((h, idx) => {
    if ((LAYOUT_HEADINGS as readonly string[]).includes(h.name)) return;
    if (/^Appraisal\b/.test(h.name)) {
      if (extensionsIdx !== undefined && idx < extensionsIdx) {
        add('heading-order', 'warn', h.line, `"## ${h.name}" sits before "## Extensions".`, 'Move Appraisal sections after Extensions.');
      }
    } else {
      add('extra-section', 'info', h.line, `"## ${h.name}" is not part of the reading-note layout.`,
        'Rename it "## Appraisal: <topic>" if it is external comparison or critical analysis; otherwise fold it into a layout section.');
    }
  });

  const sectionLines = (name: string): ScannedLine[] => {
    const h = headings.find((x) => x.name === name);
    if (!h) return [];
    const next = headings.find((x) => x.line > h.line);
    const end = next ? next.line : Number.POSITIVE_INFINITY;
    return lines.filter((l) => l.n > h.line && l.n < end);
  };

  // ---- TL;DR --------------------------------------------------------------
  let tldrWords = 0;
  const preamble = prose.filter((l) => l.n < firstH2Line);
  const calloutStart = preamble.findIndex((l) => /^\s*>\s*\[!(?:abstract|summary|tldr)\]/i.test(l.text));
  if (calloutStart < 0) {
    add('missing-tldr', 'warn', 1, 'No TL;DR callout before the first section.', 'Start the note with "> [!abstract] TL;DR" (Did, Found, Trust, Why it matters here, Source).');
  } else {
    const startLine = preamble[calloutStart].n;
    const content: ScannedLine[] = [];
    for (let i = calloutStart + 1; i < preamble.length; i++) {
      const l = preamble[i];
      if (l.n !== preamble[i - 1].n + 1 || !/^\s*>/.test(l.text)) break;
      const text = l.text.replace(/^\s*>\s?/, '').trim();
      if (text) content.push({ ...l, text });
    }
    tldrWords = countWords(content.map((c) => c.text.replace(/\*+/g, '')).join(' '));
    if (tldrWords > TLDR_MAX_WORDS) {
      add('tldr-too-long', 'warn', startLine, `TL;DR has ${tldrWords} words (limit ${TLDR_MAX_WORDS}).`, 'Cut it to Did, Found, Trust, Why it matters here, Source.');
    }
    const joined = content.map((c) => c.text).join('\n');
    const fields = tldrFields(joined);
    for (const field of ['Did', 'Found', 'Trust', 'Why it matters here']) {
      const value = fields.get(field.toLowerCase());
      if (value === undefined) {
        add('tldr-missing-field', 'warn', startLine, `TL;DR has no "**${field}:**" field.`, `Add "**${field}:** …" to the TL;DR callout.`);
      } else if (value.replace(/\*/g, '').trim() === '') {
        add('tldr-missing-field', 'warn', startLine, `TL;DR field "**${field}:**" is empty.`, `Write the ${field.toLowerCase()} field, or remove the label.`);
      }
    }
    // The Source value is the rest of its own line: filenames can contain spaces and punctuation.
    const plainSource = /(?:^|\n)[ \t]*Source:[ \t]*(.*)/i.exec(joined);
    const rawSource = (fields.get('source') ?? plainSource?.[1] ?? '').split('\n')[0].trim();
    if (!rawSource) {
      add('tldr-no-source', 'warn', startLine, 'TL;DR has no "**Source:** <filename>" line.', 'Name the primary attachment, for example "> **Source:** paper.pdf".');
    } else if (options.sources !== undefined) {
      const baseName = (s: string): string => path.posix.basename(s.replace(/\\/g, '/'));
      const registered = new Set(options.sources.map(baseName));
      // Try the exact text first (a real filename may start with an apostrophe), then without ONE matching outer wrapper.
      const candidates = [rawSource];
      for (const [open, close] of [['`', '`'], ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']]) {
        if (rawSource.length > 2 && rawSource.startsWith(open) && rawSource.endsWith(close)) candidates.push(rawSource.slice(1, -1).trim());
      }
      if (!candidates.some((c) => registered.has(baseName(c)))) {
        add('source-not-registered', 'warn', startLine, `Declared Source "${rawSource}" is not listed in the note's frontmatter sources.`, 'Use one of the registered attachment filenames, or register the source first.');
      }
    }
  }

  // ---- claims -------------------------------------------------------------
  interface Item { line: number; text: string }
  const collectItems = (name: string): Item[] => {
    const items: Item[] = [];
    let cur: Item | null = null;
    for (const l of sectionLines(name)) {
      if (l.kind !== 'prose') { cur = null; continue; }
      if (/^(?:[-*]|\d+[.)])\s+/.test(l.text)) {
        cur = { line: l.n, text: l.text };
        items.push(cur);
      } else if (cur && l.text.trim() !== '' && /^\s+\S/.test(l.text)) {
        cur.text += ` ${l.text.trim()}`;
      } else {
        cur = null;
      }
    }
    return items;
  };

  // Claims are strict: every visible line must belong to a claim bullet (or its indented continuation),
  // otherwise claim text could sit in a paragraph, table or indented list and still report ok.
  const claimItems: Item[] = [];
  const claimsHeading = headings.find((h) => h.name === 'Claims');
  {
    let cur: Item | null = null;
    let inStray = false;
    for (const l of sectionLines('Claims')) {
      if (l.kind === 'comment') continue;
      const blank = l.kind === 'prose' && l.text.trim() === '';
      if (blank) continue;
      if (l.kind === 'prose' && /^(?:[-*]|\d+[.)])\s+/.test(l.text)) {
        cur = { line: l.n, text: stripSourceField(l.text) };
        claimItems.push(cur);
        inStray = false;
      } else if (l.kind === 'prose' && cur && /^\s+\S/.test(l.text) && !/^\s+(?:(?:[-*+]|\d+[.)])\s|[|>#]|`{3,}|~{3,})/.test(l.text)) {
        // plain indented continuation only: a nested bullet, table, quote or heading is a second structure, not part of the claim
        cur.text += ` ${stripSourceField(l.text).trim()}`;
      } else {
        cur = null;
        if (!inStray) {
          inStray = true;
          add('claim-format', 'warn', l.n, 'Text in Claims that is not a claim bullet.', 'Write every claim as "- **C1** [measured] Claim text. (Fig 2A)"; move prose to Reasoning and tables to Evidence or Figure Map.');
        }
      }
    }
  }

  const claimIds = new Map<number, number>();
  const evidenceRefs: Array<{ id: number; line: number }> = [];
  for (const item of claimItems) {
    const m = /^[-*]\s+\*\*C(\d+)\*\*\s+\[([^\]]+)\]\s+\S/.exec(item.text);
    if (!m || !(SUPPORT_TYPES as readonly string[]).includes(m[2])) {
      add('claim-format', 'warn', item.line, 'Claim does not match "- **Cn** [measured|inferred|proposed] text (locator)".', 'Rewrite it as "- **C1** [measured] Claim text. (Fig 2A)".');
      continue;
    }
    const id = Number(m[1]);
    if (claimIds.has(id)) {
      add('duplicate-claim-id', 'warn', item.line, `Claim ID C${id} is used more than once.`, 'Give each claim a unique note-local ID; do not renumber cited claims.');
    } else {
      claimIds.set(id, item.line);
    }
    if (!hasLocator(item.text)) {
      add('claim-no-locator', 'warn', item.line, `Claim C${id} has no locator.`, 'Add a locator such as (Fig 2A–E), (Table 1), (Suppl. S3), (PDF p. 7) or (§Methods).');
    }
    // Which evidence IDs do claims cite? (Used to find orphan evidence; undefined IDs are reported by the scan below.)
    for (const group of visibleForRefs(item.text).matchAll(/\(([^()]*)\)/g)) {
      if (!hasLocator(group[1]) && !isIdList(group[1])) continue;
      for (const token of group[1].split(/[;,]/).map((s) => s.trim())) {
        const em = /^E(\d+)$/.exec(token);
        if (em) evidenceRefs.push({ id: Number(em[1]), line: item.line });
      }
    }
  }

  if (claimsHeading && claimIds.size === 0) {
    add('no-claims', 'warn', claimsHeading.line, 'The Claims section has no valid claim bullets.', 'Add at least one claim: "- **C1** [measured] Claim text. (Fig 2A)".');
  }

  // ---- evidence -----------------------------------------------------------
  const evidenceIds = new Map<number, number>();
  for (const item of collectItems('Evidence')) {
    const em = /^[-*]\s+\*\*E(\d+)\*\*/.exec(item.text);
    if (em) {
      const id = Number(em[1]);
      if (evidenceIds.has(id)) {
        add('duplicate-evidence-id', 'warn', item.line, `Evidence ID E${id} is used more than once.`, 'Use each E-ID once; only give evidence an ID when two claims reuse it.');
      } else {
        evidenceIds.set(id, item.line);
      }
    }
    if (!hasLocator(item.text)) {
      add('evidence-no-locator', 'info', item.line, 'Evidence bullet has no locator.', 'Add a figure, table, section or PDF page locator.');
    }
  }
  const cited = new Set<number>();
  for (const ref of evidenceRefs) cited.add(ref.id);
  for (const [id, line] of evidenceIds) {
    if (!cited.has(id)) {
      add('orphan-evidence-id', 'info', line, `E${id} is defined but no claim cites it.`, 'Cite it from a claim or drop the ID.');
    }
  }

  // ---- claim references (prose + Mermaid labels) -----------------------------
  // Claim references are read everywhere (prose and diagram labels). A scientific symbol that looks like an ID, such as
  // complement component 3 or the E3 ligase, is written in backticks or spelled out; inline code is skipped here.
  // Scanned per block, not per line: a paragraph or list item that wraps ("(Fig 1A,\n  E9)") is one parenthesis.
  const refScope: Array<{ n: number; text: string }> = [];
  {
    let cur: { n: number; text: string } | null = null;
    for (const l of lines) {
      if (l.kind === 'fence-body' && l.lang === 'mermaid' && !/^\s*%%/.test(l.text)) {
        refScope.push({ n: l.n, text: l.text });
        cur = null;
        continue;
      }
      if (l.kind !== 'prose' || l.text.trim() === '') {
        cur = null;
        continue;
      }
      const startsItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(l.text);
      const standalone = /^#{1,6}\s/.test(l.text) || /^\s*\|/.test(l.text) || /^\s*>/.test(l.text);
      if (cur && !startsItem && !standalone) {
        cur.text += ` ${stripSourceField(l.text).trim()}`;
      } else {
        cur = { n: l.n, text: stripSourceField(l.text) };
        refScope.push(cur);
        if (standalone) cur = null; // headings, table rows and callout lines never absorb the next line
      }
    }
  }
  for (const l of refScope) {
    const seenClaims = new Set<number>();
    const seenEvidence = new Set<number>();
    for (const group of visibleForRefs(l.text).matchAll(/\(([^()]*)\)/g)) {
      const tokens = group[1].split(/[;,]/).map((s) => s.trim());
      for (const token of tokens) {
        for (const num of claimRefNumbers(token) ?? []) {
          if (!claimIds.has(num) && !seenClaims.has(num)) {
            seenClaims.add(num);
            add('undefined-claim-ref', 'warn', l.n, `Reference to C${num}, which is not defined in Claims.`, `Cite an existing claim ID or add the claim. If C${num} is a scientific symbol (complement C${num}), write it in backticks or spell it out.`);
          }
        }
      }
      // Evidence IDs: a parenthesis that holds a locator or only IDs, "(Fig 2B, E2)" or "(E2)".
      if (hasLocator(group[1]) || isIdList(group[1])) {
        for (const token of tokens) {
          const em = /^E(\d+)$/.exec(token);
          const num = em ? Number(em[1]) : null;
          if (num !== null && !evidenceIds.has(num) && !seenEvidence.has(num)) {
            seenEvidence.add(num);
            add('undefined-evidence-ref', 'warn', l.n, `Reference to E${num}, which is not defined in Evidence.`, `Define "- **E${num}** …" in ## Evidence or remove the reference. If E${num} is a scientific symbol (the E${num} ligase), write it in backticks.`);
          }
        }
      }
    }
  }

  // ---- Mermaid -----------------------------------------------------------
  const mermaid: MermaidBlock[] = [];
  let current: MermaidBlock | null = null;
  for (const l of lines) {
    if (l.kind === 'fence-open') current = l.lang === 'mermaid' ? { startLine: l.n, lines: [] } : null;
    else if (l.kind === 'fence-body' && current && l.lang === 'mermaid') current.lines.push(l);
    else if (l.kind === 'fence-close' && current) { mermaid.push(current); current = null; }
  }
  if (current) mermaid.push(current);

  if (mermaid.length > MERMAID_MAX_DIAGRAMS) {
    add('too-many-diagrams', 'info', mermaid[MERMAID_MAX_DIAGRAMS].startLine, `${mermaid.length} diagrams in one note (guide: at most ${MERMAID_MAX_DIAGRAMS}).`, 'Keep only the diagram that carries the paper’s main argument.');
  }
  for (const block of mermaid) {
    const body = block.lines.filter((l) => l.text.trim() !== '' && !/^\s*%%/.test(l.text));
    const first = body[0]?.text.trim() ?? '';
    const header = /^(flowchart|graph)\s+(\w+)/.exec(first);
    if (!header) {
      add('mermaid-non-flowchart', 'info', block.startLine, 'Diagram is not a flowchart.', 'Prefer a flowchart; other diagram types are not covered by the checker.');
    } else {
      if (header[2] === 'LR' || header[2] === 'RL') {
        add('mermaid-direction', 'info', block.startLine, 'Left-to-right flowcharts shrink to unreadable size in a narrow note column.', 'Use "flowchart TB".');
      }
      const nodes = mermaidNodeCount(block.lines);
      if (nodes > MERMAID_MAX_NODES) {
        add('mermaid-too-large', 'info', block.startLine, `Diagram has about ${nodes} nodes (guide: at most ${MERMAID_MAX_NODES}).`, 'Split the argument or drop minor steps.');
      }
      for (const l of block.lines) {
        if (!/^\s*%%/.test(l.text) && hasUnquotedSpecialLabel(l.text)) {
          add('mermaid-unquoted-label', 'info', l.n, 'Label with special characters is not quoted.', 'Wrap the label in double quotes.');
        }
      }
    }
    for (const l of block.lines) {
      if (l.text.includes('[[') || l.text.includes(']]')) {
        add('mermaid-wikilink', 'warn', l.n, 'Double-bracket syntax inside a Mermaid block is read as a wikilink by kb_lint.', 'Use a plain rectangle ["label"] instead of subroutine or wikilink shapes.');
        break;
      }
    }
  }

  // ---- HTML and page locators -------------------------------------------------
  for (const l of prose) {
    const noCode = l.text.replace(/`[^`]*`/g, '');
    if (HTML_TAG.test(noCode)) {
      add('html-tag', 'warn', l.n, 'HTML tag in note text.', 'Use Markdown instead; HTML renders unreliably in Obsidian.');
    }
    if (BARE_PAGE_LOCATOR.test(noCode)) {
      add('ambiguous-page-locator', 'info', l.n, 'Bare "p. N" does not say whether it is a PDF or printed page.', 'Write "PDF p. N" (matches the compiler’s page markers) or "printed p. N".');
    }
  }

  // ---- Figure Map ---------------------------------------------------------
  let figureMapRows = 0;
  const figureHeading = headings.find((h) => h.name === 'Figure Map');
  if (figureHeading) {
    const section = sectionLines('Figure Map');
    let rowInTable = -1;
    for (const l of section) {
      const isRow = l.kind === 'prose' && /^\s*\|/.test(l.text);
      if (!isRow) { rowInTable = -1; continue; }
      rowInTable += 1;
      if (rowInTable < 2) continue; // header + separator
      figureMapRows += 1;
      for (const cell of l.text.split('|').map((c) => c.trim()).filter(Boolean)) {
        if (countWords(cell) > FIGURE_MAP_MAX_CELL_WORDS) {
          add('figure-map-cell-long', 'info', l.n, `Figure Map cell has ${countWords(cell)} words (guide: at most ${FIGURE_MAP_MAX_CELL_WORDS}).`, 'Cut it to one factual sentence; keep qualifiers.');
        }
      }
    }
    const split = section.some((l) => l.kind === 'prose' && /^###(?!#)\s+/.test(l.text));
    if (figureMapRows > FIGURE_MAP_MAX_ROWS && !split) {
      add('figure-map-long', 'info', figureHeading.line, `Figure Map has ${figureMapRows} rows in one block.`, 'Split it under "### Main figures" and "### Supplementary" headings. Do not delete rows.');
    }
  }

  // ---- sentence-level style ---------------------------------------------------
  interface Unit { line: number; text: string }
  const units: Unit[] = [];
  let para: Unit | null = null;
  for (const l of prose) {
    const t = l.text;
    const isBlank = t.trim() === '';
    const isHeading = /^#{1,6}\s/.test(t);
    const isTable = /^\s*\|/.test(t);
    const isCalloutTitle = /^\s*>\s*\[![\w-]+\]/.test(t);
    const isQuote = /^\s*>/.test(t);
    const isItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(t);
    if (isBlank || isHeading || isTable || isCalloutTitle) { para = null; continue; }
    if (isQuote || isItem) {
      para = null;
      units.push({ line: l.n, text: t });
      continue;
    }
    if (para) para.text += ` ${t.trim()}`;
    else { para = { line: l.n, text: t.trim() }; units.push(para); }
  }

  const wordCounts: number[] = [];
  for (const unit of units) {
    const sentences = splitSentences(cleanForSentences(unit.text));
    if (sentences.length >= LONG_PARAGRAPH_SENTENCES) {
      add('long-paragraph', 'info', unit.line, `Paragraph has ${sentences.length} sentences (guide: about 5).`, 'Split it by topic.');
    }
    for (const s of sentences) {
      const words = countWords(s);
      wordCounts.push(words);
      if (words > LONG_SENTENCE_WORDS) {
        add('long-sentence', 'info', unit.line, `Sentence has ${words} words.`, 'Split it unless a qualifier or comparison needs the space.');
      }
      if (/^(?:It|They|These|Those|This|That)\s+(?:is|are|was|were|has|have|had|does|do|did|can|could|may|might|will|would|shows?|suggests?|means?)\b/.test(s)) {
        add('leading-pronoun', 'info', unit.line, 'Sentence starts with a bare pronoun.', 'Repeat the noun so the sentence stands alone.');
      }
    }
  }

  // ---- finish ----------------------------------------------------------------
  for (const [code, entry] of perCode) {
    if (entry.overflow > 0) {
      raw.push({ code, severity: entry.severity, line: entry.overflowLine, message: `+${entry.overflow} more ${code} findings`, fix: entry.fix });
    }
  }
  const findings = raw
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.line - b.f.line || (a.f.severity === b.f.severity ? 0 : a.f.severity === 'warn' ? -1 : 1) || a.i - b.i)
    .map(({ f }) => f);

  const over = wordCounts.filter((w) => w > LONG_SENTENCE_WORDS).length;
  const stats: LintStats = {
    sentences: wordCounts.length,
    meanWords: wordCounts.length ? Math.round((wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) * 10) / 10 : 0,
    pctOver25: wordCounts.length ? Math.round((over / wordCounts.length) * 100) : 0,
    claims: claimIds.size,
    diagrams: mermaid.length,
    tldrWords,
    figureMapRows,
  };

  return { ok: !findings.some((f) => f.severity === 'warn'), findings, stats };
}
