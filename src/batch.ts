// Batch delegation: run several independent tasks in one agent session so the
// session start-up cost is amortized across them. The manifest parser and the
// orchestration (sequencing, fatal-abort, status aggregation, per-task report
// diffing) live here as small pure pieces; index.ts wires in the real,
// Ollama-backed task executor. Keep this module free of process/Agent I/O so
// it stays unit-testable without a live model.

import type { BatchStatus, CheckRecord } from "./session.ts";
import type { ChangedFileAction, ChatMessage, ErrorKind, RunReport, RunStatus, WorkspaceScope } from "./types.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface BatchTask {
  id: string;
  prompt: string;
  kind?: string;
  /** Per-task override for model reasoning; omitted preserves model default. */
  think?: boolean;
  check?: string;
  /** Repair attempts after a failing check; defaults to the one-shot 2. */
  checkRetries?: number;
  /** Optional per-task narrowing; intersected with CLI --allow-path values. */
  allowedPaths?: string[];
  /** Paths visible to the task but forbidden to modify. */
  protectedPaths?: string[];
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
    if (raw.think !== undefined) {
      if (typeof raw.think !== "boolean") throw new BatchConfigError(`task ${id}: "think" must be a boolean`);
      task.think = raw.think;
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
    for (const [jsonName, field] of [["allowed_paths", "allowedPaths"], ["protected_paths", "protectedPaths"]] as const) {
      const value = raw[jsonName];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
        throw new BatchConfigError(`task ${id}: "${jsonName}" must be a non-empty array of non-empty strings`);
      }
      task[field] = value as string[];
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
 * `fatal`) is "error". Otherwise, judged over ALL tasks: every task ok → "ok",
 * no task ok → "failed", a mix → "partial". `not_run` counts against "ok" (it
 * can arise without a fatal — e.g. the total wall-clock budget ran out before a
 * task started — and an incomplete batch must not report "ok").
 */
export function aggregateBatchStatus(statuses: RunStatus[], fatal: boolean): BatchStatus {
  if (fatal) return "error";
  if (statuses.length === 0) return "error";
  const ok = statuses.filter((s) => s === "ok").length;
  if (ok === statuses.length) return "ok";
  if (ok === 0) return "failed";
  return "partial";
}

/**
 * Merge per-task reports into one cumulative report (for the session-level
 * record). commandsRun is concatenated in task order; a changed file keeps a
 * "created" action if any task created it, else the last action wins.
 */
export function mergeReports(reports: RunReport[]): RunReport {
  const files = new Map<string, ChangedFileAction>();
  const commandsRun: string[] = [];
  for (const r of reports) {
    for (const f of r.changedFiles) {
      if (files.get(f.path) !== "created") files.set(f.path, f.action);
    }
    commandsRun.push(...r.commandsRun);
  }
  return { changedFiles: [...files].map(([path, action]) => ({ path, action })), commandsRun };
}

/** One task's full outcome as produced by an executor and consumed by callers.
 *  Each task runs in a fresh agent context, so `report` and `messages` are that
 *  task's own (not a slice of a shared session). */
export interface TaskExecution {
  task: BatchTask;
  status: RunStatus;
  error?: string;
  errorKind?: ErrorKind;
  check?: CheckRecord;
  report: RunReport;
  turns: number;
  durationMs: number;
  /** This task's transcript (system prompt + task prompt + repairs), for audit. */
  messages?: readonly ChatMessage[];
}

export interface BatchResult {
  executions: TaskExecution[];
  status: BatchStatus;
  fatal: boolean;
}

/** The slice of an Agent that `lh batch` drives, so a clock/agent/check-runner
 *  can be injected for tests without a live model (the real Agent satisfies it). */
export interface BatchAgent {
  run(prompt: string): Promise<string>;
  readonly lastRunStatus: RunStatus;
  getReport(): RunReport;
  getMessages(): readonly ChatMessage[];
  interrupt(): void;
}

/** Injected side-effecting dependencies of cmdBatch. Production wires the real
 *  clock, a fresh Agent per task, the shared-config budget knob, and the shell
 *  check runner; tests substitute fakes (inject `now` to drive the wall-clock
 *  budget with no real Date dependency). */
export interface BatchDeps {
  now: () => number;
  /** Build a fresh agent (clean context) for the next task, seeded with the
   *  batch's one shared system prompt (same string for every task). */
  createAgent: (systemPrompt: string, task: BatchTask, scope?: WorkspaceScope) => BatchAgent;
  /** Set the wall-clock budget handed to the next agent.run() (0 = unlimited). */
  applyBudget: (ms: number) => void;
  runCheck: (
    command: string,
    timeoutMs: number,
    attempts: number,
    signal?: AbortSignal,
    deadlineAt?: number,
    scope?: WorkspaceScope,
  ) => Promise<CheckRecord>;
}

/** A task that never ran — a fatal earlier task aborted the batch, or the total
 *  wall-clock budget was already spent before this task started. */
export function notRun(task: BatchTask): TaskExecution {
  return { task, status: "not_run", report: { changedFiles: [], commandsRun: [] }, turns: 0, durationMs: 0 };
}

/**
 * Run each task in order via `runTask`, stopping early on a fatal outcome and
 * marking the remaining tasks "not_run". `onProgress` fires after every task
 * (ran or not_run) with the executions-so-far, so the caller can persist the
 * session incrementally and survive a mid-batch kill. Pure orchestration: all
 * model/agent I/O lives behind `runTask`, so tests inject a fake executor.
 */
export async function executeBatch(
  tasks: BatchTask[],
  runTask: (task: BatchTask) => Promise<TaskExecution>,
  onProgress?: (executions: TaskExecution[]) => void,
): Promise<BatchResult> {
  const executions: TaskExecution[] = [];
  let fatal = false;
  for (const task of tasks) {
    if (fatal) {
      executions.push(notRun(task));
    } else {
      const exec = await runTask(task);
      executions.push(exec);
      if (isFatalOutcome(exec.status, exec.errorKind)) fatal = true;
    }
    onProgress?.(executions);
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
        out.push({
          ...e,
          status: check.timed_out ? "timeout" : "check_failed",
          check: { ...check, regressed: true },
        });
        continue;
      }
    }
    out.push(e);
  }
  return { executions: out, status: aggregateBatchStatus(out.map((e) => e.status), false) };
}
