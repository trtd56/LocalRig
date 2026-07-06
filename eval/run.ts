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
// so they get a longer SIGKILL backstop than the direct arms. Overridable via
// the DELEGATE_TASK_TIMEOUT_MS env var (milliseconds) for the heavyweight
// fixtures in fix_plan.md 課題4, where local execution can exceed 20 minutes.
const DELEGATE_TASK_TIMEOUT_MS = (() => {
  const override = Number(process.env.DELEGATE_TASK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 55 * 60 * 1000;
})();
// Per-task LH_HOME dirs live here (under the gitignored results dir) so that
// delegation sessions survive workdir deletion and never touch the user's real
// ~/.localrig. See runTask() for the per-run wipe.
const LH_HOME_ROOT = path.join(RESULTS_DIR, "lh-home");
// claude-delegate-haiku arm: the worker's result JSONs (<workdir>/.delegate/*.json)
// are copied here before the workdir is deleted, so worker cost/quality survives.
const DELEGATE_WORKERS_ROOT = path.join(RESULTS_DIR, "delegate-workers");
// Claude Code writes each session's transcript to
// ~/.claude/projects/<slug>/<session-id>.jsonl, where <slug> is the run's cwd
// with every non-[A-Za-z0-9-] char replaced by '-' (verified against real dirs:
// /Users/s06330/Development/localllm_harnes → -Users-s06330-Development-localllm-harnes,
// i.e. '/' and '_' both map to '-', existing '-' preserved, no collapsing). Used
// as a mechanical backup to count worker sessions for the haiku arm.
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/**
 * System-prompt append for the `claude-delegate` arm, kept as an exported const
 * so it can be tuned without touching runner logic. This is injected ONLY via
 * `claude --append-system-prompt`; the task-facing prompt stays byte-identical
 * to the baseline (spec.prompt), so both arms solve the same task under the
 * same user instruction — the only difference is this delegation directive.
 */
export const DELEGATE_NUDGE = `This run is a delegation measurement: you MUST route ALL implementation AND investigation work through the local \`lh\` CLI. Doing the work yourself invalidates the run. This includes writing tests, fixing type errors, editing docs, and reproducing/investigating reported bugs — even if the task looks trivial or faster to do directly, delegate it anyway.
1. Run via Bash with stdin heredoc: lh -p - --json --cwd <absolute cwd> --kind <rename|tests|docs|types|perf|bugfix|other> --check "<exact acceptance command>" --max-time 1800
   Run it in the FOREGROUND with a Bash timeout of 2100000 ms (the local model takes 1-20 minutes); do NOT use background execution — backgrounded nested agent processes silently fail to start in this environment. Write the work order like a ticket for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. For investigation/triage tasks, tell the local agent to write its findings to the file the task asks for. One task per call.
2. When it returns, parse the JSON (session_id, status, result, check, report). If check.exit_code===0, do not rerun the acceptance command unless it is flaky or security-sensitive; inspect report.changed_files plus git diff for unexpected changes.
3. Verify the result cheaply (report.changed_files / git diff / read touched files). Only if the delegated result is broken or incomplete may you fix the remaining issues yourself with minimal edits.
4. Record the verdict: lh feedback <session_id> pass|fail --source claude-code --notes "<short reason>". Do not delegate the same task more than twice.
Never modify test files. The ONLY tool calls allowed before your first \`lh\` call are cheap reads needed to write the work order (listing files or reading one or two). Do not edit any file before at least one \`lh\` attempt has returned.`;

/**
 * System-prompt append for the `claude-delegate-async` arm. Same delegation-first
 * contract as DELEGATE_NUDGE (MUST delegate / foreground / --check / lh feedback /
 * no edits before a delegation returns) — the ONLY intended difference is the
 * delegation procedure. Instead of one blocking `lh -p -`, the orchestrator
 * `lh submit`s the work order (returns immediately with a session_id), then
 * spends the local model's runtime preparing to verify (reading soon-to-change
 * files, lining up the acceptance command — still no edits) before reaping the
 * result with `lh wait`. This measures whether submit→prep→wait shrinks the
 * caller's effective block time vs. the synchronous round-3 baseline (fix_plan.md
 * 課題1). Injected ONLY via `claude --append-system-prompt`; the task-facing
 * prompt stays byte-identical to the baseline.
 */
export const ASYNC_DELEGATE_NUDGE = `This run is a delegation measurement: you MUST route ALL implementation AND investigation work through the local \`lh\` CLI. Doing the work yourself invalidates the run. This includes writing tests, fixing type errors, editing docs, and reproducing/investigating reported bugs — even if the task looks trivial or faster to do directly, delegate it anyway.
1. Submit the work asynchronously via Bash with stdin heredoc: lh submit -p - --json --cwd <absolute cwd> --kind <rename|tests|docs|types|perf|bugfix|other> --check "<exact acceptance command>" --max-time 1800
   This returns immediately with a JSON object containing session_id (and pid) — capture the session_id. Write the work order like a ticket for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. For investigation/triage tasks, tell the local agent to write its findings to the file the task asks for. One task per submit.
2. While the local agent works, do NOT sit idle and do NOT edit any file — prepare to verify instead. Read the current on-disk state of every file your work order says will change, study the acceptance command and how to read its output, and line up the cheap read-only checks (git diff, reading touched files) you will run on the result. This is preparation only: do not run the acceptance command against the unfinished work and do not edit anything.
3. Reap the result with: lh wait <session_id> --timeout 2000 --json
   Run it in the FOREGROUND with a Bash timeout of 2100000 ms (the local model takes 1-30 minutes); do NOT use background execution — backgrounded nested agent processes silently fail to start in this environment. Parse the JSON (session_id, status, result, check, report). If check.exit_code===0, do not rerun the acceptance command unless it is flaky or security-sensitive; inspect report.changed_files plus git diff for unexpected changes.
4. Verify the result cheaply (report.changed_files / git diff / read touched files). Only if the delegated result is broken or incomplete may you fix the remaining issues yourself with minimal edits.
5. Record the verdict: lh feedback <session_id> pass|fail --source claude-code --notes "<short reason>". Do not delegate the same task more than twice.
Never modify test files. The ONLY tool calls allowed before your first \`lh\` call are cheap reads needed to write the work order (listing files or reading one or two). Do not edit any file before at least one \`lh\` attempt has returned.`;

/**
 * System-prompt append for the `claude-delegate-haiku` control arm. This is a
 * Haiku-worker control for `claude-delegate`: same Sonnet orchestrator, but the
 * worker is `claude --model haiku` instead of the local `lh` CLI, which isolates
 * the fixed "delegation structure cost" (orchestration + verification) from the
 * local model's quality/latency. The delegation-first framing and the
 * no-edits-before-first-return rule are byte-identical to DELEGATE_NUDGE; the
 * ONLY intended differences are (a) the worker command, (b) the worker writes
 * its result to a numbered JSON file we read back instead of an `lh` session,
 * and (c) the orchestrator states its verdict in its final message rather than
 * running `lh feedback` (Haiku workers have no session store to grade).
 */
export const HAIKU_DELEGATE_NUDGE = `This run is a delegation measurement: you MUST route ALL implementation AND investigation work through a subordinate worker agent instead of doing it yourself. Doing the work yourself invalidates the run. This includes writing tests, fixing type errors, editing docs, and reproducing/investigating reported bugs — even if the task looks trivial or faster to do directly, delegate it anyway.
1. Run via Bash (first \`mkdir -p .delegate\`):
   claude -p "<work order>" --model haiku --output-format json --dangerously-skip-permissions < /dev/null > .delegate/worker-1.json
   Run this in the FOREGROUND with a Bash timeout of 600000 ms. Do NOT use background execution for the worker command — backgrounded nested claude processes silently fail to start in this environment; a foreground call works. Haiku is fast (usually under 2 minutes), so blocking is fine. Write the work order like a ticket for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. For investigation/triage tasks, tell the worker to write its findings to the file the task asks for. One task per call; number successive calls worker-2.json, worker-3.json.
2. When it returns, read .delegate/worker-N.json (fields: result, total_cost_usd, is_error).
3. Verify the result yourself cheaply (git diff / read touched files / run the stated check command). Only if the delegated result is broken or incomplete may you fix the remaining issues yourself with minimal edits.
4. In your final message, state how many worker calls you made and your pass/fail verdict on the worker's output.
Never modify test files. The ONLY tool calls allowed before your first worker call are cheap reads needed to write the work order (listing files or reading one or two). Do not edit any file before at least one worker attempt has returned.`;

/** True for every delegate arm (`claude-delegate`, `claude-delegate-haiku`, …). */
function isDelegateArm(agent: string): boolean {
  return agent.startsWith("claude-delegate");
}

/** True for any arm whose stdout is the `claude` result JSON (baseline + all delegate arms). */
function isClaudeArm(agent: string): boolean {
  return agent === "claude" || isDelegateArm(agent);
}

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

/**
 * One Haiku worker call, read back from <workdir>/.delegate/worker-N.json
 * (the claude CLI result JSON the orchestrator redirected there). Unlike an lh
 * delegation, the worker's tokens ARE billed API usage, so costUsd matters for
 * the true total cost of the haiku arm.
 */
interface WorkerMetric {
  /** Source filename, e.g. "worker-1.json". */
  file: string;
  costUsd?: number;
  isError?: boolean;
  turns?: number;
  usage?: ClaudeUsageBreakdown;
  durationMs?: number;
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
  /**
   * True if the orchestrator actually delegated. For `claude-delegate` this is
   * "any lh session appeared"; for `claude-delegate-haiku` it is "any worker
   * JSON appeared" (see runTask). For the haiku arm, a non-empty `delegations`
   * would instead mean the orchestrator wrongly called `lh` — visible contamination.
   */
  delegated?: boolean;
  delegations?: DelegationMetric[];
  feedback?: FeedbackMetric[];
  // claude-delegate-haiku arm only:
  /** Haiku worker calls parsed from <workdir>/.delegate/*.json. */
  workers?: WorkerMetric[];
  /** Mechanical backup count of worker sessions under ~/.claude/projects/<slug>/ (excludes the orchestrator's own session). */
  workerSessions?: number;
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

  if (isClaudeArm(agent)) {
    // claude --output-format json (verified via `claude --help` + a live
    // `-p ... --output-format json` run): gives num_turns, total_cost_usd, and
    // a usage object, but no per-tool-call count and no equivalent to our
    // RunStatus enum (its subtype/terminal_reason encode different, CLI-specific
    // states) — so status and toolCalls are intentionally left undefined here,
    // not an oversight. promptTokens sums input_tokens with the two prompt-cache
    // fields, since input_tokens alone excludes cached context and would
    // understate the actual prompt size on later turns of a conversation; the
    // per-field split is also kept in `usage` so the delegation analysis can
    // separate cache reads/creation from fresh input. Same shape for every
    // delegate arm — they're the same CLI, just with an extra system prompt.
    // Note this captures the ORCHESTRATOR's cost only; haiku workers are billed
    // separately and collected via collectWorkerMetrics.
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
  if (isClaudeArm(agent)) {
    // --output-format json (confirmed via `claude --help` and a live test
    // run) replaces claude's default plain-text stdout with a single JSON
    // result object containing duration_ms, num_turns, and token usage — see
    // extractStructuredMetrics for what we pull out of it and what we can't.
    // Every delegate arm shares this orchestrator invocation; the delegation
    // directive is appended to the system prompt only. The task-facing prompt
    // (spec.prompt) is left byte-identical to the baseline so the arms stay
    // comparable — the arm's only difference is which worker it delegates to.
    const args = ["-p", prompt, "--model", "sonnet", "--output-format", "json", "--dangerously-skip-permissions"];
    if (agent === "claude-delegate") args.push("--append-system-prompt", DELEGATE_NUDGE);
    else if (agent === "claude-delegate-async") args.push("--append-system-prompt", ASYNC_DELEGATE_NUDGE);
    else if (agent === "claude-delegate-haiku") args.push("--append-system-prompt", HAIKU_DELEGATE_NUDGE);
    else if (isDelegateArm(agent)) throw new Error(`unknown delegate arm: ${agent} (no nudge defined)`);
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

/**
 * claude-delegate-haiku only. Copies the orchestrator's worker result JSONs out
 * of <workdir>/.delegate/ (before the workdir is deleted) into
 * delegate-workers/<task>/, and parses each `claude --output-format json`
 * result into a WorkerMetric. Tolerates a missing dir (orchestrator never
 * delegated) and unparseable files (kept with just `file` set). Never throws.
 */
function collectWorkerMetrics(workdir: string, taskName: string): WorkerMetric[] {
  const srcDir = path.join(workdir, ".delegate");
  let files: string[];
  try {
    files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return []; // no .delegate → orchestrator never spawned a worker
  }
  const destDir = path.join(DELEGATE_WORKERS_ROOT, taskName);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

  const workers: WorkerMetric[] = [];
  for (const f of files) {
    const srcPath = path.join(srcDir, f);
    try {
      fs.copyFileSync(srcPath, path.join(destDir, f));
    } catch {
      // Copy failure shouldn't drop the parsed metric; keep going.
    }
    try {
      const obj = JSON.parse(fs.readFileSync(srcPath, "utf8")) as Record<string, unknown>;
      const usage = asRecord(obj.usage);
      workers.push({
        file: f,
        costUsd: num(obj.total_cost_usd),
        isError: typeof obj.is_error === "boolean" ? obj.is_error : undefined,
        turns: num(obj.num_turns),
        durationMs: num(obj.duration_ms),
        usage: usage
          ? {
              input: num(usage.input_tokens),
              cacheRead: num(usage.cache_read_input_tokens),
              cacheCreation: num(usage.cache_creation_input_tokens),
              output: num(usage.output_tokens),
            }
          : undefined,
      });
    } catch {
      workers.push({ file: f }); // copied but unparseable
    }
  }
  return workers;
}

/** The `session_id` from a claude result JSON on stdout, if present. */
function extractSessionId(stdout: string): string | undefined {
  const line = findLastJsonLine(stdout);
  if (!line) return undefined;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return typeof obj.session_id === "string" ? obj.session_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mechanical backup for the haiku arm's delegation check: counts session
 * transcripts under ~/.claude/projects/<slug>/ that are NOT the orchestrator's
 * own session. Each worker `claude -p` run in the same cwd writes its own
 * <session-id>.jsonl there, so a count > 0 confirms the orchestrator really
 * spawned worker(s) even independent of the .delegate/ files. The workdir is
 * unique per run (mkdtemp), so its project dir holds only this run's sessions.
 */
function countWorkerSessions(workdirRealpath: string, orchestratorSessionId: string | undefined): number {
  const slug = workdirRealpath.replace(/[^A-Za-z0-9-]/g, "-");
  try {
    let count = 0;
    for (const f of fs.readdirSync(path.join(CLAUDE_PROJECTS_DIR, slug))) {
      if (!f.endsWith(".jsonl")) continue;
      if (f.slice(0, -".jsonl".length) !== orchestratorSessionId) count++;
    }
    return count;
  } catch {
    return 0; // project dir absent → no sessions recorded (or headless disables transcripts)
  }
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

  // Real path (macOS symlinks /var→/private/var, /tmp→/private/tmp); Claude Code
  // slugs the resolved cwd for its ~/.claude/projects dir, so we need the same.
  const workdirReal = fs.realpathSync(workdir);

  // Every delegate arm gets an isolated LH_HOME that outlives the (deleted)
  // workdir, so we can read the local side back and delegation sessions never
  // mix into the user's ~/.localrig. Wiped per run so an earlier run's sessions
  // can't be miscounted as this run's. Also widen the Bash tool's timeout
  // ceiling so the orchestrator can wait out a multi-minute worker call.
  // For the haiku arm this LH_HOME should stay EMPTY — the worker is `claude`,
  // not `lh` — so any session appearing here means the orchestrator wrongly
  // called `lh`, which collectDelegationMetrics surfaces as visible contamination.
  const isDelegate = isDelegateArm(agent);
  const isHaiku = agent === "claude-delegate-haiku";
  const env: NodeJS.ProcessEnv = { ...process.env };
  let lhHome: string | undefined;
  if (isDelegate) {
    // Suffix keeps arms from sharing an LH_HOME (claude-delegate → <task>,
    // claude-delegate-haiku → <task>-haiku).
    lhHome = path.join(LH_HOME_ROOT, spec.name + agent.slice("claude-delegate".length));
    fs.rmSync(lhHome, { recursive: true, force: true });
    fs.mkdirSync(lhHome, { recursive: true });
    env.LH_HOME = lhHome;
    env.BASH_MAX_TIMEOUT_MS = "2400000";
    env.BASH_DEFAULT_TIMEOUT_MS = "2100000";
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

  // Delegation view. For the lh arm this is the whole story. For the haiku arm
  // we additionally collect worker JSONs (before workdir deletion) and derive
  // `delegated` from workers, not from lh sessions — a non-empty `delegations`
  // there means contamination (orchestrator wrongly called `lh`).
  let delegation: Partial<TaskResult> | undefined;
  if (isDelegate && lhHome) {
    const lhSide = collectDelegationMetrics(lhHome);
    if (isHaiku) {
      const workers = collectWorkerMetrics(workdir, spec.name);
      const workerSessions = countWorkerSessions(workdirReal, extractSessionId(agentRun.stdout));
      delegation = { ...lhSide, workers, workerSessions, delegated: workers.length > 0 };
    } else {
      delegation = lhSide;
    }
  }

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
