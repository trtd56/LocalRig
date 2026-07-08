// Durable store for one-shot sessions and caller feedback.
//
// Layout under $LH_HOME (default ~/.localrig):
//   sessions/<id>.json   one record per run, written atomically
//   feedback.jsonl       append-only, one fsync'd record per line

// Session files are versioned and migrated in memory. Unknown sessions return
// null; malformed/unsupported files throw a typed error so callers never
// confuse corruption with "not found".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatMessage, ErrorKind, RunReport, RunStatus } from "./types.ts";
import type { IsolationSessionMetadata } from "./isolation/types.ts";

export const SESSION_SCHEMA_VERSION = 2;
export const FEEDBACK_SCHEMA_VERSION = 2;

/** Deliberately permits short test/import ids while excluding every path
 * separator, dot-segment and control character. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export class InvalidSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super(`invalid session id: ${JSON.stringify(sessionId)}`);
    this.name = "InvalidSessionIdError";
  }
}

export class SessionStoreError extends Error {
  constructor(
    message: string,
    readonly code: "corrupt" | "unsupported_schema" | "conflict" | "unsafe_path" | "io",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}

/** Safe for CLI preflight as well as persistence paths. Single dots are kept
 * for compatibility with v1/research ids; path-like `..` segments are not. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) && !id.includes("..");
}

export function validateSessionId(id: string): string {
  if (!isValidSessionId(id)) throw new InvalidSessionIdError(id);
  return id;
}

export interface CheckRecord {
  command: string;
  exit_code: number | null;
  attempts: number;
  output_tail: string;
  timed_out?: boolean;
  /** Set by `lh batch`'s final re-verification sweep. */
  regressed?: boolean;
}

/** Overall outcome of a `lh batch` run. */
export type BatchStatus = "ok" | "partial" | "failed" | "error";

export interface TaskRecord {
  id: string;
  kind?: string;
  status: RunStatus;
  durationMs: number;
  turns: number;
  check?: CheckRecord;
  report?: RunReport;
}

/**
 * Canonical counters are totals across the whole local run. The deprecated
 * aliases are kept in persisted/CLI JSON so readers from schema v1 continue
 * to work. `prompt` means the final turn, exactly as it did in v1.
 */
export interface SessionTokens {
  prompt_last?: number;
  prompt_total?: number;
  completion_total?: number;
  /** @deprecated use prompt_last */
  prompt?: number;
  /** @deprecated use completion_total */
  completion?: number;
}

export function sessionTokens(promptLast: number, promptTotal: number, completionTotal: number): SessionTokens {
  const last = nonNegative(promptLast);
  const total = Math.max(last, nonNegative(promptTotal));
  const completion = nonNegative(completionTotal);
  return {
    prompt_last: last,
    prompt_total: total,
    completion_total: completion,
    prompt: last,
    completion,
  };
}

/** Detailed timings are optional because old providers do not expose each
 * component yet. total_ms is always populated during persistence migration. */
export interface SessionDurations {
  total_ms: number;
  model_ms?: number;
  tool_ms?: number;
  check_ms?: number;
  ttft_ms?: number;
}

export interface MetricDimensions {
  model?: string;
  hardware?: string;
  hardwareSource?: "cli" | "env" | "detected";
  hardwareUnavailableReason?: string;
  caller?: string;
  callerSource?: "cli" | "env";
  callerUnavailableReason?: string;
  integrationVersion?: string;
  integrationVersionSource?: "cli" | "env";
  integrationVersionUnavailableReason?: string;
  localrigVersion?: string;
  localrigVersionUnavailableReason?: string;
}

/** Dimensions currently supported as evidence filters. Provenance/version
 * metadata remains persisted but cannot accidentally masquerade as a filter. */
export type MetricDimensionFilters = Pick<MetricDimensions, "model" | "hardware" | "caller">;

export interface RuntimeMetricDimensionOptions {
  model: string;
  /** Explicit CLI values. Environment fallbacks are read only when omitted. */
  hardware?: string;
  caller?: string;
  integrationVersion?: string;
  env?: NodeJS.ProcessEnv;
}

let cachedLocalrigVersion: string | undefined;
let localrigVersionRead = false;

