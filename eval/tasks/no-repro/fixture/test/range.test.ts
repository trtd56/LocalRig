import { describe, expect, test } from "bun:test";
import { parseRange } from "../src/range";

describe("parseRange", () => {
  test("a bare number yields a single-element list", () => {
    expect(parseRange("3")).toEqual([3]);
  });

  test("an ascending range is expanded inclusively", () => {
    expect(parseRange("1-4")).toEqual([1, 2, 3, 4]);
  });

  test("a descending range counts down inclusively", () => {
    expect(parseRange("5-3")).toEqual([5, 4, 3]);
  });

  test("comma-separated parts combine bare numbers and ranges", () => {
    expect(parseRange("1,3,5-7")).toEqual([1, 3, 5, 6, 7]);
  });

  test("a single-value range yields that value once", () => {
    expect(parseRange("4-4")).toEqual([4]);
  });

  test("whitespace around tokens is tolerated", () => {
    expect(parseRange(" 2 , 4-6 ")).toEqual([2, 4, 5, 6]);
  });

  test("throws on an empty string", () => {
    expect(() => parseRange("")).toThrow();
  });

  test("throws on a non-numeric token", () => {
    expect(() => parseRange("abc")).toThrow();
  });

  test("throws on an empty segment", () => {
    expect(() => parseRange("1,,2")).toThrow();
  });

  test("throws on a malformed range", () => {
    expect(() => parseRange("1-2-3")).toThrow();
  });
});
