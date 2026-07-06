// String formatting helpers shared across modules.

export function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Truncates `s` to at most `maxLen` characters. If truncation is needed,
 * the result ends with "..." and the TOTAL length, including the ellipsis,
 * must not exceed maxLen. Strings already within maxLen are returned as-is.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