function nonEmptyDimension(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function detectedHardware(): { id?: string; reason?: string } {
  try {
    const cpuModel = os.cpus().map((cpu) => cpu.model.trim()).find(Boolean);
    if (!cpuModel) return { reason: "OS did not report a CPU model; set --hardware or LH_HARDWARE" };
    const slug = cpuModel
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 96);
    if (!slug) return { reason: "CPU model could not be normalized; set --hardware or LH_HARDWARE" };
    return { id: `${process.platform}-${process.arch}-${slug}` };
  } catch (err) {
    return { reason: `hardware detection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function localrigVersion(): string | undefined {
  if (localrigVersionRead) return cachedLocalrigVersion;
  localrigVersionRead = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
    cachedLocalrigVersion = isRecord(parsed) ? nonEmptyDimension(parsed.version) : undefined;
  } catch {
    cachedLocalrigVersion = undefined;
  }
  return cachedLocalrigVersion;
}

/** Dimensions stamped when a run starts. Unknown provenance is explicit so a
 * filtered stats query cannot silently treat historical gaps as matches. */
export function runtimeMetricDimensions(options: RuntimeMetricDimensionOptions): MetricDimensions {
  const env = options.env ?? process.env;
  const cliHardware = nonEmptyDimension(options.hardware);
  const envHardware = nonEmptyDimension(env.LH_HARDWARE);
  const detected = cliHardware || envHardware ? undefined : detectedHardware();
  const hardware = cliHardware ?? envHardware ?? detected?.id;
  const cliCaller = nonEmptyDimension(options.caller);
  const envCaller = nonEmptyDimension(env.LH_CALLER);
  const caller = cliCaller ?? envCaller;
  const cliIntegrationVersion = nonEmptyDimension(options.integrationVersion);
  const envIntegrationVersion = nonEmptyDimension(env.LH_INTEGRATION_VERSION);
  const integrationVersion = cliIntegrationVersion ?? envIntegrationVersion;
  const version = localrigVersion();
  return {
    model: nonEmptyDimension(options.model),
    ...(hardware
      ? { hardware, hardwareSource: cliHardware ? "cli" as const : envHardware ? "env" as const : "detected" as const }
      : { hardwareUnavailableReason: detected?.reason ?? "set --hardware or LH_HARDWARE" }),
    ...(caller
      ? { caller, callerSource: cliCaller ? "cli" as const : "env" as const }
      : { callerUnavailableReason: "set --caller or LH_CALLER" }),
    ...(integrationVersion
      ? {
          integrationVersion,
          integrationVersionSource: cliIntegrationVersion ? "cli" as const : "env" as const,
        }
      : { integrationVersionUnavailableReason: "set --integration-version or LH_INTEGRATION_VERSION" }),
    ...(version
      ? { localrigVersion: version }
      : { localrigVersionUnavailableReason: "package version was unavailable" }),
  };
}

export interface SessionRecord {
  schemaVersion?: number;
  /** Monotonic write generation used for compare-and-swap updates. */
  generation?: number;
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  prompt: string;
  kind?: string;
  status: RunStatus | BatchStatus;
  result: string;
  error?: string;
  errorKind?: ErrorKind;
  durationMs: number;
  durations?: SessionDurations;
  turns: number;
  toolCalls: number;
  tokens: SessionTokens;
  check?: CheckRecord;
  report?: RunReport;
  /** Detached worker pid for `lh submit` sessions while status is running. */
  pid?: number;
  messages?: readonly ChatMessage[];
  resumedFrom?: string;
  tasks?: TaskRecord[];
  dimensions?: MetricDimensions;
  /** Private-worktree execution and retained patch/apply state. */
  isolation?: IsolationSessionMetadata;
}

export type FeedbackOutcome = "accepted_as_is" | "accepted_after_resume" | "rejected";
export type LegacyVerdict = "pass" | "fail";

export interface CallerReceipt {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface FeedbackRecord {
  schemaVersion?: number;
  sessionId: string;
  taskId?: string;
  /** Canonical v2 outcome. */
  outcome?: FeedbackOutcome;
  /** v1 compatibility alias: accepted_* => pass, rejected => fail. */
  verdict?: LegacyVerdict;
  kind?: string;
  notes?: string;
  source?: string;
  failureCode?: string;
  reworkMs?: number;
  callerReceipt?: CallerReceipt;
  dimensions?: MetricDimensions;
  createdAt: string;
}

export function dataDir(): string {
  return process.env.LH_HOME ?? path.join(os.homedir(), ".localrig");
}

const sessionsDir = () => path.join(dataDir(), "sessions");
const feedbackFile = () => path.join(dataDir(), "feedback.jsonl");

export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeTokens(value: unknown): SessionTokens {
  const raw = isRecord(value) ? value : {};
  const promptLast = nonNegative(raw.prompt_last ?? raw.prompt);
  // A v1 prompt counter represented only the final turn. Treat it as both
  // last and total: this avoids inventing usage while making migration clear.
  const promptTotal = nonNegative(raw.prompt_total ?? raw.prompt ?? promptLast);
  const completionTotal = nonNegative(raw.completion_total ?? raw.completion);
  return sessionTokens(promptLast, promptTotal, completionTotal);
}

function normalizeDurations(value: unknown, durationMs: number): SessionDurations {
  const raw = isRecord(value) ? value : {};
  const optional = (key: string): number | undefined =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) && (raw[key] as number) >= 0
      ? raw[key] as number
      : undefined;
  return {
    total_ms: optional("total_ms") ?? nonNegative(durationMs),
    model_ms: optional("model_ms"),
    tool_ms: optional("tool_ms"),
    check_ms: optional("check_ms"),
    ttft_ms: optional("ttft_ms"),
  };
}

const ISOLATION_APPLY_STATUSES = new Set(["pending", "not_needed", "applied", "retained", "conflict", "failed"]);
const ISOLATION_CLEANUP_STATUSES = new Set(["pending", "removed", "retained"]);

function normalizeIsolation(value: unknown): IsolationSessionMetadata {
  if (!isRecord(value)) throw new SessionStoreError("session has invalid isolation metadata", "corrupt");
  if (value.mode !== "worktree" && value.mode !== "in_place") {
    throw new SessionStoreError("session has invalid isolation.mode", "corrupt");
  }
  if (typeof value.source_cwd !== "string" || !path.isAbsolute(value.source_cwd)) {
    throw new SessionStoreError("session has invalid isolation.source_cwd", "corrupt");
  }
  const optionalStrings = [
    "workspace_id",
    "baseline_commit",
    "baseline_tree",
    "patch_path",
    "patch_sha256",
    "final_content_digest",
    "final_modes_sha256",
    "worktree_path",
    "conflict",
  ] as const;
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new SessionStoreError(`session has invalid isolation.${key}`, "corrupt");
    }
  }
  if (typeof value.workspace_id === "string") validateSessionId(value.workspace_id);
  for (const key of ["patch_path", "worktree_path"] as const) {
    if (typeof value[key] === "string" && !path.isAbsolute(value[key] as string)) {
      throw new SessionStoreError(`session has non-absolute isolation.${key}`, "corrupt");
    }
  }
  for (const key of ["patch_sha256", "final_content_digest", "final_modes_sha256"] as const) {
    if (typeof value[key] === "string" && !/^[0-9a-f]{64}$/i.test(value[key] as string)) {
      throw new SessionStoreError(`session has invalid isolation.${key}`, "corrupt");
    }
  }
  for (const key of ["baseline_commit", "baseline_tree"] as const) {
    if (typeof value[key] === "string" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value[key] as string)) {
      throw new SessionStoreError(`session has invalid isolation.${key}`, "corrupt");
    }
  }
  if (value.apply_status !== undefined && !ISOLATION_APPLY_STATUSES.has(value.apply_status as string)) {
    throw new SessionStoreError("session has invalid isolation.apply_status", "corrupt");
  }
  if (value.cleanup_status !== undefined && !ISOLATION_CLEANUP_STATUSES.has(value.cleanup_status as string)) {
    throw new SessionStoreError("session has invalid isolation.cleanup_status", "corrupt");
  }
  if (value.rollback_failed !== undefined && typeof value.rollback_failed !== "boolean") {
    throw new SessionStoreError("session has invalid isolation.rollback_failed", "corrupt");
  }
  if (value.baseline_fingerprint !== undefined) {
    if (!isRecord(value.baseline_fingerprint)) {
      throw new SessionStoreError("session has invalid isolation.baseline_fingerprint", "corrupt");
    }
    const fingerprint = value.baseline_fingerprint;
    if (
      typeof fingerprint.headOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(fingerprint.headOid) ||
      typeof fingerprint.headRef !== "string" || fingerprint.headRef.length === 0 ||
      typeof fingerprint.indexDigest !== "string" || !/^[0-9a-f]{64}$/i.test(fingerprint.indexDigest) ||
      typeof fingerprint.contentDigest !== "string" || !/^[0-9a-f]{64}$/i.test(fingerprint.contentDigest)
    ) {
      throw new SessionStoreError("session has invalid isolation.baseline_fingerprint", "corrupt");
    }
  }
  if (value.final_modes !== undefined) {
    if (!isRecord(value.final_modes)) throw new SessionStoreError("session has invalid isolation.final_modes", "corrupt");
    for (const [repoPath, mode] of Object.entries(value.final_modes)) {
      const normalized = path.posix.normalize(repoPath);
      if (
        !repoPath || path.posix.isAbsolute(repoPath) || normalized === ".." || normalized.startsWith("../") ||
        !Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777
      ) {
        throw new SessionStoreError("session has invalid isolation.final_modes", "corrupt");
      }
    }
  }
  return value as unknown as IsolationSessionMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaVersion(raw: Record<string, unknown>, kind: string, current: number): number {
  const value = raw.schemaVersion ?? 1;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new SessionStoreError(`${kind} has an invalid schemaVersion`, "corrupt");
  }
  if ((value as number) > current) {
    throw new SessionStoreError(
      `${kind} schema v${value as number} is newer than supported v${current}`,
      "unsupported_schema",
    );
  }
  return value as number;
}

function normalizeSession(rawValue: unknown, expectedId?: string): SessionRecord {
  if (!isRecord(rawValue)) throw new SessionStoreError("session JSON is not an object", "corrupt");
  schemaVersion(rawValue, "session", SESSION_SCHEMA_VERSION);
  if (typeof rawValue.id !== "string") throw new SessionStoreError("session is missing id", "corrupt");
  validateSessionId(rawValue.id);
  if (expectedId !== undefined && rawValue.id !== expectedId) {
    throw new SessionStoreError(`session id mismatch: expected ${expectedId}, found ${rawValue.id}`, "corrupt");
  }
  for (const key of ["createdAt", "cwd", "model", "prompt", "status", "result"] as const) {
    if (typeof rawValue[key] !== "string") throw new SessionStoreError(`session has invalid ${key}`, "corrupt");
  }
  for (const key of ["durationMs", "turns", "toolCalls"] as const) {
    if (typeof rawValue[key] !== "number" || !Number.isFinite(rawValue[key])) {
      throw new SessionStoreError(`session has invalid ${key}`, "corrupt");
    }
  }
  if (!isRecord(rawValue.tokens)) throw new SessionStoreError("session has invalid tokens", "corrupt");
  if (rawValue.resumedFrom !== undefined) {
    if (typeof rawValue.resumedFrom !== "string") throw new SessionStoreError("invalid resumedFrom", "corrupt");
    validateSessionId(rawValue.resumedFrom);
  }
  const durationMs = nonNegative(rawValue.durationMs);
  if (rawValue.generation !== undefined && (!Number.isInteger(rawValue.generation) || (rawValue.generation as number) < 0)) {
    throw new SessionStoreError("session has invalid generation", "corrupt");
  }
  const generation = (rawValue.generation as number | undefined) ?? 0;
  const normalized = {
    ...rawValue,
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation,
    durationMs,
    durations: normalizeDurations(rawValue.durations, durationMs),
    tokens: normalizeTokens(rawValue.tokens),
    dimensions: {
      ...(isRecord(rawValue.dimensions) ? rawValue.dimensions : {}),
      model: typeof rawValue.model === "string" ? rawValue.model : undefined,
    },
    ...(rawValue.isolation !== undefined ? { isolation: normalizeIsolation(rawValue.isolation) } : {}),
  };
  return normalized as unknown as SessionRecord;
}

function normalizeFeedback(rawValue: unknown): FeedbackRecord {
  if (!isRecord(rawValue)) throw new SessionStoreError("feedback JSON is not an object", "corrupt");
  schemaVersion(rawValue, "feedback", FEEDBACK_SCHEMA_VERSION);
  if (typeof rawValue.sessionId !== "string") throw new SessionStoreError("feedback is missing sessionId", "corrupt");
  if (typeof rawValue.createdAt !== "string") throw new SessionStoreError("feedback is missing createdAt", "corrupt");
  validateSessionId(rawValue.sessionId);
  const legacy = rawValue.verdict;
  const canonical = rawValue.outcome;
  let outcome: FeedbackOutcome;
  if (canonical === "accepted_as_is" || canonical === "accepted_after_resume" || canonical === "rejected") {
    outcome = canonical;
  } else if (legacy === "pass" || legacy === "fail") {
    outcome = legacy === "pass" ? "accepted_as_is" : "rejected";
  } else {
    throw new SessionStoreError("feedback has no valid outcome/verdict", "corrupt");
  }
  const verdict: LegacyVerdict = outcome === "rejected" ? "fail" : "pass";
  if (
    rawValue.reworkMs !== undefined &&
    (typeof rawValue.reworkMs !== "number" || !Number.isFinite(rawValue.reworkMs) || rawValue.reworkMs < 0)
  ) {
    throw new SessionStoreError("feedback has invalid reworkMs", "corrupt");
  }
  if (rawValue.callerReceipt !== undefined) {
    if (!isRecord(rawValue.callerReceipt)) throw new SessionStoreError("feedback has invalid callerReceipt", "corrupt");
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
      const value = rawValue.callerReceipt[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new SessionStoreError(`feedback has invalid callerReceipt.${key}`, "corrupt");
      }
    }
  }
  const reworkMs = rawValue.reworkMs as number | undefined;
  return {
    ...(rawValue as unknown as FeedbackRecord),
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    outcome,
    verdict,
    reworkMs,
  };
}

function containedPath(root: string, fileName: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, fileName);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SessionStoreError(`unsafe data path: ${fileName}`, "unsafe_path");
  }
  return candidate;
}

function sessionPath(id: string): string {
  const dir = sessionsDir();
  rejectSymlink(dir);
  return containedPath(dir, `${validateSessionId(id)}.json`);
}

function ensurePrivateDir(dir: string): void {
  rejectSymlink(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  rejectSymlink(dir);
  if (!fs.statSync(dir).isDirectory()) {
    throw new SessionStoreError(`data path is not a directory: ${dir}`, "unsafe_path");
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // A platform may not implement POSIX modes; open/write errors still surface.
  }
}

function rejectSymlink(file: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new SessionStoreError(`refusing symlinked data file: ${file}`, "unsafe_path");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));
const MALFORMED_LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid?: number;
  token?: string;
}

interface LockObservation {
  dev: number;
  ino: number;
  mtimeMs: number;
  owner: LockOwner;
}

interface LockHandle {
  fd: number;
  token: string;
  dev: number;
  ino: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockOwner(text: string): LockOwner {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      const pid = Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 ? parsed.pid as number : undefined;
      const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
      return { pid, token };
    }
  } catch {
    // v1 lock files contained only a decimal pid.
  }
  const legacyPid = Number(trimmed);
  return Number.isInteger(legacyPid) && legacyPid > 0 ? { pid: legacyPid } : {};
}

function observeLock(lockFile: string): LockObservation {
  const stat = fs.lstatSync(lockFile);
  if (stat.isSymbolicLink()) {
    throw new SessionStoreError(`refusing symlinked data lock: ${lockFile}`, "unsafe_path");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    owner: parseLockOwner(fs.readFileSync(lockFile, "utf8")),
  };
}

function sameLockIdentity(stat: fs.Stats, observed: { dev: number; ino: number }): boolean {
  return stat.dev === observed.dev && stat.ino === observed.ino;
}

/** Remove only the exact stale inode/token that was inspected. Live owners are
 * never eligible, so an old owner cannot race this path and release a new lock. */
function removeObservedStaleLock(lockFile: string, observed: LockObservation): boolean {
  let current: LockObservation;
  try {
    current = observeLock(lockFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
  if (current.owner.pid !== observed.owner.pid || current.owner.token !== observed.owner.token) return false;
  fs.unlinkSync(lockFile);
  return true;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new SessionStoreError("short data-store write", "io");
    offset += written;
  }
}

function acquireLock(lockFile: string): LockHandle {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      const token = randomBytes(16).toString("hex");
      const stat = fs.fstatSync(fd);
      try {
        writeAll(fd, Buffer.from(JSON.stringify({ pid: process.pid, token }) + "\n"));
        fs.fsyncSync(fd);
        return { fd, token, dev: stat.dev, ino: stat.ino };
      } catch (err) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try {
          const current = fs.lstatSync(lockFile);
          if (sameLockIdentity(current, stat)) fs.unlinkSync(lockFile);
        } catch {
          // The failed lock is already gone or was replaced; never remove the replacement.
        }
        throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const observed = observeLock(lockFile);
        const ownerAlive = observed.owner.pid !== undefined && processAlive(observed.owner.pid);
        const deadOwner = observed.owner.pid !== undefined && !ownerAlive;
        const malformedAndOld = observed.owner.pid === undefined && Date.now() - observed.mtimeMs > MALFORMED_LOCK_STALE_MS;
        // Age alone never invalidates a lock with a live owner.
        if ((deadOwner || malformedAndOld) && removeObservedStaleLock(lockFile, observed)) {
          continue;
        }
      } catch (lockErr) {
        if ((lockErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockErr;
      }
      Atomics.wait(waitArray, 0, 0, 5);
    }
  }
  throw new SessionStoreError(`timed out acquiring data lock: ${lockFile}`, "io");
}

function releaseLock(lockFile: string, handle: LockHandle): void {
  try { fs.closeSync(handle.fd); } catch { /* best effort */ }
  try {
    const current = observeLock(lockFile);
    if (current.dev !== handle.dev || current.ino !== handle.ino) return;
    if (current.owner.pid !== process.pid || current.owner.token !== handle.token) return;
    fs.unlinkSync(lockFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function withLock<T>(target: string, fn: () => T): T {
  const lockFile = `${target}.lock`;
  const handle = acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile, handle);
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    // Windows and a few filesystems reject directory fsync. File fsync and
    // atomic rename still provide the strongest portable guarantee.
    if (process.platform !== "win32") throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWrite(file: string, text: string): void {
  const dir = path.dirname(file);
  const temp = containedPath(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // See ensurePrivateDir.
    }
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

export interface SaveSessionOptions {
  /** Reject the write unless the on-disk generation still equals this value. */
  expectedGeneration?: number;
}

export function saveSession(record: SessionRecord, options: SaveSessionOptions = {}): string {
  validateSessionId(record.id);
  if (record.resumedFrom !== undefined) validateSessionId(record.resumedFrom);
  const dir = sessionsDir();
  ensurePrivateDir(dir);
  const file = sessionPath(record.id);
  rejectSymlink(file);
  return withLock(file, () => {
    const existing = loadSessionUnlocked(record.id, file);
    const actualGeneration = existing?.generation ?? 0;
    if (options.expectedGeneration !== undefined && actualGeneration !== options.expectedGeneration) {
      throw new SessionStoreError(
        `session ${record.id} changed (expected generation ${options.expectedGeneration}, found ${actualGeneration})`,
        "conflict",
      );
    }
    const normalized = normalizeSession({
      ...record,
      schemaVersion: SESSION_SCHEMA_VERSION,
      generation: actualGeneration + 1,
    }, record.id);
    atomicWrite(file, JSON.stringify(normalized, null, 2) + "\n");
    return file;
  });
}

function loadSessionUnlocked(id: string, file = sessionPath(id)): SessionRecord | null {
  rejectSymlink(file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SessionStoreError(`failed to read session ${id}`, "io", { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SessionStoreError(`corrupt session ${id}: invalid JSON`, "corrupt", { cause: err });
  }
  try {
    return normalizeSession(parsed, id);
  } catch (err) {
    if (err instanceof SessionStoreError || err instanceof InvalidSessionIdError) throw err;
    throw new SessionStoreError(`corrupt session ${id}`, "corrupt", { cause: err });
  }
}

export function loadSession(id: string): SessionRecord | null {
  return loadSessionUnlocked(validateSessionId(id));
}

/** Session ids sorted oldest to newest (generated ids start with a timestamp). */
export function listSessionIds(): string[] {
  let entries: string[];
  try {
    rejectSymlink(sessionsDir());
    entries = fs.readdirSync(sessionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((id) => isValidSessionId(id))
    .sort();
}

export function latestSessionId(): string | null {
  const ids = listSessionIds();
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

export class ResumeError extends Error {
  readonly kind: ErrorKind = "config";
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export function restoreTranscript(id: string, record: SessionRecord | null): ChatMessage[] {
  validateSessionId(id);
  if (!record) throw new ResumeError(`unknown session: ${id} (see \`lh sessions\`)`);
  if (record.tasks) throw new ResumeError(`session ${id} is a batch session; resuming a batch is not supported`);
  const messages = record.messages;
  if (!messages || messages.length === 0) throw new ResumeError(`session ${id} has no saved transcript to resume`);
  if (messages[0]!.role !== "system") throw new ResumeError(`session ${id} transcript does not start with a system prompt`);
  return messages.map((message, index) => ({ ...message, _seq: index }));
}

const FEEDBACK_TAIL_SCAN_CHUNK = 64 * 1024;
const FEEDBACK_MAX_RECORD_BYTES = 4 * 1024 * 1024;

function readExactly(fd: number, start: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, out, offset, length - offset, start + offset);
    if (read <= 0) throw new SessionStoreError("feedback file changed during recovery", "io");
    offset += read;
  }
  return out;
}

