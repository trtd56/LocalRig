#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { Agent } from "./agent.ts";
import {
  type BatchAgent,
  type BatchDeps,
  BatchConfigError,
  executeBatch,
  mergeReports,
  notRun,
  parseManifest,
  reverifyBatch,
  type BatchTask,
  type TaskExecution,
} from "./batch.ts";
import { buildCheckRepairPrompt, canRetryCheck, runCheckCommand } from "./check.ts";
import { applyProfile, defaultConfig, PROFILE_FIELD_ENV, type Config, type ProfileField } from "./config.ts";
import {
  distill,
  DistillConfigError,
  DistillModelError,
  parseDigest,
  verifyCitations,
  type Digest,
  type DistillCompleteResult,
  type DistillInput,
} from "./distill.ts";
import { estimateTokens } from "./context/tokens.ts";
import { OllamaClient } from "./provider/ollama.ts";
import { buildScoutSystemPrompt, buildSystemPrompt } from "./prompt/system.ts";
import { createScoutTools } from "./tools/registry.ts";
import { isBinary } from "./tools/read.ts";
import { createRenderer, c } from "./ui/render.ts";
import type { AgentEvent, ChatMessage, ChatRequestOptions, ErrorKind, RunReport, RunStatus } from "./types.ts";
import {
  appendFeedback,
  type BatchStatus,
  type CheckRecord,
  computeStats,
  latestSessionId,
  listSessionIds,
  loadSession,
  newSessionId,
  readFeedback,
  ResumeError,
  restoreTranscript,
  saveSession,
  type SessionRecord,
  type TaskRecord,
} from "./session.ts";

const HELP = `LocalRig — coding agent for local LLMs via Ollama

Usage:
  localrig                  interactive REPL
  localrig -p "task"        one-shot: progress → stderr, final answer → stdout
  lh                        interactive REPL
  lh -p "task"              one-shot: progress → stderr, final answer → stdout
  echo "task" | lh -p -     one-shot, prompt from stdin
  lh -p "follow-up" --resume <id> --json
                            one-shot: restore a saved session's transcript and
                            continue with "follow-up" as the next instruction
  lh submit -p "task" --json
                            start a detached one-shot and return immediately
  lh batch --tasks <file|-> [--json]
                            run several independent tasks in one session (one
                            Agent, shared cwd); per-task status/check/report
  lh distill -q "question" [files...] [--json]
                            extract a citation-checked digest from large files
                            or stdin before sending it to an upstream agent
  lh scout -q "question" [--paths src/ lib/] [--json]
                            read-only repository scout: find relevant files and
                            return a citation-checked digest
  lh wait <id> [--timeout 1200] [--json]
                            wait for a submitted session to finish
  lh poll <id> [--json]     inspect a submitted session without blocking
  lh feedback <id> <pass|fail> [--notes "why"] [--source claude-code]
                            grade a past session (use --last for the newest)
  lh sessions [-n N]        list recent sessions with their feedback
  lh stats [--json] [--by-kind]
                            delegation pass rate from recorded feedback

One-shot flags:
  --json                    machine output: single JSON object on stdout,
                            progress suppressed (add -v to stream to stderr)
  --quiet                   suppress progress on stderr
  --cwd DIR                 run in DIR instead of the current directory
  --model NAME              override model (default: ${defaultConfig.model})
  --num-ctx N               context window (default: ${defaultConfig.numCtx})
  --num-predict N           max tokens generated per turn (default: ${defaultConfig.numPredict})
  --temperature T           sampling temperature (default: ${defaultConfig.temperature})
  --presence-penalty P      anti-repetition penalty (default: ${defaultConfig.presencePenalty})
  --max-iterations N        agent loop cap (default: ${defaultConfig.maxIterations})
  --max-time SECONDS        wall-clock budget; 0 disables (default: ${defaultConfig.maxTimeMs / 1000})
  --think-budget CHARS      abort a turn if thinking exceeds this before output (default: ${defaultConfig.thinkBudgetChars})
  --headroom TOKENS         tokens reserved above usage for the next reply (default: ${defaultConfig.headroomTokens})
  --check COMMAND           run an acceptance command after the agent finishes;
                            failed checks are fed back to the agent for repair
  --check-retries N         repair attempts after a failing check (default: 2)
  --kind KIND               tag this delegation (recommended: rename, tests,
                            docs, types, perf, bugfix, other)

Batch flags:
  --tasks FILE|-            JSON manifest of tasks (- reads stdin). Shape:
                            {"tasks":[{"id","prompt","kind?","check?",
                            "check_retries?"}]} (a bare [...] array also works).
                            Tasks run in order, each in a fresh context (system
                            prompt + that task's prompt only); --cwd, --json,
                            --quiet, -v, --auto/--yolo apply. --max-time here is
                            the TOTAL budget for the whole batch (all tasks +
                            checks + sweep); a task started with no budget left is
                            not_run, one still running times out. The session is
                            saved incrementally (survives a mid-batch kill).
                            After all tasks, every passed check is re-run once
                            (final sweep): a task whose check regressed (a later
                            task clobbered its work) is downgraded to check_failed
                            with "regressed": true. Grade with:
                            lh feedback <id> --task <task-id> pass|fail
Distill flags:
  -q, --query TEXT          required extraction question
  --budget TOKENS           target digest output budget (default: 2000)
  --think                   allow model thinking for this extraction (default off)
Scout flags:
  -q, --query TEXT          required repository question
  --paths PATH...           optional search-scope hints for the scout prompt
                            default loop budget: max-iterations 20, max-time 900s
                            unless explicitly overridden
  --think / --no-think      thinking is on by default for scout; --no-think
                            disables it for comparison runs
  --resume ID               continue a saved session (one-shot only): restore
                            its transcript, append the prompt as a follow-up,
                            and resume the agent loop. Records resumed_from and
                            defaults --cwd to the original session's directory
  --auto                    deny dangerous bash instead of the default
                            approve-everything (one-shot cannot prompt)
  --yolo                    approve all mutating tools (one-shot default)
  -v, --verbose             verbose progress (tool output, token usage)

Exit codes: 0 task completed, 1 stopped early (loop/max-iterations/error), 130 interrupted.`;

