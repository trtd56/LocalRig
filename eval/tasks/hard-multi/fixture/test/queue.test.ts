import { describe, expect, test } from "bun:test";
import { processBatch, type Job } from "../src/queue";

describe("processBatch", () => {
  test("returns one result per job", async () => {
    const jobs: Job<number>[] = [
      { id: "a", payload: 1 },
      { id: "b", payload: 2 },
      { id: "c", payload: 3 },
    ];
    const results = await processBatch(jobs, async (n) => n * 10);
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.result]));
    expect(byId).toEqual({ a: 10, b: 20, c: 30 });
  });

  test("handles async handlers with varying delays", async () => {
    const jobs: Job<number>[] = [
      { id: "slow", payload: 30 },
      { id: "fast", payload: 1 },
    ];
    const results = await processBatch(jobs, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results).toHaveLength(2);
  });

  test("empty batch returns empty array", async () => {
    const results = await processBatch([], async () => 1);
    expect(results).toEqual([]);
  });
});
