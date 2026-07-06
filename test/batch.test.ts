import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateBatchStatus,
  BatchConfigError,
  diffReports,
  executeBatch,
  isFatalOutcome,
  parseManifest,
  reverifyBatch,
  type BatchTask,
  type TaskExecution,
} from "../src/batch.ts";
import type { RunReport, RunStatus } from "../src/types.ts";
import {
  appendFeedback,
  type CheckRecord,
  computeStats,
  loadSession,
  readFeedback,
  restoreTranscript,
  ResumeError,
  saveSession,
  type SessionRecord,
} from "../src/session.ts";

// ---------- manifest parsing ----------

describe("parseManifest", () => {
  test("accepts a top-level tasks object", () => {
    const tasks = parseManifest(JSON.stringify({ tasks: [{ id: "a", prompt: "do a" }] }));
    expect(tasks).toEqual([{ id: "a", prompt: "do a" }]);
  });

  test("accepts a bare array", () => {
    const tasks = parseManifest(JSON.stringify([{ id: "a", prompt: "do a" }]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("a");
  });

  test("keeps optional fields and floors check_retries", () => {
    const tasks = parseManifest(
      JSON.stringify([{ id: "docs", prompt: "tweak", kind: "doc-tweak", check: "grep -q x f", check_retries: 3.9 }]),
    );
    expect(tasks[0]).toEqual({ id: "docs", prompt: "tweak", kind: "doc-tweak", check: "grep -q x f", checkRetries: 3 });
  });

  test("leaves checkRetries undefined when absent (executor defaults to 2)", () => {
    const tasks = parseManifest(JSON.stringify([{ id: "a", prompt: "p" }]));
    expect(tasks[0]!.checkRetries).toBeUndefined();
  });

  const rejects: Array<[string, string, RegExp]> = [
    ["malformed JSON", "{not json", /invalid manifest JSON/],
    ["a non-array/object top level", JSON.stringify(42), /must be a JSON array of tasks/],
    ["an empty task list", JSON.stringify({ tasks: [] }), /no tasks/],
    ["a bare empty array", JSON.stringify([]), /no tasks/],
    ["a non-object task", JSON.stringify([1]), /must be an object/],
    ["a missing id", JSON.stringify([{ prompt: "p" }]), /"id" is required/],
    ["a bad id", JSON.stringify([{ id: "has space", prompt: "p" }]), /\[A-Za-z0-9_-\]/],
    ["a duplicate id", JSON.stringify([{ id: "a", prompt: "p" }, { id: "a", prompt: "q" }]), /duplicate task id: a/],
    ["a missing prompt", JSON.stringify([{ id: "a" }]), /"prompt" is required/],
    ["a blank prompt", JSON.stringify([{ id: "a", prompt: "   " }]), /"prompt" is required/],
    ["a non-string kind", JSON.stringify([{ id: "a", prompt: "p", kind: 5 }]), /"kind" must be a string/],
    ["a non-string check", JSON.stringify([{ id: "a", prompt: "p", check: 5 }]), /"check" must be a string/],
    ["a negative check_retries", JSON.stringify([{ id: "a", prompt: "p", check_retries: -1 }]), /"check_retries"/],
  ];
  for (const [name, text, pattern] of rejects) {
    test(`rejects ${name} with a config-kind error`, () => {
      let caught: unknown;
      try {
        parseManifest(text);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BatchConfigError);
      expect((caught as BatchConfigError).kind).toBe("config");
      expect((caught as Error).message).toMatch(pattern);
    });
  }
});

// ---------- pure decision helpers ----------

describe("isFatalOutcome", () => {
  test("interrupt, dead worker, and connection error abort the batch", () => {
    expect(isFatalOutcome("interrupted")).toBe(true);
    expect(isFatalOutcome("died")).toBe(true);
    expect(isFatalOutcome("error", "connection")).toBe(true);
  });

  test("local failures do not abort the batch", () => {
    expect(isFatalOutcome("check_failed")).toBe(false);
    expect(isFatalOutcome("timeout")).toBe(false);
    expect(isFatalOutcome("max_iterations")).toBe(false);
    expect(isFatalOutcome("error", "ollama_error")).toBe(false);
    expect(isFatalOutcome("error", "internal")).toBe(false);
  });
});

describe("aggregateBatchStatus", () => {
  test("all ok → ok", () => {
    expect(aggregateBatchStatus(["ok", "ok"], false)).toBe("ok");
  });
  test("some ok → partial", () => {
    expect(aggregateBatchStatus(["ok", "check_failed"], false)).toBe("partial");
  });
  test("none ok → failed", () => {
    expect(aggregateBatchStatus(["check_failed", "timeout"], false)).toBe("failed");
  });
  test("a fatal abort → error", () => {
    expect(aggregateBatchStatus(["ok", "interrupted", "not_run"], true)).toBe("error");
  });
  test("not_run tasks are ignored when judging ok/partial/failed", () => {
    // Should never happen without a fatal, but the ran-set filter must hold.
    expect(aggregateBatchStatus(["ok", "ok", "not_run"], false)).toBe("ok");
  });
});

// ---------- per-task report split ----------

describe("diffReports", () => {
  test("slices commands and changed files added since the snapshot", () => {
    const before: RunReport = {
      changedFiles: [{ path: "a.ts", action: "created" }],
      commandsRun: ["bun test"],
    };
    const after: RunReport = {
      changedFiles: [
        { path: "a.ts", action: "created" },
        { path: "b.ts", action: "modified" },
      ],
      commandsRun: ["bun test", "bun run build", "grep -q x b.ts"],
    };
    expect(diffReports(before, after)).toEqual({
      changedFiles: [{ path: "b.ts", action: "modified" }],
      commandsRun: ["bun run build", "grep -q x b.ts"],
    });
  });

  test("an action upgrade on the same path counts for the later task", () => {
    const before: RunReport = { changedFiles: [{ path: "a.ts", action: "modified" }], commandsRun: [] };
    const after: RunReport = { changedFiles: [{ path: "a.ts", action: "created" }], commandsRun: [] };
    expect(diffReports(before, after).changedFiles).toEqual([{ path: "a.ts", action: "created" }]);
  });

  test("empty diff when nothing changed", () => {
    const r: RunReport = { changedFiles: [{ path: "a.ts", action: "created" }], commandsRun: ["x"] };
    expect(diffReports(r, r)).toEqual({ changedFiles: [], commandsRun: [] });
  });
});

// ---------- orchestration ----------

const REPORT: RunReport = { changedFiles: [], commandsRun: [] };

function fakeExec(task: BatchTask, status: RunStatus, extra: Partial<TaskExecution> = {}): TaskExecution {
  return { task, status, report: REPORT, turns: 1, durationMs: 10, ...extra };
}

describe("executeBatch", () => {
  const tasks: BatchTask[] = [
    { id: "a", prompt: "pa" },
    { id: "b", prompt: "pb" },
    { id: "c", prompt: "pc" },
  ];

  test("all ok → status ok, every task ran", async () => {
    const ran: string[] = [];
    const result = await executeBatch(tasks, async (t) => {
      ran.push(t.id);
      return fakeExec(t, "ok");
    });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(result.status).toBe("ok");
    expect(result.fatal).toBe(false);
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "ok", "ok"]);
  });

  test("partial failure continues to independent tasks", async () => {
    const result = await executeBatch(tasks, async (t) =>
      fakeExec(t, t.id === "b" ? "check_failed" : "ok"),
    );
    expect(result.status).toBe("partial");
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "check_failed", "ok"]);
  });

  test("all failing → failed", async () => {
    const result = await executeBatch(tasks, async (t) => fakeExec(t, "check_failed"));
    expect(result.status).toBe("failed");
  });

  test("a fatal task aborts the batch and leaves the rest not_run", async () => {
    const ran: string[] = [];
    const result = await executeBatch(tasks, async (t) => {
      ran.push(t.id);
      return fakeExec(t, t.id === "b" ? "interrupted" : "ok");
    });
    expect(ran).toEqual(["a", "b"]); // c never started
    expect(result.status).toBe("error");
    expect(result.fatal).toBe(true);
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "interrupted", "not_run"]);
    expect(result.executions[2]!.turns).toBe(0);
    expect(result.executions[2]!.durationMs).toBe(0);
  });

  test("a fatal last task → error with no not_run tasks", async () => {
    const result = await executeBatch(tasks, async (t) =>
      fakeExec(t, t.id === "c" ? "error" : "ok", t.id === "c" ? { errorKind: "connection" } : {}),
    );
    expect(result.status).toBe("error");
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "ok", "error"]);
  });
});