interface CliOptions {
  config: Config;
  prompt?: string;
  verbose: boolean;
  json: boolean;
  quiet: boolean;
  cwd?: string;
  permissionModeSet: boolean;
  maxIterationsSet: boolean;
  maxTimeSet: boolean;
  checkCommand?: string;
  checkRetries: number;
  kind?: string;
  sessionId?: string;
  resumeFrom?: string;
  tasksFile?: string;
  distillQuery?: string;
  distillBudget: number;
  distillThink: boolean;
  scoutPaths: string[];
  noThink: boolean;
  positionals: string[];
}

export function parseArgs(argv: string[]): CliOptions {
  const config = { ...defaultConfig };
  const opts: CliOptions = {
    config,
    verbose: false,
    json: false,
    quiet: false,
    permissionModeSet: false,
    maxIterationsSet: false,
    maxTimeSet: false,
    checkRetries: 2,
    distillBudget: 2000,
    distillThink: false,
    scoutPaths: [],
    noThink: false,
    positionals: [],
  };
  // Fields already pinned by an env var baked into defaultConfig at load time.
  // --model must not clobber these when it re-resolves a profile for the new
  // model; a CLI flag below adds to this set as it's parsed.
  const explicitProfileFields = new Set<ProfileField>(
    (Object.keys(PROFILE_FIELD_ENV) as ProfileField[]).filter((f) => process.env[PROFILE_FIELD_ENV[f]] !== undefined),
  );
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-p":
      case "--print":
        opts.prompt = argv[++i];
        break;
      case "--model":
        config.model = argv[++i]!;
        applyProfile(config, config.model, explicitProfileFields);
        break;
      case "--num-ctx":
        config.numCtx = Number(argv[++i]);
        break;
      case "--num-predict":
        config.numPredict = Number(argv[++i]);
        break;
      case "--temperature":
        config.temperature = Number(argv[++i]);
        explicitProfileFields.add("temperature");
        break;
      case "--presence-penalty":
        config.presencePenalty = Number(argv[++i]);
        explicitProfileFields.add("presencePenalty");
        break;
      case "--max-iterations":
        config.maxIterations = Number(argv[++i]);
        opts.maxIterationsSet = true;
        break;
      case "--max-time":
        config.maxTimeMs = Number(argv[++i]) * 1000;
        opts.maxTimeSet = true;
        break;
      case "--think-budget":
        config.thinkBudgetChars = Number(argv[++i]);
        explicitProfileFields.add("thinkBudgetChars");
        break;
      case "--headroom":
        config.headroomTokens = Number(argv[++i]);
        break;
      case "--cwd":
        opts.cwd = argv[++i];
        break;
      case "--check":
        opts.checkCommand = argv[++i];
        break;
      case "--check-retries":
        opts.checkRetries = Number(argv[++i]);
        break;
      case "--kind":
        opts.kind = argv[++i];
        break;
      case "--session-id":
        opts.sessionId = argv[++i];
        break;
      case "--resume":
        opts.resumeFrom = argv[++i];
        break;
      case "--tasks":
        opts.tasksFile = argv[++i];
        break;
      case "-q":
      case "--query":
        opts.distillQuery = argv[++i];
        break;
      case "--budget":
        opts.distillBudget = Number(argv[++i]);
        break;
      case "--think":
        opts.distillThink = true;
        break;
      case "--no-think":
        opts.noThink = true;
        break;
      case "--paths":
        while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) {
          opts.scoutPaths.push(argv[++i]!);
        }
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--auto":
        config.permissionMode = "auto";
        opts.permissionModeSet = true;
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        config.permissionMode = "yolo";
        opts.permissionModeSet = true;
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        if (!a.startsWith("-")) opts.positionals.push(a);
        break;
    }
  }
  return opts;
}

async function readStdin(): Promise<string> {
  return (await readStdinRaw()).trim();
}

async function readStdinRaw(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- subcommands ----------

export function cmdFeedback(argv: string[]): number {
  let id: string | undefined;
  let taskId: string | undefined;
  let verdict: "pass" | "fail" | undefined;
  let notes: string | undefined;
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--last") id = latestSessionId() ?? undefined;
    else if (a === "--task") taskId = argv[++i];
    else if (a === "--notes") notes = argv[++i];
    else if (a === "--source") source = argv[++i];
    else if (a === "pass" || a === "fail") verdict = a;
    else if (!a.startsWith("-") && id === undefined) id = a;
  }
  if (!id || !verdict) {
    console.error('usage: lh feedback <session-id|--last> [--task <id>] <pass|fail> [--notes "why"] [--source name]');
    return 1;
  }
  const session = loadSession(id);
  if (!session) {
    console.error(`unknown session: ${id} (see \`lh sessions\`)`);
    return 1;
  }
  const createdAt = new Date().toISOString();

  // --task grades a single task of a batch session with that task's own kind.
  if (taskId !== undefined) {
    const task = session.tasks?.find((t) => t.id === taskId);
    if (!task) {
      console.error(`unknown task id: ${taskId} in session ${id} (see its tasks with \`lh poll ${id} --json\`)`);
      return 1;
    }
    appendFeedback({ sessionId: id, taskId, verdict, kind: task.kind, notes, source, createdAt });
    console.log(`recorded: ${id} --task ${taskId} ${verdict}${notes ? ` — ${notes}` : ""}`);
    return 0;
  }

  // A bare verdict on a batch session fans out to every task, each carrying its
  // own kind, so by-kind stats stay accurate.
  if (session.tasks && session.tasks.length > 0) {
    for (const task of session.tasks) {
      appendFeedback({ sessionId: id, taskId: task.id, verdict, kind: task.kind, notes, source, createdAt });
    }
    console.log(`recorded: ${id} ${verdict} — fanned out to ${session.tasks.length} tasks${notes ? ` — ${notes}` : ""}`);
    return 0;
  }

  appendFeedback({ sessionId: id, verdict, kind: session.kind, notes, source, createdAt });
  console.log(`recorded: ${id} ${verdict}${notes ? ` — ${notes}` : ""}`);
  return 0;
}