function trailingRecordStart(fd: number, size: number): number {
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - FEEDBACK_TAIL_SCAN_CHUNK);
    const chunk = readExactly(fd, start, cursor - start);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    if (size - start > FEEDBACK_MAX_RECORD_BYTES) {
      throw new SessionStoreError("feedback trailing record exceeds the safety limit", "corrupt");
    }
    cursor = start;
  }
  return 0;
}

/** Repair only a syntactically partial final JSON record. A complete record
 * with a future schema or invalid fields is corruption and must remain visible. */
function recoverFeedbackTail(fd: number): void {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return;
  const lastByte = readExactly(fd, size - 1, 1)[0];
  if (lastByte === 0x0a) return;

  const start = trailingRecordStart(fd, size);
  const length = size - start;
  if (length > FEEDBACK_MAX_RECORD_BYTES) {
    throw new SessionStoreError("feedback trailing record exceeds the safety limit", "corrupt");
  }
  const tail = readExactly(fd, start, length).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // The prior writer crashed mid-record. Preserve every complete line and
    // remove only the unterminated fragment before appending the new record.
    fs.ftruncateSync(fd, start);
    return;
  }

  // Validate before adding the missing newline. Unsupported schemas and other
  // semantic corruption are intentionally not truncated or hidden.
  normalizeFeedback(parsed);
  writeAll(fd, Buffer.from("\n"));
}

