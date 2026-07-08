import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cmdScout, type ScoutAgent } from "../src/index.ts";
import { loadSession } from "../src/session.ts";
import type { Config } from "../src/config.ts";
import type { AgentEvent, ChatMessage, RunReport, RunStatus } from "../src/types.ts";

describe("cmdScout", () => {
  let tmpHome: string;
  let cwd: string;
  const origLog = console.log;
  const origErr = process.stderr.write;
  let logs: string[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-scout-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-scout-cwd-"));
    process.env.LH_HOME = tmpHome;
    logs = [];
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ""));
    };
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = origLog;
    process.stderr.write = origErr;
    delete process.env.LH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function fakeAgentFactory(responses: string[], seen?: { system?: string; think?: boolean; config?: Config; prompts: string[] }) {
    return (systemPrompt: string, onEvent: (e: AgentEvent) => void, think: boolean, config: Config): ScoutAgent => {
      if (seen) {
        seen.system = systemPrompt;
        seen.think = think;
        seen.config = { ...config };
      }
      let calls = 0;
      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
      const report: RunReport = { changedFiles: [], commandsRun: [] };
      return {
        lastRunStatus: "ok" as RunStatus,
        interrupt() {},
        getMessages: () => messages,
        getReport: () => report,
        async run(input: string) {
          seen?.prompts.push(input);
          messages.push({ role: "user", content: input });
          onEvent({ type: "tool_start", name: "grep", args: { pattern: "x" }, display: "grep pattern=x" });
          onEvent({ type: "tool_end", name: "grep", result: { ok: true, output: "hit" } });
          onEvent({ type: "usage", promptTokens: 100 + calls, evalTokens: 10, ctxPercent: 1 });
          onEvent({ type: "turn_end" });
          return responses[Math.min(calls++, responses.length - 1)]!;
        },
        async runTextOnly(input: string) {
          seen?.prompts.push(input);
          messages.push({ role: "user", content: input });
          onEvent({ type: "usage", promptTokens: 100 + calls, evalTokens: 10, ctxPercent: 1 });
          onEvent({ type: "turn_end" });
          return responses[Math.min(calls++, responses.length - 1)]!;
        },
      };
    };
  }

  test("saves a scout session with verified citations and JSON output", async () => {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "retry.ts"), "export function withRetry() {}\n");
    const seen: { system?: string; think?: boolean; prompts: string[] } = { prompts: [] };
    const rc = await cmdScout(["-q", "where is retry?", "--paths", "src", "--cwd", cwd, "--json", "--quiet", "--session-id", "scout-sid"], {
      createAgent: fakeAgentFactory([
        JSON.stringify({
          answer: "Retry is implemented in src/retry.ts.",
          not_found: false,
          citations: [{ file: "src/retry.ts", start_line: 1, end_line: 1, quote: "withRetry" }],
          omitted: [],
        }),
      ], seen),
    });
    expect(rc).toBe(0);
    expect(seen.system).toContain("path hints: src");
    expect(seen.think).toBe(true);
    const rec = loadSession("scout-sid")!;
    expect(rec.kind).toBe("scout");
    expect(rec.prompt).toBe("where is retry?");
    expect(rec.turns).toBe(1);
    expect(rec.toolCalls).toBe(1);
    expect(rec.tokens).toEqual({ prompt: 100, completion: 10 });
    expect(JSON.parse(rec.result).citations[0]).toEqual({
      file: "src/retry.ts",
      start_line: 1,
      end_line: 1,
      quote: "withRetry",
    });
    expect(JSON.parse(rec.result).input_kind).toBe("repository");
    expect(JSON.parse(rec.result).metrics).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 10,
      token_measurement: "mixed",
    });
    expect(JSON.parse(logs.at(-1)!).digest.turns).toBe(1);
  });

  test("repairs malformed final JSON once", async () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "const needle = true;\n");
    const seen: { system?: string; think?: boolean; prompts: string[] } = { prompts: [] };
    const rc = await cmdScout(["-q", "needle?", "--cwd", cwd, "--json", "--quiet", "--session-id", "repair-sid"], {
      createAgent: fakeAgentFactory([
        "not json",
        JSON.stringify({
          answer: "Needle is in a.ts.",
          not_found: false,
          citations: [{ file: "a.ts", start_line: 1, end_line: 1, quote: "needle" }],
          omitted: [],
        }),
      ], seen),
    });
    expect(rc).toBe(0);
    expect(seen.prompts).toHaveLength(2);
    expect(seen.prompts[1]).toContain("required digest JSON schema");
    expect(JSON.parse(loadSession("repair-sid")!.result).parse_failed).toBeUndefined();
    expect(JSON.parse(loadSession("repair-sid")!.result).turns).toBe(2);
  });

  test("uses one dedicated text-only turn for JSON repair", async () => {
    const methods: string[] = [];
    let clock = 1_000;
    const rc = await cmdScout([
      "-q", "needle?",
      "--cwd", cwd,
      "--json",
      "--quiet",
      "--session-id", "repair-limits-sid",
      "--max-iterations", "7",
      "--max-time", "3",
    ], {
      now: () => clock,
      createAgent: (_systemPrompt, onEvent, _think, config) => {
        let calls = 0;
        const agent: ScoutAgent = {
          lastRunStatus: "ok" as RunStatus,
          interrupt() {},
          getMessages: () => [],
          getReport: () => ({ changedFiles: [], commandsRun: [] }),
          async run() {
            methods.push(`run:${config.maxIterations}:${config.maxTimeMs}`);
            onEvent({ type: "turn_end" });
            calls++;
            clock += 2_500;
            return "not json";
          },
          async runTextOnly() {
            methods.push("text-only");
            onEvent({ type: "turn_end" });
            agent.lastRunStatus = "ok";
            return JSON.stringify({ answer: "not found", not_found: true, citations: [], omitted: [] });
          },
        };
        return agent;
      },
    });
    expect(rc).toBe(0);
    expect(methods).toEqual(["run:7:3000", "text-only"]);
    expect(loadSession("repair-limits-sid")!.status).toBe("ok");
  });

  test("does not start JSON repair after the total time budget is exhausted", async () => {
    let clock = 1_000;
    let runs = 0;
    const rc = await cmdScout([
      "-q", "needle?", "--cwd", cwd, "--json", "--quiet",
      "--session-id", "repair-timeout-sid", "--max-time", "3",
    ], {
      now: () => clock,
      createAgent: (_systemPrompt, onEvent) => ({
        lastRunStatus: "ok" as RunStatus,
        interrupt() {},
        getMessages: () => [],
        getReport: () => ({ changedFiles: [], commandsRun: [] }),
        async run() {
          runs++;
          clock += 3_001;
          onEvent({ type: "turn_end" });
          return "not json";
        },
        async runTextOnly() {
          throw new Error("repair must not start after the deadline");
        },
      }),
    });
    expect(rc).toBe(0);
    expect(runs).toBe(1);
    expect(JSON.parse(loadSession("repair-timeout-sid")!.result).parse_failed).toBe(true);
  });

  test("applies smaller scout defaults unless caller overrides them", async () => {
    const seenDefault: { config?: Config; prompts: string[] } = { prompts: [] };
    expect(await cmdScout(["-q", "needle?", "--cwd", cwd, "--json", "--quiet", "--session-id", "defaults-sid"], {
      createAgent: fakeAgentFactory([
        JSON.stringify({ answer: "not found", not_found: true, citations: [], omitted: [] }),
      ], seenDefault),
    })).toBe(0);
    expect(seenDefault.config!.maxIterations).toBe(20);
    expect(seenDefault.config!.maxTimeMs).toBe(900_000);

    const seenExplicit: { config?: Config; prompts: string[] } = { prompts: [] };
    expect(await cmdScout([
      "-q", "needle?",
      "--cwd", cwd,
      "--json",
      "--quiet",
      "--session-id", "explicit-sid",
      "--max-iterations", "7",
      "--max-time", "3",
    ], {
      createAgent: fakeAgentFactory([
        JSON.stringify({ answer: "not found", not_found: true, citations: [], omitted: [] }),
      ], seenExplicit),
    })).toBe(0);
    expect(seenExplicit.config!.maxIterations).toBe(7);
    expect(seenExplicit.config!.maxTimeMs).toBe(3_000);
  });

  test("keeps a readable parse_failed digest when repair also fails", async () => {
    const rc = await cmdScout(["-q", "needle?", "--cwd", cwd, "--json", "--quiet", "--session-id", "parse-fail-sid"], {
      createAgent: fakeAgentFactory(["still prose", "still prose"]),
    });
    expect(rc).toBe(0);
    const digest = JSON.parse(loadSession("parse-fail-sid")!.result);
    expect(digest.parse_failed).toBe(true);
    expect(digest.raw_text).toBe("still prose");
    expect(digest.omitted[0]).toContain("parse failed");
  });

  test("drops hallucinated citations and marks unsupported answers", async () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "const real = true;\n");
    const rc = await cmdScout(["-q", "fake?", "--cwd", cwd, "--json", "--quiet", "--session-id", "drop-sid"], {
      createAgent: fakeAgentFactory([
        JSON.stringify({
          answer: "Fake answer.",
          not_found: false,
          citations: [{ file: "a.ts", start_line: 1, end_line: 1, quote: "missing quote" }],
          omitted: [],
        }),
      ]),
    });
    expect(rc).toBe(0);
    const digest = JSON.parse(loadSession("drop-sid")!.result);
    expect(digest.citations).toEqual([]);
    expect(digest.citations_dropped).toBe(1);
    expect(digest.omitted.join("\n")).toContain("without any verified citations");
  });

  test("rejects citations outside cwd through absolute, parent, and symlink paths", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-scout-outside-"));
    try {
      fs.writeFileSync(path.join(cwd, "inside.ts"), "const insideNeedle = true;\n");
      const outsideFile = path.join(outside, "secret.ts");
      fs.writeFileSync(outsideFile, "const secretNeedle = true;\n");
      fs.symlinkSync(outsideFile, path.join(cwd, "linked.ts"));
      const rc = await cmdScout(["-q", "needle?", "--cwd", cwd, "--json", "--quiet", "--session-id", "outside-citations-sid"], {
        createAgent: fakeAgentFactory([
          JSON.stringify({
            answer: "Needles found.",
            not_found: false,
            citations: [
              { file: "inside.ts", start_line: 1, end_line: 1, quote: "insideNeedle" },
              { file: outsideFile, start_line: 1, end_line: 1, quote: "secretNeedle" },
              { file: path.relative(cwd, outsideFile), start_line: 1, end_line: 1, quote: "secretNeedle" },
              { file: "linked.ts", start_line: 1, end_line: 1, quote: "secretNeedle" },
            ],
            omitted: [],
          }),
        ]),
      });
      expect(rc).toBe(0);
      const digest = JSON.parse(loadSession("outside-citations-sid")!.result);
      expect(digest.citations).toEqual([
        { file: "inside.ts", start_line: 1, end_line: 1, quote: "insideNeedle" },
      ]);
      expect(digest.citations_dropped).toBe(3);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects unsupported scout invocations before saving a session", async () => {
    expect(await cmdScout(["--json", "--session-id", "missing-q"], { createAgent: fakeAgentFactory(["{}"]) })).toBe(1);
    expect(loadSession("missing-q")).toBeNull();

    expect(await cmdScout(["-q", "x", "--resume", "old", "--json", "--session-id", "resume-q"], { createAgent: fakeAgentFactory(["{}"]) })).toBe(1);
    expect(loadSession("resume-q")).toBeNull();

    expect(await cmdScout(["-q", "x", "file.ts", "--json", "--session-id", "pos-q"], { createAgent: fakeAgentFactory(["{}"]) })).toBe(1);
    expect(loadSession("pos-q")).toBeNull();
  });
});
