import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult, WorkspaceScope } from "../types.ts";
import { clampToDeadline } from "../runtime/deadline.ts";
import { runProcess, runShellProcess, type ProcessOutcome } from "../runtime/process.ts";
import { prepareWorkspaceScope } from "./path-boundary.ts";

const HARD_MAX_TIMEOUT_MS = 600_000;

const SYSTEM_RUNTIME_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/usr/local",
  "/opt/homebrew",
  "/Library/Developer",
  "/Applications/Xcode.app",
] as const;

const TRUSTED_RUNTIME_NAMES = [
  "bun",
  "bunx",
  "node",
  "npm",
  "npx",
  "git",
  "rg",
  "python3",
  "python",
  "make",
  "cmake",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
] as const;

/** Minimal environment exposed to an untrusted local-model shell. */
export function sandboxEnvironment(cwd: string, tempDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: tempDir,
    TMPDIR: tempDir,
    PWD: cwd,
    LH_SANDBOX: "1",
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function existingRealpath(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function addAncestors(target: string, output: Set<string>): void {
  let current = path.resolve(target);
  for (;;) {
    output.add(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function trustedExecutables(source: NodeJS.ProcessEnv): string[] {
  const executables = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      executables.add(path.resolve(candidate));
      executables.add(fs.realpathSync(candidate));
    } catch {
      // Missing/non-executable PATH entries are intentionally ignored.
    }
  };
  add(process.execPath);
  const search = (source.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of TRUSTED_RUNTIME_NAMES) {
    for (const directory of search) {
      const candidate = path.resolve(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        add(candidate);
        break;
      } catch {
        // Continue to the next PATH directory.
      }
    }
  }
  return [...executables];
}

function filters(kind: "literal" | "subpath", paths: Iterable<string>): string[] {
  return [...new Set(paths)].map((entry) => `(${kind} ${sbplString(entry)})`);
}

/**
 * Walk every currently writable path without following symlinks. A regular
 * file with nlink > 1 could mutate an inode reachable outside the workspace,
 * so auto mode refuses to start while one exists. The returned fingerprint is
 * compared again immediately before spawn to narrow the audit/exec race.
 */
export function auditWritableScope(scope: WorkspaceScope): string {
  const hash = createHash("sha256");
  const visitedDirectories = new Set<string>();
  const files = new Map<string, string>();
  const protectedPath = (candidate: string) => scope.protectedPaths.some((entry) => isWithin(entry, candidate));
  const signature = (stat: fs.BigIntStats) =>
    `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

  const walk = (candidate: string): void => {
    if (protectedPath(candidate)) return;
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(candidate, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const before = signature(stat);
    hash.update(`${candidate}\0${before}\n`);
    if (stat.isFile() && stat.nlink > 1n) {
      throw new Error(`Refusing sandboxed bash: writable file has ${stat.nlink} hard links: ${candidate}`);
    }
    if (stat.isFile()) files.set(candidate, before);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;

    const identity = `${stat.dev}:${stat.ino}`;
    if (visitedDirectories.has(identity)) return;
    visitedDirectories.add(identity);
    for (const name of fs.readdirSync(candidate).sort()) walk(path.join(candidate, name));
    const after = fs.lstatSync(candidate, { bigint: true });
    if (signature(after) !== before) {
      throw new Error(`Refusing sandboxed bash: directory changed during security audit: ${candidate}`);
    }
  };

  for (const allowed of [...new Set(scope.allowedPaths)].sort()) walk(allowed);
  for (const [file, before] of files) {
    const after = fs.lstatSync(file, { bigint: true });
    if (after.nlink > 1n) {
      throw new Error(`Refusing sandboxed bash: writable file has ${after.nlink} hard links: ${file}`);
    }
    if (signature(after) !== before) {
      throw new Error(`Refusing sandboxed bash: file changed during security audit: ${file}`);
    }
  }
  return hash.digest("hex");
}

/** Build the macOS seatbelt policy used by every non-yolo bash call. */
export function buildMacSandboxProfile(scope: WorkspaceScope, tempDir: string, source: NodeJS.ProcessEnv = process.env): string {
  const privateGitPaths = scope.privateGitPaths ?? [];
  const writable = [...new Set([...scope.allowedPaths, tempDir, ...privateGitPaths])];
  const writableFilter = `(require-any ${writable.map((p) => `(subpath ${sbplString(p)})`).join(" ")})`;
  const runtimeRoots = SYSTEM_RUNTIME_ROOTS.map(existingRealpath).filter((value): value is string => value !== undefined);
  const executables = trustedExecutables(source);
  const readSubpaths = [...new Set([scope.cwd, tempDir, ...runtimeRoots, ...privateGitPaths])];
  const readLiterals = new Set<string>([
    "/",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
    "/private/etc/zshenv",
    "/private/etc/zprofile",
    "/private/etc/zlogin",
  ]);
  for (const target of [scope.cwd, tempDir, ...executables]) addAncestors(target, readLiterals);
  const allowedRead = `(require-any ${[
    ...filters("subpath", readSubpaths),
    ...filters("literal", readLiterals),
    ...filters("literal", executables),
  ].join(" ")})`;
  const allowedExec = `(require-any ${[
    ...filters("subpath", [scope.cwd, tempDir, ...runtimeRoots]),
    ...filters("literal", executables),
  ].join(" ")})`;
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    `(deny process-exec (require-not ${allowedExec}))`,
    `(allow process-exec ${allowedExec})`,
    "(deny signal (require-not (target self)))",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(deny network*)",
    `(deny file-read* (require-not ${allowedRead}))`,
    `(allow file-read* ${allowedRead})`,
    `(deny file-write* (require-not ${writableFilter}))`,
    `(allow file-write* ${writableFilter})`,
  ];
  if (scope.protectedPaths.length > 0) {
    lines.push(`(deny file-write* (require-any ${scope.protectedPaths.map((p) => `(subpath ${sbplString(p)})`).join(" ")}))`);
  }
  return lines.join("\n");
}

async function runHostShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  maxOutputChars: number,
  deadlineAt?: number,
): Promise<ProcessOutcome> {
  let result = await runShellProcess({
    shell: "zsh",
    command,
    cwd,
    timeoutMs,
    signal,
    maxOutputChars,
    spoolPrefix: "lh-bash",
  });
  if (result.spawnFailed) {
    result = await runShellProcess({
      shell: "sh",
      command,
      cwd,
      timeoutMs: clampToDeadline(timeoutMs, deadlineAt),
      signal,
      maxOutputChars,
      spoolPrefix: "lh-bash",
    });
  }
  return result;
}

export async function runSandboxedShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  scope: WorkspaceScope,
  maxOutputChars: number,
): Promise<ProcessOutcome | { unsupported: string } | { denied: string }> {
  if (process.platform !== "darwin") {
    return { unsupported: `sandboxed bash is unavailable on ${process.platform}; use --yolo only if host execution is explicitly intended` };
  }
  let auditBefore: string;
  try {
    auditBefore = auditWritableScope(scope);
  } catch (err) {
    return { denied: err instanceof Error ? err.message : String(err) };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sandbox-"));
  try {
    const profile = buildMacSandboxProfile(scope, tempDir);
    const env = sandboxEnvironment(cwd, tempDir);
    let auditImmediatelyBeforeSpawn: string;
    try {
      auditImmediatelyBeforeSpawn = auditWritableScope(scope);
    } catch (err) {
      return { denied: err instanceof Error ? err.message : String(err) };
    }
    if (auditBefore !== auditImmediatelyBeforeSpawn) {
      return { denied: "Refusing sandboxed bash: writable scope changed during the pre-execution security audit" };
    }
    return await runProcess({
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, "/bin/zsh", "-lc", command],
      cwd,
      timeoutMs,
      signal,
      env,
      maxOutputChars,
      spoolPrefix: "lh-bash",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
        timeoutMs = clampToDeadline(timeoutMs, ctx.deadlineAt);
        if (ctx.signal.aborted) {
          return { ok: false, output: ctx.deadlineAt !== undefined && Date.now() >= ctx.deadlineAt
            ? "[timed out before start]"
            : "[interrupted before start]" };
        }
        if (timeoutMs <= 0) {
          return { ok: false, output: "[timed out before start: command deadline reached]" };
        }

        const scope = ctx.scope ?? prepareWorkspaceScope(ctx.cwd);
        const execution = config.permissionMode === "yolo"
          ? await runHostShell(command, ctx.cwd, timeoutMs, ctx.signal, config.bashMaxChars, ctx.deadlineAt)
          : await runSandboxedShell(command, ctx.cwd, timeoutMs, ctx.signal, scope, config.bashMaxChars);
        if ("unsupported" in execution) return { ok: false, output: `[denied] ${execution.unsupported}` };
        if ("denied" in execution) return { ok: false, output: `[denied] ${execution.denied}` };
        const res = execution;
        if (res.spawnFailed) {
          return { ok: false, output: config.permissionMode === "yolo"
            ? "Could not start a shell (tried zsh and sh). Check the system environment."
            : "Could not start the macOS sandbox. Refusing unsandboxed fallback; use --yolo only for explicit host execution." };
        }

        let output = res.output.length > 0 ? res.output : "(no output)";

        let ok = true;
        const deadlineExpired = ctx.deadlineAt !== undefined && Date.now() >= ctx.deadlineAt;
        if (res.timedOut || deadlineExpired) {
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