export function appendFeedback(feedback: FeedbackRecord): void {
  validateSessionId(feedback.sessionId);
  const dir = dataDir();
  ensurePrivateDir(dir);
  const file = containedPath(dir, "feedback.jsonl");
  rejectSymlink(file);
  const normalized = normalizeFeedback({ ...feedback, schemaVersion: FEEDBACK_SCHEMA_VERSION });
  const line = JSON.stringify(normalized) + "\n";
  withLock(file, () => {
    const existed = fs.existsSync(file);
    const fd = fs.openSync(file, "a+", 0o600);
    try {
      recoverFeedbackTail(fd);
      writeAll(fd, Buffer.from(line));
      fs.fsyncSync(fd);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // See ensurePrivateDir.
      }
    } finally {
      fs.closeSync(fd);
    }
    if (!existed) fsyncDirectory(dir);
  });
}

export function readFeedback(): FeedbackRecord[] {
  const file = feedbackFile();
  rejectSymlink(dataDir());
  rejectSymlink(file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SessionStoreError("failed to read feedback", "io", { cause: err });
  }
  const lines = text.split("\n");
  const completeLineCount = lines.length - 1;
  const records: FeedbackRecord[] = [];
  for (let index = 0; index < completeLineCount; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      records.push(normalizeFeedback(JSON.parse(line)));
    } catch (err) {
      if (err instanceof SessionStoreError || err instanceof InvalidSessionIdError) throw err;
      throw new SessionStoreError(`corrupt feedback at line ${index + 1}`, "corrupt", { cause: err });
    }
  }
  // A crash can leave one non-newline-terminated record. Parse it only when it
  // is complete; otherwise preserve all earlier durable records.
  if (!text.endsWith("\n") && lines.at(-1)?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.at(-1)!);
    } catch (err) {
      if (err instanceof SyntaxError) return records; // trailing partial record
      throw err;
    }
    // A syntactically complete future/invalid record is typed corruption, not
    // a crash fragment, and must not disappear from stats silently.
    records.push(normalizeFeedback(parsed));
  }
  return records;
}