// ---------- final re-verification sweep ----------

function checkOk(command: string): CheckRecord {
  return { command, exit_code: 0, attempts: 1, output_tail: "ok" };
}
function checkFail(command: string): CheckRecord {
  return { command, exit_code: 1, attempts: 1, output_tail: "boom" };
}

describe("reverifyBatch", () => {
  const withCheck = (id: string, status: RunStatus): TaskExecution =>
    fakeExec({ id, prompt: id, check: `check-${id}` }, status, { check: checkOk(`check-${id}`) });

  test("downgrades a task whose check no longer passes and flags it regressed", async () => {
    const execs = [withCheck("a", "ok"), withCheck("b", "ok")];
    const rechecked: string[] = [];
    const result = await reverifyBatch(execs, false, async (task) => {
      rechecked.push(task.id);
      return task.id === "a" ? checkFail(task.check!) : checkOk(task.check!);
    });
    expect(rechecked).toEqual(["a", "b"]);
    const a = result.executions[0]!;
    expect(a.status).toBe("check_failed");
    expect(a.check!.regressed).toBe(true);
    expect(a.check!.exit_code).toBe(1);
    const b = result.executions[1]!;
    expect(b.status).toBe("ok");
    expect(b.check!.regressed).toBeUndefined();
    // ok + check_failed → partial after re-aggregation
    expect(result.status).toBe("partial");
  });

  test("leaves every task alone when all checks still pass", async () => {
    const execs = [withCheck("a", "ok"), withCheck("b", "ok")];
    const result = await reverifyBatch(execs, false, async (task) => checkOk(task.check!));
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "ok"]);
    expect(result.executions.every((e) => e.check!.regressed === undefined)).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("all checks regressing → failed", async () => {
    const execs = [withCheck("a", "ok"), withCheck("b", "ok")];
    const result = await reverifyBatch(execs, false, async (task) => checkFail(task.check!));
    expect(result.executions.map((e) => e.status)).toEqual(["check_failed", "check_failed"]);
    expect(result.status).toBe("failed");
  });

  test("skips tasks without a check and tasks that did not finish ok", async () => {
    const noCheck = fakeExec({ id: "a", prompt: "a" }, "ok"); // ok but no check
    const alreadyFailed = withCheck("b", "check_failed"); // check exists but not ok
    const rechecked: string[] = [];
    const result = await reverifyBatch([noCheck, alreadyFailed], false, async (task) => {
      rechecked.push(task.id);
      return checkFail(task.check!);
    });
    expect(rechecked).toEqual([]); // neither is eligible
    expect(result.executions.map((e) => e.status)).toEqual(["ok", "check_failed"]);
  });

  test("a single-task batch is still swept", async () => {
    const result = await reverifyBatch([withCheck("only", "ok")], false, async (task) => checkFail(task.check!));
    expect(result.executions[0]!.status).toBe("check_failed");
    expect(result.executions[0]!.check!.regressed).toBe(true);
    expect(result.status).toBe("failed");
  });

  test("a fatal abort skips the sweep entirely", async () => {
    const execs = [withCheck("a", "ok"), fakeExec({ id: "b", prompt: "b" }, "not_run")];
    let called = false;
    const result = await reverifyBatch(execs, true, async (task) => {
      called = true;
      return checkFail(task.check!);
    });
    expect(called).toBe(false);
    expect(result.executions[0]!.status).toBe("ok"); // untouched
    expect(result.status).toBe("error");
  });
});

