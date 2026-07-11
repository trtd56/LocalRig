import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateBatchStatus,
  type BatchAgent,
  BatchConfigError,
  type BatchDeps,
  executeBatch,
  isFatalOutcome,
  mergeReports,
  notRun,
  parseManifest,
  reverifyBatch,
  type BatchTask,
  type TaskExecution,
} from "../src/batch.ts";
import type { ChatMessage, RunReport, RunStatus } from "../src/types.ts";
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
      JSON.stringify([{ id: "docs", prompt: "tweak", kind: "doc-tweak", think: false, check: "grep -q x f", check_retries: 3.9 }]),
    );
    expect(tasks[0]).toEqual({ id: "docs", prompt: "tweak", kind: "doc-tweak", think: false, check: "grep -q x f", checkRetries: 3 });
  });

  test("parses per-task allowed_paths and protected_paths", () => {
    const [task] = parseManifest(JSON.stringify([{ id: "scoped", prompt: "p", allowed_paths: ["src"], protected_paths: ["src/api.ts"] }]));
    expect(task!.allowedPaths).toEqual(["src"]);
    expect(task!.protectedPaths).toEqual(["src/api.ts"]);
  });

  test("rejects malformed path scopes", () => {
    expect(() => parseManifest(JSON.stringify([{ id: "x", prompt: "p", allowed_paths: "src" }]))).toThrow(BatchConfigError);
    expect(() => parseManifest(JSON.stringify([{ id: "x", prompt: "p", protected_paths: [""] }]))).toThrow(BatchConfigError);
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
    ["a non-boolean think", JSON.stringify([{ id: "a", prompt: "p", think: "no" }]), /"think" must be a boolean/],
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
  test("a non-fatal not_run (e.g. budget) keeps the batch off 'ok'", () => {
    // not_run can arise without a fatal when the total budget runs out; an
    // incomplete batch must report partial, not ok.
    expect(aggregateBatchStatus(["ok", "ok", "not_run"], false)).toBe("partial");
    expect(aggregateBatchStatus(["not_run", "not_run"], false)).toBe("failed");
  });
});

// ---------- cumulative report merge ----------

