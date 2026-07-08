import type { CheckRecord } from "./session.ts";
import { clampToDeadline } from "./runtime/deadline.ts";
import { runShellProcess } from "./runtime/process.ts";
import type { WorkspaceScope } from "./types.ts";
import { runSandboxedShell } from "./tools/bash.ts";
import { prepareWorkspaceScope } from "./tools/path-boundary.ts";

const OUTPUT_TAIL_CHARS = 2_000;
// Keep the bounded head/tail view (including its spool path) inside the saved
// CheckRecord tail. The complete stream itself is written incrementally.
const CAPTURE_CHARS = 1_800;

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
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Run acceptance code under the same write/read boundary as agent bash. */
  sandbox?: boolean;
  scope?: WorkspaceScope;
}): Promise<CheckRecord> {
  const timeoutMs = clampToDeadline(params.timeoutMs, params.deadlineAt);
  if (params.signal?.aborted || timeoutMs <= 0) {
    return {
      command: params.command,
      exit_code: null,
      attempts: params.attempts,
      output_tail: params.signal?.aborted ? "[interrupted before check started]" : "[check deadline reached before start]",
      timed_out: timeoutMs <= 0 || undefined,
    };
  }
  const signal = params.signal ?? new AbortController().signal;
  if (params.sandbox) {
    const execution = await runSandboxedShell(
      params.command,
      params.cwd,
      timeoutMs,
      signal,
      params.scope ?? prepareWorkspaceScope(params.cwd),
      CAPTURE_CHARS,
    );
    if ("unsupported" in execution || "denied" in execution) {
      const reason = "unsupported" in execution ? execution.unsupported : execution.denied;
      return {
        command: params.command,
        exit_code: null,
        attempts: params.attempts,
        output_tail: `[denied] ${reason}`,
      };
    }
    const res = execution;
    let output = res.output;
    if (res.spawnFailed) output += "Could not start the macOS check sandbox.";
    const deadlineExpired = params.deadlineAt !== undefined && Date.now() >= params.deadlineAt;
    if (res.timedOut || deadlineExpired) output += `\n[killed: timed out after ${timeoutMs} ms]`;
    else if (res.aborted) output += "\n[interrupted]";
    return {
      command: params.command,
      exit_code: res.spawnFailed ? null : res.code,
      attempts: params.attempts,
      output_tail: tail(output.length > 0 ? output : "(no output)", OUTPUT_TAIL_CHARS),
      timed_out: res.timedOut || deadlineExpired || undefined,
    };
  }

  let res = await runShellProcess({
    shell: "zsh",
    command: params.command,
    cwd: params.cwd,
    timeoutMs,
    signal,
    maxOutputChars: CAPTURE_CHARS,
    spoolPrefix: "lh-check",
  });
  if (res.spawnFailed) {
    res = await runShellProcess({
      shell: "sh",
      command: params.command,
      cwd: params.cwd,
      timeoutMs: clampToDeadline(timeoutMs, params.deadlineAt),
      signal,
      maxOutputChars: CAPTURE_CHARS,
      spoolPrefix: "lh-check",
    });
  }
  let output = res.output;
  if (res.spawnFailed) output += "Could not start a shell (tried zsh and sh).";
  const deadlineExpired = params.deadlineAt !== undefined && Date.now() >= params.deadlineAt;
  if (res.timedOut || deadlineExpired) output += `\n[killed: timed out after ${timeoutMs} ms]`;
  else if (res.aborted) output += "\n[interrupted]";
  return {
    command: params.command,
    exit_code: res.spawnFailed ? null : res.code,
    attempts: params.attempts,
    output_tail: tail(output.length > 0 ? output : "(no output)", OUTPUT_TAIL_CHARS),
    timed_out: res.timedOut || deadlineExpired || undefined,
  };
}

function tail(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(s.length - maxChars);
}
