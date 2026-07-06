import { describe, expect, test } from "bun:test";
import { sum, average, groupBy } from "../src/utils/aggregate";

describe("sum", () => {
  test("adds all numbers", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  test("returns 0 for an empty array", () => {
    expect(sum([])).toBe(0);
  });
});

describe("average", () => {
  test("computes the mean", () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  test("works for a single element", () => {
    expect(average([7])).toBe(7);
  });
});

describe("groupBy", () => {
  test("groups items by key", () => {
    const grouped = groupBy(["apple", "avocado", "banana"], (s) => s[0]!);
    expect(grouped.a).toEqual(["apple", "avocado"]);
    expect(grouped.b).toEqual(["banana"]);
  });

  test("returns an empty object for an empty array", () => {
    expect(groupBy([], (s: string) => s)).toEqual({});
  });
});
