/**
 * Return today's date as a YYYY-MM-DD string in the LOCAL timezone.
 *
 * Using toISOString() would return a UTC date, which is wrong for users
 * east of UTC near midnight (e.g. 00:30 in UTC+1 is still yesterday in UTC).
 */
export function localDateString(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a Date that represents a YAML calendar date (stored as midnight UTC
 * by gray-matter) back to YYYY-MM-DD using UTC getters, so the calendar date
 * is preserved regardless of the local timezone.
 */
export function utcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
