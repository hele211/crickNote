import { createPatch, structuredPatch } from 'diff';

/**
 * Generate a unified diff between two strings.
 *
 * @param before  - Original file content.
 * @param after   - Modified file content.
 * @param filePath - File path used in the diff header.
 * @returns Unified diff string.
 */
export function generateDiff(
  before: string,
  after: string,
  filePath: string,
): string {
  return createPatch(filePath, before, after, 'original', 'modified');
}

/**
 * Generate a structured patch (array of hunks) between two strings.
 * Useful when programmatic access to individual hunks is needed.
 */
export function generateStructuredDiff(
  before: string,
  after: string,
  filePath: string,
) {
  return structuredPatch(filePath, filePath, before, after, 'original', 'modified');
}

/**
 * Generate a formatted three-way comparison for conflict resolution.
 *
 * Shows the original content (when the agent read the file), the current
 * content on disk (modified by someone else), and the agent's proposed
 * content, each as a separate diff against the original.
 *
 * @param original  - Content when the agent first read the file.
 * @param current   - Content currently on disk (changed externally).
 * @param proposed  - Content the agent wants to write.
 * @param filePath  - File path used in diff headers.
 * @returns Formatted string with both diffs and clear section markers.
 */
export function generateThreeWayDiff(
  original: string,
  current: string,
  proposed: string,
  filePath: string,
): string {
  const externalDiff = createPatch(
    filePath,
    original,
    current,
    'original (when agent read)',
    'current (external changes)',
  );

  const proposedDiff = createPatch(
    filePath,
    original,
    proposed,
    'original (when agent read)',
    'proposed (agent changes)',
  );

  const sections: string[] = [
    '=== THREE-WAY CONFLICT ===',
    `File: ${filePath}`,
    '',
    '--- External changes (original → current on disk) ---',
    externalDiff,
    '',
    '--- Proposed changes (original → agent proposal) ---',
    proposedDiff,
    '',
    '=== END CONFLICT ===',
  ];

  return sections.join('\n');
}
