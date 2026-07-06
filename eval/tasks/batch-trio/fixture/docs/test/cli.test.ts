import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("parseArgs defaults", () => {
  test("uses the documented defaults when no flags are given", () => {
    expect(parseArgs([])).toEqual({
      format: "table",
      limit: 25,
      sort: "name",
      verbose: false,
    });
  });
});

describe("parseArgs flags", () => {
  test("reads each option", () => {
    const opts = parseArgs(["--format", "csv", "--limit", "5", "--sort", "date", "--verbose"]);
    expect(opts.format).toBe("csv");
    expect(opts.limit).toBe(5);
    expect(opts.sort).toBe("date");
    expect(opts.verbose).toBe(true);
  });

  test("rejects an unknown format", () => {
    expect(() => parseArgs(["--format", "xml"])).toThrow();
  });

  test("rejects a non-integer limit", () => {
    expect(() => parseArgs(["--limit", "abc"])).toThrow();
  });

  test("rejects an unknown sort key", () => {
    expect(() => parseArgs(["--sort", "size"])).toThrow();
  });

  test("rejects an unknown option", () => {
    expect(() => parseArgs(["--max", "5"])).toThrow();
  });
});
