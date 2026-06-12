/**
 * Paths that must never be indexed: binary/attachment trees, transient
 * mapping artifacts, Knowledge housekeeping/index files, and folder changelogs.
 */
export function shouldIgnoreIngestionPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    /(^|\/)attachments\//.test(normalized) ||
    /^(Reading\/[^/]+|Projects\/[^/]+)\/[^/]+-mapping(?:-\d{8}T\d{6})?\.md$/.test(normalized) ||
    normalized.startsWith('Knowledge/_Ops/') ||
    /^Knowledge\/(Concepts|Entities|Methods)\/_index\.md$/.test(normalized) ||
    /(^|\/)_changelog\.md$/.test(normalized)
  );
}
