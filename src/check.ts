import { spawn } from "node:child_process";
import type { CheckRecord } from "./session.ts";

const KILL_GRACE_MS = 2_000;
const OUTPUT_TAIL_CHARS = 2_000;

interface ShellOutcome {
  output: string;
  code: number | null;
  timedOut: boolean;
  spawnFailed: boolean;
}

export function buildCheckRepairPrompt(check: CheckRecord): string {
  const output = check.output_tail.trim() || "(no output)";
  return (
    "[system] The acceptance check failed. Fix the issue, then finish normally.\n" +
    `Command: ${check.command}\n` +
    `Exit code: ${check.exit_code === null ? "unknown" : check.exit_code}\n` +
    `Output tail:\n${output}`
  );
}

export function canRetryCheck(params: {
  attempts: number;
  maxRetries: number;
  startedAtMs: number;
  maxTimeMs: number;
  nowMs?: number;
}): boolean {
  if (params.attempts > params.maxRetries) return false;
  if (params.maxTimeMs <= 0) return true;
  return (params.nowMs ?? Date.now()) - params.startedAtMs < params.maxTimeMs;
}

export async function runCheckCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
  attempts: number;
}): Promise<CheckRecord> {
  let res = await runShell("zsh", params.command, params.cwd, params.timeoutMs);
  if (res.spawnFailed) res = await runShell("sh", params.command, params.cwd, params.timeoutMs);
  let output = res.output;
  if (res.spawnFailed) output += "Could not start a shell (tried zsh and sh).";
  if (res.timedOut) output += `\n[killed: timed out after ${params.timeoutMs} ms]`;
  return {
    command: params.command,
    exit_code: res.spawnFailed ? null : res.code,
    attempts: params.attempts,
    output_tail: tail(output.length > 0 ? output : "(no output)", OUTPUT_TAIL_CHARS),
    timed_out: res.timedOut || undefined,
  };
}

function runShell(shell: string, command: string, cwd: string, timeoutMs: number): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(shell, ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);

    const killSoft = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      graceTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killSoft();
    }, timeoutMs);

    const finish = (outcome: ShellOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(outcome);
    };

    proc.on("error", () => {
      finish({ output, code: null, timedOut, spawnFailed: true });
    });
    proc.on("close", (code) => {
      finish({ output, code, timedOut, spawnFailed: false });
    });
  });
}

function tail(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(s.length - maxChars);
}
