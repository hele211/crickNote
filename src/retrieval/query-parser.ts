import * as chrono from 'chrono-node';

// --- Types ---

export interface ExperimentTypeEntry {
  name: string;
  aliases: string[];
}

export interface ParsedQuery {
  date: string | null;
  dateRange: { start: string; end: string } | null;
  experimentType: string | null;
  project: string | null;
  keywords: string[];
}

export interface ParserContext {
  experimentTypes: ExperimentTypeEntry[];
  projectNames: string[];
  referenceDate?: Date;
}

// --- Levenshtein distance (simple, no external lib) ---

function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const matrix: number[][] = [];
  for (let i = 0; i <= la; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= lb; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[la][lb];
}

// --- Fuzzy matching ---

/**
 * Match a candidate string against the experiment types registry.
 * Strategy: exact match on name/alias > includes check > Levenshtein.
 * Returns the canonical type name, or null if no confident match.
 */
function fuzzyMatchExperimentType(
  candidate: string,
  registry: ExperimentTypeEntry[],
): string | null {
  const lower = candidate.toLowerCase().trim();
  if (lower.length === 0) return null;

  // Pass 1: exact match on name or alias (case-insensitive)
  for (const entry of registry) {
    if (entry.name.toLowerCase() === lower) return entry.name;
    for (const alias of entry.aliases) {
      if (alias.toLowerCase() === lower) return entry.name;
    }
  }

  // Pass 2: includes check — candidate is a substring of name/alias or vice versa
  for (const entry of registry) {
    const entryName = entry.name.toLowerCase();
    if (entryName.includes(lower) || lower.includes(entryName)) {
      return entry.name;
    }
    for (const alias of entry.aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.includes(lower) || lower.includes(aliasLower)) {
        return entry.name;
      }
    }
  }

  // Pass 3: Levenshtein — only accept if distance is small relative to string length
  const maxDistance = Math.max(2, Math.floor(lower.length * 0.3));
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const entry of registry) {
    const d = levenshtein(lower, entry.name.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      bestMatch = entry.name;
    }
    for (const alias of entry.aliases) {
      const da = levenshtein(lower, alias.toLowerCase());
      if (da < bestDistance) {
        bestDistance = da;
        bestMatch = entry.name;
      }
    }
  }

  if (bestDistance <= maxDistance && bestMatch !== null) {
    return bestMatch;
  }

  return null;
}

/**
 * Match a candidate string against known project folder names.
 * Case-insensitive exact match, then includes, then Levenshtein.
 */
function matchProject(candidate: string, projectNames: string[]): string | null {
  const lower = candidate.toLowerCase().trim();
  if (lower.length === 0) return null;

  // Exact (case-insensitive)
  for (const p of projectNames) {
    if (p.toLowerCase() === lower) return p;
  }

  // Includes
  for (const p of projectNames) {
    const pLower = p.toLowerCase();
    if (pLower.includes(lower) || lower.includes(pLower)) {
      return p;
    }
  }

  return null;
}

// --- Date formatting helper ---

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- Main parser ---

/**
 * Deterministic query parser. No LLM involved.
 *
 * Extracts structured filters from a natural-language query string
 * using chrono-node for dates, fuzzy matching for experiment types,
 * and substring matching for project names.
 *
 * Never guesses — returns null for uncertain fields.
 */
export function parseQuery(query: string, context: ParserContext): ParsedQuery {
  const referenceDate = context.referenceDate ?? new Date();

  const result: ParsedQuery = {
    date: null,
    dateRange: null,
    experimentType: null,
    project: null,
    keywords: [],
  };

  // --- 1. Date extraction via chrono-node ---
  const chronoResults = chrono.parse(query, referenceDate, { forwardDate: false });
  const consumedDateSpans: Array<{ start: number; end: number }> = [];

  if (chronoResults.length > 0) {
    const parsed = chronoResults[0];
    const startDate = parsed.start.date();

    if (parsed.end) {
      // Range: "from March 1 to March 15", "2 weeks ago" (chrono may give range)
      const endDate = parsed.end.date();
      result.dateRange = {
        start: toISODate(startDate),
        end: toISODate(endDate),
      };
    } else {
      // Single date: "last Tuesday", "March 24"
      result.date = toISODate(startDate);
    }

    consumedDateSpans.push({ start: parsed.index, end: parsed.index + parsed.text.length });
  }

  // --- 2. Remove consumed date text to get remaining tokens ---
  let remaining = query;
  // Remove consumed spans in reverse order to preserve indices
  for (const span of consumedDateSpans.reverse()) {
    remaining = remaining.slice(0, span.start) + remaining.slice(span.end);
  }

  // Normalize whitespace
  remaining = remaining.replace(/\s+/g, ' ').trim();

  // --- 3. Experiment type matching ---
  // Try matching progressively smaller n-grams from the remaining text
  const words = remaining.split(/\s+/).filter(w => w.length > 0);
  let typeMatchedIndices: Set<number> = new Set();

  // Try n-grams from largest to smallest (up to 4 words)
  const maxNgram = Math.min(4, words.length);
  for (let n = maxNgram; n >= 1 && result.experimentType === null; n--) {
    for (let i = 0; i <= words.length - n; i++) {
      const ngram = words.slice(i, i + n).join(' ');
      const matched = fuzzyMatchExperimentType(ngram, context.experimentTypes);
      if (matched !== null) {
        result.experimentType = matched;
        for (let j = i; j < i + n; j++) {
          typeMatchedIndices.add(j);
        }
        break;
      }
    }
  }

  // --- 4. Project matching ---
  let projectMatchedIndices: Set<number> = new Set();

  // Try n-grams for project names too
  for (let n = Math.min(4, words.length); n >= 1 && result.project === null; n--) {
    for (let i = 0; i <= words.length - n; i++) {
      // Skip words already consumed by type matching
      const indices = Array.from({ length: n }, (_, j) => i + j);
      if (indices.some(idx => typeMatchedIndices.has(idx))) continue;

      const ngram = words.slice(i, i + n).join(' ');
      const matched = matchProject(ngram, context.projectNames);
      if (matched !== null) {
        result.project = matched;
        for (const idx of indices) {
          projectMatchedIndices.add(idx);
        }
        break;
      }
    }
  }

  // --- 5. Remaining words become keywords ---
  const consumedIndices = new Set([...typeMatchedIndices, ...projectMatchedIndices]);
  const stopWords = new Set([
    'show', 'me', 'find', 'get', 'the', 'a', 'an', 'my', 'all', 'from',
    'in', 'on', 'for', 'with', 'about', 'of', 'and', 'or', 'to', 'at',
    'what', 'which', 'where', 'when', 'how', 'did', 'do', 'does', 'was',
    'were', 'is', 'are', 'results', 'notes', 'experiments', 'note',
    'experiment', 'recent', 'latest',
  ]);

  result.keywords = words
    .filter((_, i) => !consumedIndices.has(i))
    .map(w => w.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(w => w.length > 1 && !stopWords.has(w));

  return result;
}
