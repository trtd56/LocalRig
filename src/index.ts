#!/usr/bin/env bun
import * as readline from "node:readline";
import * as path from "node:path";
import { Agent } from "./agent.ts";
import { defaultConfig, type Config } from "./config.ts";
import { createRenderer, c } from "./ui/render.ts";
import type { AgentEvent, ErrorKind, RunStatus } from "./types.ts";
import {
  appendFeedback,
  computeStats,
  latestSessionId,
  listSessionIds,
  loadSession,
  newSessionId,
  readFeedback,
  saveSession,
} from "./session.ts";

const HELP = `LocalRig — coding agent for local LLMs via Ollama

Usage:
  localrig                  interactive REPL
  localrig -p "task"        one-shot: progress → stderr, final answer → stdout
  lh                        interactive REPL
  lh -p "task"              one-shot: progress → stderr, final answer → stdout
  echo "task" | lh -p -     one-shot, prompt from stdin
  lh feedback <id> <pass|fail> [--notes "why"] [--source claude-code]
                            grade a past session (use --last for the newest)
  lh sessions [-n N]        list recent sessions with their feedback
  lh stats [--json]         delegation pass rate from recorded feedback

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
}

export function parseArgs(argv: string[]): CliOptions {
  const config = { ...defaultConfig };
  const opts: CliOptions = { config, verbose: false, json: false, quiet: false, permissionModeSet: false };
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
  if (!loadSession(id)) {
    console.error(`unknown session: ${id} (see \`lh sessions\`)`);
    return 1;
  }
  appendFeedback({ sessionId: id, verdict, notes, source, createdAt: new Date().toISOString() });
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
    console.log(
      `${id}  ${s.status.padEnd(14)} ${Math.round(s.durationMs / 1000)}s  ${verdict.padEnd(4)} ${head}`,
    );
  }
  return 0;
}

function cmdStats(argv: string[]): number {
  const stats = computeStats();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(stats));
    return 0;
  }
  const rate = stats.graded > 0 ? Math.round((100 * stats.pass) / stats.graded) : 0;
  console.log(`sessions: ${stats.sessions}`);
  console.log(`graded:   ${stats.graded} (pass ${stats.pass} / fail ${stats.fail}, ${rate}% pass)`);
  if (stats.recentFailures.length > 0) {
    console.log("recent failures:");
    for (const f of stats.recentFailures) {
      console.log(`  ${f.sessionId}${f.notes ? ` — ${f.notes}` : ""}`);
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
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) return "connection";
  if (message.startsWith("Ollama HTTP") || message.startsWith("Ollama error:")) return "ollama_error";
  return "internal";
}

async function runOneShot(opts: CliOptions): Promise<never> {
  const { config } = opts;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const sessionId = newSessionId();
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
  process.on("SIGINT", () => {
    agent.interrupt();
    process.stderr.write("\n" + c.yellow("[interrupted]") + "\n");
  });

  const started = Date.now();
  let result = "";
  let status: RunStatus = "error";
  let error: string | undefined;
  let errorKind: ErrorKind | undefined;
  try {
    result = await agent.run(opts.prompt!);
    status = agent.lastRunStatus;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    errorKind = classifyError(error);
  }
  const durationMs = Date.now() - started;

  saveSession({
    id: sessionId,
    createdAt: new Date(started).toISOString(),
    cwd,
    model: config.model,
    prompt: opts.prompt!,
    status,
    result,
    error,
    errorKind,
    durationMs,
    turns,
    toolCalls,
    tokens: { prompt: promptTokens, completion: completionTokens },
    messages: agent.getMessages(),
  });

  if (opts.json) {
    console.log(
      JSON.stringify({
        session_id: sessionId,
        status,
        result,
        error,
        error_kind: errorKind,
        duration_ms: durationMs,
        turns,
        tool_calls: toolCalls,
        tokens: { prompt: promptTokens, completion: completionTokens },
        model: config.model,
        cwd,
        feedback_command: `lh feedback ${sessionId} <pass|fail> --notes "<verified how / what went wrong>"`,
      }),
    );
  } else {
    if (result) process.stdout.write(result + "\n");
    if (error) process.stderr.write(c.red(`error: ${error}`) + "\n");
    process.stderr.write(
      c.dim(`session ${sessionId} (${status}, ${Math.round(durationMs / 1000)}s) — grade it: lh feedback ${sessionId} pass|fail`) + "\n",
    );
  }
  process.exit(status === "ok" ? 0 : status === "interrupted" ? 130 : 1);
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

  if (opts.prompt !== undefined) {
    await runOneShot(opts);
  } else {
    await runRepl(opts);
  }
}

if (import.meta.main) main();