describe("reverifyBatch with the real check runner", () => {
  test("catches a regression the same way cmdBatch wires it", async () => {
    const { runCheckCommand } = await import("../src/check.ts");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-sweep-"));
    try {
      // Flip-flop check: passes the first time (no marker → create it), fails
      // the second (marker present) — stands in for a sibling task clobbering
      // the verified state between the task's own check and the final sweep.
      const command = "if [ -e marker ]; then exit 1; else : > marker; fi";
      const first = await runCheckCommand({ command, cwd, timeoutMs: 10_000, attempts: 1 });
      expect(first.exit_code).toBe(0); // passed during the task

      const exec = fakeExec({ id: "t", prompt: "t", check: command }, "ok", { check: first });
      const recheck = (task: BatchTask) => runCheckCommand({ command: task.check!, cwd, timeoutMs: 10_000, attempts: 1 });
      const result = await reverifyBatch([exec], false, recheck);

      expect(result.executions[0]!.status).toBe("check_failed");
      expect(result.executions[0]!.check!.regressed).toBe(true);
      expect(result.status).toBe("failed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("taskForJson", () => {
  test("exposes a regressed check in the batch JSON", async () => {
    const { taskForJson } = await import("../src/index.ts");
    const json = taskForJson({
      id: "docs",
      kind: "doc-tweak",
      status: "check_failed",
      durationMs: 100,
      turns: 2,
      check: { command: "grep -q x f", exit_code: 1, attempts: 1, output_tail: "gone", regressed: true },
    });
    expect(json.check!.regressed).toBe(true);
    expect(json.status).toBe("check_failed");
    // regressed must survive JSON serialization, not just be present on the object
    expect(JSON.parse(JSON.stringify(json)).check.regressed).toBe(true);
  });
});

// ---------- feedback --task / fan-out / stats (CLI-level) ----------

describe("batch feedback and stats", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-batch-"));
    process.env.LH_HOME = tmpHome;
  });
  afterEach(() => {
    delete process.env.LH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function batchRecord(): SessionRecord {
    return {
      id: "20260707-100000-bbbb",
      createdAt: "2026-07-07T10:00:00.000Z",
      cwd: "/tmp/project",
      model: "qwen36-27b-mtp:latest",
      prompt: "batch: docs, lint",
      status: "partial",
      result: "2 tasks: 1 ok, 1 check_failed",
      durationMs: 40_000,
      turns: 6,
      toolCalls: 9,
      tokens: { prompt: 1000, completion: 300 },
      tasks: [
        { id: "docs", kind: "doc-tweak", status: "ok", durationMs: 10_000, turns: 2 },
        { id: "lint", kind: "tests", status: "check_failed", durationMs: 30_000, turns: 4 },
      ],
    };
  }

  test("--task grades only that task with its own kind", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    saveSession(batchRecord());
    expect(cmdFeedback(["20260707-100000-bbbb", "--task", "docs", "pass"])).toBe(0);
    const fb = readFeedback();
    expect(fb).toHaveLength(1);
    expect(fb[0]!.taskId).toBe("docs");
    expect(fb[0]!.kind).toBe("doc-tweak");
    expect(fb[0]!.verdict).toBe("pass");
  });

  test("an unknown --task id is rejected without recording feedback", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    saveSession(batchRecord());
    expect(cmdFeedback(["20260707-100000-bbbb", "--task", "nope", "pass"])).toBe(1);
    expect(readFeedback()).toHaveLength(0);
  });

  test("a bare verdict fans out to every task, each with its own kind", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    saveSession(batchRecord());
    expect(cmdFeedback(["20260707-100000-bbbb", "fail", "--notes", "regressed"])).toBe(0);
    const fb = readFeedback();
    expect(fb).toHaveLength(2);
    expect(fb.map((f) => f.taskId).sort()).toEqual(["docs", "lint"]);
    expect(fb.map((f) => f.kind).sort()).toEqual(["doc-tweak", "tests"]);
    expect(fb.every((f) => f.verdict === "fail" && f.notes === "regressed")).toBe(true);
  });

  test("stats --by-kind attributes each task to its own kind and duration", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    saveSession(batchRecord());
    cmdFeedback(["20260707-100000-bbbb", "pass"]); // fan out to both tasks
    const stats = computeStats({ byKind: true });
    expect(stats.graded).toBe(2); // two tasks, not one session
    const doc = stats.byKind!.find((k) => k.kind === "doc-tweak")!;
    const tests = stats.byKind!.find((k) => k.kind === "tests")!;
    expect(doc).toEqual({ kind: "doc-tweak", graded: 1, pass: 1, fail: 0, rate: 100, avgDurationMs: 10_000 });
    expect(tests.avgDurationMs).toBe(30_000);
  });

  test("re-grading one task via --task overrides only that task (last-wins per task)", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    saveSession(batchRecord());
    cmdFeedback(["20260707-100000-bbbb", "pass"]); // both pass
    cmdFeedback(["20260707-100000-bbbb", "--task", "lint", "fail"]); // downgrade lint
    const stats = computeStats();
    expect(stats.graded).toBe(2);
    expect(stats.pass).toBe(1);
    expect(stats.fail).toBe(1);
  });
});

