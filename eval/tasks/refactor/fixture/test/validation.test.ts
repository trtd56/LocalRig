import { describe, expect, test } from "bun:test";
import { isValidEmail } from "../src/validation";

describe("validation module", () => {
  test("accepts a normal address", () => {
    expect(isValidEmail("x@y.co")).toBe(true);
  });
  test("rejects missing @", () => {
    expect(isValidEmail("xy.co")).toBe(false);
  });
  test("rejects whitespace", () => {
    expect(isValidEmail("a b@y.co")).toBe(false);
  });
  test("rejects missing tld", () => {
    expect(isValidEmail("a@b")).toBe(false);
  });
});
