import { describe, expect, test } from "bun:test";
import { sortByPriority, type Prioritized } from "../src/priority";

describe("sortByPriority", () => {
  test("orders high before medium before low", () => {
    const items: Prioritized[] = [
      { name: "c", priority: "low" },
      { name: "a", priority: "high" },
      { name: "b", priority: "medium" },
    ];
    expect(sortByPriority(items).map((i) => i.name)).toEqual(["a", "b", "c"]);
  });

  test("is stable within the same priority", () => {
    const items: Prioritized[] = [
      { name: "first", priority: "medium" },
      { name: "second", priority: "medium" },
      { name: "third", priority: "medium" },
    ];
    expect(sortByPriority(items).map((i) => i.name)).toEqual(["first", "second", "third"]);
  });

  test("does not mutate the input array", () => {
    const items: Prioritized[] = [
      { name: "x", priority: "low" },
      { name: "y", priority: "high" },
    ];
    sortByPriority(items);
    expect(items.map((i) => i.name)).toEqual(["x", "y"]);
  });
});
