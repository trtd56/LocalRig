import { describe, expect, test } from "bun:test";
import { TaskStore, createTask } from "../src/store";
import { sampleTasks } from "../src/seed";

describe("createTask", () => {
  test("fills in defaults", () => {
    const t = createTask({ title: "hello" });
    expect(t.title).toBe("hello");
    expect(t.status).toBe("open");
    expect(t.tags).toEqual([]);
    expect(t.id).toBeTruthy();
  });

  test("assigns unique ids", () => {
    const a = createTask({ title: "a" });
    const b = createTask({ title: "b" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("TaskStore", () => {
  test("all() returns the seeded tasks in order", () => {
    const store = new TaskStore(sampleTasks());
    expect(store.all().map((t) => t.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("get() finds a task by id", () => {
    const store = new TaskStore(sampleTasks());
    expect(store.get("3")?.title).toBe("Fix login bug");
    expect(store.get("nope")).toBeUndefined();
  });

  test("add() appends a new task", () => {
    const store = new TaskStore(sampleTasks());
    const t = store.add({ title: "new one", tags: ["misc"] });
    expect(store.all()).toHaveLength(6);
    expect(store.get(t.id)?.title).toBe("new one");
  });

  test("complete() marks a task done", () => {
    const store = new TaskStore(sampleTasks());
    expect(store.complete("1").status).toBe("done");
    expect(store.get("1")?.status).toBe("done");
  });

  test("complete() throws for unknown id", () => {
    const store = new TaskStore(sampleTasks());
    expect(() => store.complete("nope")).toThrow();
  });

  test("remove() deletes a task", () => {
    const store = new TaskStore(sampleTasks());
    expect(store.remove("2")).toBe(true);
    expect(store.get("2")).toBeUndefined();
    expect(store.remove("2")).toBe(false);
  });
});
