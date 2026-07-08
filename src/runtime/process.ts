import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_KILL_GRACE_MS = 250;
export const DEFAULT_MAX_SPOOL_BYTES = 16 * 1024 * 1024;

export interface ProcessOutcome {
  output: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnFailed: boolean;
  truncated: boolean;
  spoolPath?: string;
  /** Full-output spool hit its strict byte cap and the producer was stopped. */
  outputLimitExceeded: boolean;
  /** Spooling failed (for example ENOSPC); the producer was stopped. */
  spoolFailed: boolean;
  durationMs: number;
}

export interface RunShellOptions {
  shell: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  spoolPrefix: string;
  maxSpoolBytes?: number;
  /** Defaults to true. False keeps draining output after the spool is capped. */
  killOnOutputLimit?: boolean;
  /** Defaults to true. */
  killOnSpoolFailure?: boolean;
  killGraceMs?: number;
}

export interface RunProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  spoolPrefix: string;
  maxSpoolBytes?: number;
  killOnOutputLimit?: boolean;
  killOnSpoolFailure?: boolean;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

class BoundedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = "";
  private tail = "";
  private totalChars = 0;
  private fd: number | undefined;
  private path: string | undefined;
  private spoolUnavailable = false;
  private spooledBytes = 0;
  private _limitExceeded = false;
  private _spoolFailed = false;

  constructor(
    private readonly maxChars: number,
    private readonly spoolPrefix: string,
    private readonly maxSpoolBytes: number,
  ) {
    this.headLimit = Math.floor(Math.max(0, maxChars) * 0.6);
    this.tailLimit = Math.max(0, maxChars) - this.headLimit;
  }

  append(chunk: Buffer): "limit" | "error" | undefined {
    // Spool incrementally before decoding/truncating. No complete output copy
    // is ever retained in RAM, even for an indefinitely noisy child process.
    if (!this._limitExceeded && !this._spoolFailed) this.ensureSpool();
    if (this.fd !== undefined && !this._limitExceeded) {
      try {
        const remaining = Math.max(0, this.maxSpoolBytes - this.spooledBytes);
        const toWrite = Math.min(remaining, chunk.length);
        let offset = 0;
        while (offset < toWrite) {
          const written = writeSync(this.fd, chunk, offset, toWrite - offset);
          if (written <= 0) throw new Error("short spool write");
          offset += written;
        }
        this.spooledBytes += offset;
        if (chunk.length > remaining) {
          this._limitExceeded = true;
          this.closeSpool();
        } else if (this.spooledBytes >= this.maxSpoolBytes) {
          // Close at the cap. A later byte marks the stream as exceeded.
          this.closeSpool();
        }
      } catch {
        this.closeSpool();
        this.removeSpool();
        this.spoolUnavailable = true;
        this._spoolFailed = true;
      }
    } else if (!this._spoolFailed && chunk.length > 0 && this.spooledBytes >= this.maxSpoolBytes) {
      this._limitExceeded = true;
    }

    const text = chunk.toString("utf8");
    this.totalChars += text.length;
    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      this.head += text.slice(0, needed);
    }
    if (this.tailLimit > 0) {
      if (text.length >= this.tailLimit) this.tail = text.slice(-this.tailLimit);
      else this.tail = (this.tail + text).slice(-this.tailLimit);
    }
    if (this._spoolFailed) return "error";
    if (this._limitExceeded) return "limit";
    return undefined;
  }

  get limitExceeded(): boolean {
    return this._limitExceeded;
  }

  get spoolFailed(): boolean {
    return this._spoolFailed;
  }

  finish(): { output: string; truncated: boolean; spoolPath?: string } {
    this.closeSpool();
    const truncated = this.totalChars > this.maxChars;
    if (!truncated) {
      const overlap = Math.max(0, this.head.length + this.tail.length - this.totalChars);
      const output = this.head.length >= this.totalChars
        ? this.head.slice(0, this.totalChars)
        : this.head + this.tail.slice(overlap);
      this.removeSpool();
      return { output, truncated: false };
    }

    const cut = Math.max(0, this.totalChars - this.head.length - this.tail.length);
    const note = this.path
      ? ` — full output saved to ${this.path}; grep or read it`
      : " — pipe through head/tail/grep to see more";
    return {
      output: `${this.head}\n… [${cut} chars truncated${note}] …\n${this.tail}`,
      truncated: true,
      spoolPath: this.path,
    };
  }

  private ensureSpool(): void {
    if (this.spoolUnavailable || this.fd !== undefined || this.path !== undefined) return;
    if (this.maxSpoolBytes <= 0) {
      this._limitExceeded = true;
      return;
    }
    try {
      this.path = path.join(os.tmpdir(), `${this.spoolPrefix}-${randomBytes(6).toString("hex")}.log`);
      this.fd = openSync(this.path, "wx", 0o600);
    } catch {
      this.fd = undefined;
      this.path = undefined;
      this.spoolUnavailable = true;
      this._spoolFailed = true;
    }
  }

  private closeSpool(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed or the filesystem disappeared; the bounded output is
      // still usable even when the diagnostic spool is unavailable.
    }
    this.fd = undefined;
  }

  private removeSpool(): void {
    if (!this.path) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Best-effort cleanup only.
    }
    this.path = undefined;
  }
}

