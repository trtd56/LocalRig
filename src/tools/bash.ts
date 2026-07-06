import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";

const HARD_MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;

interface RunOutcome {
  output: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnFailed: boolean;
}

function runShell(shell: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let aborted = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(shell, ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    // Merge stdout + stderr in arrival order.
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

    const onAbort = () => {
      aborted = true;
      killSoft();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (outcome: RunOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    proc.on("error", () => {
      finish({ output, code: null, timedOut, aborted, spawnFailed: true });
    });
    proc.on("close", (code) => {
      finish({ output, code, timedOut, aborted, spawnFailed: false });
    });
  });
}

/** Truncate to maxChars keeping head 60% + tail 40%; spool full output to a temp log. */
export function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const cut = output.length - head - tail;
  let spoolNote = "";
  try {
    const spool = path.join(os.tmpdir(), `lh-bash-${randomBytes(6).toString("hex")}.log`);
    writeFileSync(spool, output, "utf8");
    spoolNote = ` — full output saved to ${spool}; grep or read it`;
  } catch {
    spoolNote = " — pipe through head/tail/grep to see more";
  }
  return output.slice(0, head) + `\n… [${cut} chars truncated${spoolNote}] …\n` + output.slice(output.length - tail);
}

export function createBashTool(config: Config): ToolDef {
  return {
    name: "bash",
    mutating: true,
    description:
      "Run a shell command in the working directory and return its output. Args: command (required), timeout_ms (optional). " +
      'Example: {"command": "bun test 2>&1 | tail -20"}. ' +
      "State does NOT persist between calls — cd and exports are forgotten, so use absolute paths or `cd dir && cmd` in one call. " +
      "Prefer the read/grep/glob tools instead of cat/grep/find commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${config.bashTimeoutMs}, max ${HARD_MAX_TIMEOUT_MS})` },
      },
      required: ["command"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const command = args.command;
        if (typeof command !== "string" || command.trim().length === 0) {
          return { ok: false, output: 'Missing "command". Call bash like: {"command": "ls -la"}' };
        }
        ctx.report?.commandsRun.push(command.length > 500 ? command.slice(0, 497) + "..." : command);
        let timeoutMs = config.bashTimeoutMs;
        const t = args.timeout_ms;
        if (typeof t === "number" && Number.isFinite(t) && t > 0) {
          timeoutMs = Math.min(Math.floor(t), HARD_MAX_TIMEOUT_MS);
        }
        if (ctx.signal.aborted) {
          return { ok: false, output: "[interrupted before start]" };
        }

        let res = await runShell("zsh", command, ctx.cwd, timeoutMs, ctx.signal);
        if (res.spawnFailed) {
          res = await runShell("sh", command, ctx.cwd, timeoutMs, ctx.signal);
        }
        if (res.spawnFailed) {
          return { ok: false, output: "Could not start a shell (tried zsh and sh). Check the system environment." };
        }

        let output = res.output.length > 0 ? res.output : "(no output)";
        output = truncateOutput(output, config.bashMaxChars);

        let ok = true;
        if (res.timedOut) {
          output += `\n[killed: timed out after ${timeoutMs} ms — raise timeout_ms or run a faster command]`;
          ok = false;
        } else if (res.aborted) {
          output += "\n[interrupted by user]";
          ok = false;
        } else if (res.code !== 0) {
          output += `\n[exit code ${res.code}]`;
          ok = false;
        }

        const shortCmd = command.length > 60 ? command.slice(0, 57) + "..." : command;
        return { ok, output, display: `$ ${shortCmd}` };
      } catch (err) {
        return { ok: false, output: `bash failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
