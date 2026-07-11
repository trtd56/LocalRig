#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import { Agent } from "./agent.ts";
import { advise, AdviceConfigError, parseAdviceArgs, type AdviceResult } from "./advice.ts";
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
import { preprocessDiff } from "./diff.ts";
import { toPreprocessResult } from "./preprocess.ts";
import { estimateTokens } from "./context/tokens.ts";
import { OllamaClient } from "./provider/ollama.ts";
import {
  createBraveSearch,
  createSearxngSearch,
  fetchWebPage,
  research,
  ResearchConfigError,
  ResearchFetchError,
  ResearchModelError,
  type FetchedWebPage,
  type ResearchResult,
  type SearchResult,
  type WebSnapshot,
} from "./research.ts";
import { buildScoutSystemPrompt, buildSystemPrompt } from "./prompt/system.ts";
import { createScoutTools } from "./tools/registry.ts";
import {
  intersectWorkspaceScopes,
  prepareWorkspaceScope,
} from "./tools/path-boundary.ts";
import {
  captureWorkspaceSnapshot,
  changedFileScopeViolations,
  reportFromSnapshots,
} from "./workspace-snapshot.ts";
import { isBinary } from "./tools/read.ts";
import { createRenderer, c } from "./ui/render.ts";
import type { AgentEvent, ChatMessage, ChatRequestOptions, ErrorKind, RunReport, RunStatus, WorkspaceScope } from "./types.ts";
import { RunDeadline } from "./runtime/deadline.ts";
import { createMetricsCollector, type ModelTurnMetric } from "./metrics.ts";
import {
  applyArtifact,
  cleanupIsolation,
  finalizeIsolation,
  isolationMetadata,
  mapIsolationPath,
  prepareIsolation,
  validateIsolationSource,
} from "./isolation/worktree.ts";
import { IsolationError, type IsolationArtifact, type IsolationHandle, type IsolationSessionMetadata } from "./isolation/types.ts";
import {
  appendFeedback,
  type BatchStatus,
  type CheckRecord,
  computeStats,
  dataDir,
  latestSessionId,
  listSessionIds,
  loadSession,
  newSessionId,
  InvalidSessionIdError,
  readFeedback,
  ResumeError,
  restoreTranscript,
  runtimeMetricDimensions,
  saveSession,
  sessionTokens,
  SessionStoreError,
  validateSessionId,
  type CallerReceipt,
  type FeedbackOutcome,
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
                            fresh Agent context per task, shared cwd); per-task
                            status/check/report
  lh distill -q "question" [files...] [--json]
                            extract a citation-checked digest from large files
                            or stdin before sending it to an upstream agent
  lh scout -q "question" [--paths src/ lib/] [--json]
                            read-only repository scout: find relevant files and
                            return a citation-checked digest
  lh diff -q "question" [--staged] [--base REF] [--json]
                            summarize stdin or the cwd git diff with citations
                            verified against the immutable diff snapshot
  lh research -q "question" [URL...] [--json]
                            search and/or fetch direct HTTP(S) URLs, then return
                            a citation-checked digest backed by saved snapshots
  lh wait <id> [--timeout 1200] [--json]
                            wait for a submitted session to finish
  lh poll <id> [--json]     inspect a submitted session without blocking
  lh feedback <id> <pass|fail|accepted_as_is|accepted_after_resume|rejected>
                            [--notes "why"] [--source claude-code]
                            grade a past session (use --last for the newest)
  lh sessions [-n N]        list recent sessions with their feedback
  lh stats [--json] [--by-kind]
                            delegation pass rate from recorded feedback
  lh advise --task "work" [facts...] [--json]
                            choose direct/script/delegate/batch or a context
                            preprocessing route from task facts and track record

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
  --caller NAME             upstream caller/integration name (or LH_CALLER)
  --hardware ID             stable hardware profile id (or LH_HARDWARE)
  --integration-version V   caller integration version (or LH_INTEGRATION_VERSION)
  --allow-path PATH         narrow path-tool access and bash writes to PATH
                            (repeatable; cwd-relative; bash can still read cwd)
  --protect-path PATH       allow reads but reject modifications (repeatable)
  --worktree, --isolate     run in a private Git worktree and apply a verified
                            patch afterwards (default for one-shot/batch)
  --in-place                legacy mode: let the agent modify --cwd directly
  --resume ID               continue a saved session (one-shot only): restore
                            its transcript, append the prompt as a follow-up,
                            and resume the agent loop. Records resumed_from and
                            defaults --cwd to the original session's directory
  --auto                    use cwd/scope checks and the macOS bash sandbox
                            (the safe one-shot/batch default)
  --yolo                    explicitly allow unsandboxed host shell execution
                            (requires --in-place)
  -v, --verbose             verbose progress (tool output, token usage)

Batch flags:
  --tasks FILE|-            JSON manifest of tasks (- reads stdin). Shape:
                            {"tasks":[{"id","prompt","kind?","check?",
                            "check_retries?","allowed_paths?",
                            "protected_paths?"}]} (a bare [...] array also works).
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
Diff flags:
  -q, --query TEXT          required question about the diff
  --staged                  inspect the index instead of the working tree
  --base REF                compare REF to the working tree (safe argv, no shell)
  --budget TOKENS           target digest output budget (default: 2000)
  --think / --no-think      thinking is off by default; --think enables it
Research flags:
  -q, --query TEXT          required research question
  --search-provider NAME    auto, brave, or searxng (default: auto)
  --search-url URL          SearXNG base URL or search endpoint
  --max-results N           search candidates to retrieve (default: 8)
  --max-pages N             pages to fetch and inspect (default: 5)
  --budget TOKENS           target digest output budget (default: 2000)
  --think / --no-think      thinking is off by default; --think enables it
  --resume                  not supported; research runs synchronously
Advise flags:
  -p, --prompt, --task TEXT task to route (or supply one positional argument)
  --kind KIND               feedback kind used for the historical gate
  --files/--lines/--bytes N known input/target size
  --check / --no-check      whether an objective acceptance check exists
  --risk LEVEL              low, medium, high, or unknown
  --caller/--model/--hardware NAME
                            filter historical evidence by execution dimension
  --latency-budget SECONDS  maximum acceptable p90 duration
  --batch-candidates N      number of independent eligible tasks
  --web-sources N           number of Web sources needing semantic selection
  --scriptable              a deterministic script can perform the work
Stats flags:
  --model/--hardware/--caller NAME
                            filter outcomes by execution dimension

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
  caller?: string;
  hardware?: string;
  integrationVersion?: string;
  sessionId?: string;
  resumeFrom?: string;
  tasksFile?: string;
  distillQuery?: string;
  distillBudget: number;
  distillThink: boolean;
  scoutPaths: string[];
  noThink: boolean;
  staged: boolean;
  base?: string;
  searchProvider: string;
  searchUrl?: string;
  maxResults: number;
  maxPages: number;
  positionals: string[];
  allowedPaths: string[];
  protectedPaths: string[];
  /** Legacy direct mutation mode. Private worktree isolation is the default. */
  inPlace: boolean;
}

export class CliConfigError extends Error {
  readonly kind: ErrorKind = "config";
  constructor(message: string) {
    super(message);
    this.name = "CliConfigError";
  }
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
    staged: false,
    searchProvider: "auto",
    maxResults: 8,
    maxPages: 5,
    positionals: [],
    allowedPaths: [],
    protectedPaths: [],
    inPlace: false,
  };
  // Fields already pinned by an env var baked into defaultConfig at load time.
  // --model must not clobber these when it re-resolves a profile for the new
  // model; a CLI flag below adds to this set as it's parsed.
  const explicitProfileFields = new Set<ProfileField>(
    (Object.keys(PROFILE_FIELD_ENV) as ProfileField[]).filter((f) => process.env[PROFILE_FIELD_ENV[f]] !== undefined),
  );
  let permissionFlag: "auto" | "yolo" | undefined;
  let isolationFlag: "worktree" | "in_place" | undefined;
  const fail = (message: string): never => { throw new CliConfigError(message); };
  const valueAfter = (index: number, flag: string, allowDash = false): string => {
    const value = argv[index + 1];
    if (value === undefined || (!allowDash && value.startsWith("-") && value !== "-")) fail(`${flag} requires a value`);
    return value!;
  };
  const numberAfter = (index: number, flag: string, options: { integer?: boolean; min?: number } = {}): number => {
    const raw = valueAfter(index, flag, true);
    const value = Number(raw);
    if (!Number.isFinite(value)) fail(`${flag} must be a finite number`);
    if (options.integer && !Number.isInteger(value)) fail(`${flag} must be an integer`);
    if (options.min !== undefined && value < options.min) fail(`${flag} must be >= ${options.min}`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-p":
      case "--print":
        opts.prompt = valueAfter(i, a);
        i++;
        break;
      case "--model":
        config.model = valueAfter(i, a);
        i++;
        applyProfile(config, config.model, explicitProfileFields);
        break;
      case "--num-ctx":
        config.numCtx = numberAfter(i, a, { integer: true, min: 1 });
        i++;
        break;
      case "--num-predict":
        config.numPredict = numberAfter(i, a, { integer: true, min: 1 });
        i++;
        break;
      case "--temperature":
        config.temperature = numberAfter(i, a, { min: 0 });
        i++;
        explicitProfileFields.add("temperature");
        break;
      case "--presence-penalty":
        config.presencePenalty = numberAfter(i, a);
        i++;
        explicitProfileFields.add("presencePenalty");
        break;
      case "--max-iterations":
        config.maxIterations = numberAfter(i, a, { integer: true, min: 0 });
        i++;
        opts.maxIterationsSet = true;
        break;
      case "--max-time":
        config.maxTimeMs = numberAfter(i, a, { min: 0 }) * 1000;
        i++;
        opts.maxTimeSet = true;
        break;
      case "--think-budget":
        config.thinkBudgetChars = numberAfter(i, a, { integer: true, min: 0 });
        i++;
        explicitProfileFields.add("thinkBudgetChars");
        break;
      case "--headroom":
        config.headroomTokens = numberAfter(i, a, { integer: true, min: 0 });
        i++;
        break;
      case "--cwd":
        opts.cwd = valueAfter(i, a);
        i++;
        break;
      case "--check":
        opts.checkCommand = valueAfter(i, a);
        i++;
        break;
      case "--check-retries":
        opts.checkRetries = numberAfter(i, a, { integer: true, min: 0 });
        i++;
        break;
      case "--kind":
        opts.kind = valueAfter(i, a);
        i++;
        break;
      case "--caller":
        opts.caller = valueAfter(i, a);
        i++;
        break;
      case "--hardware":
        opts.hardware = valueAfter(i, a);
        i++;
        break;
      case "--integration-version":
        opts.integrationVersion = valueAfter(i, a);
        i++;
        break;
      case "--session-id":
        opts.sessionId = validateSessionId(valueAfter(i, a));
        i++;
        break;
      case "--resume":
        opts.resumeFrom = validateSessionId(valueAfter(i, a));
        i++;
        break;
      case "--tasks":
        opts.tasksFile = valueAfter(i, a);
        i++;
        break;
      case "-q":
      case "--query":
        opts.distillQuery = valueAfter(i, a);
        i++;
        break;
      case "--budget":
        opts.distillBudget = numberAfter(i, a, { integer: true, min: 1 });
        i++;
        break;
      case "--think":
        opts.distillThink = true;
        break;
      case "--no-think":
        opts.noThink = true;
        break;
      case "--staged":
        opts.staged = true;
        break;
      case "--base":
        opts.base = valueAfter(i, a);
        i++;
        break;
      case "--search-provider":
        opts.searchProvider = valueAfter(i, a);
        i++;
        break;
      case "--search-url":
        opts.searchUrl = valueAfter(i, a);
        i++;
        break;
      case "--max-results":
        opts.maxResults = numberAfter(i, a, { integer: true, min: 1 });
        i++;
        break;
      case "--max-pages":
        opts.maxPages = numberAfter(i, a, { integer: true, min: 1 });
        i++;
        break;
      case "--paths":
        if (argv[i + 1] === undefined || argv[i + 1]!.startsWith("-")) fail("--paths requires at least one path");
        while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) {
          opts.scoutPaths.push(argv[++i]!);
        }
        break;
      case "--allow-path":
      case "--allowed-path":
        opts.allowedPaths.push(valueAfter(i, a));
        i++;
        break;
      case "--protect-path":
      case "--protected-path":
        opts.protectedPaths.push(valueAfter(i, a));
        i++;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--auto":
        if (permissionFlag && permissionFlag !== "auto") fail("--auto and --yolo are mutually exclusive");
        permissionFlag = "auto";
        config.permissionMode = "auto";
        opts.permissionModeSet = true;
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        if (permissionFlag && permissionFlag !== "yolo") fail("--auto and --yolo are mutually exclusive");
        permissionFlag = "yolo";
        config.permissionMode = "yolo";
        opts.permissionModeSet = true;
        break;
      case "--in-place":
        if (isolationFlag && isolationFlag !== "in_place") fail("--in-place and --worktree/--isolate are mutually exclusive");
        isolationFlag = "in_place";
        opts.inPlace = true;
        break;
      case "--worktree":
      case "--isolate":
        if (isolationFlag && isolationFlag !== "worktree") fail("--in-place and --worktree/--isolate are mutually exclusive");
        isolationFlag = "worktree";
        opts.inPlace = false;
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
        if (a.startsWith("-")) fail(`unknown option: ${a}`);
        opts.positionals.push(a);
        break;
    }
  }
  const requireFinite = (value: number, name: string, options: { integer?: boolean; min?: number; max?: number } = {}) => {
    if (!Number.isFinite(value)) fail(`${name} must be a finite number`);
    if (options.integer && !Number.isInteger(value)) fail(`${name} must be an integer`);
    if (options.min !== undefined && value < options.min) fail(`${name} must be >= ${options.min}`);
    if (options.max !== undefined && value > options.max) fail(`${name} must be <= ${options.max}`);
  };
  if (!config.model.trim()) fail("--model must not be empty");
  requireFinite(config.numCtx, "--num-ctx", { integer: true, min: 1 });
  requireFinite(config.numPredict, "--num-predict", { integer: true, min: 1 });
  requireFinite(config.temperature, "--temperature", { min: 0 });
  requireFinite(config.topP, "top_p configuration", { min: 0, max: 1 });
  requireFinite(config.topK, "top_k configuration", { integer: true, min: 1 });
  requireFinite(config.presencePenalty, "--presence-penalty");
  requireFinite(config.maxIterations, "--max-iterations", { integer: true, min: 0 });
  requireFinite(config.maxTimeMs, "--max-time", { min: 0 });
  requireFinite(config.thinkBudgetChars, "--think-budget", { integer: true, min: 0 });
  requireFinite(config.headroomTokens, "--headroom", { integer: true, min: 0 });
  if (opts.distillThink && opts.noThink) fail("--think and --no-think are mutually exclusive");
  return opts;
}