// ---------- rejections ----------

describe("batch rejections", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-batch-"));
    process.env.LH_HOME = tmpHome;
  });
  afterEach(() => {
    delete process.env.LH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("restoreTranscript refuses to resume a batch session", () => {
    const rec: SessionRecord = {
      id: "s1",
      createdAt: "t",
      cwd: "/tmp",
      model: "m",
      prompt: "batch: a",
      status: "ok",
      result: "",
      durationMs: 1,
      turns: 1,
      toolCalls: 0,
      tokens: { prompt: 0, completion: 0 },
      messages: [{ role: "system", content: "sys", _seq: 0 }],
      tasks: [{ id: "a", status: "ok", durationMs: 1, turns: 1 }],
    };
    expect(() => restoreTranscript("s1", rec)).toThrow(ResumeError);
    expect(() => restoreTranscript("s1", rec)).toThrow(/batch session/);
  });

  test("cmdBatch rejects --resume before touching the model", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    expect(await cmdBatch(["--resume", "20260101-000000-abcd", "--tasks", "/dev/null", "--json"])).toBe(1);
  });

  test("cmdBatch without --tasks is a usage error", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    expect(await cmdBatch(["--json"])).toBe(1);
  });

  test("cmdBatch rejects a malformed manifest as a config error", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    const file = path.join(tmpHome, "bad.json");
    fs.writeFileSync(file, "{not json");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg));
    try {
      expect(await cmdBatch(["--tasks", file, "--json"])).toBe(1);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: "error", error_kind: "config" });
  });

  test("cmdSubmit refuses a batch invocation", async () => {
    const { cmdSubmit } = await import("../src/index.ts");
    expect(await cmdSubmit(["batch", "--tasks", "-"])).toBe(1);
  });
});

// ---------- batch --tasks arg parsing ----------

describe("cli parseArgs --tasks", () => {
  test("captures the manifest source and batch flags", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs(["--tasks", "-", "--cwd", "/tmp/x", "--json", "--max-time", "120", "--quiet"]);
    expect(opts.tasksFile).toBe("-");
    expect(opts.cwd).toBe("/tmp/x");
    expect(opts.json).toBe(true);
    expect(opts.config.maxTimeMs).toBe(120_000);
    expect(opts.quiet).toBe(true);
  });
});
