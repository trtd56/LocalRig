/** Bucket items by a derived string key. */
export function groupBy<T, K extends string>(
  items: T[],
  key: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/** Sum a numeric field across items. */
export function sumBy<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((acc, item) => acc + value(item), 0);
}

/** De-duplicate a list, preserving first-seen order. */
export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
