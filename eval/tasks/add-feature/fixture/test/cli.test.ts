import { describe, expect, test } from "bun:test";
import { formatOutput, type Item } from "../src/cli";

const items: Item[] = [
  { name: "alpha.txt", size: 100 },
  { name: "b.md", size: 42 },
];

describe("formatOutput", () => {
  test("table format keeps existing behavior", () => {
    const out = formatOutput(items, "table");
    expect(out).toContain("name");
    expect(out).toContain("alpha.txt");
    expect(out.split("\n")).toHaveLength(3);
  });

  test("json format returns structured JSON with count", () => {
    const out = formatOutput(items, "json");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ items, count: 2 });
  });

  test("json format is pretty-printed with 2-space indent", () => {
    const out = formatOutput(items, "json");
    expect(out).toBe(JSON.stringify({ items, count: 2 }, null, 2));
  });

  test("unknown format throws", () => {
    expect(() => formatOutput(items, "xml")).toThrow();
  });
});