function cmdSessions(argv: string[]): number {
  let n = 10;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-n") n = Number(argv[++i]);
  }
  const verdicts = new Map<string, string>();
  for (const fb of readFeedback()) verdicts.set(fb.sessionId, fb.verdict);
  const ids = listSessionIds().slice(-n);
  if (ids.length === 0) {
    console.log("no sessions recorded yet");
    return 0;
  }
  for (const id of ids) {
    const s = loadSession(id);
    if (!s) continue;
    const head = s.prompt.replace(/\s+/g, " ").slice(0, 60);
    const verdict = verdicts.get(id) ?? "";
    const kind = s.kind ? `[${s.kind}] ` : "";
    console.log(
      `${id}  ${s.status.padEnd(14)} ${Math.round(s.durationMs / 1000)}s  ${verdict.padEnd(4)} ${kind}${head}`,
    );
  }
  return 0;
}

function cmdStats(argv: string[]): number {
  const byKind = argv.includes("--by-kind");
  const stats = computeStats({ byKind });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  console.log(`sessions: ${stats.sessions}`);
  console.log(`graded:   ${stats.graded} (pass ${stats.pass} / fail ${stats.fail}, ${stats.rate ?? 0}% pass)`);
  if (stats.recentFailures.length > 0) {
    console.log("recent failures:");
    for (const f of stats.recentFailures) {
      console.log(`  ${f.sessionId}${f.notes ? ` — ${f.notes}` : ""}`);
    }
  }
  if (byKind && stats.byKind) {
    console.log("by kind:");
    for (const k of stats.byKind) {
      console.log(
        `  ${k.kind.padEnd(12)} ${k.graded} graded, pass ${k.pass} / fail ${k.fail}, ${k.rate ?? 0}% pass, avg ${Math.round(k.avgDurationMs / 1000)}s, gate ${k.gate.status}`,
      );
    }
  }
  return 0;
}

// ---------- one-shot ----------

/**
 * Bucket a caught run error's message so a caller can branch on cause
 * (e.g. retry after a connection failure) without parsing free text.
 * Order matters: connection/ollama_error patterns are checked before the
 * generic "internal" fallback. "config" has no current thrower — reserved
 * for future validation errors (e.g. bad --model / config values).
 */
function classifyError(message: string): ErrorKind {
  // Bun's fetch collapses both connection-refused and DNS failure into this
  // exact generic string (verified against a real dead port and a bad
  // hostname on Bun 1.2.21 — neither produces ECONNREFUSED/ENOTFOUND text
  // the way Node's fetch does). Node-style codes are kept for when this runs
  // under `node` instead (package.json allows node >=24 as an alternative).
  if (/fetch failed|unable to connect|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) return "connection";
  if (message.startsWith("Ollama HTTP") || message.startsWith("Ollama error:")) return "ollama_error";
  return "internal";
}

function reportForJson(report: RunReport | undefined) {
  return report
    ? {
        changed_files: report.changedFiles,
        commands_run: report.commandsRun,
      }
    : { changed_files: [], commands_run: [] };
}

export function taskForJson(task: TaskRecord) {
  return {
    id: task.id,
    status: task.status,
    kind: task.kind,
    duration_ms: task.durationMs,
    turns: task.turns,
    check: task.check,
    ...reportForJson(task.report),
  };
}

/** Batch `--json`: the task-oriented view (distinct from a one-shot session). */
function batchForJson(record: SessionRecord) {
  return {
    session_id: record.id,
    status: record.status,
    duration_ms: record.durationMs,
    model: record.model,
    cwd: record.cwd,
    tasks: (record.tasks ?? []).map(taskForJson),
    tokens: record.tokens,
    feedback_command: `lh feedback ${record.id} --task <id> <pass|fail> --notes "<verified how / what went wrong>"`,
  };
}

function sessionForJson(record: SessionRecord) {
  return {
    session_id: record.id,
    status: record.status,
    result: record.result,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    turns: record.turns,
    tool_calls: record.toolCalls,
    tokens: record.tokens,
    model: record.model,
    cwd: record.cwd,
    kind: record.kind,
    resumed_from: record.resumedFrom,
    pid: record.pid,
    check: record.check,
    report: reportForJson(record.report),
    tasks: record.tasks ? record.tasks.map(taskForJson) : undefined,
    feedback_command: `lh feedback ${record.id} <pass|fail> --notes "<verified how / what went wrong>"`,
  };
}

/**
 * A `--resume` target could not be replayed (unknown id / no transcript). Emit
 * a clear error before any session is minted — no phantom record is saved — and
 * exit 1. JSON callers get { status, error, error_kind } so they can branch on
 * error_kind ("config" for a bad id) without parsing the message.
 */
function failResume(opts: CliOptions, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const errorKind: ErrorKind = err instanceof ResumeError ? err.kind : "internal";
  if (opts.json) {
    console.log(JSON.stringify({ status: "error", error: message, error_kind: errorKind }));
  } else {
    process.stderr.write(c.red(`error: ${message}`) + "\n");
  }
  process.exit(1);
}

function statusExitCode(status: RunStatus | BatchStatus): number {
  if (status === "ok" || status === "running") return 0;
  if (status === "interrupted") return 130;
  return 1;
}

