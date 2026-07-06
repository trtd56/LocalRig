// Batch delegation: run several independent tasks in one agent session so the
// session start-up cost is amortized across them. The manifest parser and the
// orchestration (sequencing, fatal-abort, status aggregation, per-task report
// diffing) live here as small pure pieces; index.ts wires in the real,
// Ollama-backed task executor. Keep this module free of process/Agent I/O so
// it stays unit-testable without a live model.

import type { CheckRecord } from "./session.ts";
import type { BatchStatus } from "./session.ts";
import type { ErrorKind, RunReport, RunStatus } from "./types.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface BatchTask {
  id: string;
  prompt: string;
  kind?: string;
  check?: string;
  /** Repair attempts after a failing check; defaults to the one-shot 2. */
  checkRetries?: number;
}

/** A rejected manifest. Carries the "config" ErrorKind so callers can branch
 *  on cause without parsing the message (mirrors ResumeError). */
export class BatchConfigError extends Error {
  readonly kind: ErrorKind = "config";
  constructor(message: string) {
    super(message);
    this.name = "BatchConfigError";
  }
}

/**
 * Parse and validate a batch manifest. Accepts either a top-level
 * `{"tasks": [...]}` object or a bare `[...]` array. Throws BatchConfigError
 * (kind "config") on malformed JSON, an empty task list, a missing/blank
 * prompt, a bad or duplicate id, or a wrong-typed optional field — every
 * rejection happens here, before any session is minted.
 */
export function parseManifest(text: string): BatchTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BatchConfigError(`invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawTasks = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray((parsed as { tasks?: unknown }).tasks)
      ? (parsed as { tasks: unknown[] }).tasks
      : null;
  if (rawTasks === null) {
    throw new BatchConfigError('manifest must be a JSON array of tasks or an object with a "tasks" array');
  }
  if (rawTasks.length === 0) {
    throw new BatchConfigError("manifest has no tasks");
  }

  const tasks: BatchTask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i];
    const where = `task #${i + 1}`;
    if (!isRecord(raw)) throw new BatchConfigError(`${where}: must be an object`);

    const id = raw.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new BatchConfigError(`${where}: "id" is required and must match [A-Za-z0-9_-]+`);
    }
    if (seen.has(id)) throw new BatchConfigError(`duplicate task id: ${id}`);
    seen.add(id);

    const prompt = raw.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new BatchConfigError(`task ${id}: "prompt" is required and must be a non-empty string`);
    }

    const task: BatchTask = { id, prompt };
    if (raw.kind !== undefined) {
      if (typeof raw.kind !== "string") throw new BatchConfigError(`task ${id}: "kind" must be a string`);
      task.kind = raw.kind;
    }
    if (raw.check !== undefined) {
      if (typeof raw.check !== "string") throw new BatchConfigError(`task ${id}: "check" must be a string`);
      task.check = raw.check;
    }
    if (raw.check_retries !== undefined) {
      const n = raw.check_retries;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new BatchConfigError(`task ${id}: "check_retries" must be a number >= 0`);
      }
      task.checkRetries = Math.floor(n);
    }
    tasks.push(task);
  }
  return tasks;
}

/** A fatal outcome aborts the whole batch (remaining tasks go "not_run"):
 *  a user interrupt, a dead worker, or a connection failure to Ollama. Other
 *  per-task failures (check_failed, timeout, ollama_error, internal error) are
 *  local — the batch continues with the next independent task. */
export function isFatalOutcome(status: RunStatus, errorKind?: ErrorKind): boolean {
  if (status === "interrupted" || status === "died") return true;
  if (status === "error" && errorKind === "connection") return true;
  return false;
}

/**
 * Roll per-task statuses up into the batch status. A fatal abort (signalled by
 * `fatal`, which also leaves "not_run" tasks) is "error". Otherwise: all ran
 * tasks ok → "ok", none ok → "failed", a mix → "partial".
 */