export interface Stats {
  sessions: number;
  gradable: number;
  graded: number;
  coverageRate: number | null;
  dimensionCoverage: DimensionCoverage;
  pass: number;
  fail: number;
  rate: number | null;
  successLowerBound: number | null;
  rework: number;
  reworkRate: number | null;
  p50DurationMs: number | null;
  p90DurationMs: number | null;
  recentFailures: FeedbackRecord[];
  byKind?: KindStats[];
  /** Dimension filters applied to this aggregate. Omitted keys are unfiltered. */
  filters?: MetricDimensionFilters;
}

export interface KindStats {
  kind: string;
  gradable: number;
  graded: number;
  coverageRate: number | null;
  dimensionCoverage: DimensionCoverage;
  pass: number;
  fail: number;
  rate: number | null;
  successLowerBound: number | null;
  rework: number;
  reworkRate: number | null;
  avgDurationMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  gate: KindGate;
}

export interface DimensionCoverage {
  /** Keys whose requested dimensions are all known and equal the filter. */
  matched: number;
  /** Keys with no known mismatch but at least one requested dimension absent. */
  unknown: number;
  /** Keys with at least one requested dimension known to differ. */
  excluded: number;
  /** Conservative denominator for this slice: matched + unknown. */
  eligible: number;
  /** How much of the eligible population is known to match. */
  rate: number | null;
}

