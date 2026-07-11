import { afterEach, describe, expect, test } from "bun:test";
import { daemonEnv, daemonPaths, parseDaemonArgs } from "../eval/daemon.ts";
import { foreignEntriesForInterval, type WatchEntry } from "../eval/watch-daemon.ts";
import { fetchRunnerSnapshot, parseRunnerPs } from "../src/provider/ollama.ts";

describe("runner snapshots", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("parses useful /api/ps fields and ignores malformed rows", () => {
    expect(parseRunnerPs({ models: [
      { name: "qwen", model: "qwen:latest", digest: "abc", size_vram: 12, context_length: 32768 },
      { digest: "missing-name" },
    ] })).toEqual([{ name: "qwen", model: "qwen:latest", digest: "abc", size_vram: 12, context_length: 32768 }]);
  });

  test("never rejects on HTTP, JSON, or timeout failures", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect((await fetchRunnerSnapshot("http://x")).error).toContain("503");
    globalThis.fetch = (async () => new Response("not-json")) as unknown as typeof fetch;
    expect((await fetchRunnerSnapshot("http://x")).error).toBeTruthy();
    globalThis.fetch = (async (_url, init) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    expect((await fetchRunnerSnapshot("http://x", 5)).error).toBeTruthy();
  });
});

describe("daemon helpers", () => {
  test("parses flags and builds hygienic env and paths", () => {
    const options = parseDaemonArgs(["start", "--port", "11500", "--flash-attention", "--kv-cache-type", "q8_0", "--env", "X=y"]);
    expect(daemonEnv(options, {})).toMatchObject({
      OLLAMA_HOST: "127.0.0.1:11500", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1",
      OLLAMA_KEEP_ALIVE: "30m", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", X: "y",
    });
    expect(daemonPaths(11500, "/tmp/lh").pid).toBe("/tmp/lh/daemon/11500/ollama.pid");
  });
});

test("watcher interval matching flags foreign digests only inside the sample", () => {
  const entries: WatchEntry[] = [
    { url: "other", captured_at: new Date(900).toISOString(), models: [{ name: "carry-in", digest: "bad" }] },
    { url: "u", captured_at: new Date(1500).toISOString(), models: [{ name: "ours", digest: "ok" }] },
    { url: "u", captured_at: new Date(1600).toISOString(), models: [{ name: "foreign", digest: "bad" }] },
    { url: "u", captured_at: new Date(3000).toISOString(), models: [{ name: "late", digest: "bad" }] },
  ];
  expect(foreignEntriesForInterval(entries, 1000, 2000, new Set(["ok"]))).toEqual([entries[0]!, entries[2]!]);
});
