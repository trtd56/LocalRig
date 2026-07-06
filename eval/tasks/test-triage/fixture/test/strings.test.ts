import { describe, expect, test } from "bun:test";
import { capitalize, truncate, slugify } from "../src/utils/strings";

describe("capitalize", () => {
  test("capitalizes the first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });
});

describe("slugify", () => {
  test("converts to a url-safe slug", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });
});

describe("truncate", () => {
  test("returns the string unchanged when within maxLen", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  test("truncates and appends '...' without exceeding maxLen", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
    expect(truncate("hello world", 8).length).toBe(8);
  });
});
