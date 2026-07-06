import { describe, expect, test } from "bun:test";
import { makeConfigStore, readTimeoutMs, writeTimeoutMs } from "../src/config";

describe("config", () => {
  test("falls back to the default when nothing is stored", () => {
    const store = makeConfigStore();
    expect(readTimeoutMs(store)).toBe(5000);
  });

  test("returns the stored value once written", () => {
    const store = makeConfigStore();
    writeTimeoutMs(store, 9000);
    expect(readTimeoutMs(store)).toBe(9000);
  });
});
