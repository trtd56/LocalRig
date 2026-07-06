import { describe, expect, test } from "bun:test";
import { getOrCompute, makeCacheStore } from "../src/cache";

describe("cache", () => {
  test("computes once and caches the result", () => {
    const store = makeCacheStore();
    let calls = 0;
    const compute = () => {
      calls++;
      return "computed";
    };
    expect(getOrCompute(store, "k1", compute)).toBe("computed");
    expect(getOrCompute(store, "k1", compute)).toBe("computed");
    expect(calls).toBe(1);
  });

  test("surfaces the storage library's own error instead of silently dropping it", () => {
    const store = makeCacheStore();
    expect(() => getOrCompute(store, "", () => "computed")).toThrow("storage:");
  });
});