async function runOneShot(opts: CliOptions): Promise<never> {
  const { config } = opts;

  // --resume: restore a saved session's transcript to seed this run. Replay in
  // the original session's cwd (so file paths in the transcript still resolve)
  // unless the caller overrode --cwd.
  let restored: ChatMessage[] | undefined;
  let resumedFrom: string | undefined;
  let baseCwd = opts.cwd;
  if (opts.resumeFrom !== undefined) {
    const original = loadSession(opts.resumeFrom);
    try {
      restored = restoreTranscript(opts.resumeFrom, original);
    } catch (err) {
      return failResume(opts, err);
    }
    resumedFrom = opts.resumeFrom;
    baseCwd = opts.cwd ?? original!.cwd;
  }

  const cwd = path.resolve(baseCwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const checkRetries = Number.isFinite(opts.checkRetries) && opts.checkRetries >= 0 ? Math.floor(opts.checkRetries) : 2;
  const originalMaxTimeMs = config.maxTimeMs;
  // One-shot can't prompt for permission: default to yolo unless the caller
  // chose --auto (then dangerous bash is denied instead of asked).
  if (!opts.permissionModeSet) config.permissionMode = "yolo";
  const denyPermission = async () => false;

  const showProgress = opts.json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const onEvent = (e: AgentEvent) => {
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptTokens = e.promptTokens;
      completionTokens += e.evalTokens;
    }
    progress?.(e);
  };

  const agent = new Agent(config, cwd, onEvent, denyPermission);
  if (restored) agent.restore(restored);
  process.on("SIGINT", () => {
    agent.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  });

  const started = Date.now();
  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  let check: CheckRecord | undefined;
  try {
    result = await agent.run(opts.prompt!);
    status = agent.lastRunStatus;
    if (opts.checkCommand && status === "ok") {
      for (let attempt = 1; ; attempt++) {
        check = await runCheckCommand({
          command: opts.checkCommand,
          cwd,
          timeoutMs: config.bashTimeoutMs,
          attempts: attempt,
        });
        if (check.exit_code === 0) break;
        if (
          !canRetryCheck({
            attempts: attempt,
            maxRetries: checkRetries,
            startedAtMs: started,
            maxTimeMs: originalMaxTimeMs,
          })
        ) {
          status = "check_failed";
          break;
        }
        if (originalMaxTimeMs > 0) {
          config.maxTimeMs = Math.max(1, originalMaxTimeMs - (Date.now() - started));
        }
        result = await agent.run(buildCheckRepairPrompt(check));
        status = agent.lastRunStatus;
        if (status !== "ok") break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    errorKind = classifyError(error);
  }
  const durationMs = Date.now() - started;

  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    prompt: opts.prompt!,
    kind: opts.kind,
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls,
    tokens: { prompt: promptTokens, completion: completionTokens },
    check,
    report: agent.getReport(),
    messages: agent.getMessages(),
    resumedFrom,
  };
  saveSession(record);

  if (opts.json) {
    console.log(JSON.stringify(sessionForJson(record)));
  } else {
    if (result) process.stdout.write(result + "\n");
    if (error) process.stderr.write(c.red(`error: ${error}`) + "\n");
    if (check) {
      const msg = check.exit_code === 0 ? `check passed: ${check.command}` : `check failed: ${check.command}`;
      process.stderr.write(c.dim(`${msg} (attempts ${check.attempts})`) + "\n");
    }
    process.stderr.write(
      c.dim(`session ${sessionId} (${status}, ${Math.round(durationMs / 1000)}s) — grade it: lh feedback ${sessionId} pass|fail`) + "\n",
    );
  }
  process.exit(statusExitCode(status));
}

// ---------- batch ----------

function emitBatchConfigError(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
  else process.stderr.write(c.red(`error: ${message}`) + "\n");
  return 1;
}

function summarizeTasks(executions: TaskExecution[]): string {
  const counts = new Map<string, number>();
  for (const e of executions) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`);
  return `${executions.length} task${executions.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function toTaskRecords(executions: TaskExecution[]): TaskRecord[] {
  return executions.map((e) => ({
    id: e.task.id,
    kind: e.task.kind,
    status: e.status,
    durationMs: e.durationMs,
    turns: e.turns,
    check: e.check,
    report: e.report,
  }));
}

function printBatchSummary(record: SessionRecord, executions: TaskExecution[]): void {
  for (const e of executions) {
    const parts = [`  ${e.task.id.padEnd(16)} ${e.status.padEnd(14)} ${Math.round(e.durationMs / 1000)}s`];
    if (e.check) parts.push(`check ${e.check.exit_code === 0 ? "passed" : e.check.regressed ? "regressed" : "failed"}`);
    if (e.report.changedFiles.length > 0) parts.push(`${e.report.changedFiles.length} file(s)`);
    if (e.error) parts.push(`error: ${e.error}`);
    process.stdout.write(parts.join("  ") + "\n");
  }
  process.stderr.write(
    c.dim(
      `session ${record.id} (${record.status}, ${Math.round(record.durationMs / 1000)}s) — ` +
        `grade tasks: lh feedback ${record.id} --task <id> pass|fail`,
    ) + "\n",
  );
}

/**
 * `lh batch`: run several independent tasks back-to-back, amortizing session
 * start-up. Each task runs in a FRESH agent context (system prompt + that task's
 * prompt only) and is run to completion, then optionally re-verified with its
 * own `check` loop. `--max-time` is the TOTAL wall-clock budget for the whole
 * batch. A fatal task aborts the batch and leaves the rest "not_run"; other
 * failures fall through to the next task. The session is persisted incrementally
 * (running placeholder, then after every task) so a mid-batch kill still leaves
 * a record of the completed tasks.
 *
 * `deps` is injected only by tests (fake clock/agent/check runner); production
 * passes nothing and gets the real wiring.
 */
export async function cmdBatch(argv: string[], deps?: BatchDeps): Promise<number> {
  const opts = parseArgs(argv);
  const json = opts.json;

  // Batch is synchronous and self-contained: no detached/resume variants (v1).
  if (opts.resumeFrom !== undefined) {
    return emitBatchConfigError(json, "batch does not support --resume (a batch session cannot be resumed in v1)");
  }
  if (!opts.tasksFile) {
    console.error("usage: lh batch --tasks <file|-> [--cwd DIR] [--json] [--auto|--yolo] [--max-time SEC] [--quiet] [-v]");
    return 1;
  }

  let manifestText: string;
  try {
    manifestText = opts.tasksFile === "-" ? await readStdin() : fs.readFileSync(path.resolve(opts.tasksFile), "utf8");
  } catch (err) {
    return emitBatchConfigError(json, `cannot read manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tasks: BatchTask[];
  try {
    tasks = parseManifest(manifestText);
  } catch (err) {
    if (err instanceof BatchConfigError) return emitBatchConfigError(json, err.message);
    throw err;
  }

  const { config } = opts;
  if (!opts.permissionModeSet) config.permissionMode = "yolo";
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const denyPermission = async () => false;
  // --max-time is the TOTAL wall-clock budget for the whole batch (all tasks +
  // checks + the final sweep), not per task. When it is not set explicitly, fall
  // back to the per-run default × task count so each task keeps its usual
  // allowance (the default is 0 = unlimited, which stays unlimited).
  const totalBudgetMs = opts.maxTimeSet ? config.maxTimeMs : config.maxTimeMs * tasks.length;
  const budgetActive = totalBudgetMs > 0;

  const showProgress = json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const onEvent = (e: AgentEvent) => {
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptTokens = e.promptTokens;
      completionTokens += e.evalTokens;
    }
    progress?.(e);
  };

  // Build the system prompt ONCE for the whole batch. Each task gets a fresh
  // agent, but they all reuse this one string (the directory snapshot inside it
  // is frozen at batch start — stale is harmless, it is only a 25-entry hint),
  // so the system prefix stays byte-identical and Ollama's prefix KV cache holds.
  const systemPrompt = buildSystemPrompt(cwd, config);

  // Real wiring: fresh Agent per task, the shared-config budget knob, the shell
  // check runner, and the system clock. Tests inject fakes via `deps`.
  const d: BatchDeps = deps ?? {
    now: () => Date.now(),
    createAgent: (sp) => new Agent(config, cwd, onEvent, denyPermission, sp),
    applyBudget: (ms) => {
      config.maxTimeMs = ms;
    },
    runCheck: (command, timeoutMs, attempts) => runCheckCommand({ command, cwd, timeoutMs, attempts }),
  };

  // The SIGINT handler must interrupt whichever fresh agent is currently running.
  // Registered only in production (an injected deps means a test — avoid leaking
  // process listeners across test runs).
  let currentAgent: BatchAgent | undefined;
  if (deps === undefined) {
    process.on("SIGINT", () => {
      currentAgent?.interrupt();
      process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
    });
  }

  const started = d.now();
  const remainingMs = () => totalBudgetMs - (d.now() - started);

  // Run one task in a FRESH agent context (the shared system prompt + this
  // task's prompt only). Tasks are independent by contract, and a 27B model
  // degrades and slows when a later task inherits an earlier one's bloated
  // transcript; a clean context avoids that. The agent loop and check-repair
  // loop are handed the budget REMAINING for the whole batch, so their total
  // can never exceed --max-time.
  const runTask = async (task: BatchTask): Promise<TaskExecution> => {
    if (budgetActive && remainingMs() <= 0) return notRun(task); // total budget spent
    const taskStarted = d.now();
    const turnsBefore = turns;
    const agent = d.createAgent(systemPrompt);
    currentAgent = agent;
    const checkRetries = task.checkRetries ?? 2;
    let status: RunStatus = "error";
    let error: string | undefined;
    let errorKind: ErrorKind | undefined;
    let check: CheckRecord | undefined;
    try {
      d.applyBudget(budgetActive ? Math.max(1, remainingMs()) : 0);
      await agent.run(task.prompt);
      status = agent.lastRunStatus;
      if (task.check && status === "ok") {
        for (let attempt = 1; ; attempt++) {
          const timeoutMs = budgetActive ? Math.max(1, Math.min(config.bashTimeoutMs, remainingMs())) : config.bashTimeoutMs;
          check = await d.runCheck(task.check, timeoutMs, attempt);
          if (check.exit_code === 0) break;
          if (!canRetryCheck({ attempts: attempt, maxRetries: checkRetries, startedAtMs: started, maxTimeMs: totalBudgetMs })) {
            status = "check_failed";
            break;
          }
          d.applyBudget(budgetActive ? Math.max(1, remainingMs()) : 0);
          await agent.run(buildCheckRepairPrompt(check));
          status = agent.lastRunStatus;
          if (status !== "ok") break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      errorKind = classifyError(error);
      status = "error";
    }
    return {
      task,
      status,
      error,
      errorKind,
      check,
      report: agent.getReport(),
      turns: turns - turnsBefore,
      durationMs: d.now() - taskStarted,
      messages: agent.getMessages(),
    };
  };

  // Assemble a session record from whatever tasks have finished so far, so the
  // same builder serves the incremental running saves and the final save.
  const buildRecord = (status: RunStatus | BatchStatus, execs: TaskExecution[]): SessionRecord => {
    const errored = execs.find((e) => e.error);
    return {
      id: sessionId,
      createdAt: new Date(started).toISOString(),
      cwd,
      model: config.model,
      prompt: `batch: ${tasks.map((t) => t.id).join(", ")}`,
      status,
      result: summarizeTasks(execs),
      error: errored?.error,
      errorKind: errored?.errorKind,
      durationMs: d.now() - started,
      turns,
      toolCalls,
      tokens: { prompt: promptTokens, completion: completionTokens },
      report: mergeReports(execs.map((e) => e.report)),
      messages: execs.flatMap((e) => (e.messages ? [...e.messages] : [])),
      tasks: toTaskRecords(execs),
    };
  };

  // Persist a running placeholder up front, then after every task, so a
  // mid-batch SIGTERM still leaves the completed tasks on disk.
  saveSession(buildRecord("running", []));
  const batch = await executeBatch(tasks, runTask, (execs) => saveSession(buildRecord("running", execs)));

  // Final re-verification sweep re-runs each passed check once, catching an
  // earlier task's work being clobbered by a later one (bash/git side effects
  // never show up in changed_files, so this is the only signal for it). It is
  // lightweight (shell only), so it runs even when the budget is spent, using
  // the full bash timeout rather than the (possibly zero) remaining budget.
  const recheck = (task: BatchTask) => d.runCheck(task.check!, config.bashTimeoutMs, 1);
  const { executions, status } = await reverifyBatch(batch.executions, batch.fatal, recheck);

  const record = buildRecord(status, executions);
  saveSession(record);

  if (json) console.log(JSON.stringify(batchForJson(record)));
  else printBatchSummary(record, executions);
  return statusExitCode(status);
}

// ---------- distill ----------

export interface DistillCliDeps {
  readFileBuffer?: (file: string) => Buffer;
  readStdin?: () => Promise<string>;
  complete?: (messages: ChatMessage[], options: ChatRequestOptions) => Promise<DistillCompleteResult>;
  now?: () => number;
}

function emitDistillConfigError(json: boolean, message: string, warnings: string[] = []): number {
  if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind, warnings }));
  else process.stderr.write(c.red(`error: ${message}`) + "\n");
  return 1;
}

function distillForJson(record: SessionRecord, warnings: string[] = []) {
  return {
    session_id: record.id,
    status: record.status,
    digest: record.result ? JSON.parse(record.result) : undefined,
    warnings,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    turns: record.turns,
    tokens: record.tokens,
    model: record.model,
    cwd: record.cwd,
    kind: record.kind,
    feedback_command: `lh feedback ${record.id} <pass|fail> --notes "<digest useful? cited ranges verified?>"`,
  };
}

function displayPath(cwd: string, file: string): string {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

function loadDistillFile(cwd: string, file: string, readFileBuffer: (file: string) => Buffer): DistillInput | string {
  const abs = path.resolve(cwd, file);
  const label = displayPath(cwd, file);
  let buf: Buffer;
  try {
    buf = readFileBuffer(abs);
  } catch (err) {
    return `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (isBinary(buf)) return `skipped binary file: ${label}`;
  const text = buf.toString("utf8");
  const longLine = text.split("\n").find((line) => line.length > 500_000);
  if (longLine !== undefined) return `skipped huge single-line file: ${label}`;
  return { file: label, text };
}

function stdinHasData(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const st = fs.fstatSync(0);
    return st.isFIFO() || st.isFile() || st.isSocket();
  } catch {
    return process.stdin.isTTY === false;
  }
}

export async function cmdDistill(argv: string[], deps: DistillCliDeps = {}): Promise<number> {
  const opts = parseArgs(argv);
  const json = opts.json;
  const query = opts.distillQuery;
  if (opts.resumeFrom !== undefined) return emitDistillConfigError(json, "distill does not support --resume");
  if (!query || !query.trim()) return emitDistillConfigError(json, "distill requires -q/--query");
  const budget = Math.floor(opts.distillBudget);
  if (!Number.isFinite(opts.distillBudget) || budget < 1) {
    return emitDistillConfigError(json, "--budget must be an integer >= 1");
  }

  const { config } = opts;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const readFileBuffer = deps.readFileBuffer ?? ((file: string) => fs.readFileSync(file));
  const readPipe = deps.readStdin ?? readStdinRaw;
  const inputs: DistillInput[] = [];
  const warnings: string[] = [];

  for (const file of opts.positionals) {
    const loaded = loadDistillFile(cwd, file, readFileBuffer);
    if (typeof loaded === "string") warnings.push(loaded);
    else inputs.push(loaded);
  }

  const shouldReadStdin = deps.readStdin !== undefined || stdinHasData();
  if (shouldReadStdin) {
    const stdin = await readPipe();
    if (stdin.length > 0) inputs.push({ file: "(stdin)", text: stdin });
  }

  if (warnings.length > 0 && !opts.quiet && !json) {
    for (const warning of warnings) process.stderr.write(c.yellow(`warning: ${warning}`) + "\n");
  }
  if (inputs.length === 0) return emitDistillConfigError(json, "distill found no readable input", warnings);

  const sessionId = opts.sessionId ?? newSessionId();
  const started = deps.now?.() ?? Date.now();
  const abort = new AbortController();
  let timedOut = false;
  let interrupted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (config.maxTimeMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, config.maxTimeMs);
  }
  const onSigint = () => {
    interrupted = true;
    abort.abort();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  if (deps.complete === undefined) process.on("SIGINT", onSigint);

  const client = deps.complete === undefined ? new OllamaClient(config.ollamaUrl, config.model) : undefined;
  let turns = 0;
  const complete = async (messages: ChatMessage[], options: ChatRequestOptions): Promise<DistillCompleteResult> => {
    turns++;
    if (deps.complete) return deps.complete(messages, options);
    let usage = { promptTokens: 0, evalTokens: 0 };
    const text = await client!.complete(
      messages,
      {
        ...options,
        onUsage: (u) => {
          usage = u;
          options.onUsage?.(u);
        },
      },
      abort.signal,
    );
    return { text, promptTokens: usage.promptTokens, evalTokens: usage.evalTokens };
  };

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const out = await distill(
      {
        query,
        inputs,
        numCtx: config.numCtx,
        budget,
        think: opts.distillThink,
      },
      { complete, estimator: estimateTokens },
    );
    result = JSON.stringify(out.digest, null, 2);
    promptTokens = out.promptTokens;
    completionTokens = out.evalTokens;
    status = "ok";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    status = interrupted ? "interrupted" : timedOut ? "timeout" : "error";
    errorKind = err instanceof DistillConfigError ? "config" : err instanceof DistillModelError ? "ollama_error" : classifyError(error);
  } finally {
    if (timer) clearTimeout(timer);
    if (deps.complete === undefined) process.off("SIGINT", onSigint);
  }

  const durationMs = (deps.now?.() ?? Date.now()) - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    prompt: query,
    kind: opts.kind ?? "distill",
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls: 0,
    tokens: { prompt: promptTokens, completion: completionTokens },
    report: { changedFiles: [], commandsRun: [] },
  };
  saveSession(record);

  if (json) console.log(JSON.stringify(distillForJson(record, warnings)));
  else {
    if (result) process.stdout.write(result + "\n");
    if (error) process.stderr.write(c.red(`error: ${error}`) + "\n");
    process.stderr.write(
      c.dim(`session ${sessionId} (${status}, ${Math.round(durationMs / 1000)}s) — grade it: lh feedback ${sessionId} pass|fail`) + "\n",
    );
  }
  return statusExitCode(status);
}

// ---------- scout ----------

export interface ScoutAgent {
  lastRunStatus: RunStatus;
  run(input: string): Promise<string>;
  runTextOnly(input: string): Promise<string>;
  interrupt(): void;
  getMessages(): readonly ChatMessage[];
  getReport(): RunReport;
}

export interface ScoutCliDeps {
  createAgent?: (systemPrompt: string, onEvent: (e: AgentEvent) => void, think: boolean, config: Config) => ScoutAgent;
  readFile?: (file: string) => string;
  now?: () => number;
}

type ScoutDigest = Digest & {
  turns: number;
  parse_failed?: boolean;
  raw_text?: string;
};

function emitScoutConfigError(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
  else process.stderr.write(c.red(`error: ${message}`) + "\n");
  return 1;
}

function scoutForJson(record: SessionRecord) {
  return {
    session_id: record.id,
    status: record.status,
    digest: record.result ? JSON.parse(record.result) : undefined,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    turns: record.turns,
    tool_calls: record.toolCalls,
    tokens: record.tokens,
    model: record.model,
    cwd: record.cwd,
    kind: record.kind,
    feedback_command: `lh feedback ${record.id} <pass|fail> --notes "<scout useful? cited ranges verified?>"`,
  };
}

function readCitationFile(cwd: string, file: string, readFile: (file: string) => string): string {
  const root = fs.realpathSync(cwd);
  const target = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(root, realTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`citation path is outside cwd: ${file}`);
  }
  return readFile(realTarget);
}

function evidenceCheckedScoutDigest(
  digest: Digest,
  cwd: string,
  readFile: (file: string) => string,
  turns: number,
): ScoutDigest {
  const checked = verifyCitations(digest.citations, (file) => readCitationFile(cwd, file, readFile));
  const out: ScoutDigest = {
    ...digest,
    citations: checked.verified,
    citations_dropped: digest.citations_dropped + checked.dropped.length,
    turns,
  };
  if (!out.not_found && out.answer.trim() && out.citations.length === 0) {
    out.omitted = [
      ...out.omitted,
      "model returned an answer without any verified citations; treat the answer as unsupported",
    ];
  }
  return out;
}

function parseFailedScoutDigest(text: string, error: string | undefined, turns: number): ScoutDigest {
  return {
    answer: text,
    not_found: false,
    citations: [],
    omitted: [`parse failed: ${error ?? "unknown error"}`],
    citations_dropped: 0,
    turns,
    parse_failed: true,
    raw_text: text,
  };
}

export async function cmdScout(argv: string[], deps: ScoutCliDeps = {}): Promise<number> {
  const opts = parseArgs(argv);
  const json = opts.json;
  const query = opts.distillQuery;
  if (opts.resumeFrom !== undefined) return emitScoutConfigError(json, "scout does not support --resume");
  if (!query || !query.trim()) return emitScoutConfigError(json, "scout requires -q/--query");
  if (opts.positionals.length > 0) return emitScoutConfigError(json, "scout does not accept positional input files; use --paths for hints");

  const { config } = opts;
  if (!opts.maxIterationsSet) config.maxIterations = Math.min(config.maxIterations, 20);
  if (!opts.maxTimeSet) config.maxTimeMs = 900_000;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const now = deps.now ?? Date.now;
  const started = now();
  const showProgress = json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const onEvent = (e: AgentEvent) => {
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptTokens = e.promptTokens;
      completionTokens += e.evalTokens;
    }
    progress?.(e);
  };

  const think = !opts.noThink;
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const denyPermission = async () => false;
  const systemPrompt = buildScoutSystemPrompt(cwd, config, query, opts.scoutPaths);
  const agent =
    deps.createAgent?.(systemPrompt, onEvent, think, config) ??
    new Agent(config, cwd, onEvent, denyPermission, systemPrompt, createScoutTools(config, {
      cwd,
      readFiles: new Map(),
      todos: [],
      signal: new AbortController().signal,
    }), think);

  const onSigint = () => {
    agent.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  if (deps.createAgent === undefined) process.on("SIGINT", onSigint);

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  try {
    let text = await agent.run(query);
    status = agent.lastRunStatus;
    let parsed = parseDigest(text);
    if (!parsed.ok && status === "ok") {
      const originalMaxTimeMs = config.maxTimeMs;
      const elapsedMs = now() - started;
      const remainingMs = originalMaxTimeMs > 0 ? originalMaxTimeMs - elapsedMs : 0;
      if (originalMaxTimeMs === 0 || remainingMs > 0) {
        // Repair is a final formatting pass, not another scout loop. The
        // dedicated method exposes no tools and does not add Agent.run's
        // max-iteration wrap-up prompt.
        const repairTimer = originalMaxTimeMs > 0
          ? setTimeout(() => agent.interrupt(), Math.max(1, remainingMs))
          : undefined;
        try {
          text = await agent.runTextOnly(
            `The previous response did not match the required digest JSON schema: ${parsed.error}. ` +
              "Do not call tools. Return only valid JSON with answer, not_found, citations, omitted, and citations_dropped. No markdown.",
          );
          status = agent.lastRunStatus;
          parsed = parseDigest(text);
        } finally {
          if (repairTimer !== undefined) clearTimeout(repairTimer);
        }
      }
    }
    const digest = parsed.ok && parsed.digest
      ? evidenceCheckedScoutDigest(parsed.digest, cwd, readFile, turns)
      : parseFailedScoutDigest(text, parsed.error, turns);
    result = JSON.stringify(digest, null, 2);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    errorKind = classifyError(error);
    status = agent.lastRunStatus === "interrupted" ? "interrupted" : "error";
  } finally {
    if (deps.createAgent === undefined) process.off("SIGINT", onSigint);
  }

  const durationMs = now() - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    prompt: query,
    kind: opts.kind ?? "scout",
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls,
    tokens: { prompt: promptTokens, completion: completionTokens },
    report: agent.getReport(),
    messages: agent.getMessages(),
  };
  saveSession(record);

  if (json) console.log(JSON.stringify(scoutForJson(record)));
  else {
    if (result) process.stdout.write(result + "\n");
    if (error) process.stderr.write(c.red(`error: ${error}`) + "\n");
    process.stderr.write(
      c.dim(`session ${sessionId} (${status}, ${Math.round(durationMs / 1000)}s) — grade it: lh feedback ${sessionId} pass|fail`) + "\n",
    );
  }
  return statusExitCode(status);
}

