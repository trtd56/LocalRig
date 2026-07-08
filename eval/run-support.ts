import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CacheState = "cold" | "warm";

export interface RunOptions {
  agents: string[];
  only?: Set<string>;
  keep: boolean;
  runId?: string;
  repeat: number;
  orderSeed: string;
}

export interface RunPlanRound {
  repetition: number;
  runId?: string;
  armOrder: string[];
}

export interface EnvironmentMetadata {
  capturedAt: string;
  platform: string;
  release: string;
  arch: string;
  git: {
    commit: string | null;
    dirty: boolean | null;
    error: string | null;
  };
  model: {
    name: string;
    digest: string | null;
    quantization: string | null;
    error: string | null;
  };
  ollama: {
    version: string | null;
    error: string | null;
  };
  gpu: {
    name: string | null;
    details: string | null;
    error: string | null;
  };
  caller: {
    name: string;
    version: string | null;
    error: string | null;
  };
  claudeCli: {
    version: string | null;
    error: string | null;
  };
}

export interface RunMetadata {
  experimentId: string | null;
  runId: string | null;
  repetition: number;
  repeat: number;
  orderSeed: string;
  armOrder: string[];
  armPosition: number;
  sequenceInArm: number;
  cacheState: CacheState;
  environment: EnvironmentMetadata;
}

export const MAX_REPEAT = 1_000;

export function parseRunArgs(argv: string[]): RunOptions {
  let agents = ["harness"];
  let only: Set<string> | undefined;
  let keep = false;
  let runId: string | undefined;
  let repeat = 1;
  let orderSeed = "0";

  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--agent" || arg === "--arms") {
      agents = valueAfter(i, arg).split(",").map((value) => value.trim()).filter(Boolean);
      i++;
    } else if (arg === "--task") {
      only = new Set(valueAfter(i, arg).split(",").map((value) => value.trim()).filter(Boolean));
      i++;
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "--run-id") {
      runId = valueAfter(i, arg);
      i++;
    } else if (arg === "--repeat") {
      const raw = valueAfter(i, arg);
      repeat = Number(raw);
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
        throw new Error(`--repeat must be an integer in [1, ${MAX_REPEAT}] (received ${raw})`);
      }
      i++;
    } else if (arg === "--seed" || arg === "--order-seed") {
      orderSeed = valueAfter(i, arg);
      i++;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  agents = [...new Set(agents)];
  if (agents.length === 0) throw new Error("at least one --agent/--arms value is required");
  if (runId !== undefined) validateRunId(runId);
  return { agents, only, keep, runId, repeat, orderSeed };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededArmOrder(agents: string[], seed: string): string[] {
  const result = [...agents];
  const random = mulberry32(hashSeed(seed));
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export const MAX_RUN_ID_LENGTH = 128;

/** Run ids are path components in several result locations; never normalize. */
export function validateRunId(runId: string): string {
  if (!runId || runId.length > MAX_RUN_ID_LENGTH) {
    throw new Error(`--run-id must contain 1-${MAX_RUN_ID_LENGTH} characters`);
  }
  if (runId === "." || runId === ".." || /[\x00-\x1f\x7f/\\]/.test(runId)) {
    throw new Error("--run-id must not contain dot segments, path separators, or control characters");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(runId)) {
    throw new Error("--run-id must use alphanumeric, underscore, hyphen, and non-empty dot-separated segments");
  }
  return runId;
}

export function safeRunId(runId: string | undefined): string | undefined {
  return runId === undefined ? undefined : validateRunId(runId);
}

export function generatedExperimentId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
}

export function buildRunPlan(options: RunOptions, generatedId = generatedExperimentId()): RunPlanRound[] {
  const baseOrder = seededArmOrder(options.agents, options.orderSeed);
  const experimentId = options.runId !== undefined
    ? validateRunId(options.runId)
    : options.repeat > 1
      ? validateRunId(generatedId)
      : undefined;
  return Array.from({ length: options.repeat }, (_, index) => {
    const offset = baseOrder.length === 0 ? 0 : index % baseOrder.length;
    const armOrder = baseOrder.slice(offset).concat(baseOrder.slice(0, offset));
    const runId =
      options.repeat === 1
        ? options.runId
        : `${experimentId}.r${String(index + 1).padStart(Math.max(3, String(options.repeat).length), "0")}`;
    return { repetition: index + 1, runId: runId === undefined ? undefined : validateRunId(runId), armOrder };
  });
}

interface CommandOutput {
  ok: boolean;
  stdout: string;
  error: string | null;
}

function command(command: string, args: string[], cwd: string): CommandOutput {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (result.error) return { ok: false, stdout, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stdout, error: stderr || `${command} exited ${result.status ?? "without a status"}` };
  }
  return { ok: true, stdout, error: null };
}

