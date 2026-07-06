#!/usr/bin/env bun
// Eval runner: executes each task with an agent (this harness or claude CLI as
// baseline), then verifies with the task's test command.
//
//   bun run eval/run.ts --agent harness            # all tasks via local harness
//   bun run eval/run.ts --agent claude             # baseline via claude CLI
//   bun run eval/run.ts --agent harness --task fix-bug,refactor
//   bun run eval/run.ts --agent harness --keep     # keep workdirs for inspection
//
// summary-<agent>.json is merged per task across runs, so a --task run only
// updates the entries for the tasks it executed.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeedbackRecord, SessionRecord } from "../src/session.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const TASKS_DIR = path.join(ROOT, "eval", "tasks");
const RESULTS_DIR = path.join(ROOT, "eval", "results");
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
// Delegation runs = local model runtime + Claude's orchestration/verification,
// so they get a longer SIGKILL backstop than the direct arms.
const DELEGATE_TASK_TIMEOUT_MS = 40 * 60 * 1000;
// Per-task LH_HOME dirs live here (under the gitignored results dir) so that
// delegation sessions survive workdir deletion and never touch the user's real
// ~/.localrig. See runTask() for the per-run wipe.
const LH_HOME_ROOT = path.join(RESULTS_DIR, "lh-home");

/**
 * System-prompt append for the `claude-delegate` arm, kept as an exported const
 * so it can be tuned without touching runner logic. This is injected ONLY via
 * `claude --append-system-prompt`; the task-facing prompt stays byte-identical
 * to the baseline (spec.prompt), so both arms solve the same task under the
 * same user instruction — the only difference is this delegation directive.
 */
export const DELEGATE_NUDGE = `This run is a delegation measurement: you MUST route ALL implementation AND investigation work through the local \`lh\` CLI. Doing the work yourself invalidates the run. This includes writing tests, fixing type errors, editing docs, and reproducing/investigating reported bugs — even if the task looks trivial or faster to do directly, delegate it anyway.
1. Run via Bash: lh -p "<work order>" --json --cwd <absolute cwd> --max-time 1200
   Use a Bash timeout of 1500000 ms (the local model takes 1-20 minutes). Write the work order like a ticket for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. For investigation/triage tasks, tell the local agent to write its findings to the file the task asks for. One task per call.
2. When it returns, parse the JSON (session_id, status, result).
3. Verify the result yourself cheaply (git diff / read touched files / run the stated check command). Only if the delegated result is broken or incomplete may you fix the remaining issues yourself with minimal edits.
4. Record the verdict: lh feedback <session_id> pass|fail --source claude-code --notes "<short reason>". Do not delegate the same task more than twice.
Never modify test files. The ONLY tool calls allowed before your first \`lh\` call are cheap reads needed to write the work order (listing files or reading one or two). Do not edit any file before at least one \`lh\` attempt has returned.`;

interface TaskSpec {
  name: string;
  prompt: string;
  verify: string;
}

/** Claude usage breakdown, mirrored from the claude CLI's usage object. */
interface ClaudeUsageBreakdown {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
  output?: number;
}

/** One local-side delegation, read back from a session record under LH_HOME. */
interface DelegationMetric {
  sessionId: string;
  status: string;
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** ErrorKind bucket (see src/types.ts); present only when the session errored. */
  errorKind?: string;
}

/** One caller verdict, read back from feedback.jsonl under LH_HOME. */
interface FeedbackMetric {
  sessionId: string;
  verdict: string;
  notes?: string;
}