export const KIND_GATE_MIN_GRADED = 3;
export const KIND_GATE_MIN_PASS_RATE = 50;
export const MIN_EVIDENCE_COVERAGE_RATE = 50;
export const CONFIDENCE_LEVEL = 0.95;

export type KindGateStatus = "insufficient_data" | "allow" | "block";

export interface KindGate {
  status: KindGateStatus;
  minGraded: number;
  minPassRate: number;
  confidenceLevel: number;
  successLowerBound: number | null;
  reason: string;
}

export function evaluateKindGate(
  graded: number,
  rate: number | null,
  thresholds: {
    minGraded?: number;
    minPassRate?: number;
    successLowerBound?: number | null;
    coverageRate?: number | null;
    minCoverageRate?: number;
  } = {},
): KindGate {
  const minGraded = thresholds.minGraded ?? KIND_GATE_MIN_GRADED;
  const minPassRate = thresholds.minPassRate ?? KIND_GATE_MIN_PASS_RATE;
  const inferredPass = rate === null ? 0 : Math.round((rate * graded) / 100);
  const lower = thresholds.successLowerBound === undefined
    ? successLowerBound(inferredPass, graded)
    : thresholds.successLowerBound;
  if (graded < minGraded || rate === null || lower === null) {
    return {
      status: "insufficient_data",
      minGraded,
      minPassRate,
      confidenceLevel: CONFIDENCE_LEVEL,
      successLowerBound: lower,
      reason: `need at least ${minGraded} graded runs before gating`,
    };
  }
  if (lower < minPassRate) {
    return {
      status: "block",
      minGraded,
      minPassRate,
      confidenceLevel: CONFIDENCE_LEVEL,
      successLowerBound: lower,
      reason: `conservative success bound ${lower}% is below ${minPassRate}%`,
    };
  }
  if (thresholds.coverageRate !== undefined) {
    const coverage = thresholds.coverageRate;
    const minCoverage = thresholds.minCoverageRate ?? MIN_EVIDENCE_COVERAGE_RATE;
    if (coverage === null || !Number.isFinite(coverage) || coverage < minCoverage) {
      return {
        status: "insufficient_data",
        minGraded,
        minPassRate,
        confidenceLevel: CONFIDENCE_LEVEL,
        successLowerBound: lower,
        reason: coverage === null || !Number.isFinite(coverage)
          ? "feedback coverage is unavailable"
          : `feedback coverage ${coverage}% is below ${minCoverage}%`,
      };
    }
  }
  return {
    status: "allow",
    minGraded,
    minPassRate,
    confidenceLevel: CONFIDENCE_LEVEL,
    successLowerBound: lower,
    reason: `conservative success bound ${lower}% meets ${minPassRate}%`,
  };
}