function parseOllamaModel(model: string, cwd: string): {
  digest: string | null;
  quantization: string | null;
  error: string | null;
} {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const tagsBase = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/$/, "");
  const tagsUrl = `${tagsBase}/api/tags`;
  const tags = command("curl", ["--fail", "--silent", "--max-time", "3", tagsUrl], cwd);
  const listed = command("ollama", ["list"], cwd);
  const shown = command("ollama", ["show", model], cwd);
  let digest: string | null = null;
  if (tags.ok) {
    try {
      const parsed = JSON.parse(tags.stdout) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
      const wanted = model.includes(":") ? model : `${model}:latest`;
      const match = parsed.models?.find((entry) => entry.name === model || entry.name === wanted || entry.model === model || entry.model === wanted);
      digest = typeof match?.digest === "string" ? match.digest : null;
    } catch {
      // The human-readable list below is still a useful short-digest fallback.
    }
  }
  if (listed.ok) {
    const wanted = model.includes(":") ? model : `${model}:latest`;
    for (const line of listed.stdout.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[0] === model || columns[0] === wanted) {
        digest ??= columns[1] ?? null;
        break;
      }
    }
  }
  let quantization: string | null = null;
  if (shown.ok) {
    const match = shown.stdout.match(/^\s*quantization\s+(.+?)\s*$/im);
    quantization = match?.[1]?.trim() ?? null;
  }
  const errors = [
    tags.ok || digest ? null : `ollama tags API: ${tags.error}`,
    listed.ok ? null : `ollama list: ${listed.error}`,
    shown.ok ? null : `ollama show: ${shown.error}`,
  ].filter(
    (value): value is string => value !== null,
  );
  if (!digest && listed.ok) errors.push(`model ${model} was not present in ollama list`);
  if (!quantization && shown.ok) errors.push(`quantization was absent from ollama show ${model}`);
  return { digest, quantization, error: errors.length > 0 ? errors.join("; ") : null };
}

