import { describe, expect, test } from "bun:test";
import { createMetricsCollector } from "../src/metrics.ts";

describe("createMetricsCollector", () => {
  test("collects per-turn rates, task ids, context events, and totals", () => {
    let task = "a";
    const metrics = createMetricsCollector(() => task);
    metrics.collect({ type: "prune", freedTokens: 100 });
    metrics.collect({
      type: "timing", phase: "model", durationMs: 1000, ttftMs: 50,
      totalMs: 800, loadMs: 10, promptEvalMs: 500, evalMs: 250,
      promptTokens: 1000, evalTokens: 100, thinkingChars: 20,
    });
    task = "b";
    metrics.collect({ type: "timing", phase: "tool", durationMs: 40 });
    expect(metrics.modelTurns[0]).toMatchObject({
      turn: 1, task_id: "a", total_duration_ms: 800, queue_residual_ms: 40,
      client_overhead_ms: 200, prefill_tps: 2000, decode_tps: 400, context_event: "prune",
    });
    expect(metrics.totals).toEqual({
      modelMs: 1000, toolMs: 40, ttftMs: 50, loadMs: 10, promptEvalMs: 500, evalMs: 250,
    });
  });

  test("guards zero and missing durations", () => {
    const metrics = createMetricsCollector();
    metrics.collect({
      type: "timing", phase: "model", durationMs: 1,
      promptEvalMs: 0, evalMs: 0, promptTokens: 10, evalTokens: 10,
    });
    expect(metrics.modelTurns[0]!.prefill_tps).toBeUndefined();
    expect(metrics.modelTurns[0]!.decode_tps).toBeUndefined();
  });
});