function passRate(pass: number, graded: number): number | null {
  return graded > 0 ? Math.round((100 * pass) / graded) : null;
}

/** Wilson score lower bound at 95% confidence, expressed as a percentage. */
export function successLowerBound(pass: number, graded: number): number | null {
  if (graded <= 0) return null;
  const z = 1.959963984540054;
  const p = pass / graded;
  const z2 = z * z;
  const denominator = 1 + z2 / graded;
  const centre = p + z2 / (2 * graded);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * graded)) / graded);
  return Math.round(((centre - margin) / denominator) * 1000) / 10;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index]!;
}

function feedbackKey(feedback: FeedbackRecord): string {
  return feedback.taskId ? `${feedback.sessionId}::${feedback.taskId}` : feedback.sessionId;
}

type DimensionDisposition = "matched" | "unknown" | "excluded";

interface PopulationRun {
  key: string;
  sessionId: string;
  feedback?: FeedbackRecord;
  kind: string;
  durationMs: number;
  dimensions: MetricDimensions;
  disposition: DimensionDisposition;
}

type GradedRun = PopulationRun & { feedback: FeedbackRecord; disposition: "matched" };

export interface ComputeStatsOptions extends MetricDimensionFilters {
  byKind?: boolean;
}

function dimensionValue(value: unknown): string | undefined {
  return nonEmptyDimension(value);
}

function sessionDimensions(session: SessionRecord | undefined): MetricDimensions {
  return {
    model: dimensionValue(session?.dimensions?.model) ?? dimensionValue(session?.model),
    hardware: dimensionValue(session?.dimensions?.hardware),
    caller: dimensionValue(session?.dimensions?.caller),
  };
}

function feedbackDimensions(feedback: FeedbackRecord, session: SessionRecord | undefined): MetricDimensions {
  const fallback = sessionDimensions(session);
  return {
    // Execution-time session dimensions are authoritative. Feedback metadata
    // backfills only legacy sessions written before dimensions were stamped.
    model: fallback.model ?? dimensionValue(feedback.dimensions?.model),
    hardware: fallback.hardware ?? dimensionValue(feedback.dimensions?.hardware),
    caller: fallback.caller ?? dimensionValue(feedback.dimensions?.caller) ?? dimensionValue(feedback.source),
  };
}

function dimensionDisposition(dimensions: MetricDimensions, filters: MetricDimensionFilters): DimensionDisposition {
  let unknown = false;
  for (const key of ["model", "hardware", "caller"] as const) {
    const requested = filters[key];
    if (requested === undefined) continue;
    const actual = dimensionValue(dimensions[key]);
    if (actual === undefined) unknown = true;
    else if (actual !== requested) return "excluded";
  }
  return unknown ? "unknown" : "matched";
}

function roundedRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((1000 * numerator) / denominator) / 10 : null;
}

function summarizeDimensionCoverage(runs: PopulationRun[]): DimensionCoverage {
  const matched = runs.filter((run) => run.disposition === "matched").length;
  const unknown = runs.filter((run) => run.disposition === "unknown").length;
  const excluded = runs.length - matched - unknown;
  const eligible = matched + unknown;
  return { matched, unknown, excluded, eligible, rate: roundedRate(matched, eligible) };
}