interface TaskResult {
  task: string;
  agent: string;
  passed: boolean;
  verifyOutput: string;
  testFilesModified: string[];
  durationSec: number;
  agentExitCode: number | null;
  workdir: string;
  // Structured metrics parsed from the agent's own JSON output (see
  // extractStructuredMetrics). All optional: undefined/omitted whenever the
  // agent has no equivalent data (e.g. `claude` has no per-tool-call count,
  // see agentCommand) or the JSON couldn't be parsed.
  /** RunStatus string for the harness (see src/types.ts); not populated for claude. */
  status?: string;
  promptTokens?: number;
  completionTokens?: number;
  turns?: number;
  toolCalls?: number;
  /** ErrorKind string (see src/types.ts); harness only emits this if/when its --json output grows an error_kind field. */
  errorKind?: string;
  /** Dollar cost of the run (claude/claude-delegate only, from total_cost_usd). */
  costUsd?: number;
  /** Claude token usage breakdown (claude/claude-delegate only). */
  usage?: ClaudeUsageBreakdown;
  // claude-delegate arm only: local-side view of the delegated work, collected
  // from LH_HOME after the run (see collectDelegationMetrics). Absent otherwise.
  /** True if any local session file was produced (i.e. Claude actually delegated). */
  delegated?: boolean;
  delegations?: DelegationMetric[];
  feedback?: FeedbackMetric[];
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let agent = "harness";
  let only: Set<string> | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") agent = argv[++i]!;
    else if (argv[i] === "--task") only = new Set(argv[++i]!.split(",").filter(Boolean));
    else if (argv[i] === "--keep") keep = true;
  }
  return { agent, only, keep };
}

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; output: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    let stdout = "";
    const timer = setTimeout(() => {
      output += "\n[eval runner: timed out, killing agent]";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      output += d;
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      output += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, stdout });
    });
  });
}

/** Returns the last line of `text` that looks like a JSON object, if any. */
function findLastJsonLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) return line;
  }
  return undefined;
}

interface StructuredMetrics {
  status?: string;
  promptTokens?: number;
  completionTokens?: number;
  turns?: number;
  toolCalls?: number;
  errorKind?: string;
  costUsd?: number;
  usage?: ClaudeUsageBreakdown;
}

/**
 * Pulls structured run metrics out of an agent's stdout, tolerating anything
 * that doesn't parse (agents are external CLIs we don't control — a crash,
 * timeout kill, or version mismatch can leave stdout without a JSON line at
 * all, or with one that fails to parse). Never throws.
 */
