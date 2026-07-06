#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { Agent } from "./agent.ts";
import { buildCheckRepairPrompt, canRetryCheck, runCheckCommand } from "./check.ts";
import { defaultConfig, type Config } from "./config.ts";
import { createRenderer, c } from "./ui/render.ts";
import type { AgentEvent, ChatMessage, ErrorKind, RunStatus } from "./types.ts";
import {
  appendFeedback,
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
  checkCommand?: string;
  checkRetries: number;
  kind?: string;
  sessionId?: string;
  resumeFrom?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const config = { ...defaultConfig };
  const opts: CliOptions = {
    config,
    verbose: false,
    json: false,
    quiet: false,
    permissionModeSet: false,
    checkRetries: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-p":
      case "--print":
        opts.prompt = argv[++i];
        break;
      case "--model":
        config.model = argv[++i]!;
        break;
      case "--num-ctx":
        config.numCtx = Number(argv[++i]);
        break;
      case "--num-predict":
        config.numPredict = Number(argv[++i]);
        break;
      case "--temperature":
        config.temperature = Number(argv[++i]);
        break;
      case "--presence-penalty":
        config.presencePenalty = Number(argv[++i]);
        break;
      case "--max-iterations":
        config.maxIterations = Number(argv[++i]);
        break;
      case "--max-time":
        config.maxTimeMs = Number(argv[++i]) * 1000;
        break;
      case "--think-budget":
        config.thinkBudgetChars = Number(argv[++i]);
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
    }
  }
  return opts;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ---------- subcommands ----------

function cmdFeedback(argv: string[]): number {
  let id: string | undefined;
  let verdict: "pass" | "fail" | undefined;
  let notes: string | undefined;
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--last") id = latestSessionId() ?? undefined;
    else if (a === "--notes") notes = argv[++i];
    else if (a === "--source") source = argv[++i];
    else if (a === "pass" || a === "fail") verdict = a;
    else if (!a.startsWith("-") && id === undefined) id = a;
  }
  if (!id || !verdict) {
    console.error('usage: lh feedback <session-id|--last> <pass|fail> [--notes "why"] [--source name]');
    return 1;
  }
  const session = loadSession(id);
  if (!session) {
    console.error(`unknown session: ${id} (see \`lh sessions\`)`);
    return 1;
  }
  appendFeedback({ sessionId: id, verdict, kind: session.kind, notes, source, createdAt: new Date().toISOString() });
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
        `  ${k.kind.padEnd(12)} ${k.graded} graded, pass ${k.pass} / fail ${k.fail}, ${k.rate ?? 0}% pass, avg ${Math.round(k.avgDurationMs / 1000)}s`,
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

function reportForJson(record: SessionRecord) {
  return record.report
    ? {
        changed_files: record.report.changedFiles,
        commands_run: record.report.commandsRun,
      }
    : { changed_files: [], commands_run: [] };
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
    report: reportForJson(record),
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

function statusExitCode(status: RunStatus): number {
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

// ---------- async submit / wait / poll ----------

async function cmdSubmit(argv: string[]): Promise<number> {
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