/** Aggregate outcomes over all feedback (re-grades: last one wins). */
export function computeStats(options: ComputeStatsOptions = {}): Stats {
  const filters: MetricDimensionFilters = {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.hardware !== undefined ? { hardware: options.hardware } : {}),
    ...(options.caller !== undefined ? { caller: options.caller } : {}),
  };
  const filtered = Object.keys(filters).length > 0;
  const ids = listSessionIds();
  const sessions = new Map<string, SessionRecord>();
  for (const id of ids) {
    const session = loadSession(id);
    if (!session) continue;
    sessions.set(id, session);
  }

  const byId = new Map<string, FeedbackRecord>();
  for (const feedback of readFeedback()) byId.set(feedbackKey(feedback), feedback);
  const population = new Map<string, PopulationRun>();
  for (const session of sessions.values()) {
    const tasks = session.tasks && session.tasks.length > 0 ? session.tasks : [undefined];
    for (const task of tasks) {
      const key = task ? `${session.id}::${task.id}` : session.id;
      const fb = byId.get(key);
      const dimensions = fb ? feedbackDimensions(fb, session) : sessionDimensions(session);
      population.set(key, {
        key,
        sessionId: session.id,
        feedback: fb,
        kind: fb?.kind ?? task?.kind ?? session.kind ?? "(untagged)",
        durationMs: task?.durationMs ?? session.durationMs,
        dimensions,
        disposition: dimensionDisposition(dimensions, filters),
      });
    }
  }
  // Preserve feedback imported without a corresponding session, while still
  // classifying missing requested dimensions as unknown rather than matched.
  for (const fb of byId.values()) {
    const key = feedbackKey(fb);
    if (population.has(key)) continue;
    const session = sessions.get(fb.sessionId);
    const task = fb.taskId ? session?.tasks?.find((candidate) => candidate.id === fb.taskId) : undefined;
    const dimensions = feedbackDimensions(fb, session);
    population.set(key, {
      key,
      sessionId: fb.sessionId,
      feedback: fb,
      kind: fb.kind ?? task?.kind ?? session?.kind ?? "(untagged)",
      durationMs: task?.durationMs ?? session?.durationMs ?? 0,
      dimensions,
      disposition: dimensionDisposition(dimensions, filters),
    });
  }
  const populationRuns = [...population.values()];
  const eligibleRuns = populationRuns.filter((run) => run.disposition !== "excluded");
  const gradedRuns = populationRuns.filter(
    (run): run is GradedRun => run.disposition === "matched" && run.feedback !== undefined,
  );
  const feedback = gradedRuns.map((run) => run.feedback);
  const gradable = eligibleRuns.length;
  const matchingSessionIds = new Set(eligibleRuns.map((run) => run.sessionId));
  const dimensionCoverage = summarizeDimensionCoverage(populationRuns);
  const pass = feedback.filter((item) => item.outcome !== "rejected").length;
  const rework = feedback.filter((item) => item.outcome === "accepted_after_resume").length;
  const durations = gradedRuns.map((item) => item.durationMs);
  const failures = feedback.filter((item) => item.outcome === "rejected").slice(-5);
  const stats: Stats = {
    sessions: matchingSessionIds.size,
    gradable,
    graded: feedback.length,
    coverageRate: roundedRate(feedback.length, gradable),
    dimensionCoverage,
    pass,
    fail: feedback.length - pass,
    rate: passRate(pass, feedback.length),
    successLowerBound: successLowerBound(pass, feedback.length),
    rework,
    reworkRate: feedback.length > 0 ? Math.round((1000 * rework) / feedback.length) / 10 : null,
    p50DurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
    recentFailures: failures,
    ...(filtered ? { filters } : {}),
  };
  if (options.byKind) stats.byKind = computeKindStats(populationRuns);
  return stats;
}

function computeKindStats(runs: PopulationRun[]): KindStats[] {
  const buckets = new Map<string, PopulationRun[]>();
  for (const run of runs) {
    const current = buckets.get(run.kind) ?? [];
    current.push(run);
    buckets.set(run.kind, current);
  }
  return [...buckets.entries()]
    .map(([kind, population]) => {
      const eligible = population.filter((run) => run.disposition !== "excluded");
      const gradedRuns = population.filter(
        (run): run is GradedRun => run.disposition === "matched" && run.feedback !== undefined,
      );
      const pass = gradedRuns.filter((run) => run.feedback.outcome !== "rejected").length;
      const fail = gradedRuns.length - pass;
      const rework = gradedRuns.filter((run) => run.feedback.outcome === "accepted_after_resume").length;
      const durations = gradedRuns.map((run) => run.durationMs);
      const graded = gradedRuns.length;
      const coverageRate = roundedRate(graded, eligible.length);
      const rate = passRate(pass, graded);
      const lower = successLowerBound(pass, graded);
      const sum = durations.reduce((total, value) => total + value, 0);
      return {
        kind,
        gradable: eligible.length,
        graded,
        coverageRate,
        dimensionCoverage: summarizeDimensionCoverage(population),
        pass,
        fail,
        rate,
        successLowerBound: lower,
        rework,
        reworkRate: roundedRate(rework, graded),
        avgDurationMs: graded > 0 ? Math.round(sum / graded) : 0,
        p50DurationMs: percentile(durations, 0.5) ?? 0,
        p90DurationMs: percentile(durations, 0.9) ?? 0,
        gate: evaluateKindGate(graded, rate, { successLowerBound: lower, coverageRate }),
      };
    })
    .filter((stats) => stats.gradable > 0)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