describe("mergeReports", () => {
  test("concatenates commands and unions changed files across tasks", () => {
    const a: RunReport = { changedFiles: [{ path: "a.ts", action: "created" }], commandsRun: ["bun test"] };
    const b: RunReport = { changedFiles: [{ path: "b.ts", action: "modified" }], commandsRun: ["bun run build"] };
    expect(mergeReports([a, b])).toEqual({
      changedFiles: [
        { path: "a.ts", action: "created" },
        { path: "b.ts", action: "modified" },
      ],
      commandsRun: ["bun test", "bun run build"],
    });
  });

  test("a 'created' action for a path is not downgraded by a later 'modified'", () => {
    const a: RunReport = { changedFiles: [{ path: "x.ts", action: "created" }], commandsRun: [] };
    const b: RunReport = { changedFiles: [{ path: "x.ts", action: "modified" }], commandsRun: [] };
    expect(mergeReports([a, b]).changedFiles).toEqual([{ path: "x.ts", action: "created" }]);
  });

  test("empty when there are no reports", () => {
    expect(mergeReports([])).toEqual({ changedFiles: [], commandsRun: [] });
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

  test("onProgress fires after every task with the executions so far", async () => {
    const snapshots: string[][] = [];
    await executeBatch(
      tasks,
      async (t) => fakeExec(t, "ok"),
      (execs) => snapshots.push(execs.map((e) => e.task.id)),
    );
    expect(snapshots).toEqual([["a"], ["a", "b"], ["a", "b", "c"]]);
  });

  test("onProgress fires for not_run tasks after a fatal abort too", async () => {
    const counts: number[] = [];
    await executeBatch(
      tasks,
      async (t) => fakeExec(t, t.id === "a" ? "interrupted" : "ok"),
      (execs) => counts.push(execs.length),
    );
    expect(counts).toEqual([1, 2, 3]); // b and c are not_run but still reported
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

  test("a final sweep that exhausts its deadline is reported as timeout", async () => {
    const result = await reverifyBatch([withCheck("only", "ok")], false, async (task) => ({
      command: task.check!,
      exit_code: null,
      attempts: 1,
      output_tail: "deadline reached",
      timed_out: true,
    }));
    expect(result.executions[0]!.status).toBe("timeout");
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
    expect(doc).toMatchObject({
      kind: "doc-tweak",
      graded: 1,
      pass: 1,
      fail: 0,
      rate: 100,
      avgDurationMs: 10_000,
      p50DurationMs: 10_000,
      p90DurationMs: 10_000,
      rework: 0,
      reworkRate: 0,
      gate: {
        status: "insufficient_data",
        minGraded: 3,
        minPassRate: 50,
      },
    });
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

// ---------- cmdBatch execution (injected agent + clock) ----------

describe("cmdBatch execution", () => {
  let tmpHome: string;
  const origLog = console.log;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-batch-"));
    process.env.LH_HOME = tmpHome;
    console.log = () => {}; // silence the batch's --json output; tests read loadSession
  });
  afterEach(() => {
    console.log = origLog;
    delete process.env.LH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  interface FakeSetup {
    now?: () => number;
    status?: (prompt: string) => RunStatus;
    check?: (command: string) => CheckRecord;
    onRun?: (prompt: string) => void;
  }

  // Fake batch dependencies: fresh recording agent per task, a check runner, and
  // an injectable clock — no live model, no real Date (time is driven by `now`).
  function fakeDeps(setup: FakeSetup = {}) {
    const created: BatchAgent[] = [];
    const budgets: number[] = [];
    const deps: BatchDeps = {
      now: setup.now ?? (() => 0),
      applyBudget: (ms) => budgets.push(ms),
      runCheck: async (command) => (setup.check ? setup.check(command) : { command, exit_code: 0, attempts: 1, output_tail: "ok" }),
      createAgent: (systemPrompt) => {
        const msgs: ChatMessage[] = [{ role: "system", content: systemPrompt, _seq: 0 }];
        let last: RunStatus = "ok";
        const agent: BatchAgent = {
          run: async (prompt: string) => {
            msgs.push({ role: "user", content: prompt });
            setup.onRun?.(prompt);
            last = setup.status ? setup.status(prompt) : "ok";
            return "done";
          },
          get lastRunStatus() {
            return last;
          },
          getReport: () => ({ changedFiles: [], commandsRun: [] }),
          getMessages: () => msgs,
          interrupt: () => {},
        };
        created.push(agent);
        return agent;
      },
    };
    return { deps, created, budgets };
  }

  function manifestFile(tasks: unknown[]): string {
    const f = path.join(tmpHome, "tasks.json");
    fs.writeFileSync(f, JSON.stringify({ tasks }));
    return f;
  }

  test("each task runs in a fresh context: system + only that task's prompt", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    const { deps, created } = fakeDeps();
    const file = manifestFile([{ id: "a", prompt: "do A" }, { id: "b", prompt: "do B" }]);
    const rc = await cmdBatch([
      "--tasks", file, "--cwd", tmpHome, "--in-place", "--json", "--quiet", "--session-id", "ctx-sid",
      "--caller", "codex", "--hardware", "test-hardware", "--integration-version", "2.1.0",
    ], deps);
    expect(rc).toBe(0);
    expect(created).toHaveLength(2); // one fresh agent per task
    // Each agent's transcript is [system, its own user prompt] — task B's agent
    // never saw task A's prompt.
    expect(created[0]!.getMessages().map((m) => m.role)).toEqual(["system", "user"]);
    expect(created[0]!.getMessages()[1]!.content).toBe("do A");
    expect(created[1]!.getMessages()[1]!.content).toBe("do B");
    // The saved transcript is the per-task segments concatenated (audit).
    const rec = loadSession("ctx-sid")!;
    expect(rec.messages!.map((m) => m.role)).toEqual(["system", "user", "system", "user"]);
    expect(rec.messages!.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["do A", "do B"]);
    expect(rec.status).toBe("ok");
    expect(rec.dimensions).toMatchObject({
      model: rec.model,
      caller: "codex",
      callerSource: "cli",
      hardware: "test-hardware",
      hardwareSource: "cli",
      integrationVersion: "2.1.0",
      integrationVersionSource: "cli",
      localrigVersion: "0.1.0",
    });
  });

  test("all tasks reuse one byte-identical system prompt (prefix KV cache holds)", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    const { deps, created } = fakeDeps();
    const file = manifestFile([{ id: "a", prompt: "do A" }, { id: "b", prompt: "do B" }]);
    await cmdBatch(["--tasks", file, "--cwd", tmpHome, "--in-place", "--json", "--quiet", "--session-id", "sys-sid"], deps);
    // The prompt cmdBatch built once and handed to each fresh agent.
    const sysA = created[0]!.getMessages()[0]!.content;
    const sysB = created[1]!.getMessages()[0]!.content;
    expect(sysA).toBe(sysB);
    expect(sysA.length).toBeGreaterThan(362); // the drift the fix addresses was past char 362
    // ...and the two system messages in the saved transcript are identical too.
    const sys = loadSession("sys-sid")!.messages!.filter((m) => m.role === "system").map((m) => m.content);
    expect(sys).toHaveLength(2);
    expect(sys[0]).toBe(sys[1]);
  });

  test("--max-time is a TOTAL budget: later tasks go not_run once it is spent", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    let clock = 0;
    const durations: Record<string, number> = { "do A": 6000, "do B": 6000, "do C": 0 };
    const { deps, budgets } = fakeDeps({
      now: () => clock,
      status: (prompt) => (prompt === "do B" ? "timeout" : "ok"),
      onRun: (prompt) => {
        clock += durations[prompt] ?? 0; // simulate wall-clock spent by the task
      },
    });
    const file = manifestFile([
      { id: "a", prompt: "do A" },
      { id: "b", prompt: "do B" },
      { id: "c", prompt: "do C" },
    ]);
    const rc = await cmdBatch(["--tasks", file, "--in-place", "--json", "--quiet", "--session-id", "bud-sid", "--max-time", "10"], deps);
    const rec = loadSession("bud-sid")!;
    expect(rec.tasks!.map((t) => t.status)).toEqual(["ok", "timeout", "not_run"]);
    expect(rec.status).toBe("timeout");
    expect(rc).toBe(1);
    // Each task got the REMAINING budget, not a fresh full one (10s then 4s).
    expect(budgets).toEqual([10_000, 4_000]);
  });

  test("without --max-time there is no budget: every task runs (unlimited)", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    let clock = 0;
    const { deps, budgets } = fakeDeps({ now: () => (clock += 1_000_000) });
    const file = manifestFile([{ id: "a", prompt: "A" }, { id: "b", prompt: "B" }]);
    await cmdBatch(["--tasks", file, "--in-place", "--json", "--quiet", "--session-id", "nob-sid"], deps);
    const rec = loadSession("nob-sid")!;
    expect(rec.tasks!.map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(budgets).toEqual([0, 0]); // 0 = unlimited handed to each agent
  });

  test("persists incrementally: running placeholder, then each completed task", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    const snaps: Record<string, SessionRecord | null> = {};
    const { deps } = fakeDeps({
      onRun: (prompt) => {
        snaps[prompt] = loadSession("inc-sid");
      },
    });
    const file = manifestFile([{ id: "a", prompt: "do A" }, { id: "b", prompt: "do B" }]);
    await cmdBatch(["--tasks", file, "--in-place", "--json", "--quiet", "--session-id", "inc-sid"], deps);
    // When task A starts, only the running placeholder exists (no tasks yet).
    expect(snaps["do A"]!.status).toBe("running");
    expect(snaps["do A"]!.tasks).toEqual([]);
    // When task B starts, task A is already on disk with status running.
    expect(snaps["do B"]!.status).toBe("running");
    expect(snaps["do B"]!.tasks!.map((t) => t.id)).toEqual(["a"]);
    // The final record is authoritative.
    const final = loadSession("inc-sid")!;
    expect(final.status).toBe("ok");
    expect(final.tasks!.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("snapshot catches unreported bash-style changes and fails allowed_paths violations", async () => {
    const { cmdBatch } = await import("../src/index.ts");
    fs.mkdirSync(path.join(tmpHome, "allowed"));
    const { deps } = fakeDeps({
      onRun: () => fs.writeFileSync(path.join(tmpHome, "outside-scope.txt"), "created by fake bash"),
    });
    const file = manifestFile([{ id: "scoped", prompt: "do it", allowed_paths: ["allowed"] }]);
    const rc = await cmdBatch(["--tasks", file, "--cwd", tmpHome, "--in-place", "--json", "--quiet", "--session-id", "scope-sid"], deps);
    const rec = loadSession("scope-sid")!;
    expect(rc).toBe(1);
    expect(rec.status).toBe("failed");
    expect(rec.tasks![0]!.status).toBe("error");
    expect(rec.tasks![0]!.report!.changedFiles).toContainEqual({ path: "outside-scope.txt", action: "created" });
    expect(rec.error).toContain("workspace scope violation");
  });

  test("notRun helper preserves the task's id/kind for the record", () => {
    const nr = notRun({ id: "x", prompt: "p", kind: "docs" });
    expect(nr.status).toBe("not_run");
    expect(nr.task.kind).toBe("docs");
    expect(nr.report).toEqual({ changedFiles: [], commandsRun: [] });
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