// ---------- async submit / wait / poll ----------

export async function cmdSubmit(argv: string[]): Promise<number> {
  if (argv[0] === "batch") {
    console.error("error: submit does not support batch; run `lh batch` directly (it is synchronous — detached batch is not available in v1)");
    return 1;
  }
  if (argv[0] === "distill") {
    console.error("error: submit does not support distill; run `lh distill` directly (it is synchronous)");
    return 1;
  }
  if (argv[0] === "scout") {
    console.error("error: submit does not support scout; run `lh scout` directly (it is synchronous)");
    return 1;
  }
  const opts = parseArgs(argv);
  if (opts.prompt === "-") opts.prompt = await readStdin();
  if (opts.prompt === undefined || !opts.prompt.trim()) {
    console.error("usage: lh submit -p <task> [--json] [--check COMMAND]");
    return 1;
  }
  if (opts.resumeFrom !== undefined) {
    console.error("error: submit does not support --resume; use `lh -p <follow-up> --resume <id>`");
    return 1;
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = newSessionId();
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    cwd,
    model: opts.config.model,
    prompt: opts.prompt,
    kind: opts.kind,
    status: "running",
    result: "",
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    tokens: { prompt: 0, completion: 0 },
    report: { changedFiles: [], commandsRun: [] },
  };
  saveSession(record);

  const args = buildDetachedArgs(opts, sessionId, cwd);
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const current = loadSession(sessionId);
  if (current?.status === "running") saveSession({ ...current, pid: child.pid });

  if (opts.json) console.log(JSON.stringify({ session_id: sessionId, status: "running", pid: child.pid }));
  else console.log(`submitted: ${sessionId} (pid ${child.pid})`);
  return 0;
}

