const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Whole days between two dates (b - a), rounded to the nearest day. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** A new Date shifted by `days` (may be negative). */
export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** The YYYY-MM-DD portion of a date in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
