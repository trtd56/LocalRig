import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cmdBatch,
  cmdDiff,
  cmdDistill,
  cmdFeedback,
  cmdPoll,
  cmdResearch,
  cmdScout,
  cmdSubmit,
  cmdWait,
} from "../src/index.ts";
import {
  InvalidSessionIdError,
  isValidSessionId,
  loadSession,
  readFeedback,
  saveSession,
  validateSessionId,
  type SessionRecord,
} from "../src/session.ts";

interface Captured<T> {
  result: T;
  stdout: string[];
  stderr: string[];
}

async function capture<T>(run: () => T | Promise<T>): Promise<Captured<T>> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stderr.write;
  console.log = (value?: unknown) => { stdout.push(String(value ?? "")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr.push(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalWrite;
  }
}

function record(id: string): SessionRecord {
  return {
    id,
    createdAt: "2026-07-08T00:00:00.000Z",
    cwd: process.cwd(),
    model: "test-model",
    prompt: "test",
    status: "ok",
    result: "done",
    durationMs: 1,
    turns: 1,
    toolCalls: 0,
    tokens: { prompt: 1, completion: 1 },
  };
}

describe("session id CLI boundary", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-id-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-id-cwd-"));
    process.env.LH_HOME = home;
  });

  afterEach(() => {
    delete process.env.LH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("the shared validator preserves safe dotted legacy ids and rejects path-like ids", () => {
    const safe = ["a", "legacy.v1-run", "a.b-c_d9", "a".repeat(128)];
    for (const id of safe) {
      expect(isValidSessionId(id)).toBe(true);
      expect(validateSessionId(id)).toBe(id);
    }

    const unsafe = [
      "",
      ".hidden",
      "trailing.",
      "a..b",
      "../escape",
      "a/b",
      "a\\b",
      "/tmp/absolute",
      "C:\\tmp\\absolute",
      "nul\0byte",
      "a".repeat(129),
    ];
    for (const id of unsafe) {
      expect(isValidSessionId(id)).toBe(false);
      expect(() => validateSessionId(id)).toThrow(InvalidSessionIdError);
    }
  });

  test("every id-taking subcommand returns config JSON before doing work", async () => {
    const invalid = "../escape";
    let distillInputReads = 0;
    let diffRuns = 0;
    let researchCalls = 0;
    let scoutAgents = 0;
    const missingManifest = path.join(cwd, "must-not-be-read.json");
    const commands: Array<[string, () => number | Promise<number>]> = [
      ["feedback", () => cmdFeedback([invalid, "pass", "--json"])],
      ["poll", () => cmdPoll([invalid, "--json"])],
      ["wait", () => cmdWait([invalid, "--timeout", "0", "--json"])],
      ["submit", () => cmdSubmit(["-p", "do nothing", "--session-id", invalid, "--json"])],
      ["batch", () => cmdBatch(["--tasks", missingManifest, "--session-id", invalid, "--json"])],
      ["distill", () => cmdDistill(["-q", "x", "--session-id", invalid, "--json"], {
        readStdin: async () => { distillInputReads++; return "must not read"; },
        complete: async () => ({ text: "{}" }),
      })],
      ["diff", () => cmdDiff(["-q", "x", "--session-id", invalid, "--json"], {
        runGit: async () => { diffRuns++; return "must not run"; },
        complete: async () => ({ text: "{}" }),
      })],
      ["research", () => cmdResearch([
        "-q", "x", "https://example.com", "--session-id", invalid, "--json",
      ], {
        env: {},
        search: async () => { researchCalls++; return []; },
        fetchPage: async () => { researchCalls++; return { url: "https://example.com", title: "x", text: "x" }; },
        complete: async () => { researchCalls++; return { text: "{}" }; },
        writeSnapshots: async () => { researchCalls++; return []; },
      })],
      ["scout", () => cmdScout(["-q", "x", "--session-id", invalid, "--json"], {
        createAgent: () => {
          scoutAgents++;
          throw new Error("must not create an agent");
        },
      })],
    ];

    for (const [name, run] of commands) {
      const captured = await capture(run);
      expect(captured.result, name).toBe(1);
      expect(captured.stdout, name).toHaveLength(1);
      expect(JSON.parse(captured.stdout[0]!), name).toMatchObject({
        status: "error",
        error_kind: "config",
      });
      expect(JSON.parse(captured.stdout[0]!).error, name).toContain("invalid session id");
      expect(captured.stderr.join("\n"), name).not.toContain("InvalidSessionIdError");
      expect(fs.readdirSync(home), name).toEqual([]);
    }
    expect(fs.existsSync(missingManifest)).toBe(false);
    expect(distillInputReads).toBe(0);
    expect(diffRuns).toBe(0);
    expect(researchCalls).toBe(0);
    expect(scoutAgents).toBe(0);
  });

  test("one-shot session and resume ids fail before model or persistence work", async () => {
    const script = path.resolve(import.meta.dir, "../src/index.ts");
    for (const args of [
      ["-p", "do nothing", "--session-id", "../escape", "--json"],
      ["-p", "follow up", "--resume", "../escape", "--json"],
    ]) {
      const proc = Bun.spawn([process.execPath, script, ...args], {
        cwd,
        env: { ...process.env, LH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ status: "error", error_kind: "config" });
      expect(stderr).not.toContain("InvalidSessionIdError");
      expect(stderr).not.toMatch(/\n\s+at\s/);
      expect(fs.readdirSync(home)).toEqual([]);
    }
  });

  test("non-JSON invalid ids never expose a stack", async () => {
    for (const run of [
      () => cmdFeedback(["../escape", "pass"]),
      () => cmdPoll(["../escape"]),
      () => cmdWait(["../escape", "--timeout", "0"]),
    ]) {
      const captured = await capture(run);
      expect(captured.result).toBe(1);
      const text = captured.stderr.join("\n");
      expect(text).toContain("invalid session id");
      expect(text).not.toContain("InvalidSessionIdError");
      expect(text).not.toMatch(/\n\s+at\s/);
      expect(fs.readdirSync(home)).toEqual([]);
    }
  });

  test("safe dotted legacy ids work through load, poll, wait, and feedback", async () => {
    const id = "legacy.v1-run";
    saveSession(record(id));
    expect(loadSession(id)?.id).toBe(id);

    const polled = await capture(() => cmdPoll([id, "--json"]));
    expect(polled.result).toBe(0);
    expect(JSON.parse(polled.stdout[0]!)).toMatchObject({ session_id: id, status: "ok" });

    const waited = await capture(() => cmdWait([id, "--json", "--timeout", "0"]));
    expect(waited.result).toBe(0);
    expect(JSON.parse(waited.stdout[0]!)).toMatchObject({ session_id: id, status: "ok" });

    const graded = await capture(() => cmdFeedback([id, "pass", "--json"]));
    expect(graded.result).toBe(0);
    expect(JSON.parse(graded.stdout[0]!)).toMatchObject({ status: "recorded", session_id: id });
    expect(readFeedback().at(-1)?.sessionId).toBe(id);
  });
});