async function readStdin(signal?: AbortSignal): Promise<string> {
  return (await readStdinRaw(signal)).trim();
}

async function readStdinRaw(signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  const onAbort = () => process.stdin.destroy(
    signal?.reason instanceof Error ? signal.reason : new DOMException("Input interrupted", "AbortError"),
  );
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of process.stdin) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Input interrupted", "AbortError");
      chunks.push(chunk as Buffer);
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException("Input interrupted", "AbortError");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------- subcommands ----------

export function cmdFeedback(argv: string[]): number {
  let id: string | undefined;
  let json = false;
  let taskId: string | undefined;
  let outcome: FeedbackOutcome | undefined;
  let notes: string | undefined;
  let source: string | undefined;
  let failureCode: string | undefined;
  let reworkMs: number | undefined;
  let hardware: string | undefined;
  const receipt: CallerReceipt = {};
  const required = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) throw new CliConfigError(`${flag} requires a value`);
    return value;
  };
  const numberRequired = (i: number, flag: string): number => {
    const value = Number(required(i, flag));
    if (!Number.isFinite(value) || value < 0) throw new CliConfigError(`${flag} must be a finite number >= 0`);
    return value;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--json") json = true;
      else if (a === "--last") id = latestSessionId() ?? undefined;
      else if (a === "--task") { taskId = required(i, a); i++; }
      else if (a === "--notes") { notes = required(i, a); i++; }
      else if (a === "--source") { source = required(i, a); i++; }
      else if (a === "--failure-code") { failureCode = required(i, a); i++; }
      else if (a === "--rework-ms") { reworkMs = numberRequired(i, a); i++; }
      else if (a === "--hardware") { hardware = required(i, a); i++; }
      else if (a === "--caller-input-tokens") { receipt.inputTokens = numberRequired(i, a); i++; }
      else if (a === "--caller-output-tokens") { receipt.outputTokens = numberRequired(i, a); i++; }
      else if (a === "--caller-cache-read-tokens") { receipt.cacheReadTokens = numberRequired(i, a); i++; }
      else if (a === "--caller-cache-write-tokens") { receipt.cacheWriteTokens = numberRequired(i, a); i++; }
      else if (a === "--caller-cost-usd") { receipt.costUsd = numberRequired(i, a); i++; }
      else if (["pass", "fail", "accepted_as_is", "accepted_after_resume", "rejected"].includes(a)) {
        if (outcome) throw new CliConfigError("feedback accepts exactly one outcome");
        outcome = a === "pass" || a === "accepted_as_is"
          ? "accepted_as_is"
          : a === "fail" || a === "rejected"
            ? "rejected"
            : "accepted_after_resume";
      }
      else if (!a.startsWith("-") && id === undefined) id = a;
      else throw new CliConfigError(a.startsWith("-") ? `unknown feedback option: ${a}` : `unexpected feedback argument: ${a}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json || argv.includes("--json")) {
      console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
  if (id !== undefined) {
    try {
      id = validateSessionId(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
      else console.error(`error: ${message}`);
      return 1;
    }
  }
  if (!id || !outcome) {
    const usage = 'usage: lh feedback <session-id|--last> [--task <id>] <pass|fail|accepted_as_is|accepted_after_resume|rejected> [--notes "why"] [--source name]';
    if (json) console.log(JSON.stringify({ status: "error", error: usage, error_kind: "config" satisfies ErrorKind }));
    else console.error(usage);
    return 1;
  }
  let session: SessionRecord | null;
  try {
    session = loadSession(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    else console.error(`error: ${message}`);
    return 1;
  }
  if (!session) {
    const message = `unknown session: ${id} (see \`lh sessions\`)`;
    if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    else console.error(message);
    return 1;
  }
  const createdAt = new Date().toISOString();
  const callerReceipt = Object.keys(receipt).length > 0 ? receipt : undefined;
  const dimensions = {
    ...session.dimensions,
    model: session.model,
    hardware: session.dimensions?.hardware ?? hardware ?? process.env.LH_HARDWARE,
    caller: session.dimensions?.caller ?? source,
  };
  const common = { outcome, notes, source, failureCode, reworkMs, callerReceipt, dimensions, createdAt };
  const label = outcome === "accepted_as_is" ? "pass" : outcome === "rejected" ? "fail" : outcome;

  // --task grades a single task of a batch session with that task's own kind.
  if (taskId !== undefined) {
    const task = session.tasks?.find((t) => t.id === taskId);
    if (!task) {
      const message = `unknown task id: ${taskId} in session ${id} (see its tasks with \`lh poll ${id} --json\`)`;
      if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
      else console.error(message);
      return 1;
    }
    appendFeedback({ sessionId: id, taskId, kind: task.kind, ...common });
    if (json) console.log(JSON.stringify({ status: "recorded", session_id: id, task_id: taskId, outcome }));
    else console.log(`recorded: ${id} --task ${taskId} ${label}${notes ? ` — ${notes}` : ""}`);
    return 0;
  }

  // A bare verdict on a batch session fans out to every task, each carrying its
  // own kind, so by-kind stats stay accurate.
  if (session.tasks && session.tasks.length > 0) {
    for (const task of session.tasks) {
      appendFeedback({ sessionId: id, taskId: task.id, kind: task.kind, ...common });
    }
    if (json) console.log(JSON.stringify({ status: "recorded", session_id: id, outcome, tasks: session.tasks.length }));
    else console.log(`recorded: ${id} ${label} — fanned out to ${session.tasks.length} tasks${notes ? ` — ${notes}` : ""}`);
    return 0;
  }

  appendFeedback({ sessionId: id, kind: session.kind, ...common });
  if (json) console.log(JSON.stringify({ status: "recorded", session_id: id, outcome }));
  else console.log(`recorded: ${id} ${label}${notes ? ` — ${notes}` : ""}`);
  return 0;
}

function cmdSessions(argv: string[]): number {
  let n = 10;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-n") {
      console.error(`error: unknown sessions option: ${argv[i]}`);
      return 1;
    }
    const raw = argv[++i];
    n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n < 1) {
      console.error("error: -n requires an integer >= 1");
      return 1;
    }
  }
  const verdicts = new Map<string, string>();
  for (const fb of readFeedback()) verdicts.set(fb.sessionId, fb.verdict ?? "");
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

export function cmdStats(argv: string[]): number {
  let byKind = false;
  let json = false;
  let model: string | undefined;
  let hardware: string | undefined;
  let caller: string | undefined;
  let error: string | undefined;
  const valueAfter = (index: number, flag: string): string | undefined => {
    const value = argv[index + 1];
    if (value === undefined || !value.trim() || value.startsWith("-")) {
      error = `${flag} requires a value`;
      return undefined;
    }
    return value;
  };
  for (let i = 0; i < argv.length && error === undefined; i++) {
    const flag = argv[i]!;
    if (flag === "--by-kind") byKind = true;
    else if (flag === "--json") json = true;
    else if (flag === "--model" || flag === "--hardware" || flag === "--caller") {
      const value = valueAfter(i, flag);
      if (value === undefined) break;
      if (flag === "--model") model = value;
      else if (flag === "--hardware") hardware = value;
      else caller = value;
      i++;
    } else {
      error = `unknown stats option: ${flag}`;
    }
  }
  if (error) {
    if (json || argv.includes("--json")) console.log(JSON.stringify({ status: "error", error, error_kind: "config" }));
    else console.error(`error: ${error}`);
    return 1;
  }
  const stats = computeStats({ byKind, model, hardware, caller });
  if (json) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  if (stats.filters) {
    const filterText = Object.entries(stats.filters).map(([key, value]) => `${key}=${value}`).join(", ");
    console.log(`filters:  ${filterText}`);
  }
  console.log(`sessions: ${stats.sessions}`);
  console.log(
    `dimensions: matched ${stats.dimensionCoverage.matched}, unknown ${stats.dimensionCoverage.unknown}, ` +
      `excluded ${stats.dimensionCoverage.excluded} (${stats.dimensionCoverage.rate ?? 0}% known-match coverage)`,
  );
  console.log(
    `graded:   ${stats.graded}/${stats.gradable} (${stats.coverageRate ?? 0}% coverage; pass ${stats.pass} / fail ${stats.fail}, ` +
      `${stats.rate ?? 0}% pass, 95% lower bound ${stats.successLowerBound ?? 0}%; rework ${stats.reworkRate ?? 0}%)`,
  );
  if (stats.p50DurationMs !== null) {
    console.log(`duration: p50 ${Math.round(stats.p50DurationMs / 1000)}s / p90 ${Math.round((stats.p90DurationMs ?? 0) / 1000)}s`);
  }
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
        `  ${k.kind.padEnd(12)} ${k.graded}/${k.gradable} graded (${k.coverageRate ?? 0}% coverage, ` +
          `${k.dimensionCoverage.unknown} dimension-unknown), pass ${k.pass} / fail ${k.fail}, ${k.rate ?? 0}% pass ` +
          `(lower ${k.successLowerBound ?? 0}%), rework ${k.reworkRate ?? 0}%, p50/p90 ` +
          `${Math.round(k.p50DurationMs / 1000)}s/${Math.round(k.p90DurationMs / 1000)}s, gate ${k.gate.status}`,
      );
    }
  }
  return 0;
}