/** Snapshot descendants before the root is killed, including new process groups. */
function discoverDescendants(rootPid: number): number[] {
  if (process.platform === "win32" || rootPid <= 1) return [];
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (pid <= 1 || pid === process.pid || seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

/**
 * Run a shell in its own process group. Cancellation first sends TERM to the
 * whole tree, then KILL after a short grace period (including descendants that
 * ignore TERM or outlive their shell). Windows uses taskkill /T, then /F /T.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessOutcome> {
  const started = Date.now();
  if (options.signal?.aborted || options.timeoutMs <= 0) {
    return Promise.resolve({
      output: "",
      code: null,
      timedOut: !options.signal?.aborted,
      aborted: options.signal?.aborted ?? false,
      spawnFailed: false,
      truncated: false,
      outputLimitExceeded: false,
      spoolFailed: false,
      durationMs: Date.now() - started,
    });
  }

  return new Promise((resolve) => {
    const maxSpoolBytes = Number.isFinite(options.maxSpoolBytes)
      ? Math.max(0, Math.floor(options.maxSpoolBytes!))
      : DEFAULT_MAX_SPOOL_BYTES;
    const output = new BoundedOutput(Math.max(1, options.maxOutputChars), options.spoolPrefix, maxSpoolBytes);
    let timedOut = false;
    let aborted = false;
    let spawnFailed = false;
    let done = false;
    let terminating = false;
    let outputLimitExceeded = false;
    let spoolFailed = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const trackedDescendants = new Set<number>();
    const graceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

    const proc = spawn(options.executable, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const killTree = (force: boolean): void => {
      if (!proc.pid) return;
      if (process.platform === "win32") {
        const args = ["/pid", String(proc.pid), "/t"];
        if (force) args.push("/f");
        try {
          const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
          killer.once("error", () => {
            try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
          });
          killer.unref();
        } catch {
          try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
        }
        return;
      }
      for (const pid of discoverDescendants(proc.pid)) trackedDescendants.add(pid);
      try {
        process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
      }
      // A descendant may have called setsid()/setpgid() and escaped the root's
      // process group. Kill every PID captured while it was still parented.
      for (const pid of trackedDescendants) {
        try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
      }
    };

    const terminate = (immediate: boolean): void => {
      if (!terminating) {
        terminating = true;
        killTree(false);
      }
      if (immediate) {
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        forceTimer = undefined;
        killTree(true);
      } else if (forceTimer === undefined) {
        forceTimer = setTimeout(() => killTree(true), graceMs);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(false);
    }, Math.max(1, Math.floor(options.timeoutMs)));

    const onAbort = (): void => {
      aborted = true;
      // The caller may return/exit as soon as its AbortSignal fires. Escalate
      // synchronously so detached TERM-ignoring descendants cannot escape.
      terminate(true);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the spawn/listener race if cancellation happened between the
    // function's initial check and listener registration.
    if (options.signal?.aborted) onAbort();

    const onOutput = (chunk: Buffer): void => {
      const issue = output.append(chunk);
      if (!issue) return;
      if (issue === "limit") {
        outputLimitExceeded = true;
        if (options.killOnOutputLimit !== false) terminate(true);
      } else {
        spoolFailed = true;
        if (options.killOnSpoolFailure !== false) terminate(true);
      }
    };
    proc.stdout?.on("data", onOutput);
    proc.stderr?.on("data", onOutput);

    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      // The shell can exit on TERM before a detached/redirected descendant.
      // Reap the whole group before resolving so no background work escapes.
      if (terminating) killTree(true);
      options.signal?.removeEventListener("abort", onAbort);
      const captured = output.finish();
      let rendered = captured.output;
      if (outputLimitExceeded || output.limitExceeded) {
        const action = options.killOnOutputLimit === false ? "" : "killed: ";
        rendered += `\n[${action}output spool limit ${maxSpoolBytes} bytes exceeded]`;
      } else if (spoolFailed || output.spoolFailed) {
        const action = options.killOnSpoolFailure === false ? "" : "killed: ";
        rendered += `\n[${action}output spool failed; possible disk exhaustion]`;
      }
      resolve({
        ...captured,
        output: rendered,
        code,
        timedOut,
        aborted,
        spawnFailed,
        outputLimitExceeded: outputLimitExceeded || output.limitExceeded,
        spoolFailed: spoolFailed || output.spoolFailed,
        durationMs: Date.now() - started,
      });
    };

    proc.on("error", () => {
      spawnFailed = true;
      finish(null);
    });
    proc.on("close", (code) => finish(code));
  });
}

export function runShellProcess(options: RunShellOptions): Promise<ProcessOutcome> {
  return runProcess({
    executable: options.shell,
    args: ["-lc", options.command],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    maxOutputChars: options.maxOutputChars,
    spoolPrefix: options.spoolPrefix,
    maxSpoolBytes: options.maxSpoolBytes,
    killOnOutputLimit: options.killOnOutputLimit,
    killOnSpoolFailure: options.killOnSpoolFailure,
    killGraceMs: options.killGraceMs,
  });
}
