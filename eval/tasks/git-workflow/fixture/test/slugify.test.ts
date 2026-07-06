import { describe, expect, test } from "bun:test";
import { slugify } from "../src/slugify";

describe("slugify", () => {
  test("lowercases the input", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("collapses whitespace and hyphens", () => {
    expect(slugify("a  b - c")).toBe("a-b-c");
  });

  test("strips punctuation", () => {
    expect(slugify("Ship it, now!")).toBe("ship-it-now");
  });
});
