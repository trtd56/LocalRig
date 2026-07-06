import { describe, expect, test } from "bun:test";
import { findDuplicates } from "../src/dupes";

describe("findDuplicates - correctness", () => {
  test("empty array has no duplicates", () => {
    expect(findDuplicates([])).toEqual([]);
  });

  test("all-unique array has no duplicates", () => {
    expect(findDuplicates(["a", "b", "c", "d"])).toEqual([]);
  });

  test("lists each duplicated element once", () => {
    expect(findDuplicates(["a", "b", "a", "c", "b"])).toEqual(["a", "b"]);
  });

  test("an element repeated three or more times is still listed once", () => {
    expect(findDuplicates(["x", "y", "x", "x", "z"])).toEqual(["x"]);
  });

  test("preserves first-appearance order of the duplicates", () => {
    // "c" first appears before "a", so it must come first in the result even
    // though "a" reaches its second occurrence earlier.
    expect(findDuplicates(["c", "a", "a", "b", "c"])).toEqual(["c", "a"]);
  });

  test("single element is never a duplicate", () => {
    expect(findDuplicates(["only"])).toEqual([]);
  });
});

// --- Deterministic large-input generation -------------------------------

/** Small, fast, deterministic PRNG (mulberry32) so the input is identical on
 *  every run without pulling in any dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds `n` string items drawn from `distinctSpace` possible values, so a
 *  large fraction of them repeat. */
function makeInput(n: number, distinctSpace: number, seed: number): string[] {
  const rand = mulberry32(seed);
  const items = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    items[i] = "item-" + Math.floor(rand() * distinctSpace);
  }
  return items;
}

/** Independent verification oracle: derives the expected result from the same
 *  input via sorting (O(n log n)), a different approach from the function under
 *  test. Used only to check correctness of the large-input result; it is not
 *  the timed code. */
function expectedDuplicates(items: string[]): string[] {
  const sorted = [...items].sort();
  const multi = new Set<string>();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) multi.add(sorted[i]!);
  }
  const result: string[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    if (multi.has(item) && !emitted.has(item)) {
      emitted.add(item);
      result.push(item);
    }
  }
  return result;
}

describe("findDuplicates - performance", () => {
  // The result must be correct AND produced quickly on a large input. An
  // O(n^2) implementation (e.g. scanning the whole array to count each element)
  // blows far past this budget; an O(n) / O(n log n) implementation finishes in
  // a few milliseconds.
  //
  // NOTE: the gate is the explicit elapsed-time assertion below, NOT Bun's
  // per-test timeout. Bun's test timeout is timer-based and cannot preempt a
  // synchronous CPU-bound call that never yields to the event loop, so a slow
  // synchronous findDuplicates would otherwise run to completion and be
  // reported as a pass. The generous test timeout is only a backstop for a
  // pathological (e.g. hanging) implementation.
  const N = 100_000;
  const DISTINCT_SPACE = 50_000;
  const SEED = 12345;
  const TIME_BUDGET_MS = 3000;

  test(
    "large input: correct result within the time budget",
    () => {
      const items = makeInput(N, DISTINCT_SPACE, SEED);
      const expected = expectedDuplicates(items);
      // Sanity check on the generator: this input genuinely contains many
      // duplicates, so the test can't pass by trivially returning [].
      expect(expected.length).toBeGreaterThan(1000);

      const started = performance.now();
      const actual = findDuplicates(items);
      const elapsedMs = performance.now() - started;

      expect(actual).toEqual(expected);
      expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
    },
    60_000,
  );
});
