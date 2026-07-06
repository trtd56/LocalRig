// Date helpers. Dates are ISO strings in "YYYY-MM-DD" form, which sort
// and compare correctly as plain strings.

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

export function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(diff / msPerDay);
}

/**
 * Returns true if `date` falls within [start, end], inclusive of both
 * endpoints.
 */
export function isWithinRange(date: string, start: string, end: string): boolean {
  return date > start && date < end;
}