function printAdvice(result: AdviceResult): void {
  console.log(`route:      ${result.route}`);
  console.log(`local LLM:  ${result.recommended ? "recommended" : "not recommended"}`);
  console.log(`confidence: ${Math.round(result.confidence * 100)}%`);
  console.log(
    `evidence:   n=${result.sample_size}, lower=${result.estimated_success_lower_bound ?? "n/a"}%, ` +
      `p50/p90=${result.p50_ms ?? "n/a"}/${result.p90_ms ?? "n/a"}ms, gate=${result.gate.status}`,
  );
  console.log(
    `dimensions: matched=${result.dimension_matched}, unknown=${result.dimension_unknown}, ` +
      `excluded=${result.dimension_excluded}, coverage=${result.dimension_coverage_rate ?? "n/a"}%`,
  );
  for (const reason of result.reasons) console.log(`reason:     ${reason}`);
}

export function cmdAdvise(argv: string[]): number {
  const jsonRequested = argv.includes("--json");
  try {
    const parsed = parseAdviceArgs(argv);
    const currentDimensions = runtimeMetricDimensions({
      model: parsed.input.model ?? defaultConfig.model,
      hardware: parsed.input.hardware,
      caller: parsed.input.caller,
    });
    const input = {
      ...parsed.input,
      model: parsed.input.model ?? defaultConfig.model,
      hardware: currentDimensions.hardware,
      caller: currentDimensions.caller,
    };
    const stats = computeStats({
      byKind: true,
      model: input.model,
      hardware: input.hardware,
      caller: input.caller,
    });
    const result = advise(input, stats);
    if (parsed.json) console.log(JSON.stringify(result));
    else printAdvice(result);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorKind: ErrorKind = err instanceof AdviceConfigError ? "config" : "internal";
    if (jsonRequested) console.log(JSON.stringify({ status: "error", error: message, error_kind: errorKind }));
    else console.error(`error: ${message}`);
    return 1;
  }
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
    durations: task.durations,
    check: task.check,
    ...reportForJson(task.report),
  };
}

/** Batch `--json`: the task-oriented view (distinct from a one-shot session). */
function batchForJson(record: SessionRecord) {
  return {
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    model: record.model,
    dimensions: record.dimensions,
    cwd: record.cwd,
    isolation: record.isolation,
    tasks: (record.tasks ?? []).map(taskForJson),
    model_turns: record.modelTurns,
    tokens: record.tokens,
    feedback_command: `lh feedback ${record.id} --task <id> <pass|fail> --notes "<verified how / what went wrong>"`,
  };
}

function sessionForJson(record: SessionRecord) {
  return {
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    result: record.result,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    turns: record.turns,
    tool_calls: record.toolCalls,
    tokens: record.tokens,
    model: record.model,
    dimensions: record.dimensions,
    cwd: record.cwd,
    isolation: record.isolation,
    kind: record.kind,
    resumed_from: record.resumedFrom,
    pid: record.pid,
    check: record.check,
    report: reportForJson(record.report),
    tasks: record.tasks ? record.tasks.map(taskForJson) : undefined,
    model_turns: record.modelTurns,
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
  const errorKind: ErrorKind = err instanceof ResumeError || err instanceof InvalidSessionIdError ? "config" : "internal";
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

function executionDimensions(opts: CliOptions) {
  return runtimeMetricDimensions({
    model: opts.config.model,
    hardware: opts.hardware,
    caller: opts.caller,
    integrationVersion: opts.integrationVersion,
  });
}

function rewritePathStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((entry) => rewritePathStrings(entry, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewritePathStrings(entry, from, to)]),
    );
  }
  return value;
}

function rewriteRestoredIsolationPaths(messages: ChatMessage[], from: string, to: string): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.replaceAll(from, to),
    thinking: message.thinking?.replaceAll(from, to),
    _filePath: message._filePath?.replaceAll(from, to),
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: rewritePathStrings(call.function.arguments, from, to) as Record<string, unknown> | string,
      },
    })),
  }));
}

