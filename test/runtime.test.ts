import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../src/agent.ts";
import { runCheckCommand } from "../src/check.ts";
import { defaultConfig } from "../src/config.ts";
import { cmdDistill } from "../src/index.ts";
import { OllamaClient } from "../src/provider/ollama.ts";
import { RunDeadline } from "../src/runtime/deadline.ts";
import { runShellProcess } from "../src/runtime/process.ts";
import { loadSession } from "../src/session.ts";
import { createGrepTool } from "../src/tools/grep.ts";
import type { AgentEvent, ToolContext, ToolDef } from "../src/types.ts";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function neverRespondingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

describe("command deadline", () => {
  test("clamps local timeouts and deterministically expires with an injected clock", () => {
    let now = 1_000;
    const deadline = new RunDeadline(250, () => now, undefined, now);
    expect(deadline.clampTimeout(10_000)).toBe(250);
    now = 1_249;
    expect(deadline.remainingMs()).toBe(1);
    now = 1_250;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.timedOut).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  test("late-bound deadlines retain the command start epoch", () => {
    let now = 1_000;
    const deadline = new RunDeadline(0, () => now, undefined, now);
    now = 1_200;
    deadline.configure(250, 1_000);
    expect(deadline.remainingMs()).toBe(50);
    now = 1_250;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.timedOut).toBe(true);
    deadline.dispose();
  });

  test("dispose ends lazy wall-clock expiry but preserves explicit interruption", () => {
    let now = 1_000;
    const deadline = new RunDeadline(10, () => now, undefined, now);
    deadline.dispose();
    now = 2_000;

    expect(deadline.cause).toBeUndefined();
    expect(deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(deadline.signal.aborted).toBe(false);

    deadline.interrupt();
    expect(deadline.interrupted).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
  });

  test("aborts both streaming chat and non-streaming completion when Ollama never responds", async () => {
    globalThis.fetch = neverRespondingFetch();
    const client = new OllamaClient("http://ollama.invalid", "model");

    const chatDeadline = new RunDeadline(30);
    const chatStarted = Date.now();
    await expect(client.chat(
      [{ role: "user", content: "hello" }],
      [],
      { num_ctx: 1024 },
      () => {},
      chatDeadline.signal,
    )).rejects.toBeDefined();
    expect(Date.now() - chatStarted).toBeLessThan(1_000);
    expect(chatDeadline.timedOut).toBe(true);
    chatDeadline.dispose();

    const completeDeadline = new RunDeadline(30);
    const completeStarted = Date.now();
    await expect(client.complete(
      [{ role: "user", content: "hello" }],
      { num_ctx: 1024 },
      completeDeadline.signal,
    )).rejects.toBeDefined();
    expect(Date.now() - completeStarted).toBeLessThan(1_000);
    expect(completeDeadline.timedOut).toBe(true);
    completeDeadline.dispose();
  });

  test("a slow tool cannot trigger a timeout wrap-up or another model turn", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    globalThis.fetch = (async () => {
      modelCalls++;
      const line = JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "slow", arguments: {} } }],
        },
        done: true,
        prompt_eval_count: 4,
        eval_count: 2,
      });
      return new Response(line + "\n", { status: 200 });
    }) as unknown as typeof fetch;

    const slow: ToolDef = {
      name: "slow",
      description: "never resolves",
      parameters: { type: "object", properties: {} },
      mutating: false,
      execute: () => new Promise(() => {}),
    };
    const agent = new Agent(
      { ...defaultConfig, maxTimeMs: 40, permissionMode: "yolo" },
      os.tmpdir(),
      (event) => events.push(event),
      async () => true,
      "SYS",
      [slow],
    );
    const started = Date.now();
    expect(await agent.run("use the tool")).toContain("time budget");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(agent.lastRunStatus).toBe("timeout");
    expect(modelCalls).toBe(1);
    expect(events.some((event) => event.type === "timing" && event.phase === "model")).toBe(true);
    expect(events.some((event) => event.type === "timing" && event.phase === "tool")).toBe(true);
    expect(agent.getMessages().some((m) => m.content.includes("CRITICAL - stopping now"))).toBe(false);
  });
});

