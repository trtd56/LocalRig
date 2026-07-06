import { describe, expect, test } from "bun:test";
import { search } from "../src/search";
import type { Task } from "../src/types";

// Isolated fixture so the query language is tested independently of the store.
const tasks: Task[] = [
  { id: "1", title: "Write the design doc", status: "open", tags: ["docs", "urgent"], createdAt: 1 },
  { id: "2", title: "Review pull request", status: "done", tags: ["code"], createdAt: 2 },
  { id: "3", title: "Fix login bug", status: "open", tags: ["code", "urgent"], createdAt: 3 },
  { id: "4", title: "Write release notes", status: "open", tags: ["docs"], createdAt: 4 },
  { id: "5", title: "Deploy to staging", status: "done", tags: ["ops"], createdAt: 5 },
];

const ids = (query: string) => search(tasks, query).map((t) => t.id);

describe("empty query", () => {
  test("empty string returns all tasks", () => {
    expect(ids("")).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("whitespace-only returns all tasks", () => {
    expect(ids("   \t ")).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("bare words (title substring)", () => {
  test("matches a substring of the title", () => {
    expect(ids("write")).toEqual(["1", "4"]);
  });

  test("is case-insensitive", () => {
    expect(ids("WRITE")).toEqual(["1", "4"]);
  });

  test("multiple words are ANDed", () => {
    expect(ids("write notes")).toEqual(["4"]);
  });
});

describe("quoted phrases", () => {
  test("matches a contiguous phrase", () => {
    expect(ids('"pull request"')).toEqual(["2"]);
  });

  test("is case-insensitive", () => {
    expect(ids('"PULL REQUEST"')).toEqual(["2"]);
  });

  test("a phrase is stricter than ANDed words", () => {
    // Both words appear in task 1 but not as a contiguous phrase.
    expect(ids("write doc")).toEqual(["1"]);
    expect(ids('"write doc"')).toEqual([]);
  });

  test("a quoted token with a colon is literal text, not a key", () => {
    expect(ids('"status:open"')).toEqual([]);
  });
});

describe("status filter", () => {
  test("status:open", () => {
    expect(ids("status:open")).toEqual(["1", "3", "4"]);
  });

  test("status:done", () => {
    expect(ids("status:done")).toEqual(["2", "5"]);
  });

  test("conflicting status filters AND to nothing", () => {
    expect(ids("status:open status:done")).toEqual([]);
  });

  test("invalid status value throws", () => {
    expect(() => search(tasks, "status:archived")).toThrow();
  });
});

describe("tag filter", () => {
  test("tag:code", () => {
    expect(ids("tag:code")).toEqual(["2", "3"]);
  });

  test("multiple tags are ANDed", () => {
    expect(ids("tag:code tag:urgent")).toEqual(["3"]);
  });

  test("tag comparison is case-sensitive", () => {
    expect(ids("tag:CODE")).toEqual([]);
  });
});

describe("negation", () => {
  test("-tag excludes tasks with the tag", () => {
    expect(ids("-tag:urgent")).toEqual(["2", "4", "5"]);
  });

  test("-word excludes tasks whose title contains the word", () => {
    expect(ids("-write")).toEqual(["2", "3", "5"]);
  });
});

describe("combinations", () => {
  test("status and tag together", () => {
    expect(ids("status:open tag:docs")).toEqual(["1", "4"]);
  });

  test("bare word and status together", () => {
    expect(ids("write status:open")).toEqual(["1", "4"]);
  });

  test("status with tag exclusion", () => {
    expect(ids("status:open -tag:urgent")).toEqual(["4"]);
  });

  test("results preserve input order", () => {
    expect(ids("status:open")).toEqual(["1", "3", "4"]);
  });
});

describe("errors", () => {
  test("unknown key throws (foo:bar)", () => {
    expect(() => search(tasks, "foo:bar")).toThrow();
  });

  test("unknown key throws (priority:high)", () => {
    expect(() => search(tasks, "priority:high")).toThrow();
  });

  test("unterminated quote throws", () => {
    expect(() => search(tasks, '"unterminated')).toThrow();
  });
});
