import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChangedFileReport, RunReport, WorkspaceScope } from "./types.ts";
import { PathOutsideCwdError, PathScopeError, resolvePathWithinScope } from "./tools/path-boundary.ts";

interface FileState {
  digest: string;
}

export interface WorkspaceSnapshot {
  cwd: string;
  files: Map<string, FileState>;
}

/** Explicitly excluded high-volume implementation directories. Git ignore
 * rules are intentionally not consulted: ignored source/secrets such as .env
 * still need to appear in the change audit. */
export const SNAPSHOT_EXCLUDED_NAMES = new Set([".git", "node_modules"]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Snapshot aborted", "AbortError");
}

async function collectPaths(dir: string, base: string, out: string[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.isDirectory() && SNAPSHOT_EXCLUDED_NAMES.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(base, absolute);
    if (entry.isDirectory()) await collectPaths(absolute, base, out, signal);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative);
  }
}

async function candidatePaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  await collectPaths(cwd, cwd, out, signal);
  return out.sort();
}

async function hashPath(absolute: string, signal?: AbortSignal): Promise<FileState | undefined> {
  throwIfAborted(signal);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const hash = createHash("sha256");
  hash.update(`${stat.mode & 0o7777}\0`);
  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${await fs.readlink(absolute)}`);
  } else if (stat.isFile()) {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolute, { signal });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  } else {
    return undefined;
  }
  return { digest: hash.digest("hex") };
}

/** Capture all ordinary workspace files, including git-ignored files. */
export async function captureWorkspaceSnapshot(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  throwIfAborted(signal);
  const absoluteCwd = await fs.realpath(cwd);
  const files = new Map<string, FileState>();
  for (const candidate of await candidatePaths(absoluteCwd, signal)) {
    throwIfAborted(signal);
    const relative = candidate.split(path.sep).join("/");
    const state = await hashPath(path.resolve(absoluteCwd, candidate), signal);
    if (state) files.set(relative, state);
  }
  return { cwd: absoluteCwd, files };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ChangedFileReport[] {
  if (before.cwd !== after.cwd) throw new Error("cannot diff snapshots from different working directories");
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  const changed: ChangedFileReport[] = [];
  for (const file of paths) {
    const oldState = before.files.get(file);
    const newState = after.files.get(file);
    if (!oldState && newState) changed.push({ path: file, action: "created" });
    else if (oldState && !newState) changed.push({ path: file, action: "deleted" });
    else if (oldState!.digest !== newState!.digest) changed.push({ path: file, action: "modified" });
  }
  return changed;
}

/** Keep commands from the agent report, but make the filesystem diff authoritative. */
export function reportFromSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, agent: RunReport): RunReport {
  const files = new Map(diffWorkspaceSnapshots(before, after).map((change) => [change.path, change.action]));
  // A git-ignore rule can hide a directly-created file; retain direct tool
  // bookkeeping as a conservative supplement.
  for (const change of agent.changedFiles) if (!files.has(change.path)) files.set(change.path, change.action);
  return {
    changedFiles: [...files].map(([file, action]) => ({ path: file, action })).sort((a, b) => a.path.localeCompare(b.path)),
    commandsRun: [...agent.commandsRun],
  };
}

/** Return human-readable scope violations for a final workspace diff. */
export function changedFileScopeViolations(scope: WorkspaceScope, report: RunReport): string[] {
  const violations: string[] = [];
  for (const change of report.changedFiles) {
    try {
      resolvePathWithinScope(scope, change.path, { mustExist: false, mutation: true });
    } catch (err) {
      if (err instanceof PathScopeError || err instanceof PathOutsideCwdError) violations.push(`${change.path}: ${err.message}`);
      else violations.push(`${change.path}: scope validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return violations;
}