describe("bounded process runner", () => {
  function writeEscapedWriter(cwd: string): void {
    fs.writeFileSync(path.join(cwd, "escaped-writer.pl"), `use strict;
use warnings;
use POSIX qw(setsid);
setsid() or die "setsid failed: $!";
$SIG{TERM} = 'IGNORE';
open(my $pid, '>', 'escaped.pid') or die $!;
print $pid "$$\\n";
close($pid);
select(undef, undef, undef, 0.35);
open(my $out, '>', 'delayed.txt') or die $!;
print $out "escaped\\n";
close($out);
sleep(5);
`);
  }

  test("check cancellation reaches the process and returns promptly", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40);
    const started = Date.now();
    try {
      const check = await runCheckCommand({
        command: "sleep 10",
        cwd: os.tmpdir(),
        timeoutMs: 10_000,
        attempts: 1,
        signal: controller.signal,
      });
      expect(check.exit_code).not.toBe(0);
      expect(check.output_tail).toContain("interrupted");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      clearTimeout(timer);
    }
  });

  test("timeout kills a TERM-ignoring descendant process group", async () => {
    if (process.platform === "win32") return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-process-tree-"));
    const pidFile = path.join(cwd, "child.pid");
    try {
      const outcome = await runShellProcess({
        shell: "sh",
        command: "sh -c 'trap \"\" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait",
        cwd,
        timeoutMs: 80,
        maxOutputChars: 1_000,
        spoolPrefix: "lh-test-tree",
        killGraceMs: 20,
      });
      expect(outcome.timedOut).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(pid)).toBe(true);
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(10);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("AbortSignal immediately kills a TERM-ignoring descendant", async () => {
    if (process.platform === "win32") return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-process-abort-tree-"));
    const pidFile = path.join(cwd, "child.pid");
    const controller = new AbortController();
    try {
      const running = runShellProcess({
        shell: "sh",
        command: "sh -c 'trap \"\" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait",
        cwd,
        timeoutMs: 10_000,
        signal: controller.signal,
        maxOutputChars: 1_000,
        spoolPrefix: "lh-test-abort-tree",
      });
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await Bun.sleep(5);
      expect(fs.existsSync(pidFile)).toBe(true);
      controller.abort();
      const outcome = await running;
      expect(outcome.aborted).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("timeout kills a setsid descendant before it can perform a delayed write", async () => {
    if (process.platform === "win32" || !Bun.which("perl")) return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-process-setsid-timeout-"));
    try {
      writeEscapedWriter(cwd);
      const outcome = await runShellProcess({
        shell: "sh",
        command: "perl escaped-writer.pl & wait",
        cwd,
        timeoutMs: 80,
        maxOutputChars: 1_000,
        spoolPrefix: "lh-test-setsid-timeout",
        killGraceMs: 20,
      });
      expect(outcome.timedOut).toBe(true);
      expect(fs.existsSync(path.join(cwd, "escaped.pid"))).toBe(true);
      await Bun.sleep(400);
      expect(fs.existsSync(path.join(cwd, "delayed.txt"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("AbortSignal kills a setsid descendant before it can perform a delayed write", async () => {
    if (process.platform === "win32" || !Bun.which("perl")) return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-process-setsid-abort-"));
    const controller = new AbortController();
    try {
      writeEscapedWriter(cwd);
      const running = runShellProcess({
        shell: "sh",
        command: "perl escaped-writer.pl & wait",
        cwd,
        timeoutMs: 10_000,
        signal: controller.signal,
        maxOutputChars: 1_000,
        spoolPrefix: "lh-test-setsid-abort",
      });
      for (let i = 0; i < 100 && !fs.existsSync(path.join(cwd, "escaped.pid")); i++) await Bun.sleep(5);
      expect(fs.existsSync(path.join(cwd, "escaped.pid"))).toBe(true);
      controller.abort();
      const outcome = await running;
      expect(outcome.aborted).toBe(true);
      await Bun.sleep(400);
      expect(fs.existsSync(path.join(cwd, "delayed.txt"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("multi-megabyte output stays bounded in memory view and is incrementally spooled", async () => {
    const outcome = await runShellProcess({
      shell: "sh",
      command: "yes 0123456789 | head -c 5000000",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputChars: 1_000,
      spoolPrefix: "lh-test-output",
    });
    expect(outcome.code).toBe(0);
    expect(outcome.truncated).toBe(true);
    expect(outcome.output.length).toBeLessThan(1_400);
    expect(outcome.spoolPath).toBeDefined();
    expect(fs.statSync(outcome.spoolPath!).size).toBe(5_000_000);
    expect(fs.statSync(outcome.spoolPath!).mode & 0o777).toBe(0o600);
    fs.rmSync(outcome.spoolPath!, { force: true });
  });

  test("strict spool byte cap stops an unbounded producer without exceeding the cap", async () => {
    const cap = 64 * 1024;
    const outcome = await runShellProcess({
      shell: "sh",
      command: "yes capped-output",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputChars: 1_000,
      maxSpoolBytes: cap,
      spoolPrefix: "lh-test-output-cap",
      killGraceMs: 10,
    });
    try {
      expect(outcome.timedOut).toBe(false);
      expect(outcome.outputLimitExceeded).toBe(true);
      expect(outcome.spoolFailed).toBe(false);
      expect(outcome.output).toContain(`output spool limit ${cap} bytes exceeded`);
      expect(outcome.spoolPath).toBeDefined();
      const stat = fs.statSync(outcome.spoolPath!);
      expect(stat.size).toBe(cap);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(outcome.durationMs).toBeLessThan(1_000);
    } finally {
      if (outcome.spoolPath) fs.rmSync(outcome.spoolPath, { force: true });
    }
  });

  test("strict spool cap can stop writing without stopping a finite producer", async () => {
    const cap = 32 * 1024;
    const outcome = await runShellProcess({
      shell: "sh",
      command: "yes optional-output | head -c 200000",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputChars: 1_000,
      maxSpoolBytes: cap,
      killOnOutputLimit: false,
      spoolPrefix: "lh-test-output-cap-drain",
    });
    try {
      expect(outcome.code).toBe(0);
      expect(outcome.outputLimitExceeded).toBe(true);
      expect(outcome.output).toContain(`[output spool limit ${cap} bytes exceeded]`);
      expect(outcome.output).not.toContain("[killed: output spool limit");
      expect(fs.statSync(outcome.spoolPath!).size).toBe(cap);
    } finally {
      if (outcome.spoolPath) fs.rmSync(outcome.spoolPath, { force: true });
    }
  });

  test("spool creation failure is reported and stops the producer", async () => {
    const missing = `lh-missing-${process.pid}-${Date.now()}/output`;
    const outcome = await runShellProcess({
      shell: "sh",
      command: "yes spool-failure",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputChars: 1_000,
      spoolPrefix: missing,
      killGraceMs: 10,
    });
    expect(outcome.spoolFailed).toBe(true);
    expect(outcome.outputLimitExceeded).toBe(false);
    expect(outcome.spoolPath).toBeUndefined();
    expect(outcome.output).toContain("output spool failed");
    expect(outcome.durationMs).toBeLessThan(1_000);
  });
});

describe("grep cancellation", () => {
  function context(cwd: string, signal: AbortSignal, deadlineAt?: number): ToolContext {
    return {
      cwd,
      readFiles: new Map(),
      todos: [],
      signal,
      deadlineAt,
      report: { changedFiles: new Map(), commandsRun: [] },
    };
  }

  function installSlowRg(cwd: string, pidFile: string): void {
    const bin = path.join(cwd, "bin");
    fs.mkdirSync(bin);
    const executable = path.join(bin, "rg");
    fs.writeFileSync(executable, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  }

  test("AbortSignal stops an in-flight rg process", async () => {
    if (process.platform === "win32") return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-grep-abort-"));
    const pidFile = path.join(cwd, "rg.pid");
    const controller = new AbortController();
    try {
      installSlowRg(cwd, pidFile);
      const tool = createGrepTool({ ...defaultConfig, bashTimeoutMs: 10_000 });
      const running = tool.execute({ pattern: "needle", path: "." }, context(cwd, controller.signal));
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await Bun.sleep(5);
      expect(fs.existsSync(pidFile)).toBe(true);
      controller.abort();
      const result = await running;
      expect(result.ok).toBe(false);
      expect(result.output).toContain("interrupted");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("absolute command deadline bounds an in-flight rg process", async () => {
    if (process.platform === "win32") return;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-grep-deadline-"));
    const pidFile = path.join(cwd, "rg.pid");
    try {
      installSlowRg(cwd, pidFile);
      const tool = createGrepTool({ ...defaultConfig, bashTimeoutMs: 10_000 });
      const started = Date.now();
      const result = await tool.execute(
        { pattern: "needle", path: "." },
        context(cwd, new AbortController().signal, started + 40),
      );
      expect(result.ok).toBe(false);
      expect(result.output).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("CLI timeout status", () => {
  test("one-shot deadline starts while piped prompt input is still open", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-input-timeout-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-input-timeout-cwd-"));
    const proc = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../src/index.ts"),
      "-p", "-",
      "--cwd", cwd,
      "--max-time", "0.05",
      "--json",
      "--quiet",
      "--session-id", "runtime-input-timeout",
    ], {
      cwd,
      env: { ...process.env, LH_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(2_000).then(() => -999),
      ]);
      if (exitCode === -999) proc.kill("SIGKILL");
      expect(exitCode).toBe(1);
      const payload = JSON.parse(await new Response(proc.stdout).text());
      expect(payload).toMatchObject({ status: "timeout" });
      expect(payload.durations.total_ms).toBeGreaterThanOrEqual(40);
    } finally {
      proc.stdin.end();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("distill deadline includes injected stdin acquisition", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-distill-input-timeout-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lh-distill-input-timeout-cwd-"));
    const previousHome = process.env.LH_HOME;
    const originalLog = console.log;
    let completeCalled = false;
    process.env.LH_HOME = home;
    console.log = () => {};
    try {
      const started = Date.now();
      const result = await cmdDistill([
        "-q", "summarize",
        "--cwd", cwd,
        "--max-time", "0.03",
        "--json",
        "--quiet",
        "--session-id", "runtime-distill-input-timeout",
      ], {
        readStdin: () => new Promise<string>(() => {}),
        complete: async () => {
          completeCalled = true;
          return { text: "{}" };
        },
      });
      expect(result).toBe(1);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(completeCalled).toBe(false);
      expect(loadSession("runtime-distill-input-timeout")?.status).toBe("timeout");
    } finally {
      console.log = originalLog;
      if (previousHome === undefined) delete process.env.LH_HOME;
      else process.env.LH_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("one-shot emits timeout JSON and exits 1 when Ollama stalls", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-timeout-"));
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new URL(request.url).pathname === "/api/ps"
        ? Response.json({ models: [] })
        : new Response(new ReadableStream({ start() {} })),
    });
    try {
      const proc = Bun.spawn([
        process.execPath,
        path.resolve(import.meta.dir, "../src/index.ts"),
        "-p", "wait forever",
        "--max-time", "0.05",
        "--json",
        "--quiet",
        "--session-id", "runtime-timeout",
      ], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, OLLAMA_HOST: server.url.toString(), LH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      expect(exitCode).toBe(1);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ status: "timeout" });
      expect(payload.durations.total_ms).toBeGreaterThanOrEqual(40);
      // The command deadline includes the pre-run workspace snapshot, so a
      // very small budget can expire before the provider request begins.
      expect(payload.durations.model_ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("SIGINT during a check propagates cancellation and exits 130", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-check-int-"));
    const checkPid = path.join(home, "check.pid");
    const line = JSON.stringify({
      message: { role: "assistant", content: "done" },
      done: true,
      prompt_eval_count: 2,
      eval_count: 1,
    });
    const server = Bun.serve({ port: 0, fetch: () => new Response(line + "\n") });
    try {
      const proc = Bun.spawn([
        process.execPath,
        path.resolve(import.meta.dir, "../src/index.ts"),
        "-p", "finish",
        "--in-place",
        "--yolo",
        "--check", `echo $$ > ${JSON.stringify(checkPid)}; sleep 10`,
        "--json",
        "--quiet",
        "--session-id", "runtime-interrupt",
      ], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, OLLAMA_HOST: server.url.toString(), LH_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

      for (let i = 0; i < 200 && !fs.existsSync(checkPid); i++) await Bun.sleep(5);
      expect(fs.existsSync(checkPid)).toBe(true);
      proc.kill("SIGINT");
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      expect(exitCode).toBe(130);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ status: "interrupted" });
      expect(payload.durations.model_ms).toBeGreaterThanOrEqual(0);
      expect(payload.durations.check_ms).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