async function runOneShot(opts: CliOptions): Promise<never> {
  const { config } = opts;
  const dimensions = executionDimensions(opts);
  const started = Date.now();
  const originalMaxTimeMs = config.maxTimeMs;
  const deadline = new RunDeadline(originalMaxTimeMs, Date.now, undefined, started);
  const onSigint = () => {
    deadline.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  process.on("SIGINT", onSigint);

  // --resume: restore a saved session's transcript to seed this run. Replay in
  // the original session's cwd (so file paths in the transcript still resolve)
  // unless the caller overrode --cwd.
  let restored: ChatMessage[] | undefined;
  let resumedFrom: string | undefined;
  let resumedRecord: SessionRecord | undefined;
  let baseCwd = opts.cwd;
  if (opts.resumeFrom !== undefined) {
    try {
      const resumeId = validateSessionId(opts.resumeFrom);
      const original = loadSession(resumeId);
      restored = restoreTranscript(resumeId, original);
      resumedRecord = original ?? undefined;
      resumedFrom = resumeId;
      baseCwd = opts.cwd ?? original!.cwd;
    } catch (err) {
      return failResume(opts, err);
    }
  }
  const logicalCwd = path.resolve(baseCwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  let inputStopped = false;
  if (opts.prompt === "-") {
    try {
      opts.prompt = await readStdin(deadline.signal);
    } catch (err) {
      if (!deadline.cause) throw err;
      inputStopped = true;
      opts.prompt = "";
    }
  }
  if (!opts.inPlace && config.permissionMode === "yolo") {
    const message = "--yolo cannot be combined with private worktree isolation; add --in-place to accept direct host access";
    if (opts.json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" }));
    else process.stderr.write(c.red(`error: ${message}`) + "\n");
    process.off("SIGINT", onSigint);
    deadline.dispose();
    process.exit(1);
  }
  let isolationHandle: IsolationHandle | undefined;
  let isolation: IsolationSessionMetadata = { mode: opts.inPlace ? "in_place" : "worktree", source_cwd: logicalCwd };
  let cwd = logicalCwd;
  try {
    if (!opts.inPlace && !inputStopped) {
      const previousIsolation = resumedRecord?.isolation;
      const replayRequired = previousIsolation?.mode === "worktree" &&
        !["applied", "not_needed"].includes(previousIsolation.apply_status ?? "pending");
      if (replayRequired && !previousIsolation.patch_path) {
        throw new IsolationError(
          `session ${resumedFrom} has unapplied isolated work but no retained patch`,
          "conflict",
        );
      }
      if (previousIsolation?.mode === "worktree" && !previousIsolation.worktree_path) {
        throw new IsolationError(`session ${resumedFrom} is missing its private worktree path metadata`, "conflict");
      }
      const previousPatch = replayRequired ? previousIsolation.patch_path : undefined;
      if (previousPatch && !fs.existsSync(previousPatch)) {
        throw new IsolationError(`resume patch is missing: ${previousPatch}`, "conflict");
      }
      if (previousPatch && (!resumedRecord?.isolation?.patch_sha256 || !resumedRecord.isolation.baseline_tree)) {
        throw new IsolationError("resume patch metadata is incomplete (SHA-256 or baseline tree missing)", "conflict");
      }
      if (previousPatch && (
        !resumedRecord?.isolation?.baseline_fingerprint ||
        !resumedRecord.isolation.final_content_digest ||
        resumedRecord.isolation.final_modes === undefined ||
        !resumedRecord.isolation.final_modes_sha256
      )) {
        throw new IsolationError("resume patch metadata is incomplete (fingerprint or final modes missing)", "conflict");
      }
      if (previousPatch && resumedRecord?.isolation?.source_cwd) {
        const previousSource = fs.realpathSync(resumedRecord.isolation.source_cwd);
        const currentSource = fs.realpathSync(logicalCwd);
        if (previousSource !== currentSource) {
          throw new IsolationError(
            `resume patch belongs to ${previousSource}, not ${currentSource}`,
            "conflict",
          );
        }
      }
      isolationHandle = await prepareIsolation({
        sourceCwd: logicalCwd,
        sessionId,
        seedPatchPath: previousPatch,
        seedPatchSha256: previousPatch ? resumedRecord?.isolation?.patch_sha256 : undefined,
        seedBaselineTree: previousPatch ? resumedRecord?.isolation?.baseline_tree : undefined,
        seedBaselineFingerprint: previousPatch ? resumedRecord?.isolation?.baseline_fingerprint : undefined,
        seedFinalContentDigest: previousPatch ? resumedRecord?.isolation?.final_content_digest : undefined,
        seedFinalModes: previousPatch ? resumedRecord?.isolation?.final_modes : undefined,
        seedFinalModesSha256: previousPatch ? resumedRecord?.isolation?.final_modes_sha256 : undefined,
      });
      cwd = isolationHandle.executionCwd;
      isolation = isolationMetadata(isolationHandle);
      if (restored && restored.length > 0) {
        const previousRoot = resumedRecord?.isolation?.worktree_path;
        restored = previousRoot
          ? rewriteRestoredIsolationPaths(restored, previousRoot, isolationHandle.worktreeRoot)
          : rewriteRestoredIsolationPaths(restored, resumedRecord?.cwd ?? logicalCwd, cwd);
        restored = restored.map((message, index) => index === 0 && message.role === "system"
          ? { ...message, content: buildSystemPrompt(cwd, config) }
          : message);
      }
    }
  } catch (err) {
    const message = `worktree isolation failed: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.json) console.log(JSON.stringify({ status: "error", error: message, error_kind: err instanceof IsolationError && err.code === "conflict" ? "conflict" : "config" }));
    else process.stderr.write(c.red(`error: ${message}`) + "\n");
    process.off("SIGINT", onSigint);
    deadline.dispose();
    process.exit(1);
  }
  let scope: WorkspaceScope;
  try {
    const allowedPaths = isolationHandle ? opts.allowedPaths.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : opts.allowedPaths;
    const protectedPaths = isolationHandle ? opts.protectedPaths.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : opts.protectedPaths;
    scope = prepareWorkspaceScope(cwd, { allowedPaths, protectedPaths });
    if (isolationHandle) {
      scope.privateGitPaths = [isolationHandle.gitDir, path.join(isolationHandle.worktreeRoot, ".git")];
    }
  } catch (err) {
    const message = `invalid workspace scope: ${err instanceof Error ? err.message : String(err)}`;
    if (isolationHandle) await cleanupIsolation(isolationHandle);
    if (opts.json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    else process.stderr.write(c.red(`error: ${message}`) + "\n");
    process.exit(1);
  }
  const checkRetries = Number.isFinite(opts.checkRetries) && opts.checkRetries >= 0 ? Math.floor(opts.checkRetries) : 2;
  // One-shot cannot prompt, so its implicit mode must be the mechanically
  // constrained one. Unrestricted host execution requires explicit --yolo.
  if (!opts.permissionModeSet) config.permissionMode = "auto";
  const denyPermission = async () => false;

  if (!inputStopped && (opts.prompt === undefined || !opts.prompt.trim())) {
    if (isolationHandle) await cleanupIsolation(isolationHandle);
    process.off("SIGINT", onSigint);
    deadline.dispose();
    if (opts.json) console.log(JSON.stringify({ status: "error", error: "empty prompt", error_kind: "config" }));
    else process.stderr.write(c.red("error: empty prompt") + "\n");
    process.exit(1);
  }

  const showProgress = opts.json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  let checkMs = 0;
  const metrics = createMetricsCollector();
  const onEvent = (e: AgentEvent) => {
    metrics.collect(e);
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptLastTokens = e.promptTokens;
      promptTotalTokens += e.promptTokens;
      completionTokens += e.evalTokens;
    }
    progress?.(e);
  };

  let beforeSnapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined;
  if (!deadline.signal.aborted) {
    try {
      beforeSnapshot = await captureWorkspaceSnapshot(cwd, deadline.signal);
    } catch (snapshotErr) {
      if (!deadline.cause) {
        const message = `workspace change audit failed before run: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`;
        if (isolationHandle) await cleanupIsolation(isolationHandle);
        if (opts.json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "internal" satisfies ErrorKind }));
        else process.stderr.write(c.red(`error: ${message}`) + "\n");
        process.off("SIGINT", onSigint);
        deadline.dispose();
        process.exit(1);
      }
      inputStopped = true;
    }
  }
  const agent = new Agent(config, cwd, onEvent, denyPermission, undefined, undefined, undefined, scope, deadline);
  if (restored) agent.restore(restored);

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  let check: CheckRecord | undefined;
  let report: RunReport = { changedFiles: [], commandsRun: [] };
  try {
    if (inputStopped || deadline.signal.aborted) {
      status = deadline.timedOut ? "timeout" : "interrupted";
      result = status === "timeout" ? "[stopped: reached time budget]" : "[interrupted]";
    } else {
      result = await agent.run(opts.prompt!);
      status = agent.lastRunStatus;
    }
    if (opts.checkCommand && status === "ok") {
      for (let attempt = 1; ; attempt++) {
        const checkStarted = Date.now();
        check = await runCheckCommand({
          command: opts.checkCommand,
          cwd,
          timeoutMs: config.bashTimeoutMs,
          attempts: attempt,
          signal: deadline.signal,
          deadlineAt: deadline.deadlineAt,
          sandbox: config.permissionMode !== "yolo",
          scope,
        });
        checkMs += Date.now() - checkStarted;
        if (deadline.cause) {
          status = deadline.timedOut ? "timeout" : "interrupted";
          break;
        }
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
        result = await agent.run(buildCheckRepairPrompt(check));
        status = agent.lastRunStatus;
        if (status !== "ok") break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (deadline.cause) {
      status = deadline.timedOut ? "timeout" : "interrupted";
      error = undefined;
      errorKind = undefined;
    } else {
      errorKind = classifyError(error);
    }
  }
  try {
    if (!beforeSnapshot) throw deadline.signal.reason ?? new Error("before snapshot unavailable");
    const afterSnapshot = await captureWorkspaceSnapshot(cwd, deadline.signal);
    report = reportFromSnapshots(beforeSnapshot, afterSnapshot, agent.getReport());
    if (deadline.cause) {
      status = deadline.timedOut ? "timeout" : "interrupted";
      error = undefined;
      errorKind = undefined;
    }
    const violations = changedFileScopeViolations(scope, report);
    if (violations.length > 0) {
      if (status !== "timeout" && status !== "interrupted") {
        status = "error";
        errorKind = "config";
        error = `workspace scope violation: ${violations.join("; ")}`;
      }
    }
  } catch (snapshotErr) {
    report = agent.getReport();
    if (deadline.cause) {
      status = deadline.timedOut ? "timeout" : "interrupted";
      error = undefined;
      errorKind = undefined;
    } else if (status !== "timeout" && status !== "interrupted") {
      status = "error";
      errorKind = "internal";
      error = `workspace change audit failed: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`;
    }
  }
  if (deadline.cause) {
    status = deadline.timedOut ? "timeout" : "interrupted";
    error = undefined;
    errorKind = undefined;
  }
  // Stop the wall-clock timer, but keep the SIGINT handler installed through
  // isolation finalization/apply/cleanup. Otherwise Node's default SIGINT
  // action can terminate the process in the middle of a parent mutation.
  deadline.dispose();
  if (isolationHandle) {
    try {
      const artifact = await finalizeIsolation(isolationHandle, { timeoutMs: 30_000 });
      if (deadline.cause) {
        status = deadline.timedOut ? "timeout" : "interrupted";
        error = undefined;
        errorKind = undefined;
      }
      const prefix = isolationHandle.cwdRelative.split(path.sep).join("/");
      const outside = artifact.changedRepoPaths.filter((repoPath) => {
        if (!prefix) return false;
        const rel = path.posix.relative(prefix, repoPath);
        return rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel);
      });
      if (outside.length > 0 && status !== "timeout" && status !== "interrupted") {
        status = "error";
        errorKind = "config";
        error = `workspace scope violation outside cwd: ${outside.join(", ")}`;
      }
      if (status === "ok") {
        const applied = await applyArtifact(isolationHandle, artifact, { signal: deadline.signal });
        if (deadline.cause) {
          status = deadline.timedOut ? "timeout" : "interrupted";
          error = undefined;
          errorKind = undefined;
        } else if (applied !== "applied") {
          status = "error";
          errorKind = applied === "conflict" ? "conflict" : "internal";
          error = artifact.conflict ?? `isolated patch ${applied}`;
        }
      } else if (artifact.applyStatus === "pending") {
        artifact.applyStatus = "retained";
      }
      await cleanupIsolation(isolationHandle, artifact);
      isolation = isolationMetadata(artifact);
      if (deadline.cause) {
        status = deadline.timedOut ? "timeout" : "interrupted";
        error = undefined;
        errorKind = undefined;
      }
    } catch (finalizeErr) {
      // spawnSync Git can return before Node dispatches a queued OS SIGINT.
      // Keep the listener installed for one event-loop turn before classifying.
      await new Promise<void>((resolve) => setImmediate(resolve));
      isolation = { ...isolationMetadata(isolationHandle), cleanup_status: "retained", worktree_path: isolationHandle.worktreeRoot };
      if (deadline.cause) {
        status = deadline.timedOut ? "timeout" : "interrupted";
        error = undefined;
        errorKind = undefined;
      } else if (status !== "timeout" && status !== "interrupted") {
        status = "error";
        errorKind = "internal";
        error = `isolation finalization failed; worktree retained at ${isolationHandle.worktreeRoot}: ${finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)}`;
      }
    }
  }
  process.off("SIGINT", onSigint);
  deadline.dispose();
  const durationMs = Date.now() - started;

  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd: logicalCwd,
    model: config.model,
    dimensions,
    prompt: opts.prompt ?? "",
    kind: opts.kind,
    status,
    result,
    error,
    errorKind,
    durationMs,
    durations: {
      total_ms: durationMs,
      model_ms: metrics.totals.modelMs,
      tool_ms: metrics.totals.toolMs,
      check_ms: checkMs,
      ttft_ms: metrics.totals.ttftMs,
      model_prompt_eval_ms: metrics.totals.promptEvalMs,
      model_eval_ms: metrics.totals.evalMs,
      load_ms: metrics.totals.loadMs,
    },
    modelTurns: metrics.modelTurns,
    turns,
    toolCalls,
    tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
    check,
    report,
    messages: agent.getMessages(),
    resumedFrom,
    isolation,
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

function emitBatchStopped(json: boolean, deadline: RunDeadline): number {
  const status: RunStatus = deadline.timedOut ? "timeout" : "interrupted";
  const message = status === "timeout" ? "batch time budget reached while reading input" : "batch interrupted";
  if (json) console.log(JSON.stringify({ status, error: message }));
  else process.stderr.write(c.yellow(message) + "\n");
  return statusExitCode(status);
}

function summarizeTasks(executions: TaskExecution[]): string {
  const counts = new Map<string, number>();
  for (const e of executions) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`);
  return `${executions.length} task${executions.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function toTaskRecords(executions: TaskExecution[], modelTurns: ModelTurnMetric[] = []): TaskRecord[] {
  return executions.map((e) => ({
    id: e.task.id,
    kind: e.task.kind,
    status: e.status,
    durationMs: e.durationMs,
    turns: e.turns,
    check: e.check,
    report: e.report,
    durations: taskDurations(e.durationMs, modelTurns.filter((turn) => turn.task_id === e.task.id)),
  }));
}

function taskDurations(totalMs: number, turns: ModelTurnMetric[]): SessionRecord["durations"] {
  const sum = (key: "duration_ms" | "load_ms" | "prompt_eval_ms" | "eval_ms") =>
    turns.reduce((total, turn) => total + (turn[key] ?? 0), 0);
  return {
    total_ms: totalMs,
    model_ms: sum("duration_ms"),
    ttft_ms: turns.find((turn) => turn.ttft_ms !== undefined)?.ttft_ms,
    load_ms: sum("load_ms"),
    model_prompt_eval_ms: sum("prompt_eval_ms"),
    model_eval_ms: sum("eval_ms"),
  };
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
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return emitBatchConfigError(argv.includes("--json"), err instanceof Error ? err.message : String(err));
  }
  const json = opts.json;
  const dimensions = executionDimensions(opts);
  const now = deps?.now ?? Date.now;
  const started = now();

  // Batch is synchronous and self-contained: no detached/resume variants (v1).
  if (opts.resumeFrom !== undefined) {
    return emitBatchConfigError(json, "batch does not support --resume (a batch session cannot be resumed in v1)");
  }
  if (!opts.tasksFile) {
    return emitBatchConfigError(json, "batch requires --tasks <file|->");
  }

  // Start the budget before manifest/stdin acquisition. A default per-task
  // budget is used as the provisional input-acquisition cap; after the task
  // count is known we expand the same deadline to the total batch budget while
  // retaining `started` as the epoch.
  const deadline = new RunDeadline(opts.config.maxTimeMs, now, undefined, started);

  let manifestText: string;
  try {
    manifestText = opts.tasksFile === "-"
      ? await readStdin(deadline.signal)
      : fs.readFileSync(path.resolve(opts.tasksFile), "utf8");
    deadline.remainingMs();
  } catch (err) {
    if (deadline.cause) {
      const code = emitBatchStopped(json, deadline);
      deadline.dispose();
      return code;
    }
    deadline.dispose();
    return emitBatchConfigError(json, `cannot read manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tasks: BatchTask[];
  try {
    tasks = parseManifest(manifestText);
  } catch (err) {
    if (err instanceof BatchConfigError) {
      deadline.dispose();
      return emitBatchConfigError(json, err.message);
    }
    deadline.dispose();
    throw err;
  }

  const { config } = opts;
  if (!opts.permissionModeSet) config.permissionMode = "auto";
  const logicalCwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const useIsolation = !opts.inPlace;
  if (useIsolation && config.permissionMode === "yolo") {
    deadline.dispose();
    return emitBatchConfigError(json, "--yolo cannot be combined with private worktree isolation; add --in-place");
  }
  let isolationHandle: IsolationHandle | undefined;
  let isolation: IsolationSessionMetadata = { mode: useIsolation ? "worktree" : "in_place", source_cwd: logicalCwd };
  let cwd = logicalCwd;
  if (useIsolation) {
    try {
      isolationHandle = await prepareIsolation({ sourceCwd: logicalCwd, sessionId });
      cwd = isolationHandle.executionCwd;
      isolation = isolationMetadata(isolationHandle);
    } catch (err) {
      deadline.dispose();
      return emitBatchConfigError(json, `worktree isolation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let cliScope: WorkspaceScope;
  const taskScopes = new Map<string, WorkspaceScope>();
  try {
    const cliAllowed = isolationHandle ? opts.allowedPaths.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : opts.allowedPaths;
    const cliProtected = isolationHandle ? opts.protectedPaths.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : opts.protectedPaths;
    cliScope = prepareWorkspaceScope(cwd, { allowedPaths: cliAllowed, protectedPaths: cliProtected });
    if (isolationHandle) {
      cliScope.privateGitPaths = [isolationHandle.gitDir, path.join(isolationHandle.worktreeRoot, ".git")];
    }
    for (const task of tasks) {
      if (task.allowedPaths || task.protectedPaths) {
        const manifestScope = prepareWorkspaceScope(cwd, {
          allowedPaths: isolationHandle ? task.allowedPaths?.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : task.allowedPaths,
          protectedPaths: isolationHandle ? task.protectedPaths?.map((value) => mapIsolationPath(logicalCwd, cwd, value)) : task.protectedPaths,
        });
        taskScopes.set(task.id, intersectWorkspaceScopes(cliScope, manifestScope));
      } else {
        taskScopes.set(task.id, cliScope);
      }
    }
  } catch (err) {
    if (isolationHandle) await cleanupIsolation(isolationHandle);
    deadline.dispose();
    return emitBatchConfigError(json, `invalid workspace scope: ${err instanceof Error ? err.message : String(err)}`);
  }
  const denyPermission = async () => false;
  // --max-time is the TOTAL wall-clock budget for the whole batch (all tasks +
  // checks + the final sweep), not per task. When it is not set explicitly, fall
  // back to the per-run default × task count so each task keeps its usual
  // allowance (the default is 0 = unlimited, which stays unlimited).
  const totalBudgetMs = opts.maxTimeSet ? config.maxTimeMs : config.maxTimeMs * tasks.length;
  const budgetActive = totalBudgetMs > 0;
  if (!opts.maxTimeSet) deadline.configure(totalBudgetMs, started);

  const showProgress = json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  let checkMs = 0;
  let currentTaskId: string | undefined;
  const metrics = createMetricsCollector(() => currentTaskId);
  const onEvent = (e: AgentEvent) => {
    metrics.collect(e);
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptLastTokens = e.promptTokens;
      promptTotalTokens += e.promptTokens;
      completionTokens += e.evalTokens;
    }
    progress?.(e);
  };

  // Build the system prompt ONCE for the whole batch. Each task gets a fresh
  // agent, but they all reuse this one string (the directory snapshot inside it
  // is frozen at batch start — stale is harmless, it is only a 25-entry hint),
  // so the system prefix stays byte-identical and Ollama's prefix KV cache holds.
  const systemPrompt = buildSystemPrompt(cwd, config);

  // Real wiring: fresh Agent per task, one command-scoped deadline, the shell
  // check runner, and the system clock. Tests inject fakes via `deps`.
  const d: BatchDeps = deps ?? {
    now,
    createAgent: (sp, task, scope) => new Agent(config, cwd, onEvent, denyPermission, sp, undefined, task.think, scope, deadline),
    applyBudget: (ms) => {
      config.maxTimeMs = ms;
    },
    runCheck: (command, timeoutMs, attempts, signal, deadlineAt, scope) =>
      runCheckCommand({
        command,
        cwd,
        timeoutMs,
        attempts,
        signal,
        deadlineAt,
        sandbox: config.permissionMode !== "yolo",
        scope,
      }),
  };

  // The SIGINT handler must interrupt whichever fresh agent is currently running.
  // Registered only in production (an injected deps means a test — avoid leaking
  // process listeners across test runs).
  let currentAgent: BatchAgent | undefined;
  let sigintReceived = false;
  const onSigint = () => {
    sigintReceived = true;
    deadline.interrupt();
    currentAgent?.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  if (deps === undefined) {
    process.on("SIGINT", onSigint);
  }

  const remainingMs = () => budgetActive ? deadline.remainingMs() : Number.POSITIVE_INFINITY;

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
    const scope = taskScopes.get(task.id)!;
    let beforeSnapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>>;
    try {
      beforeSnapshot = await captureWorkspaceSnapshot(cwd, deadline.signal);
    } catch (err) {
      const stopped = deadline.cause;
      return {
        task,
        status: stopped ? (deadline.timedOut ? "timeout" : "interrupted") : "error",
        error: stopped ? undefined : `workspace change audit failed before task: ${err instanceof Error ? err.message : String(err)}`,
        errorKind: stopped ? undefined : "internal",
        report: { changedFiles: [], commandsRun: [] },
        turns: 0,
        durationMs: d.now() - taskStarted,
      };
    }
    const agent = d.createAgent(systemPrompt, task, scope);
    currentTaskId = task.id;
    currentAgent = agent;
    const checkRetries = task.checkRetries ?? 2;
    let status: RunStatus = "error";
    let error: string | undefined;
    let errorKind: ErrorKind | undefined;
    let check: CheckRecord | undefined;
    let report: RunReport = { changedFiles: [], commandsRun: [] };
    try {
      d.applyBudget(budgetActive ? Math.max(1, remainingMs()) : 0);
      await agent.run(task.prompt);
      status = agent.lastRunStatus;
      if (deadline.cause) status = deadline.timedOut ? "timeout" : "interrupted";
      if (task.check && status === "ok") {
        for (let attempt = 1; ; attempt++) {
          const timeoutMs = budgetActive ? Math.max(1, Math.min(config.bashTimeoutMs, remainingMs())) : config.bashTimeoutMs;
          const checkStarted = d.now();
          check = await d.runCheck(task.check, timeoutMs, attempt, deadline.signal, deadline.deadlineAt, scope);
          checkMs += d.now() - checkStarted;
          if (deadline.cause) {
            status = deadline.timedOut ? "timeout" : "interrupted";
            break;
          }
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
      status = deadline.cause ? (deadline.timedOut ? "timeout" : "interrupted") : "error";
      errorKind = deadline.cause ? undefined : classifyError(error);
      if (deadline.cause) error = undefined;
    }
    try {
      const afterSnapshot = await captureWorkspaceSnapshot(cwd, deadline.signal);
      report = reportFromSnapshots(beforeSnapshot, afterSnapshot, agent.getReport());
      const violations = changedFileScopeViolations(scope, report);
      if (violations.length > 0) {
        if (status !== "timeout" && status !== "interrupted") {
          status = "error";
          errorKind = "config";
          error = `workspace scope violation: ${violations.join("; ")}`;
        }
      }
    } catch (snapshotErr) {
      report = agent.getReport();
      if (deadline.cause) {
        status = deadline.timedOut ? "timeout" : "interrupted";
        error = undefined;
        errorKind = undefined;
      } else if (status !== "timeout" && status !== "interrupted") {
        status = "error";
        errorKind = "internal";
        error = `workspace change audit failed after task: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`;
      }
    }
    if (deadline.cause) {
      status = deadline.timedOut ? "timeout" : "interrupted";
      error = undefined;
      errorKind = undefined;
    }
    currentTaskId = undefined;
    return {
      task,
      status,
      error,
      errorKind,
      check,
      report,
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
      cwd: logicalCwd,
      model: config.model,
      dimensions,
      prompt: `batch: ${tasks.map((t) => t.id).join(", ")}`,
      status,
      result: summarizeTasks(execs),
      error: errored?.error,
      errorKind: errored?.errorKind,
      durationMs: d.now() - started,
      durations: {
        total_ms: d.now() - started,
        model_ms: metrics.totals.modelMs,
        tool_ms: metrics.totals.toolMs,
        check_ms: checkMs,
        ttft_ms: metrics.totals.ttftMs,
        model_prompt_eval_ms: metrics.totals.promptEvalMs,
        model_eval_ms: metrics.totals.evalMs,
        load_ms: metrics.totals.loadMs,
      },
      turns,
      toolCalls,
      tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
      report: mergeReports(execs.map((e) => e.report)),
      messages: execs.flatMap((e) => (e.messages ? [...e.messages] : [])),
      tasks: toTaskRecords(execs, metrics.modelTurns),
      modelTurns: metrics.modelTurns,
      isolation,
    };
  };

  try {
    // Persist a running placeholder up front, then after every task, so a
    // mid-batch SIGTERM still leaves the completed tasks on disk.
    saveSession(buildRecord("running", []));
    const batch = await executeBatch(tasks, runTask, (execs) => saveSession(buildRecord("running", execs)));

    // Final re-verification catches an earlier task being clobbered by a later
    // one. It consumes the same total deadline; an exhausted budget produces a
    // timed-out record without spawning another process.
    const sweepReports = new Map<string, RunReport>();
    const recheck = async (task: BatchTask) => {
      const checkStarted = d.now();
      const taskScope = taskScopes.get(task.id)!;
      let before: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined;
      try {
        if (!deadline.signal.aborted) before = await captureWorkspaceSnapshot(cwd, deadline.signal);
      } catch (err) {
        if (!deadline.cause) {
          return {
            command: task.check!,
            exit_code: null,
            attempts: 1,
            output_tail: `final check audit failed before execution: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      try {
        let checked = await d.runCheck(
          task.check!,
          budgetActive ? Math.max(0, Math.min(config.bashTimeoutMs, remainingMs())) : config.bashTimeoutMs,
          1,
          deadline.signal,
          deadline.deadlineAt,
          taskScope,
        );
        if (before && !deadline.signal.aborted) {
          try {
            const after = await captureWorkspaceSnapshot(cwd, deadline.signal);
            const sweepReport = reportFromSnapshots(before, after, { changedFiles: [], commandsRun: [] });
            sweepReports.set(task.id, sweepReport);
            const violations = changedFileScopeViolations(taskScope, sweepReport);
            if (sweepReport.changedFiles.length > 0) {
              const paths = sweepReport.changedFiles.map((entry) => entry.path).join(", ");
              checked = {
                ...checked,
                exit_code: null,
                output_tail: `${checked.output_tail}\nfinal check modified the workspace: ${paths}` +
                  (violations.length > 0 ? `\nscope violation: ${violations.join("; ")}` : ""),
              };
            }
          } catch (err) {
            if (!deadline.cause) {
              checked = {
                ...checked,
                exit_code: null,
                output_tail: `${checked.output_tail}\nfinal check audit failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }
        }
        return checked;
      } finally {
        checkMs += d.now() - checkStarted;
      }
    };
    const verified = await reverifyBatch(batch.executions, batch.fatal, recheck);
    const executions = verified.executions.map((execution) => {
      const sweep = sweepReports.get(execution.task.id);
      return sweep ? { ...execution, report: mergeReports([execution.report, sweep]) } : execution;
    });
    const status = verified.status;

    const stopCause = deadline.cause;
    let finalStatus: RunStatus | BatchStatus = stopCause === "timeout"
      ? "timeout"
      : stopCause === "interrupted"
        ? "interrupted"
        : status;
    let isolationError: string | undefined;
    let isolationErrorKind: ErrorKind | undefined;
    deadline.dispose();
    if (isolationHandle) {
      try {
        const artifact = await finalizeIsolation(isolationHandle, { timeoutMs: 30_000 });
        const prefix = isolationHandle.cwdRelative.split(path.sep).join("/");
        const outside = artifact.changedRepoPaths.filter((repoPath) => {
          if (!prefix) return false;
          const rel = path.posix.relative(prefix, repoPath);
          return rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel);
        });
        if (outside.length > 0) {
          finalStatus = "error";
          isolationErrorKind = "config";
          isolationError = `workspace scope violation outside cwd: ${outside.join(", ")}`;
        }
        if (sigintReceived || deadline.interrupted) finalStatus = "interrupted";
        if (finalStatus === "ok") {
          const applied = await applyArtifact(isolationHandle, artifact, { signal: deadline.signal });
          if (sigintReceived || deadline.interrupted) {
            finalStatus = "interrupted";
            isolationError = undefined;
            isolationErrorKind = undefined;
          } else if (applied !== "applied") {
            finalStatus = "error";
            isolationErrorKind = applied === "conflict" ? "conflict" : "internal";
            isolationError = artifact.conflict ?? `isolated patch ${applied}`;
          }
        } else if (artifact.applyStatus === "pending") {
          artifact.applyStatus = "retained";
        }
        await cleanupIsolation(isolationHandle, artifact);
        isolation = isolationMetadata(artifact);
        if (sigintReceived || deadline.interrupted) {
          finalStatus = "interrupted";
          isolationError = undefined;
          isolationErrorKind = undefined;
        }
      } catch (err) {
        // Let a SIGINT queued while synchronous Git was running reach onSigint
        // before the finally block removes the process listener.
        await new Promise<void>((resolve) => setImmediate(resolve));
        isolation = { ...isolationMetadata(isolationHandle), cleanup_status: "retained", worktree_path: isolationHandle.worktreeRoot };
        if (sigintReceived || deadline.interrupted) {
          finalStatus = "interrupted";
          isolationError = undefined;
          isolationErrorKind = undefined;
        } else if (finalStatus === "ok") {
          finalStatus = "error";
          isolationErrorKind = "internal";
          isolationError = `isolation finalization failed; worktree retained at ${isolationHandle.worktreeRoot}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    const record = buildRecord(finalStatus, executions);
    if (isolationError) {
      record.error = isolationError;
      record.errorKind = isolationErrorKind;
    }
    saveSession(record);

    if (json) console.log(JSON.stringify(batchForJson(record)));
    else printBatchSummary(record, executions);
    return statusExitCode(finalStatus);
  } finally {
    if (deps === undefined) process.off("SIGINT", onSigint);
    deadline.dispose();
  }
}

// ---------- distill ----------

export interface DistillCliDeps {
  readFileBuffer?: (file: string, signal?: AbortSignal) => Buffer | Promise<Buffer>;
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
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    digest: record.result ? JSON.parse(record.result) : undefined,
    warnings,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    turns: record.turns,
    tokens: record.tokens,
    model: record.model,
    dimensions: record.dimensions,
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

async function loadDistillFile(
  cwd: string,
  file: string,
  readFileBuffer: (file: string, signal?: AbortSignal) => Buffer | Promise<Buffer>,
  signal?: AbortSignal,
): Promise<DistillInput | string> {
  const abs = path.resolve(cwd, file);
  const label = displayPath(cwd, file);
  let buf: Buffer;
  try {
    const pending = Promise.resolve(readFileBuffer(abs, signal));
    buf = signal ? await abortable(pending, signal) : await pending;
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
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return emitDistillConfigError(argv.includes("--json"), err instanceof Error ? err.message : String(err));
  }
  const json = opts.json;
  const dimensions = executionDimensions(opts);
  const query = opts.distillQuery;
  if (opts.resumeFrom !== undefined) return emitDistillConfigError(json, "distill does not support --resume");
  if (!query || !query.trim()) return emitDistillConfigError(json, "distill requires -q/--query");
  const budget = Math.floor(opts.distillBudget);
  if (!Number.isFinite(opts.distillBudget) || budget < 1) {
    return emitDistillConfigError(json, "--budget must be an integer >= 1");
  }

  const { config } = opts;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const readFileBuffer = deps.readFileBuffer ?? ((file: string, signal?: AbortSignal) => fs.promises.readFile(file, { signal }));
  const readPipe = deps.readStdin ?? readStdinRaw;
  const sessionId = opts.sessionId ?? newSessionId();
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = new RunDeadline(config.maxTimeMs, now, undefined, started);
  const onSigint = () => {
    deadline.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  if (deps.complete === undefined) process.on("SIGINT", onSigint);
  const inputs: DistillInput[] = [];
  const warnings: string[] = [];
  let acquisitionError: unknown;

  try {
    for (const file of opts.positionals) {
      const loaded = await loadDistillFile(cwd, file, readFileBuffer, deadline.signal);
      if (typeof loaded === "string") warnings.push(loaded);
      else inputs.push(loaded);
      if (deadline.remainingMs() === 0) throw deadline.signal.reason;
    }

    const shouldReadStdin = deps.readStdin !== undefined || stdinHasData();
    if (shouldReadStdin) {
      const stdin = deps.readStdin
        ? await abortable(readPipe(), deadline.signal)
        : await readStdinRaw(deadline.signal);
      if (stdin.length > 0) inputs.push({ file: "(stdin)", text: stdin });
    }
  } catch (err) {
    acquisitionError = err;
  }

  if (warnings.length > 0 && !opts.quiet && !json) {
    for (const warning of warnings) process.stderr.write(c.yellow(`warning: ${warning}`) + "\n");
  }
  if (!acquisitionError && inputs.length === 0) {
    if (deps.complete === undefined) process.off("SIGINT", onSigint);
    deadline.dispose();
    return emitDistillConfigError(json, "distill found no readable input", warnings);
  }

  const client = deps.complete === undefined ? new OllamaClient(config.ollamaUrl, config.model, config.keepAlive) : undefined;
  let turns = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  const complete = async (messages: ChatMessage[], options: ChatRequestOptions): Promise<DistillCompleteResult> => {
    turns++;
    let completed: DistillCompleteResult;
    if (deps.complete) {
      completed = await abortable(deps.complete(messages, options), deadline.signal);
    } else {
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
        deadline.signal,
      );
      completed = { text, promptTokens: usage.promptTokens, evalTokens: usage.evalTokens };
    }
    promptLastTokens = completed.promptTokens ?? 0;
    promptTotalTokens += completed.promptTokens ?? 0;
    completionTokens += completed.evalTokens ?? 0;
    return completed;
  };

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  try {
    if (acquisitionError) throw acquisitionError;
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
    if (deadline.remainingMs() === 0) throw deadline.signal.reason;
    result = JSON.stringify(out.digest, null, 2);
    status = "ok";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    status = deadline.cause ? (deadline.timedOut ? "timeout" : "interrupted") : "error";
    errorKind = deadline.cause
      ? undefined
      : err instanceof DistillConfigError
        ? "config"
        : err instanceof DistillModelError
          ? "ollama_error"
          : classifyError(error);
    if (deadline.cause) error = undefined;
  } finally {
    if (deps.complete === undefined) process.off("SIGINT", onSigint);
    deadline.dispose();
  }

  const durationMs = now() - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    dimensions,
    prompt: query,
    kind: opts.kind ?? "distill",
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls: 0,
    tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
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

// ---------- diff preprocessing ----------

export interface DiffCliDeps {
  readStdin?: () => Promise<string>;
  runGit?: (args: string[], cwd: string, signal: AbortSignal) => Promise<string>;
  complete?: (messages: ChatMessage[], options: ChatRequestOptions) => Promise<DistillCompleteResult>;
  now?: () => number;
}

function emitDiffConfigError(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
  else process.stderr.write(c.red(`error: ${message}`) + "\n");
  return 1;
}

function diffForJson(record: SessionRecord) {
  return {
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    digest: record.result ? JSON.parse(record.result) : undefined,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    turns: record.turns,
    tokens: record.tokens,
    model: record.model,
    dimensions: record.dimensions,
    cwd: record.cwd,
    kind: record.kind,
    feedback_command: `lh feedback ${record.id} <pass|fail> --notes "<diff digest useful? snapshot citations verified?>"`,
  };
}

function runGitDiff(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maxBytes = 64 * 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill();
        reject(new DistillConfigError("git diff exceeds the 64 MiB safety limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new DistillConfigError(`git diff failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("operation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function readDiffStdin(signal: AbortSignal): Promise<string> {
  return readStdinRaw(signal);
}

export async function cmdDiff(argv: string[], deps: DiffCliDeps = {}): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return emitDiffConfigError(argv.includes("--json"), err instanceof Error ? err.message : String(err));
  }
  const json = opts.json;
  const dimensions = executionDimensions(opts);
  const query = opts.distillQuery;
  if (opts.resumeFrom !== undefined) return emitDiffConfigError(json, "diff does not support --resume");
  if (!query || !query.trim()) return emitDiffConfigError(json, "diff requires -q/--query");
  if (opts.positionals.length > 0) return emitDiffConfigError(json, "diff does not accept positional files; pipe a diff or use --cwd");
  if (opts.base !== undefined && (!opts.base.trim() || opts.base.startsWith("-"))) {
    return emitDiffConfigError(json, "--base must be a non-option git ref");
  }
  const budget = Math.floor(opts.distillBudget);
  if (!Number.isFinite(opts.distillBudget) || budget < 1) return emitDiffConfigError(json, "--budget must be an integer >= 1");

  const { config } = opts;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = new RunDeadline(config.maxTimeMs, now, undefined, started);
  const onSigint = () => {
    deadline.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  if (deps.complete === undefined) process.on("SIGINT", onSigint);
  const client = deps.complete === undefined ? new OllamaClient(config.ollamaUrl, config.model, config.keepAlive) : undefined;
  let turns = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  const complete = async (messages: ChatMessage[], options: ChatRequestOptions): Promise<DistillCompleteResult> => {
    turns++;
    let completed: DistillCompleteResult;
    if (deps.complete) {
      completed = await abortable(deps.complete(messages, options), deadline.signal);
    } else {
      let usage = { promptTokens: 0, evalTokens: 0 };
      const text = await client!.complete(messages, {
        ...options,
        onUsage: (u) => {
          usage = u;
          options.onUsage?.(u);
        },
      }, deadline.signal);
      completed = { text, promptTokens: usage.promptTokens, evalTokens: usage.evalTokens };
    }
    promptLastTokens = completed.promptTokens ?? 0;
    promptTotalTokens += completed.promptTokens ?? 0;
    completionTokens += completed.evalTokens ?? 0;
    return completed;
  };

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  try {
    const shouldReadStdin = deps.readStdin !== undefined || stdinHasData();
    let diffText: string;
    if (shouldReadStdin) {
      diffText = deps.readStdin
        ? await abortable(deps.readStdin(), deadline.signal)
        : await readDiffStdin(deadline.signal);
      if (!diffText.trim()) throw new DistillConfigError("diff input from stdin is empty");
    } else {
      const gitArgs = ["diff", "--no-ext-diff", "--no-color"];
      if (opts.staged) gitArgs.push("--cached");
      if (opts.base) gitArgs.push(opts.base);
      gitArgs.push("--");
      try {
        diffText = await abortable((deps.runGit ?? runGitDiff)(gitArgs, cwd, deadline.signal), deadline.signal);
      } catch (err) {
        if (deadline.signal.aborted || err instanceof DistillConfigError) throw err;
        throw new DistillConfigError(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!diffText.trim()) throw new DistillConfigError("git diff is empty");
    }
    if (deadline.signal.aborted) throw deadline.signal.reason;

    const out = await preprocessDiff({
      query,
      text: diffText,
      numCtx: config.numCtx,
      budget,
      think: opts.noThink ? false : opts.distillThink,
    }, { complete, estimator: estimateTokens });
    if (deadline.remainingMs() === 0) throw deadline.signal.reason;
    result = JSON.stringify(out.digest, null, 2);
    status = "ok";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    status = deadline.cause ? (deadline.timedOut ? "timeout" : "interrupted") : "error";
    errorKind = deadline.cause
      ? undefined
      : err instanceof DistillConfigError
        ? "config"
        : err instanceof DistillModelError
          ? "ollama_error"
          : classifyError(error);
    if (deadline.cause) error = undefined;
  } finally {
    if (deps.complete === undefined) process.off("SIGINT", onSigint);
    deadline.dispose();
  }

  const durationMs = now() - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    dimensions,
    prompt: query,
    kind: opts.kind ?? "diff",
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls: 0,
    tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
    report: { changedFiles: [], commandsRun: [] },
  };
  saveSession(record);

  if (json) console.log(JSON.stringify(diffForJson(record)));
  else {
    if (result) process.stdout.write(result + "\n");
    if (error) process.stderr.write(c.red(`error: ${error}`) + "\n");
    process.stderr.write(c.dim(`session ${sessionId} (${status}, ${Math.round(durationMs / 1000)}s) — grade it: lh feedback ${sessionId} pass|fail`) + "\n");
  }
  return statusExitCode(status);
}

// ---------- web research preprocessing ----------

export interface SavedResearchSnapshot {
  id: string;
  sha256: string;
  url: string;
  path: string;
}

export interface ResearchCliDeps {
  search?: (query: string, maxResults: number) => Promise<SearchResult[]>;
  fetchPage?: (url: string) => Promise<FetchedWebPage>;
  complete?: (messages: ChatMessage[], options: ChatRequestOptions) => Promise<DistillCompleteResult>;
  now?: () => number;
  writeSnapshots?: (sessionId: string, snapshots: WebSnapshot[]) => SavedResearchSnapshot[] | Promise<SavedResearchSnapshot[]>;
  env?: NodeJS.ProcessEnv;
}

interface ResearchSessionResult {
  digest: ResearchResult["digest"];
  sources: Array<Record<string, unknown>>;
  manifest_path: string | undefined;
}

const RESEARCH_VALUE_FLAGS = new Set([
  "-q",
  "--query",
  "--search-provider",
  "--search-url",
  "--max-results",
  "--max-pages",
  "--budget",
  "--max-time",
  "--model",
  "--kind",
  "--caller",
  "--hardware",
  "--integration-version",
  "--cwd",
  "--session-id",
  "--num-ctx",
]);
const RESEARCH_BOOLEAN_FLAGS = new Set(["--json", "--quiet", "-v", "--verbose", "--think", "--no-think"]);

function validateResearchArgv(argv: string[]): string | undefined {
  let think = false;
  let noThink = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (RESEARCH_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return `${arg} requires a value`;
      i++;
      continue;
    }
    if (arg === "--think") think = true;
    if (arg === "--no-think") noThink = true;
    if (RESEARCH_BOOLEAN_FLAGS.has(arg) || !arg.startsWith("-")) continue;
    if (arg === "--resume") return "research does not support --resume";
    return `unknown research option: ${arg}`;
  }
  if (think && noThink) return "--think and --no-think cannot be used together";
  return undefined;
}

function parseHttpUrl(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResearchConfigError(`${flag} must be an absolute http:// or https:// URL: ${value}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
    throw new ResearchConfigError(`${flag} must be an absolute http:// or https:// URL without credentials: ${value}`);
  }
  return parsed.href;
}

function emitResearchConfigError(json: boolean, message: string): number {
  if (json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
  else process.stderr.write(c.red(`error: ${message}`) + "\n");
  return 1;
}

function writeResearchSnapshots(sessionId: string, snapshots: WebSnapshot[]): SavedResearchSnapshot[] {
  validateSessionId(sessionId);
  const root = path.join(dataDir(), "research", sessionId);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root);
  const written = new Set<string>();
  const saved = snapshots.map((snapshot) => {
    const digest = createHash("sha256").update(snapshot.text).digest("hex");
    if (snapshot.snapshot_sha256 !== digest) {
      throw new Error(`snapshot digest mismatch for ${snapshot.url}`);
    }
    const file = path.join(root, `${digest}.txt`);
    if (!written.has(digest)) {
      fs.writeFileSync(file, snapshot.text, { encoding: "utf8", flag: "wx" });
      written.add(digest);
    }
    return { id: digest, sha256: digest, url: snapshot.url, path: file };
  });
  const manifest = {
    version: 1,
    session_id: sessionId,
    snapshots: snapshots.map((snapshot, index) => ({
      id: saved[index]!.id,
      sha256: saved[index]!.sha256,
      url: snapshot.url,
      normalized_url: snapshot.normalized_url,
      title: snapshot.title,
      fetched_at: snapshot.fetched_at,
      path: path.basename(saved[index]!.path),
      bytes: Buffer.byteLength(snapshot.text),
    })),
  };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });
  return saved;
}

function sanitizedResearchSources(
  sources: ResearchResult["sources"],
  saved: SavedResearchSnapshot[],
): Array<Record<string, unknown>> {
  const bySha = new Map(saved.map((snapshot) => [snapshot.sha256, snapshot]));
  return sources.map((source) => {
    const snapshot = bySha.get(source.snapshot_sha256);
    return {
      url: source.url,
      normalized_url: source.normalized_url,
      title: source.title,
      fetched_at: source.fetched_at,
      snapshot_sha256: source.snapshot_sha256,
      snapshot_id: snapshot?.id ?? source.snapshot_sha256,
      snapshot_path: snapshot?.path,
      input_tokens: source.input_tokens,
    };
  });
}

function researchForJson(record: SessionRecord) {
  const payload = record.result ? JSON.parse(record.result) as ResearchSessionResult : undefined;
  return {
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    digest: payload?.digest,
    sources: payload?.sources,
    manifest_path: payload?.manifest_path,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    turns: record.turns,
    tokens: record.tokens,
    model: record.model,
    dimensions: record.dimensions,
    cwd: record.cwd,
    kind: record.kind,
    feedback_command: `lh feedback ${record.id} <pass|fail> --notes "<research useful? source snapshots and citations verified?>"`,
  };
}

function chooseResearchSearch(
  provider: string,
  searchUrl: string | undefined,
  directUrls: string[],
  env: NodeJS.ProcessEnv,
  injected: ResearchCliDeps["search"],
): ResearchCliDeps["search"] {
  if (provider === "brave") {
    if (searchUrl) throw new ResearchConfigError("--search-url can only be used with the searxng provider");
    if (!env.BRAVE_SEARCH_API_KEY) throw new ResearchConfigError("brave search requires BRAVE_SEARCH_API_KEY");
    return injected ?? createBraveSearch({ apiKey: env.BRAVE_SEARCH_API_KEY });
  }
  if (provider === "searxng") {
    const baseUrl = searchUrl ?? env.LH_SEARXNG_URL;
    if (!baseUrl) throw new ResearchConfigError("searxng search requires --search-url or LH_SEARXNG_URL");
    const parsed = parseHttpUrl(baseUrl, "--search-url");
    return injected ?? createSearxngSearch({ baseUrl: parsed });
  }
  if (searchUrl) {
    const parsed = parseHttpUrl(searchUrl, "--search-url");
    return injected ?? createSearxngSearch({ baseUrl: parsed });
  }
  if (env.BRAVE_SEARCH_API_KEY) return injected ?? createBraveSearch({ apiKey: env.BRAVE_SEARCH_API_KEY });
  if (env.LH_SEARXNG_URL) {
    const parsed = parseHttpUrl(env.LH_SEARXNG_URL, "LH_SEARXNG_URL");
    return injected ?? createSearxngSearch({ baseUrl: parsed });
  }
  if (directUrls.length > 0) return injected ?? (async () => []);
  throw new ResearchConfigError("research needs a search provider: set BRAVE_SEARCH_API_KEY or LH_SEARXNG_URL, or pass direct URLs");
}

export async function cmdResearch(argv: string[], deps: ResearchCliDeps = {}): Promise<number> {
  const preliminaryJson = argv.includes("--json");
  const argvError = validateResearchArgv(argv);
  if (argvError) return emitResearchConfigError(preliminaryJson, argvError);
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return emitResearchConfigError(preliminaryJson, err instanceof Error ? err.message : String(err));
  }
  const json = opts.json;
  const dimensions = executionDimensions(opts);
  const query = opts.distillQuery;
  if (!query || !query.trim()) return emitResearchConfigError(json, "research requires -q/--query");
  if (!new Set(["auto", "brave", "searxng"]).has(opts.searchProvider)) {
    return emitResearchConfigError(json, "--search-provider must be one of: auto, brave, searxng");
  }
  const positiveInteger = (value: number) => Number.isInteger(value) && value >= 1;
  if (!positiveInteger(opts.maxResults)) return emitResearchConfigError(json, "--max-results must be an integer >= 1");
  if (!positiveInteger(opts.maxPages)) return emitResearchConfigError(json, "--max-pages must be an integer >= 1");
  if (!positiveInteger(opts.distillBudget)) return emitResearchConfigError(json, "--budget must be an integer >= 1");
  if (!positiveInteger(opts.config.numCtx)) return emitResearchConfigError(json, "--num-ctx must be an integer >= 1");
  if (!opts.config.model.trim()) return emitResearchConfigError(json, "--model must not be empty");
  if (opts.maxTimeSet && (!Number.isFinite(opts.config.maxTimeMs) || opts.config.maxTimeMs < 0)) {
    return emitResearchConfigError(json, "--max-time must be a finite number >= 0");
  }
  let directUrls: string[];
  let search: NonNullable<ResearchCliDeps["search"]>;
  try {
    directUrls = opts.positionals.map((url) => parseHttpUrl(url, "direct URL"));
    search = chooseResearchSearch(opts.searchProvider, opts.searchUrl, directUrls, deps.env ?? process.env, deps.search)!;
  } catch (err) {
    return emitResearchConfigError(json, err instanceof Error ? err.message : String(err));
  }

  const { config } = opts;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? newSessionId();
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = new RunDeadline(config.maxTimeMs, now, undefined, started);
  const onSigint = () => {
    deadline.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  };
  const fullyInjected = deps.search !== undefined && deps.fetchPage !== undefined && deps.complete !== undefined;
  if (!fullyInjected) process.on("SIGINT", onSigint);

  const client = deps.complete === undefined ? new OllamaClient(config.ollamaUrl, config.model, config.keepAlive) : undefined;
  let turns = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  const complete = async (messages: ChatMessage[], options: ChatRequestOptions): Promise<DistillCompleteResult> => {
    turns++;
    let completed: DistillCompleteResult;
    if (deps.complete) {
      completed = await abortable(deps.complete(messages, options), deadline.signal);
    } else {
      let usage = { promptTokens: 0, evalTokens: 0 };
      const text = await client!.complete(messages, {
        ...options,
        onUsage: (value) => {
          usage = value;
          options.onUsage?.(value);
        },
      }, deadline.signal);
      completed = { text, promptTokens: usage.promptTokens, evalTokens: usage.evalTokens };
    }
    promptLastTokens = completed.promptTokens ?? 0;
    promptTotalTokens += completed.promptTokens ?? 0;
    completionTokens += completed.evalTokens ?? 0;
    return completed;
  };
  const fetchPage = deps.fetchPage ?? ((url: string) => fetchWebPage(url, {
    fetch: (input, init) => globalThis.fetch(input, { ...init, signal: deadline.signal }),
  }));
  const writer = deps.writeSnapshots ?? writeResearchSnapshots;

  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  try {
    const out = await research({
      query,
      directUrls,
      maxResults: opts.maxResults,
      maxPages: opts.maxPages,
      numCtx: config.numCtx,
      budget: opts.distillBudget,
      think: opts.noThink ? false : opts.distillThink,
    }, {
      search: (value, limit) => abortable(search(value, limit), deadline.signal),
      fetchPage: (url) => abortable(fetchPage(url), deadline.signal),
      complete,
      estimator: estimateTokens,
      now: () => new Date(now()),
    });
    if (deadline.signal.aborted) throw deadline.signal.reason;
    const saved = await writer(sessionId, out.snapshots);
    if (deadline.remainingMs() === 0) throw deadline.signal.reason;
    const sources = sanitizedResearchSources(out.sources, saved);
    const manifestPath = deps.writeSnapshots === undefined && saved.length > 0
      ? path.join(dataDir(), "research", sessionId, "manifest.json")
      : undefined;
    result = JSON.stringify({ digest: out.digest, sources, manifest_path: manifestPath } satisfies ResearchSessionResult);
    status = "ok";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    status = deadline.cause ? (deadline.timedOut ? "timeout" : "interrupted") : "error";
    errorKind = deadline.cause
      ? undefined
      : err instanceof ResearchConfigError
        ? "config"
        : err instanceof ResearchModelError
          ? "ollama_error"
          : err instanceof ResearchFetchError
            ? "connection"
            : classifyError(error);
    if (deadline.cause) error = undefined;
  } finally {
    if (!fullyInjected) process.off("SIGINT", onSigint);
    deadline.dispose();
  }

  const durationMs = now() - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    dimensions,
    prompt: query,
    kind: opts.kind ?? "research",
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls: 0,
    tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
    report: { changedFiles: [], commandsRun: [] },
  };
  saveSession(record);

  if (json) console.log(JSON.stringify(researchForJson(record)));
  else {
    if (result) process.stdout.write(JSON.stringify((JSON.parse(result) as ResearchSessionResult).digest, null, 2) + "\n");
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
    schema_version: record.schemaVersion ?? 2,
    session_id: record.id,
    status: record.status,
    digest: record.result ? JSON.parse(record.result) : undefined,
    error: record.error,
    error_kind: record.errorKind,
    duration_ms: record.durationMs,
    durations: record.durations ?? { total_ms: record.durationMs },
    turns: record.turns,
    tool_calls: record.toolCalls,
    tokens: record.tokens,
    model: record.model,
    dimensions: record.dimensions,
    cwd: record.cwd,
    kind: record.kind,
    model_turns: record.modelTurns,
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
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return emitScoutConfigError(argv.includes("--json"), err instanceof Error ? err.message : String(err));
  }
  const json = opts.json;
  const dimensions = executionDimensions(opts);
  const query = opts.distillQuery;
  if (opts.resumeFrom !== undefined) return emitScoutConfigError(json, "scout does not support --resume");
  if (!query || !query.trim()) return emitScoutConfigError(json, "scout requires -q/--query");
  if (opts.positionals.length > 0) return emitScoutConfigError(json, "scout does not accept positional input files; use --paths for hints");

  const { config } = opts;
  if (!opts.maxIterationsSet) config.maxIterations = Math.min(config.maxIterations, 20);
  if (!opts.maxTimeSet) config.maxTimeMs = 900_000;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = deps.createAgent === undefined
    ? new RunDeadline(config.maxTimeMs, now, undefined, started)
    : undefined;
  let scope: WorkspaceScope;
  try {
    scope = prepareWorkspaceScope(cwd, { allowedPaths: opts.allowedPaths, protectedPaths: opts.protectedPaths });
  } catch (err) {
    deadline?.dispose();
    return emitScoutConfigError(json, `invalid workspace scope: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sessionId = opts.sessionId ?? newSessionId();
  const showProgress = json ? opts.verbose : !opts.quiet;
  const progress = showProgress ? createRenderer(opts.verbose, process.stderr) : null;
  let turns = 0;
  let toolCalls = 0;
  let promptLastTokens = 0;
  let promptTotalTokens = 0;
  let completionTokens = 0;
  const metrics = createMetricsCollector();
  const onEvent = (e: AgentEvent) => {
    metrics.collect(e);
    if (e.type === "turn_end") turns++;
    else if (e.type === "tool_start") toolCalls++;
    else if (e.type === "usage") {
      promptLastTokens = e.promptTokens;
      promptTotalTokens += e.promptTokens;
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
      scope,
    }), think, scope, deadline);

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
      const remainingMs = deadline?.remainingMs() ?? (originalMaxTimeMs > 0 ? originalMaxTimeMs - elapsedMs : 0);
      if ((originalMaxTimeMs === 0 || remainingMs > 0) && !deadline?.signal.aborted) {
        // Repair is a final formatting pass, not another scout loop. The
        // dedicated method exposes no tools and does not add Agent.run's
        // max-iteration wrap-up prompt.
        const repairTimer = deadline === undefined && originalMaxTimeMs > 0
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
    const baseDigest = parsed.ok && parsed.digest
      ? evidenceCheckedScoutDigest(parsed.digest, cwd, readFile, turns)
      : parseFailedScoutDigest(text, parsed.error, turns);
    const digest = toPreprocessResult(baseDigest, "repository", {
      inputTokens: promptTotalTokens || estimateTokens(query),
      outputTokens: estimateTokens(JSON.stringify(baseDigest)),
      promptTokens: promptTotalTokens,
      completionTokens,
      inputMeasured: promptTotalTokens > 0,
    });
    result = JSON.stringify(digest, null, 2);
    if (deadline?.remainingMs() === 0) status = "timeout";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    errorKind = classifyError(error);
    status = agent.lastRunStatus === "interrupted"
      ? "interrupted"
      : agent.lastRunStatus === "timeout" || deadline?.timedOut
        ? "timeout"
        : "error";
    if (status === "timeout" || status === "interrupted") {
      error = undefined;
      errorKind = undefined;
    }
  } finally {
    if (deps.createAgent === undefined) process.off("SIGINT", onSigint);
    deadline?.dispose();
  }

  const durationMs = now() - started;
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    dimensions,
    prompt: query,
    kind: opts.kind ?? "scout",
    status,
    result,
    error,
    errorKind,
    durationMs,
    durations: {
      total_ms: durationMs,
      model_ms: metrics.totals.modelMs,
      tool_ms: metrics.totals.toolMs,
      check_ms: 0,
      ttft_ms: metrics.totals.ttftMs,
      model_prompt_eval_ms: metrics.totals.promptEvalMs,
      model_eval_ms: metrics.totals.evalMs,
      load_ms: metrics.totals.loadMs,
    },
    modelTurns: metrics.modelTurns,
    turns,
    toolCalls,
    tokens: sessionTokens(promptLastTokens, promptTotalTokens, completionTokens),
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
  if (argv[0] === "diff") {
    console.error("error: submit does not support diff; run `lh diff` directly (it is synchronous)");
    return 1;
  }
  if (argv[0] === "research") {
    console.error("error: submit does not support research; run `lh research` directly (it is synchronous)");
    return 1;
  }
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (argv.includes("--json")) console.log(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err), error_kind: "config" }));
    else console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const dimensions = executionDimensions(opts);
  if (opts.prompt === "-") opts.prompt = await readStdin();
  if (opts.prompt === undefined || !opts.prompt.trim()) {
    console.error("usage: lh submit -p <task> [--json] [--check COMMAND]");
    return 1;
  }
  if (opts.resumeFrom !== undefined) {
    console.error("error: submit does not support --resume; use `lh -p <follow-up> --resume <id>`");
    return 1;
  }
  if (!opts.inPlace && opts.config.permissionMode === "yolo") {
    console.error("error: --yolo cannot be combined with private worktree isolation; add --in-place");
    return 1;
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  try {
    prepareWorkspaceScope(cwd, { allowedPaths: opts.allowedPaths, protectedPaths: opts.protectedPaths });
    if (!opts.inPlace) validateIsolationSource(cwd);
  } catch (err) {
    const message = `invalid workspace scope: ${err instanceof Error ? err.message : String(err)}`;
    if (opts.json) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    else console.error(`error: ${message}`);
    return 1;
  }
  const sessionId = newSessionId();
  const record: SessionRecord = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    cwd,
    model: opts.config.model,
    dimensions,
    prompt: opts.prompt,
    kind: opts.kind,
    status: "running",
    result: "",
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    tokens: sessionTokens(0, 0, 0),
    report: { changedFiles: [], commandsRun: [] },
    isolation: {
      mode: opts.inPlace ? "in_place" : "worktree",
      source_cwd: cwd,
      workspace_id: sessionId,
      apply_status: "pending",
      cleanup_status: "pending",
    },
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
  if (current?.status === "running") {
    try {
      saveSession({ ...current, pid: child.pid }, { expectedGeneration: current.generation });
    } catch (err) {
      // The detached worker can finish before the parent records its pid. A
      // generation conflict means its final record won and must not be
      // overwritten with the stale running placeholder.
      if (!(err instanceof SessionStoreError) || err.code !== "conflict") throw err;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      session_id: sessionId,
      status: "running",
      pid: child.pid,
      isolation: record.isolation,
    }));
  }
  else console.log(`submitted: ${sessionId} (pid ${child.pid})`);
  return 0;
}

export async function cmdWait(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseSessionWaitArgs(argv, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes("--json")) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" }));
    else console.error(`error: ${message}`);
    return 1;
  }
  const { id, timeoutSeconds, json } = parsed;
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

export function cmdPoll(argv: string[]): number {
  let parsed;
  try {
    parsed = parseSessionWaitArgs(argv, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes("--json")) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" }));
    else console.error(`error: ${message}`);
    return 1;
  }
  const { id, json } = parsed;
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

function parseSessionWaitArgs(argv: string[], allowTimeout: boolean): { id?: string; timeoutSeconds?: number; json: boolean } {
  let id: string | undefined;
  let timeoutSeconds: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--timeout") {
      if (!allowTimeout) throw new CliConfigError("poll does not support --timeout");
      const raw = argv[++i];
      timeoutSeconds = Number(raw);
      if (raw === undefined || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        throw new CliConfigError("--timeout requires a finite number >= 0");
      }
    }
    else if (a === "--json") json = true;
    else if (!a.startsWith("-") && id === undefined) id = a;
    else throw new CliConfigError(a.startsWith("-") ? `unknown option: ${a}` : `unexpected argument: ${a}`);
  }
  if (id !== undefined) id = validateSessionId(id);
  return { id, timeoutSeconds, json };
}

function refreshRunningSession(id: string): SessionRecord | null {
  const record = loadSession(id);
  if (!record) return null;
  if (record.status === "running" && record.pid && !isProcessAlive(record.pid)) {
    const died = { ...record, status: "died" as const, durationMs: Date.now() - Date.parse(record.createdAt) };
    try {
      saveSession(died, { expectedGeneration: record.generation });
      return loadSession(id) ?? died;
    } catch (err) {
      // The worker may have completed between our read and liveness check.
      // Keep its newer final record instead of overwriting it with "died".
      if (err instanceof SessionStoreError && err.code === "conflict") return loadSession(id);
      throw err;
    }
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
  args.push(opts.inPlace ? "--in-place" : "--worktree");
  for (const allowed of opts.allowedPaths) args.push("--allow-path", allowed);
  for (const protectedPath of opts.protectedPaths) args.push("--protect-path", protectedPath);
  if (opts.checkCommand) args.push("--check", opts.checkCommand, "--check-retries", String(opts.checkRetries));
  if (opts.kind) args.push("--kind", opts.kind);
  if (opts.caller) args.push("--caller", opts.caller);
  if (opts.hardware) args.push("--hardware", opts.hardware);
  if (opts.integrationVersion) args.push("--integration-version", opts.integrationVersion);
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
    case "advise":
      process.exit(cmdAdvise(argv.slice(1)));
    case "batch":
      process.exit(await cmdBatch(argv.slice(1)));
    case "distill":
      process.exit(await cmdDistill(argv.slice(1)));
    case "scout":
      process.exit(await cmdScout(argv.slice(1)));
    case "diff":
      process.exit(await cmdDiff(argv.slice(1)));
    case "research":
      process.exit(await cmdResearch(argv.slice(1)));
  }

  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes("--json")) console.log(JSON.stringify({ status: "error", error: message, error_kind: "config" satisfies ErrorKind }));
    else process.stderr.write(c.red(`error: ${message}`) + "\n");
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
