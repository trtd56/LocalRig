/** URL-safe slug: lowercase, words joined by single hyphens, no edge hyphens. */
export function slugify(title: string): string {
  return title
    .trim()
    .replace(/[^A-Za-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-");
}