export function aggregateBatchStatus(statuses: RunStatus[], fatal: boolean): BatchStatus {
  if (fatal) return "error";
  const ran = statuses.filter((s) => s !== "not_run");
  if (ran.length === 0) return "error";
  const ok = ran.filter((s) => s === "ok").length;
  if (ok === ran.length) return "ok";
  if (ok === 0) return "failed";
  return "partial";
}

/**
 * Per-task report slice: what changed during one task, given the cumulative
 * session report snapshotted before and after it. commandsRun is append-only,
 * so the tail past `before`'s length is this task's. A changed file counts for
 * the task when its (path, action) pair is new since `before`.
 *
 * Caveat: a file created in one task and only edited in a later one stays
 * "created" in the cumulative map, so the later edit is not re-attributed —
 * acceptable because batch tasks are meant to be independent.
 */
export function diffReports(before: RunReport, after: RunReport): RunReport {
  const beforeActions = new Map(before.changedFiles.map((f) => [f.path, f.action]));
  return {
    changedFiles: after.changedFiles.filter((f) => beforeActions.get(f.path) !== f.action),
    commandsRun: after.commandsRun.slice(before.commandsRun.length),
  };
}

/** One task's full outcome as produced by an executor and consumed by callers. */
export interface TaskExecution {
  task: BatchTask;
  status: RunStatus;
  error?: string;
  errorKind?: ErrorKind;
  check?: CheckRecord;
  report: RunReport;
  turns: number;
  durationMs: number;
}

export interface BatchResult {
  executions: TaskExecution[];
  status: BatchStatus;
  fatal: boolean;
}

const EMPTY_REPORT: RunReport = { changedFiles: [], commandsRun: [] };

function notRun(task: BatchTask): TaskExecution {
  return { task, status: "not_run", report: EMPTY_REPORT, turns: 0, durationMs: 0 };
}

/**
 * Run each task in order via `runTask`, stopping early on a fatal outcome and
 * marking the remaining tasks "not_run". Pure orchestration: all model/agent
 * I/O lives behind `runTask`, so tests inject a fake executor.
 */
export async function executeBatch(
  tasks: BatchTask[],
  runTask: (task: BatchTask) => Promise<TaskExecution>,
): Promise<BatchResult> {
  const executions: TaskExecution[] = [];
  let fatal = false;
  for (const task of tasks) {
    if (fatal) {
      executions.push(notRun(task));
      continue;
    }
    const exec = await runTask(task);
    executions.push(exec);
    if (isFatalOutcome(exec.status, exec.errorKind)) fatal = true;
  }
  return { executions, status: aggregateBatchStatus(executions.map((e) => e.status), fatal), fatal };
}

/**
 * Final re-verification sweep: re-run the `check` of every task that finished
 * ok, once, after the whole batch. A later task can silently undo an earlier
 * task's verified work through bash/git (e.g. `git checkout HEAD~1 -- file`);
 * bash side effects never land in changed_files, so this second check is the
 * last line of defense against sibling-task interference. A now-failing check
 * downgrades its task to "check_failed" and marks the CheckRecord `regressed`;
 * passing tasks are left untouched. Skipped entirely on a fatal abort (the
 * remaining tasks never ran, so nothing downstream could have clobbered them).
 * Pure orchestration: the actual re-run lives behind `recheck` for testing.
 */
export async function reverifyBatch(
  executions: TaskExecution[],
  fatal: boolean,
  recheck: (task: BatchTask) => Promise<CheckRecord>,
): Promise<{ executions: TaskExecution[]; status: BatchStatus }> {
  if (fatal) {
    return { executions, status: aggregateBatchStatus(executions.map((e) => e.status), true) };
  }
  const out: TaskExecution[] = [];
  for (const e of executions) {
    if (e.task.check && e.status === "ok") {
      const check = await recheck(e.task);
      if (check.exit_code !== 0) {
        out.push({ ...e, status: "check_failed", check: { ...check, regressed: true } });
        continue;
      }
    }
    out.push(e);
  }
  return { executions: out, status: aggregateBatchStatus(out.map((e) => e.status), false) };
}