function captureGpu(cwd: string): { name: string | null; details: string | null; error: string | null } {
  if (process.platform === "darwin") {
    const result = command("system_profiler", ["SPDisplaysDataType", "-json"], cwd);
    if (!result.ok) return { name: null, details: null, error: result.error };
    try {
      const parsed = JSON.parse(result.stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
      const adapters = parsed.SPDisplaysDataType ?? [];
      const names = adapters.map((entry) => entry._name).filter((name): name is string => typeof name === "string");
      return {
        name: names.length > 0 ? names.join(", ") : null,
        details: JSON.stringify(adapters),
        error: names.length > 0 ? null : "system_profiler returned no GPU names",
      };
    } catch (error) {
      return { name: null, details: null, error: `invalid system_profiler JSON: ${String(error)}` };
    }
  }
  const result = command("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], cwd);
  return result.ok
    ? { name: result.stdout.split("\n")[0]?.split(",")[0]?.trim() || null, details: result.stdout, error: null }
    : { name: null, details: null, error: result.error };
}

export function captureEnvironmentMetadata(agent: string, model: string, cwd: string): EnvironmentMetadata {
  const commit = command("git", ["rev-parse", "HEAD"], cwd);
  const status = command("git", ["status", "--porcelain"], cwd);
  const ollamaVersion = command("ollama", ["--version"], cwd);
  const claudeVersion = command("claude", ["--version"], cwd);
  const bunVersion = command("bun", ["--version"], cwd);
  const localModel =
    agent === "harness" ||
    (agent.startsWith("claude-delegate") && agent !== "claude-delegate-haiku") ||
    agent === "claude-scout" ||
    agent === "claude-research";
  const modelInfo = localModel
    ? parseOllamaModel(model, cwd)
    : { digest: null, quantization: null, error: `agent ${agent} does not use a local Ollama model` };
  const gpu = captureGpu(cwd);
  const gitErrors = [commit.ok ? null : `commit: ${commit.error}`, status.ok ? null : `dirty: ${status.error}`].filter(
    (value): value is string => value !== null,
  );
  const callerName = process.env.LH_EVAL_CALLER ?? "eval/run.ts";
  const callerVersion =
    process.env.LH_EVAL_CALLER_VERSION ?? (callerName === "eval/run.ts" ? (bunVersion.stdout || null) : null);
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    git: {
      commit: commit.ok ? commit.stdout : null,
      dirty: status.ok ? status.stdout.length > 0 : null,
      error: gitErrors.length > 0 ? gitErrors.join("; ") : null,
    },
    model: { name: model, ...modelInfo },
    ollama: { version: ollamaVersion.ok ? ollamaVersion.stdout : null, error: ollamaVersion.error },
    gpu,
    caller: {
      name: callerName,
      version: callerVersion,
      error:
        callerVersion !== null
          ? null
          : callerName === "eval/run.ts"
            ? bunVersion.error ?? "Bun version was unavailable"
            : "LH_EVAL_CALLER_VERSION was not supplied",
    },
    claudeCli: {
      version: claudeVersion.ok ? claudeVersion.stdout : null,
      error: claudeVersion.error,
    },
  };
}

const summaryLockWait = new Int32Array(new SharedArrayBuffer(4));

interface SummaryLock {
  fd: number;
  dev: number;
  ino: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireSummaryLock(file: string): SummaryLock {
  const lockFile = `${file}.lock`;
  for (let attempt = 0; attempt < 2_000; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      const stat = fs.fstatSync(fd);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
        fs.fsyncSync(fd);
        return { fd, dev: stat.dev, ino: stat.ino };
      } catch (error) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try {
          const current = fs.lstatSync(lockFile);
          if (current.dev === stat.dev && current.ino === stat.ino) fs.unlinkSync(lockFile);
        } catch { /* best effort */ }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const before = fs.lstatSync(lockFile);
        if (before.isSymbolicLink()) throw new Error(`refusing symlinked summary lock: ${lockFile}`);
        const owner = Number(fs.readFileSync(lockFile, "utf8").trim());
        const validOwner = Number.isSafeInteger(owner) && owner > 0;
        const recoverable = (validOwner && !processAlive(owner)) || (!validOwner && Date.now() - before.mtimeMs > 1_000);
        if (recoverable) {
          const after = fs.lstatSync(lockFile);
          if (before.dev === after.dev && before.ino === after.ino) fs.unlinkSync(lockFile);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }
      Atomics.wait(summaryLockWait, 0, 0, 5);
    }
  }
  throw new Error(`timed out acquiring summary lock: ${file}.lock`);
}

function releaseSummaryLock(file: string, lock: SummaryLock): void {
  try { fs.closeSync(lock.fd); } catch { /* best effort */ }
  const lockFile = `${file}.lock`;
  try {
    const stat = fs.lstatSync(lockFile);
    if (stat.dev === lock.dev && stat.ino === lock.ino) fs.unlinkSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function atomicSummaryWrite(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function mergeSummaryFile<T>(file: string, newResults: T[], key: (result: T) => string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireSummaryLock(file);
  try {
    let merged: T[] = [];
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`refusing symlinked summary file: ${file}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`cannot merge corrupt summary ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!Array.isArray(parsed)) throw new Error(`cannot merge summary ${file}: top level is not an array`);
      merged = parsed as T[];
      const existingKeys = new Set<string>();
      for (const result of merged) {
        const resultKey = key(result);
        if (existingKeys.has(resultKey)) throw new Error(`cannot merge summary ${file}: duplicate key ${resultKey}`);
        existingKeys.add(resultKey);
      }
    }
    const newKeys = new Set<string>();
    for (const result of newResults) {
      const resultKey = key(result);
      if (newKeys.has(resultKey)) throw new Error(`duplicate summary key in update: ${resultKey}`);
      newKeys.add(resultKey);
    }
    merged = merged.filter((result) => !newKeys.has(key(result))).concat(newResults);
    merged.sort((a, b) => key(a).localeCompare(key(b)));
    atomicSummaryWrite(file, `${JSON.stringify(merged, null, 2)}\n`);
  } finally {
    releaseSummaryLock(file, lock);
  }
}