function extractStructuredMetrics(agent: string, taskName: string, stdout: string): StructuredMetrics {
  const line = findLastJsonLine(stdout);
  if (!line) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    console.warn(
      `[${agent}/${taskName}] warning: last '{'-looking stdout line failed to parse as JSON ` +
        `(${err instanceof Error ? err.message : String(err)}); structured metrics omitted for this task.`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

  if (agent === "harness") {
    // Matches the --json shape in src/index.ts runOneShot(): { status, turns,
    // tool_calls, tokens: { prompt, completion }, ... }. error_kind isn't
    // emitted there yet (see types.ts ErrorKind) — read defensively so this
    // starts working automatically if that's added later.
    const tokens = asRecord(obj.tokens);
    return {
      status: str(obj.status),
      turns: num(obj.turns),
      toolCalls: num(obj.tool_calls),
      promptTokens: tokens ? num(tokens.prompt) : undefined,
      completionTokens: tokens ? num(tokens.completion) : undefined,
      errorKind: str(obj.error_kind),
    };
  }

  if (agent === "claude" || agent === "claude-delegate") {
    // claude --output-format json (verified via `claude --help` + a live
    // `-p ... --output-format json` run): gives num_turns, total_cost_usd, and
    // a usage object, but no per-tool-call count and no equivalent to our
    // RunStatus enum (its subtype/terminal_reason encode different, CLI-specific
    // states) — so status and toolCalls are intentionally left undefined here,
    // not an oversight. promptTokens sums input_tokens with the two prompt-cache
    // fields, since input_tokens alone excludes cached context and would
    // understate the actual prompt size on later turns of a conversation; the
    // per-field split is also kept in `usage` so the delegation analysis can
    // separate cache reads/creation from fresh input. Same shape for the
    // claude-delegate arm (it's the same CLI, just with an extra system prompt).
    const usage = asRecord(obj.usage);
    const promptTokens = usage
      ? (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0)
      : undefined;
    return {
      turns: num(obj.num_turns),
      promptTokens,
      completionTokens: usage ? num(usage.output_tokens) : undefined,
      costUsd: num(obj.total_cost_usd),
      usage: usage
        ? {
            input: num(usage.input_tokens),
            cacheRead: num(usage.cache_read_input_tokens),
            cacheCreation: num(usage.cache_creation_input_tokens),
            output: num(usage.output_tokens),
          }
        : undefined,
    };
  }

  return {};
}

function agentCommand(agent: string, prompt: string): { cmd: string; args: string[] } {
  if (agent === "harness") {
    // --max-time makes the harness wrap up gracefully before the runner's
    // 30-min SIGKILL, which becomes a backstop rather than the primary limit.
    // -v and --json together: per src/index.ts runOneShot(), showProgress =
    // opts.json ? opts.verbose : !opts.quiet, and the progress renderer
    // always targets process.stderr in one-shot mode — so with both flags,
    // verbose progress streams to stderr (captured into the .log file below)
    // while the single structured result object is the only thing printed to
    // stdout (parsed out by extractStructuredMetrics).
    return {
      cmd: "bun",
      args: ["run", path.join(ROOT, "src", "index.ts"), "-p", prompt, "-v", "--json", "--max-time", "1500"],
    };
  }
  if (agent === "claude" || agent === "claude-delegate") {
    // --output-format json (confirmed via `claude --help` and a live test
    // run) replaces claude's default plain-text stdout with a single JSON
    // result object containing duration_ms, num_turns, and token usage — see
    // extractStructuredMetrics for what we pull out of it and what we can't.
    const args = ["-p", prompt, "--model", "sonnet", "--output-format", "json", "--dangerously-skip-permissions"];
    // claude-delegate: identical invocation, but the delegation directive is
    // appended to the system prompt. The task-facing prompt (spec.prompt) is
    // left byte-identical to the baseline so the arms stay comparable.
    if (agent === "claude-delegate") args.push("--append-system-prompt", DELEGATE_NUDGE);
    return { cmd: "claude", args };
  }
  throw new Error(`unknown agent: ${agent}`);
}

/**
 * Reads the local side of a claude-delegate run back out of its LH_HOME:
 * every session record `lh` wrote under sessions/ plus the verdicts in
 * feedback.jsonl. Tolerates a missing/partial LH_HOME (Claude may not have
 * delegated at all, or may have crashed mid-run) — never throws. Field names
 * mirror SessionRecord / FeedbackRecord in src/session.ts.
 */
function collectDelegationMetrics(lhHome: string): {
  delegated: boolean;
  delegations: DelegationMetric[];
  feedback: FeedbackMetric[];
} {
  const delegations: DelegationMetric[] = [];
  const sessionsDir = path.join(lhHome, "sessions");
  try {
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8")) as Partial<SessionRecord>;
        delegations.push({
          sessionId: rec.id ?? f.slice(0, -".json".length),
          status: rec.status ?? "",
          turns: rec.turns ?? 0,
          toolCalls: rec.toolCalls ?? 0,
          promptTokens: rec.tokens?.prompt ?? 0,
          completionTokens: rec.tokens?.completion ?? 0,
          durationMs: rec.durationMs ?? 0,
          errorKind: rec.errorKind,
        });
      } catch {
        // Skip an unreadable/partial session file rather than losing the rest.
      }
    }
  } catch {
    // No sessions dir → Claude never delegated. Falls through to delegated:false.
  }
  // Session ids start with a timestamp, so this is oldest → newest.
  delegations.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const feedback: FeedbackMetric[] = [];
  try {
    const lines = fs.readFileSync(path.join(lhHome, "feedback.jsonl"), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const fb = JSON.parse(line) as Partial<FeedbackRecord>;
        feedback.push({ sessionId: fb.sessionId ?? "", verdict: fb.verdict ?? "", notes: fb.notes });
      } catch {
        // Skip a corrupt jsonl line.
      }
    }
  } catch {
    // No feedback file → Claude delegated but didn't grade. Tolerated.
  }

  return { delegated: delegations.length > 0, delegations, feedback };
}

