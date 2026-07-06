import { describe, expect, test } from "bun:test";
import { incrementCounter, makeCounterStore, resetCounter } from "../src/rate-limiter";

describe("rate-limiter", () => {
  test("increments from zero", () => {
    const store = makeCounterStore();
    expect(incrementCounter(store, "ip1")).toBe(1);
    expect(incrementCounter(store, "ip1")).toBe(2);
  });

  test("resetCounter returns false when there was nothing to reset", () => {
    const store = makeCounterStore();
    expect(resetCounter(store, "ip2")).toBe(false);
  });

  test("resetCounter returns true and clears the counter", () => {
    const store = makeCounterStore();
    incrementCounter(store, "ip3");
    expect(resetCounter(store, "ip3")).toBe(true);
    expect(incrementCounter(store, "ip3")).toBe(1);
  });
});
