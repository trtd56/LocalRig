// Aggregation helpers for working with collections of numbers and records.

export function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("average of empty array");
  return sum(nums) / nums.length;
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}
