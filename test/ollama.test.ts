import { afterEach, describe, expect, test } from "bun:test";
import { OllamaClient } from "../src/provider/ollama.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("OllamaClient metrics", () => {
  test("converts done-frame nanoseconds to milliseconds", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      message: { role: "assistant", content: "ok" }, done: true,
      prompt_eval_count: 20, eval_count: 4,
      total_duration: 30_000_000, load_duration: 2_000_000,
      prompt_eval_duration: 10_000_000, eval_duration: 15_000_000,
    }) + "\n")) as unknown as typeof fetch;
    const response = await new OllamaClient("http://test", "model").chat(
      [{ role: "user", content: "hi" }], [], { num_ctx: 100 }, () => {}, new AbortController().signal,
    );
    expect(response.timings).toEqual({ totalMs: 30, loadMs: 2, promptEvalMs: 10, evalMs: 15 });
  });

  test("leaves timings undefined when the provider omits durations", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      message: { role: "assistant", content: "ok" }, done: true,
      prompt_eval_count: 20, eval_count: 4,
    }) + "\n")) as unknown as typeof fetch;
    const response = await new OllamaClient("http://test", "model").chat(
      [{ role: "user", content: "hi" }], [], { num_ctx: 100 }, () => {}, new AbortController().signal,
    );
    expect(response.timings).toBeUndefined();
  });

  test("complete reports timings and sends keep_alive at top level", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        message: { content: "ok" }, prompt_eval_count: 8, eval_count: 2,
        total_duration: 9_000_000, load_duration: 1_000_000,
        prompt_eval_duration: 3_000_000, eval_duration: 4_000_000,
      }));
    }) as typeof fetch;
    let usage: unknown;
    await new OllamaClient("http://test", "model", "30m").complete(
      [{ role: "user", content: "hi" }],
      { num_ctx: 100, onUsage: (value) => { usage = value; } },
      new AbortController().signal,
    );
    expect(body.keep_alive).toBe("30m");
    expect((body.options as Record<string, unknown>).keep_alive).toBeUndefined();
    expect(usage).toEqual({
      promptTokens: 8, evalTokens: 2,
      timings: { totalMs: 9, loadMs: 1, promptEvalMs: 3, evalMs: 4 },
    });
  });
});
