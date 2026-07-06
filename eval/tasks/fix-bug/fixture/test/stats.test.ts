import { describe, expect, test } from "bun:test";
import { mean, median, variance } from "../src/stats";

describe("stats", () => {
  test("mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  test("median of odd-length array", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  test("median of even-length array averages the middle pair", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("median must not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test("variance", () => {
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBe(4);
  });
});
