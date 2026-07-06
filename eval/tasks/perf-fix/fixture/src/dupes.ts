/**
 * Returns the elements that occur two or more times in `items`.
 *
 * Contract:
 * - An element is a "duplicate" if it appears at least twice in `items`.
 * - Each duplicate element is listed exactly once in the result, even if it
 *   appears three or more times.
 * - The result is ordered by each duplicate's first appearance in `items`
 *   (the position of its first occurrence, not its second).
 * - Elements that appear only once are not included.
 *
 * Examples:
 *   findDuplicates([])                    -> []
 *   findDuplicates(["a", "b", "c"])       -> []
 *   findDuplicates(["a", "b", "a", "b"])  -> ["a", "b"]
 *   findDuplicates(["x", "x", "x"])       -> ["x"]
 */
export function findDuplicates(items: string[]): string[] {
  const duplicates: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Count how many times this element occurs by scanning the whole array.
    let count = 0;
    for (let j = 0; j < items.length; j++) {
      if (items[j] === item) count++;
    }
    if (count >= 2 && !duplicates.includes(item)) {
      duplicates.push(item);
    }
  }
  return duplicates;
}