async function runTask(agent: string, taskDir: string, keep: boolean): Promise<TaskResult> {
  const spec: TaskSpec = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-eval-${spec.name}-`));
  fs.cpSync(path.join(taskDir, "fixture"), workdir, { recursive: true });

  // Snapshot test files so agents can't "fix" the tests.
  const testHashes = new Map<string, string>();
  for (const f of listFiles(workdir)) {
    if (f.includes("test")) testHashes.set(f, sha(path.join(workdir, f)));
  }

  // claude-delegate: hand the spawned Claude Code an isolated LH_HOME that
  // outlives the (deleted) workdir, so we can read the local side back after
  // the run and delegation sessions never mix into the user's ~/.localrig.
  // Wiped per run so an earlier run's sessions can't be miscounted as this
  // run's. Also widen the Bash tool's timeout ceiling so Claude can actually
  // wait out a multi-minute `lh` call.
  const isDelegate = agent === "claude-delegate";
  const env: NodeJS.ProcessEnv = { ...process.env };
  let lhHome: string | undefined;
  if (isDelegate) {
    lhHome = path.join(LH_HOME_ROOT, spec.name);
    fs.rmSync(lhHome, { recursive: true, force: true });
    fs.mkdirSync(lhHome, { recursive: true });
    env.LH_HOME = lhHome;
    env.BASH_MAX_TIMEOUT_MS = "1800000";
    env.BASH_DEFAULT_TIMEOUT_MS = "1500000";
  }

  console.log(`\n=== [${agent}] ${spec.name} — workdir ${workdir} ===`);
  const { cmd, args } = agentCommand(agent, spec.prompt);
  const timeoutMs = isDelegate ? DELEGATE_TASK_TIMEOUT_MS : TASK_TIMEOUT_MS;
  const started = Date.now();
  const agentRun = await run(cmd, args, workdir, timeoutMs, env);
  const durationSec = Math.round((Date.now() - started) / 1000);

  const testFilesModified: string[] = [];
  for (const [f, h] of testHashes) {
    const p = path.join(workdir, f);
    if (!fs.existsSync(p) || sha(p) !== h) testFilesModified.push(f);
  }

  const [vcmd, ...vargs] = spec.verify.split(" ") as [string, ...string[]];
  const verify = await run(vcmd, vargs, workdir, 120_000);
  const passed = verify.code === 0 && testFilesModified.length === 0;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${agent}-${spec.name}.log`), agentRun.output);

  const metrics = extractStructuredMetrics(agent, spec.name, agentRun.stdout);
  const delegation = isDelegate && lhHome ? collectDelegationMetrics(lhHome) : undefined;

  if (!keep) fs.rmSync(workdir, { recursive: true, force: true });
  return {
    task: spec.name,
    agent,
    passed,
    verifyOutput: verify.output.slice(-2000),
    testFilesModified,
    durationSec,
    agentExitCode: agentRun.code,
    workdir: keep ? workdir : "(removed)",
    ...metrics,
    ...(delegation ?? {}),
  };
}

/**
 * Merges `newResults` into summary-<agent>.json, keyed by task name (a rerun
 * of a task overwrites just that entry). Called once per completed task
 * (see main()) rather than only after a whole batch finishes, so a crash,
 * timeout, or Ctrl-C partway through a multi-task run doesn't discard results
 * for tasks that already finished — see REPORT.md / the investigation into
 * summary-claude.json for a real instance of that data loss.
 */
function writeSummary(agent: string, newResults: TaskResult[]): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const summaryPath = path.join(RESULTS_DIR, `summary-${agent}.json`);
  let merged: TaskResult[] = [];
  if (fs.existsSync(summaryPath)) {
    try {
      merged = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch {
      merged = [];
    }
  }
  const newNames = new Set(newResults.map((r) => r.task));
  merged = merged.filter((r) => !newNames.has(r.task)).concat(newResults);
  merged.sort((a, b) => a.task.localeCompare(b.task));
  fs.writeFileSync(summaryPath, JSON.stringify(merged, null, 2));
}

async function main() {
  const { agent, only, keep } = parseArgs();
  const tasks = fs
    .readdirSync(TASKS_DIR)
    .filter((t) => fs.existsSync(path.join(TASKS_DIR, t, "task.json")))
    .filter((t) => !only || only.has(t))
    .sort();
  if (tasks.length === 0) {
    console.error("no tasks found");
    process.exit(1);
  }

  const results: TaskResult[] = [];
  for (const t of tasks) {
    const result = await runTask(agent, path.join(TASKS_DIR, t), keep);
    results.push(result);
    writeSummary(agent, [result]);
  }

  console.log(`\n=== summary (${agent}) ===`);
  for (const r of results) {
    const flag = r.passed ? "PASS" : "FAIL";
    const cheat = r.testFilesModified.length ? ` [test files modified: ${r.testFilesModified.join(", ")}]` : "";
    console.log(`${flag}  ${r.task}  ${r.durationSec}s${cheat}`);
  }
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main();
