import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cmdResearch, cmdSubmit, type ResearchCliDeps } from "../src/index.ts";
import { loadSession } from "../src/session.ts";
import type { ChatMessage, ChatRequestOptions } from "../src/types.ts";

const PAGE_TEXT = "Evidence says the launch date is July 8.\nPRIVATE FULL PAGE TAIL MUST NOT LEAK.";

function completeResearch(modelFailure = false): NonNullable<ResearchCliDeps["complete"]> {
  return async (messages: ChatMessage[], _options: ChatRequestOptions) => {
    if (messages[0]?.content.startsWith("Plan 1 to 3")) {
      return { text: JSON.stringify({ queries: ["launch date"] }), promptTokens: 4, evalTokens: 2 };
    }
    if (modelFailure) return { text: "not JSON", promptTokens: 3, evalTokens: 1 };
    return {
      text: JSON.stringify({
        answer: "The launch date is July 8.",
        not_found: false,
        citations: [{
          file: "https://example.com/a",
          start_line: 1,
          end_line: 1,
          quote: "launch date is July 8",
        }],
        omitted: [],
      }),
      promptTokens: 12,
      evalTokens: 5,
    };
  };
}

describe("cmdResearch", () => {
  let home: string;
  let cwd: string;
  let logs: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const originalStderrWrite = process.stderr.write;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-research-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-research-cwd-"));
    process.env.LH_HOME = home;
    logs = [];
    console.log = (value?: unknown) => { logs.push(String(value ?? "")); };
    console.error = (() => {}) as typeof console.error;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalStderrWrite;
    delete process.env.LH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const page = async (url: string) => ({ url, title: "Example", text: PAGE_TEXT });

  test("rejects a missing query and a search-only run without a configured provider", async () => {
    expect(await cmdResearch(["--json"], { env: {} })).toBe(1);
    expect(JSON.parse(logs.pop()!).error_kind).toBe("config");

    expect(await cmdResearch(["-q", "when?", "--json"], { env: {} })).toBe(1);
    expect(JSON.parse(logs.pop()!).error).toContain("search provider");
    expect(fs.existsSync(path.join(home, "sessions"))).toBe(false);
  });

  test("strictly rejects unsupported, malformed, and unsafe arguments", async () => {
    const cases = [
      ["-q", "x", "--wat", "--json"],
      ["-q", "x", "--search-provider", "google", "--json"],
      ["-q", "x", "--max-results", "1.5", "--json"],
      ["-q", "x", "--max-pages", "0", "--json"],
      ["-q", "x", "--search-url", "file:///tmp/a", "--json"],
      ["-q", "x", "ftp://example.com/a", "--json"],
      ["-q", "x", "https://user:pass@example.com/a", "--json"],
      ["-q", "x", "https://example.com", "--resume", "old", "--json"],
    ];
    for (const argv of cases) {
      expect(await cmdResearch(argv, { env: {} })).toBe(1);
      expect(JSON.parse(logs.pop()!).error_kind).toBe("config");
    }
  });

  test("runs with direct URLs only and does not require a provider", async () => {
    let fetched = "";
    const rc = await cmdResearch([
      "-q", "when?", "https://example.com/a", "--json", "--cwd", cwd, "--session-id", "direct-url",
      "--caller", "codex", "--hardware", "test-hardware", "--integration-version", "2.1.0",
    ], {
      env: {},
      fetchPage: async (url) => { fetched = url; return page(url); },
      complete: completeResearch(),
    });
    expect(rc).toBe(0);
    expect(fetched).toBe("https://example.com/a");
    expect(loadSession("direct-url")?.kind).toBe("research");
    expect(loadSession("direct-url")?.dimensions).toMatchObject({
      caller: "codex",
      hardware: "test-hardware",
      integrationVersion: "2.1.0",
      localrigVersion: "0.1.0",
    });
  });

  test("selects an auto provider from the environment while using injected I/O", async () => {
    const searches: Array<[string, number]> = [];
    const rc = await cmdResearch([
      "-q", "when?", "--json", "--session-id", "provider-env", "--max-results", "3",
    ], {
      env: { BRAVE_SEARCH_API_KEY: "test-key", LH_SEARXNG_URL: "https://search.example.test" },
      search: async (query, limit) => {
        searches.push([query, limit]);
        return [{ url: "https://example.com/a", title: "Example" }];
      },
      fetchPage: page,
      complete: completeResearch(),
    });
    expect(rc).toBe(0);
    expect(searches).toEqual([["launch date", 3]]);
  });

  test("saves sha256-named snapshots and a safe manifest without leaking page bodies to JSON or sessions", async () => {
    const rc = await cmdResearch([
      "-q", "when?", "https://example.com/a", "--json", "--cwd", cwd, "--session-id", "saved-snapshot",
    ], { env: {}, fetchPage: page, complete: completeResearch() });
    expect(rc).toBe(0);
    expect(logs).toHaveLength(1);
    const line = logs[0]!;
    expect(line).not.toContain("PRIVATE FULL PAGE TAIL");
    expect(line.includes("\n")).toBe(false);
    const output = JSON.parse(line);
    expect(output.status).toBe("ok");
    expect(output.manifest_path).toBe(path.join(home, "research", "saved-snapshot", "manifest.json"));
    expect(output.turns).toBe(2);
    expect(output.cwd).toBe(cwd);
    expect(output.sources[0].snapshot_id).toMatch(/^[a-f0-9]{64}$/);
    expect(path.basename(output.sources[0].snapshot_path)).toBe(`${output.sources[0].snapshot_id}.txt`);

    const manifestFile = output.manifest_path;
    const manifestText = fs.readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifestText).not.toContain("PRIVATE FULL PAGE TAIL");
    expect(manifest.snapshots[0].path).toBe(`${output.sources[0].snapshot_id}.txt`);
    expect(fs.readFileSync(output.sources[0].snapshot_path, "utf8")).toBe(PAGE_TEXT);

    const record = loadSession("saved-snapshot")!;
    expect(record.result).not.toContain("PRIVATE FULL PAGE TAIL");
    expect(JSON.parse(record.result).digest.citations[0]).toMatchObject({
      url: "https://example.com/a",
      snapshot_sha256: output.sources[0].snapshot_id,
    });
    expect(record.tokens).toEqual({
      prompt_last: 12,
      prompt_total: 16,
      completion_total: 7,
      prompt: 12,
      completion: 7,
    });
  });

  test("classifies timeout, fetch, and model failures", async () => {
    const timeout = await cmdResearch([
      "-q", "x", "https://example.com/a", "--max-time", "0.001", "--json", "--session-id", "timeout",
    ], {
      env: {},
      fetchPage: async () => await new Promise(() => {}),
      complete: completeResearch(),
    });
    expect(timeout).toBe(1);
    expect(loadSession("timeout")?.status).toBe("timeout");

    const fetchError = await cmdResearch([
      "-q", "x", "https://example.com/a", "--json", "--session-id", "fetch-error",
    ], {
      env: {},
      fetchPage: async () => { throw new Error("network down"); },
      complete: completeResearch(),
    });
    expect(fetchError).toBe(1);
    expect(loadSession("fetch-error")?.errorKind).toBe("connection");

    const modelError = await cmdResearch([
      "-q", "x", "https://example.com/a", "--json", "--session-id", "model-error",
    ], { env: {}, fetchPage: page, complete: completeResearch(true) });
    expect(modelError).toBe(1);
    expect(loadSession("model-error")?.errorKind).toBe("ollama_error");
  });

  test("does not hide snapshot persistence failures", async () => {
    const rc = await cmdResearch([
      "-q", "x", "https://example.com/a", "--json", "--session-id", "write-error",
    ], {
      env: {},
      fetchPage: page,
      complete: completeResearch(),
      writeSnapshots: async () => { throw new Error("snapshot disk full"); },
    });
    expect(rc).toBe(1);
    const output = JSON.parse(logs.at(-1)!);
    expect(output).toMatchObject({ status: "error", error: "snapshot disk full", error_kind: "internal" });
    expect(loadSession("write-error")?.tokens).toEqual({
      prompt_last: 12,
      prompt_total: 16,
      completion_total: 7,
      prompt: 12,
      completion: 7,
    });
  });

  test("submit explicitly rejects research", async () => {
    expect(await cmdSubmit(["research", "-q", "x", "--json"])).toBe(1);
  });
});