async function cmdWait(argv: string[]): Promise<number> {
  const { id, timeoutSeconds, json } = parseSessionWaitArgs(argv);
  if (!id) {
    console.error("usage: lh wait <session-id> [--timeout 1200] [--json]");
    return 1;
  }
  const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const record = refreshRunningSession(id);
    if (!record) {
      console.error(`unknown session: ${id}`);
      return 1;
    }
    if (record.status !== "running") return printPolledSession(record, json);
    if (deadline !== undefined && Date.now() >= deadline) {
      if (json) console.log(JSON.stringify(sessionForJson(record)));
      else console.log(`${id} still running`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function cmdPoll(argv: string[]): number {
  const { id, json } = parseSessionWaitArgs(argv);
  if (!id) {
    console.error("usage: lh poll <session-id> [--json]");
    return 1;
  }
  const record = refreshRunningSession(id);
  if (!record) {
    console.error(`unknown session: ${id}`);
    return 1;
  }
  return printPolledSession(record, json);
}

function printPolledSession(record: SessionRecord, json: boolean): number {
  if (json) console.log(JSON.stringify(sessionForJson(record)));
  else {
    console.log(`${record.id}  ${record.status}  ${Math.round(record.durationMs / 1000)}s`);
    if (record.result) console.log(record.result);
    if (record.error) console.error(`error: ${record.error}`);
  }
  return statusExitCode(record.status);
}

function parseSessionWaitArgs(argv: string[]): { id?: string; timeoutSeconds?: number; json: boolean } {
  let id: string | undefined;
  let timeoutSeconds: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--timeout") timeoutSeconds = Number(argv[++i]);
    else if (a === "--json") json = true;
    else if (!a.startsWith("-") && id === undefined) id = a;
  }
  return { id, timeoutSeconds, json };
}

function refreshRunningSession(id: string): SessionRecord | null {
  const record = loadSession(id);
  if (!record) return null;
  if (record.status === "running" && record.pid && !isProcessAlive(record.pid)) {
    const died = { ...record, status: "died" as const, durationMs: Date.now() - Date.parse(record.createdAt) };
    saveSession(died);
    return died;
  }
  return record;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function buildDetachedArgs(opts: CliOptions, sessionId: string, cwd: string): string[] {
  const script = process.argv[1]!;
  const args = [
    script,
    "-p",
    opts.prompt!,
    "--json",
    "--quiet",
    "--session-id",
    sessionId,
    "--cwd",
    cwd,
    "--model",
    opts.config.model,
    "--num-ctx",
    String(opts.config.numCtx),
    "--num-predict",
    String(opts.config.numPredict),
    "--temperature",
    String(opts.config.temperature),
    "--presence-penalty",
    String(opts.config.presencePenalty),
    "--max-iterations",
    String(opts.config.maxIterations),
    "--max-time",
    String(opts.config.maxTimeMs / 1000),
    "--think-budget",
    String(opts.config.thinkBudgetChars),
    "--headroom",
    String(opts.config.headroomTokens),
  ];
  if (opts.permissionModeSet) args.push(opts.config.permissionMode === "auto" ? "--auto" : "--yolo");
  if (opts.checkCommand) args.push("--check", opts.checkCommand, "--check-retries", String(opts.checkRetries));
  if (opts.kind) args.push("--kind", opts.kind);
  return args;
}

// ---------- REPL ----------

async function runRepl(opts: CliOptions): Promise<void> {
  const { config } = opts;
  const cwd = process.cwd();
  const render = createRenderer(opts.verbose);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  const askPermission = async (name: string, _args: Record<string, unknown>, display: string) => {
    const answer = (await ask(c.yellow(`  allow ${display}? [y/N/a(lways)/auto] `))).trim().toLowerCase();
    if (answer === "a") {
      config.permissionMode = "yolo"; // "always": approve everything from here on
      return true;
    }
    if (answer === "auto") {
      config.permissionMode = "auto"; // keep asking for dangerous bash only
      return true;
    }
    return answer === "y";
  };

  const agent = new Agent(config, cwd, render, askPermission);

  process.on("SIGINT", () => {
    agent.interrupt();
    process.stdout.write("\n" + c.yellow("[interrupted]") + "\n");
  });

  console.log(c.bold(`LocalRig`) + c.dim(` — ${config.model} @ ${config.ollamaUrl} (ctx ${config.numCtx})`));
  console.log(c.dim(`cwd: ${cwd} — type a task, "/auto" to toggle auto mode, "exit" to quit`));
  for (;;) {
    const input = (await ask(c.bold("\n> "))).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (input === "/auto") {
      config.permissionMode = config.permissionMode === "auto" ? "default" : "auto";
      console.log(c.dim(`permission mode: ${config.permissionMode}`));
      continue;
    }
    try {
      await agent.run(input);
    } catch (err) {
      console.error(c.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  rl.close();
}

async function main() {
  const argv = process.argv.slice(2);

  switch (argv[0]) {
    case "submit":
      process.exit(await cmdSubmit(argv.slice(1)));
    case "wait":
      process.exit(await cmdWait(argv.slice(1)));
    case "poll":
      process.exit(cmdPoll(argv.slice(1)));
    case "feedback":
      process.exit(cmdFeedback(argv.slice(1)));
    case "sessions":
      process.exit(cmdSessions(argv.slice(1)));
    case "stats":
      process.exit(cmdStats(argv.slice(1)));
    case "batch":
      process.exit(await cmdBatch(argv.slice(1)));
    case "distill":
      process.exit(await cmdDistill(argv.slice(1)));
    case "scout":
      process.exit(await cmdScout(argv.slice(1)));
  }

  const opts = parseArgs(argv);
  if (opts.prompt === "-") opts.prompt = await readStdin();
  if (opts.prompt !== undefined && !opts.prompt.trim()) {
    console.error("error: empty prompt");
    process.exit(1);
  }

  // --resume is one-shot only: it needs a follow-up prompt to append, and the
  // REPL has no session to resume into.
  if (opts.resumeFrom !== undefined && opts.prompt === undefined) {
    console.error("error: --resume requires a prompt (-p); it is one-shot only and not available in the REPL");
    process.exit(1);
  }

  if (opts.prompt !== undefined) {
    await runOneShot(opts);
  } else {
    await runRepl(opts);
  }
}

if (import.meta.main) main();
