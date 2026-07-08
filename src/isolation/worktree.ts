import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  IsolationError,
  type IsolationArtifact,
  type IsolationGcOptions,
  type IsolationGcResult,
  type IsolationHandle,
  type IsolationSessionMetadata,
  type WorkspaceFingerprint,
} from "./types.ts";

const EXCLUDED_NAMES = new Set([".git", "node_modules"]);
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;
const DEFAULT_GC_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const OWNER_FILE = "owner.json";
const GIT_LOCATION_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_ATTR_SOURCE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
]);
const PRIVATE_GIT_CONFIG_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: "0",
};
const MALFORMED_REPO_LOCK_STALE_MS = 30_000;

interface PrepareIsolationOptions {
  sourceCwd: string;
  sessionId: string;
  homeDir?: string;
  seedPatchPath?: string;
  seedPatchSha256?: string;
  seedBaselineTree?: string;
  seedBaselineFingerprint?: WorkspaceFingerprint;
  seedFinalContentDigest?: string;
  seedFinalModes?: Record<string, number>;
  seedFinalModesSha256?: string;
}

interface FinalizeIsolationOptions {
  timeoutMs?: number;
}

function dataHome(): string {
  return process.env.LH_HOME ?? path.join(os.homedir(), ".localrig");
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new IsolationError(`invalid isolation id: ${JSON.stringify(value)}`, "config");
  }
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new IsolationError(`unsafe isolation directory: ${dir}`, "io");
  }
  fs.chmodSync(dir, 0o700);
}

function git(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer | string; allowFailure?: boolean; timeoutMs?: number } = { cwd: process.cwd() },
): Buffer {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (GIT_LOCATION_ENV.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  Object.assign(env, options.env);
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    env,
    input: options.input,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw new IsolationError(`git ${args[0] ?? ""} failed: ${result.error.message}`, "io");
  if (result.status !== 0 && !options.allowFailure) {
    const detail = Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new IsolationError(`git ${args.join(" ")} failed (${result.status}): ${detail}`, "config");
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return git(args, { cwd, env }).toString("utf8").trim();
}

function walk(
  root: string,
  visitor: (relative: string, absolute: string, stat: fs.Stats) => void,
  extraExcluded: readonly string[] = [],
  check?: () => void,
): void {
  const excluded = extraExcluded.map((entry) => path.resolve(entry));
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      check?.();
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (excluded.some((candidate) => isWithin(candidate, absolute))) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else visitor(relative, absolute, stat);
    }
  };
  visit(root);
}

function gitMode(stat: fs.Stats): string {
  if (stat.isSymbolicLink()) return "120000";
  if (stat.isFile()) return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
  throw new IsolationError("workspace contains an unsupported special file", "config");
}

function contentDigest(root: string, extraExcluded: readonly string[] = []): string {
  const hash = createHash("sha256");
  walk(root, (relative, absolute, stat) => {
    const permissionMode = stat.isFile() ? stat.mode & 0o777 : 0;
    hash.update(relative + "\0" + gitMode(stat) + "\0" + permissionMode + "\0" + (stat.isFile() ? stat.nlink : 1) + "\0");
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolute));
    else if (stat.isFile()) hash.update(fs.readFileSync(absolute));
    else throw new IsolationError(`unsupported workspace entry: ${relative}`, "config");
    hash.update("\0");
  }, extraExcluded);
  return hash.digest("hex");
}

function copyWorkspace(source: string, destination: string, extraExcluded: readonly string[] = []): void {
  privateDir(destination);
  copyWorkspaceInto(source, destination, extraExcluded);
}

function copyWorkspaceInto(source: string, destination: string, extraExcluded: readonly string[] = []): void {
  walk(source, (relative, absolute, stat) => {
    const target = path.join(destination, ...relative.split("/"));
    privateDir(path.dirname(target));
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(absolute), target);
    else if (stat.isFile()) {
      fs.copyFileSync(absolute, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, stat.mode & 0o777);
    } else {
      throw new IsolationError(`unsupported workspace entry: ${relative}`, "config");
    }
  }, extraExcluded);
}

function workspaceModes(root: string, extraExcluded: readonly string[] = []): Record<string, number> {
  const modes: Record<string, number> = Object.create(null) as Record<string, number>;
  walk(root, (relative, _absolute, stat) => {
    if (stat.isFile()) modes[relative] = stat.mode & 0o777;
  }, extraExcluded);
  return modes;
}

async function copyWorkspaceForFinalization(
  source: string,
  destination: string,
  deadlineAt: number,
): Promise<string> {
  const ensureTime = () => {
    if (Date.now() >= deadlineAt) {
      throw new IsolationError("isolation finalization timed out; worktree retained", "io");
    }
  };
  privateDir(destination);
  const entries: Array<{ relative: string; absolute: string; stat: fs.Stats }> = [];
  walk(source, (relative, absolute, stat) => entries.push({ relative, absolute, stat }), [], ensureTime);
  const hash = createHash("sha256");
  for (const { relative, absolute, stat } of entries) {
    ensureTime();
    const target = path.join(destination, ...relative.split("/"));
    privateDir(path.dirname(target));
    const permissionMode = stat.isFile() ? stat.mode & 0o777 : 0;
    hash.update(relative + "\0" + gitMode(stat) + "\0" + permissionMode + "\0" + (stat.isFile() ? stat.nlink : 1) + "\0");
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(absolute);
      hash.update(link);
      fs.symlinkSync(link, target);
    } else if (stat.isFile()) {
      const signal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          fs.createReadStream(absolute),
          hashing,
          fs.createWriteStream(target, { flags: "wx", mode: stat.mode & 0o777 }),
          { signal },
        );
      } catch (err) {
        if (signal.aborted || Date.now() >= deadlineAt) {
          throw new IsolationError("isolation finalization timed out; worktree retained", "io");
        }
        throw err;
      }
      fs.chmodSync(target, stat.mode & 0o777);
    } else {
      throw new IsolationError(`unsupported workspace entry: ${relative}`, "config");
    }
    hash.update("\0");
  }
  ensureTime();
  return hash.digest("hex");
}

function assertNoHardlinks(root: string, excluded: readonly string[]): void {
  walk(root, (relative, _absolute, stat) => {
    if (stat.isFile() && stat.nlink > 1) {
      throw new IsolationError(
        `worktree isolation refuses multiply-linked file ${relative}; break the hard link or use --in-place`,
        "config",
      );
    }
  }, excluded);
}

function indexDigest(repoRoot: string): string {
  return createHash("sha256").update(fs.readFileSync(resolveGitPath(repoRoot, "index"))).digest("hex");
}

function resolveGitPath(repoRoot: string, name: string): string {
  const rawPath = gitText(["rev-parse", "--git-path", name], repoRoot);
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

function privateRepositoryEnv(gitDir: string): NodeJS.ProcessEnv {
  return {
    ...PRIVATE_GIT_CONFIG_ENV,
    GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  };
}

function copyParentIndex(repoRoot: string, privateWorktree: string): void {
  const sourceIndex = resolveGitPath(repoRoot, "index");
  const rawTarget = git(["rev-parse", "--git-path", "index"], {
    cwd: privateWorktree,
    env: PRIVATE_GIT_CONFIG_ENV,
  }).toString("utf8").trim();
  const targetIndex = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(privateWorktree, rawTarget);
  privateDir(path.dirname(targetIndex));
  fs.copyFileSync(sourceIndex, targetIndex);
  fs.chmodSync(targetIndex, fs.statSync(sourceIndex).mode & 0o777);

  // A split index references sharedindex.<oid> beside the main index. Copying
  // those immutable companions keeps skip-worktree/intent flags intact.
  for (const name of fs.readdirSync(path.dirname(sourceIndex))) {
    if (!name.startsWith("sharedindex.")) continue;
    const source = path.join(path.dirname(sourceIndex), name);
    if (!fs.lstatSync(source).isFile()) continue;
    const target = path.join(path.dirname(targetIndex), name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
  }
}

function fingerprint(repoRoot: string, excluded: readonly string[] = []): WorkspaceFingerprint {
  const headOid = gitText(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  const symbolic = git(["symbolic-ref", "-q", "HEAD"], { cwd: repoRoot, allowFailure: true }).toString("utf8").trim();
  return {
    headOid,
    headRef: symbolic || "(detached)",
    indexDigest: indexDigest(repoRoot),
    contentDigest: contentDigest(repoRoot, excluded),
  };
}

function assertSupportedRepo(sourceCwd: string): { repoRoot: string; cwdRelative: string } {
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(gitText(["rev-parse", "--show-toplevel"], sourceCwd));
    gitText(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  } catch (err) {
    throw new IsolationError(`worktree isolation requires a Git repository with HEAD; use --in-place (${err instanceof Error ? err.message : String(err)})`, "config");
  }
  const realCwd = fs.realpathSync(sourceCwd);
  if (!isWithin(repoRoot, realCwd)) throw new IsolationError("cwd is outside the Git worktree", "config");
  if (git(["ls-files", "-u", "-z"], { cwd: repoRoot }).length > 0) {
    throw new IsolationError("worktree isolation does not support an unmerged index; resolve it or use --in-place", "config");
  }
  const hasGitlink = git(["ls-files", "--stage", "-z"], { cwd: repoRoot })
    .toString("utf8")
    .split("\0")
    .some((entry) => entry.startsWith("160000 "));
  if (hasGitlink) {
    throw new IsolationError("worktree isolation does not yet support repositories with submodules; use --in-place", "config");
  }
  return { repoRoot, cwdRelative: path.relative(repoRoot, realCwd) };
}

/** Read-only fail-closed preflight used before detached workers are spawned. */
export function validateIsolationSource(sourceCwd: string): void {
  assertSupportedRepo(fs.realpathSync(sourceCwd));
}

function treeFromDirectory(gitDir: string, workTree: string, indexFile: string, deadlineAt?: number): { tree: string; commit: string } {
  const env = {
    ...privateRepositoryEnv(gitDir),
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "LocalRig Isolation",
    GIT_AUTHOR_EMAIL: "localrig@localhost.invalid",
    GIT_COMMITTER_NAME: "LocalRig Isolation",
    GIT_COMMITTER_EMAIL: "localrig@localhost.invalid",
  };
  const gitOptions = () => {
    if (deadlineAt === undefined) return { cwd: workTree, env };
    const timeoutMs = deadlineAt - Date.now();
    if (timeoutMs <= 0) throw new IsolationError("isolation finalization timed out; worktree retained", "io");
    return { cwd: workTree, env, timeoutMs };
  };
  try { fs.rmSync(indexFile, { force: true }); } catch { /* best effort */ }
  git(["read-tree", "--empty"], gitOptions());
  git(["add", "-A", "-f", "--", "."], gitOptions());
  const tree = git(["write-tree"], gitOptions()).toString("utf8").trim();
  const commit = git(["commit-tree", tree], gitOptions()).toString("utf8").trim();
  return { tree, commit };
}

function atomicWrite(file: string, bytes: Buffer | string): void {
  privateDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    const dirFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

function artifactManifest(artifact: IsolationArtifact, baseline: WorkspaceFingerprint): string {
  return JSON.stringify({ schema_version: 1, ...artifact, baseline }, null, 2) + "\n";
}

function modesDigest(modes: Record<string, number>): string {
  const stable = Object.entries(modes).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function readOwnerPid(file: string): number | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const pid = (value as Record<string, unknown>).pid;
    return Number.isInteger(pid) && (pid as number) > 0 ? pid as number : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Conservatively collect only stale private execution material. Patch and
 * manifest artifacts are never deleted, live owners are never touched, and
 * symlinked/unknown entries are skipped rather than followed.
 */
export function gcIsolation(options: IsolationGcOptions = {}): IsolationGcResult {
  const result: IsolationGcResult = {
    examined: 0,
    removedWorktrees: 0,
    removedEmptyStores: 0,
    preservedArtifacts: 0,
    skippedLive: 0,
    skippedUnsafe: 0,
  };
  const requestedHome = path.resolve(options.homeDir ?? dataHome());
  if (!fs.existsSync(requestedHome)) return result;
  const home = fs.realpathSync(requestedHome);
  const base = path.join(home, "isolation");
  if (!fs.existsSync(base)) return result;
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    result.skippedUnsafe++;
    return result;
  }
  const now = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_GC_STALE_MS);
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    result.examined++;
    const store = path.join(base, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(store);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      result.skippedUnsafe++;
      continue;
    }
    const ownerFile = path.join(store, OWNER_FILE);
    const ownerExists = fs.existsSync(ownerFile);
    const ownerPid = readOwnerPid(ownerFile);
    if (ownerExists && ownerPid === undefined) {
      result.skippedUnsafe++;
      continue;
    }
    if (ownerPid !== undefined && processAlive(ownerPid)) {
      result.skippedLive++;
      continue;
    }
    const ownerMtime = ownerExists ? fs.lstatSync(ownerFile).mtimeMs : stat.mtimeMs;
    if (now - Math.max(stat.mtimeMs, ownerMtime) < staleAfterMs) continue;

    const artifactPresent = fs.existsSync(path.join(store, "changes.patch")) || fs.existsSync(path.join(store, "manifest.json"));
    if (artifactPresent) result.preservedArtifacts++;
    let removedExecution = false;
    for (const name of ["worktree", "repo.git", "seed", "final-seed", "git-template", "baseline.index", "final.index"] as const) {
      const target = path.join(store, name);
      let targetStat: fs.Stats;
      try {
        targetStat = fs.lstatSync(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      // Explicitly unlink symlinks so maintenance never traverses a target.
      if (targetStat.isSymbolicLink()) fs.unlinkSync(target);
      else fs.rmSync(target, { recursive: true, force: true });
      removedExecution = true;
    }
    fs.rmSync(ownerFile, { force: true });
    if (removedExecution) result.removedWorktrees++;
    if (!artifactPresent && fs.readdirSync(store).length === 0) {
      fs.rmdirSync(store);
      result.removedEmptyStores++;
    }
  }
  return result;
}

function canonicalLogicalCandidate(sourceCwd: string, value: string): { source: string; target: string } {
  const source = fs.realpathSync(sourceCwd);
  const lexical = path.resolve(sourceCwd, value);
  try {
    return { source, target: fs.realpathSync(lexical) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  let ancestor = lexical;
  const suffix: string[] = [];
  for (;;) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      return { source, target: path.join(realAncestor, ...suffix.reverse()) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          throw new IsolationError(`scope path traverses a dangling symlink: ${value}`, "config");
        }
      } catch (lstatErr) {
        if (lstatErr instanceof IsolationError) throw lstatErr;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw err;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function mapIsolationPath(sourceCwd: string, executionCwd: string, value: string): string {
  const { source, target } = canonicalLogicalCandidate(sourceCwd, value);
  if (!isWithin(source, target)) throw new IsolationError(`scope path is outside logical cwd: ${value}`, "config");
  return path.resolve(executionCwd, path.relative(source, target));
}

export function isolationMetadata(value: IsolationHandle | IsolationArtifact): IsolationSessionMetadata {
  if ("patchPath" in value) {
    return {
      mode: "worktree",
      source_cwd: value.sourceCwd,
      workspace_id: value.sessionId,
      baseline_commit: value.baselineCommit,
      baseline_tree: value.baselineTree,
      patch_path: value.patchPath,
      patch_sha256: value.patchSha256,
      apply_status: value.applyStatus,
      cleanup_status: value.cleanupStatus,
      worktree_path: value.worktreePath,
      conflict: value.conflict,
      baseline_fingerprint: value.baselineFingerprint,
      final_content_digest: value.finalContentDigest,
      final_modes: value.finalModes,
      final_modes_sha256: modesDigest(value.finalModes),
      rollback_failed: value.rollbackFailed,
    };
  }
  return {
    mode: "worktree",
    source_cwd: value.sourceCwd,
    workspace_id: value.sessionId,
    baseline_commit: value.baselineCommit,
    baseline_tree: value.baselineTree,
    apply_status: "pending",
    cleanup_status: "pending",
    worktree_path: value.worktreeRoot,
    baseline_fingerprint: value.baseline,
  };
}

export async function prepareIsolation(options: PrepareIsolationOptions): Promise<IsolationHandle> {
  const sessionId = safeId(options.sessionId);
  const sourceCwd = fs.realpathSync(options.sourceCwd);
  const { repoRoot, cwdRelative } = assertSupportedRepo(sourceCwd);
  const requestedHome = path.resolve(options.homeDir ?? dataHome());
  privateDir(requestedHome);
  const home = fs.realpathSync(requestedHome);
  if (home === repoRoot) {
    throw new IsolationError("LH_HOME cannot be the repository root when worktree isolation is enabled", "config");
  }
  const base = path.join(home, "isolation");
  privateDir(base);
  gcIsolation({ homeDir: home });
  const excluded = isWithin(repoRoot, home) ? [home] : [];
  assertNoHardlinks(repoRoot, excluded);
  const requestedStore = path.join(base, sessionId);
  if (fs.existsSync(requestedStore)) throw new IsolationError(`isolation workspace already exists: ${requestedStore}`, "conflict");
  privateDir(requestedStore);
  const storeDir = fs.realpathSync(requestedStore);
  atomicWrite(path.join(storeDir, OWNER_FILE), JSON.stringify({
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  }) + "\n");
  const baseline = fingerprint(repoRoot, excluded);
  if (options.seedBaselineFingerprint && !sameFingerprint(options.seedBaselineFingerprint, baseline)) {
    throw new IsolationError("resume baseline fingerprint no longer matches the retained artifact", "conflict");
  }
  const baselineModes = workspaceModes(repoRoot, excluded);
  const refsBefore = git(["show-ref", "--head", "--dereference"], { cwd: repoRoot, allowFailure: true });
  const objectsBefore = fs.statSync(resolveGitPath(repoRoot, "objects")).mtimeMs;
  const seed = path.join(storeDir, "seed");
  const gitDir = path.join(storeDir, "repo.git");
  const worktreeRoot = path.join(storeDir, "worktree");
  try {
    copyWorkspace(repoRoot, seed, excluded);
    const templateDir = path.join(storeDir, "git-template");
    privateDir(templateDir);
    git(["clone", "--bare", "--no-hardlinks", `--template=${templateDir}`, repoRoot, gitDir], {
      cwd: storeDir,
      env: PRIVATE_GIT_CONFIG_ENV,
    });
    const privateRepoEnv = privateRepositoryEnv(gitDir);
    git(["--git-dir", gitDir, "config", "core.autocrlf", "false"], { cwd: storeDir, env: privateRepoEnv });
    git(["--git-dir", gitDir, "config", "core.hooksPath", path.join(storeDir, "disabled-hooks")], { cwd: storeDir, env: privateRepoEnv });
    const built = treeFromDirectory(gitDir, seed, path.join(storeDir, "baseline.index"));
    if (options.seedBaselineTree && options.seedBaselineTree !== built.tree) {
      throw new IsolationError(
        "resume baseline no longer matches the retained patch; parent workspace changed",
        "conflict",
      );
    }
    const worktreeArgs = ["--git-dir", gitDir, "worktree", "add", "--no-checkout"];
    if (baseline.headRef === "(detached)") worktreeArgs.push("--detach");
    const checkoutTarget = baseline.headRef.startsWith("refs/heads/")
      ? baseline.headRef.slice("refs/heads/".length)
      : baseline.headOid;
    worktreeArgs.push(worktreeRoot, checkoutTarget);
    git(worktreeArgs, { cwd: storeDir, env: privateRepoEnv });
    if (baseline.headRef !== "(detached)" && !baseline.headRef.startsWith("refs/heads/")) {
      git(["symbolic-ref", "HEAD", baseline.headRef], { cwd: worktreeRoot, env: PRIVATE_GIT_CONFIG_ENV });
    }
    copyWorkspaceInto(repoRoot, worktreeRoot, excluded);
    copyParentIndex(repoRoot, worktreeRoot);
    const executionCwd = path.join(worktreeRoot, cwdRelative);
    if (!fs.existsSync(executionCwd)) privateDir(executionCwd);
    if (contentDigest(worktreeRoot) !== baseline.contentDigest) {
      throw new IsolationError("private worktree does not reproduce the parent workspace exactly", "internal");
    }
    const privateHead = gitText(["rev-parse", "--verify", "HEAD^{commit}"], worktreeRoot);
    const privateRef = git(["symbolic-ref", "-q", "HEAD"], {
      cwd: worktreeRoot,
      env: PRIVATE_GIT_CONFIG_ENV,
      allowFailure: true,
    }).toString("utf8").trim() || "(detached)";
    if (privateHead !== baseline.headOid || privateRef !== baseline.headRef) {
      throw new IsolationError("private worktree did not preserve parent HEAD identity", "internal");
    }
    if (options.seedPatchPath) {
      const patchStat = fs.lstatSync(options.seedPatchPath);
      if (patchStat.isSymbolicLink() || !patchStat.isFile()) {
        throw new IsolationError("retained resume patch is not a regular file", "conflict");
      }
      const patchBytes = fs.readFileSync(options.seedPatchPath);
      if (
        options.seedPatchSha256 &&
        createHash("sha256").update(patchBytes).digest("hex") !== options.seedPatchSha256
      ) {
        throw new IsolationError("retained resume patch failed its SHA-256 integrity check", "conflict");
      }
      try {
        if (patchBytes.length > 0) {
          git(["apply", "--check", "--binary", options.seedPatchPath], { cwd: worktreeRoot, env: PRIVATE_GIT_CONFIG_ENV });
          git(["apply", "--binary", options.seedPatchPath], { cwd: worktreeRoot, env: PRIVATE_GIT_CONFIG_ENV });
        }
      } catch (err) {
        throw new IsolationError(
          `retained resume patch does not apply cleanly: ${err instanceof Error ? err.message : String(err)}`,
          "conflict",
        );
      }
      const seedModes = options.seedFinalModes ?? {};
      if (options.seedFinalModesSha256 && modesDigest(seedModes) !== options.seedFinalModesSha256) {
        throw new IsolationError("retained resume modes failed their SHA-256 integrity check", "conflict");
      }
      for (const [repoPath, mode] of Object.entries(seedModes)) {
        const target = artifactPath(worktreeRoot, repoPath);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new IsolationError(`cannot replay mode for non-regular path: ${repoPath}`, "conflict");
        }
        fs.chmodSync(target, mode);
      }
      if (options.seedFinalContentDigest && contentDigest(worktreeRoot) !== options.seedFinalContentDigest) {
        throw new IsolationError("retained resume patch/modes do not reproduce their recorded final workspace", "conflict");
      }
    }
    const refsAfter = git(["show-ref", "--head", "--dereference"], { cwd: repoRoot, allowFailure: true });
    const current = fingerprint(repoRoot, excluded);
    const objectsAfter = fs.statSync(resolveGitPath(repoRoot, "objects")).mtimeMs;
    if (!refsBefore.equals(refsAfter) || !sameFingerprint(baseline, current) || objectsBefore !== objectsAfter) {
      throw new IsolationError("parent Git/workspace changed while preparing isolation", "conflict");
    }
    fs.rmSync(seed, { recursive: true, force: true });
    fs.rmSync(path.join(storeDir, "baseline.index"), { force: true });
    fs.rmSync(templateDir, { recursive: true, force: true });
    return {
      mode: "worktree",
      sessionId,
      sourceCwd,
      repoRoot,
      cwdRelative,
      storeDir,
      gitDir,
      worktreeRoot,
      executionCwd,
      baselineCommit: built.commit,
      baselineTree: built.tree,
      baseline,
      baselineModes,
      parentExcluded: excluded,
    };
  } catch (err) {
    // Retain the private directory for diagnosis; the parent has not been touched.
    throw err instanceof IsolationError ? err : new IsolationError(err instanceof Error ? err.message : String(err), "io");
  }
}

export async function finalizeIsolation(
  handle: IsolationHandle,
  options: FinalizeIsolationOptions = {},
): Promise<IsolationArtifact> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadlineAt = started + Math.max(0, timeoutMs);
  const ensureTime = () => {
    if (Date.now() >= deadlineAt) throw new IsolationError("isolation finalization timed out; worktree retained", "io");
  };
  const gitOptions = () => {
    ensureTime();
    return { cwd: handle.storeDir, env: privateRepositoryEnv(handle.gitDir), timeoutMs: Math.max(1, deadlineAt - Date.now()) };
  };
  ensureTime();
  const finalSeed = path.join(handle.storeDir, "final-seed");
  fs.rmSync(finalSeed, { recursive: true, force: true });
  const finalContentDigest = await copyWorkspaceForFinalization(handle.worktreeRoot, finalSeed, deadlineAt);
  ensureTime();
  const built = treeFromDirectory(handle.gitDir, finalSeed, path.join(handle.storeDir, "final.index"), deadlineAt);
  const patch = git([
    "--git-dir", handle.gitDir,
    "diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", handle.baselineCommit, built.commit, "--",
  ], gitOptions());
  const changed = git([
    "--git-dir", handle.gitDir,
    "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", handle.baselineCommit, built.commit, "--",
  ], gitOptions()).toString("utf8").split("\0").filter(Boolean);
  const allFinalModes = workspaceModes(finalSeed);
  const changedSet = new Set(changed);
  for (const repoPath of new Set([...Object.keys(handle.baselineModes), ...Object.keys(allFinalModes)])) {
    if (handle.baselineModes[repoPath] !== allFinalModes[repoPath]) changedSet.add(repoPath);
  }
  const changedRepoPaths = [...changedSet].sort((a, b) => a.localeCompare(b));
  const finalModes: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const repoPath of changedRepoPaths) {
    const mode = allFinalModes[repoPath];
    if (mode !== undefined) finalModes[repoPath] = mode;
  }
  ensureTime();
  const patchPath = path.join(handle.storeDir, "changes.patch");
  const manifestPath = path.join(handle.storeDir, "manifest.json");
  atomicWrite(patchPath, patch);
  const artifact: IsolationArtifact = {
    mode: "worktree",
    sessionId: handle.sessionId,
    sourceCwd: handle.sourceCwd,
    repoRoot: handle.repoRoot,
    worktreePath: handle.worktreeRoot,
    baselineCommit: handle.baselineCommit,
    baselineTree: handle.baselineTree,
    finalTree: built.tree,
    patchPath,
    manifestPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    changedRepoPaths,
    finalContentDigest,
    finalModes,
    baselineFingerprint: handle.baseline,
    applyStatus: patch.length === 0 && Object.keys(finalModes).length === 0 ? "not_needed" : "pending",
    cleanupStatus: "pending",
  };
  atomicWrite(manifestPath, artifactManifest(artifact, handle.baseline));
  fs.rmSync(finalSeed, { recursive: true, force: true });
  fs.rmSync(path.join(handle.storeDir, "final.index"), { force: true });
  return artifact;
}

interface RepoLockOwner {
  pid?: number;
  token?: string;
  journalPath?: string;
}

interface RepoLockObservation {
  dev: number;
  ino: number;
  mtimeMs: number;
  owner: RepoLockOwner;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function observeRepoLock(file: string): RepoLockObservation {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new IsolationError(`refusing symlinked isolation lock: ${file}`, "conflict");
  let owner: RepoLockOwner = {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof value === "object" && value !== null) {
      const raw = value as Record<string, unknown>;
      owner = {
        pid: Number.isInteger(raw.pid) && (raw.pid as number) > 0 ? raw.pid as number : undefined,
        token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : undefined,
        journalPath: typeof raw.journalPath === "string" && path.isAbsolute(raw.journalPath) ? raw.journalPath : undefined,
      };
    }
  } catch {
    // A malformed lock is never reclaimed automatically; fail closed.
  }
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, owner };
}

function removeObservedDeadRepoLock(file: string, observed: RepoLockObservation): boolean {
  let current: RepoLockObservation;
  try {
    current = observeRepoLock(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
  if (
    current.owner.pid !== observed.owner.pid ||
    current.owner.token !== observed.owner.token ||
    current.owner.journalPath !== observed.owner.journalPath
  ) return false;
  fs.unlinkSync(file);
  return true;
}

export function isolationRepoLockPath(repoRoot: string): string {
  return path.join(
    os.homedir(),
    ".localrig",
    "isolation-locks",
    createHash("sha256").update(fs.realpathSync(repoRoot)).digest("hex") + ".lock",
  );
}

function repoLock(repoRoot: string): {
  file: string;
  setJournal: (journalPath?: string) => void;
  keepForRecovery: () => void;
  release: () => void;
} {
  const file = isolationRepoLockPath(repoRoot);
  const locks = path.dirname(file);
  privateDir(locks);
  let fd: number | undefined;
  for (let attempt = 0; attempt < 3 && fd === undefined; attempt++) {
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const observed = observeRepoLock(file);
      if (observed.owner.pid !== undefined && !processAlive(observed.owner.pid) && observed.owner.journalPath) {
        const recovery = recoverInterruptedApply(repoRoot, observed.owner.journalPath);
        if (!recovery.ok) {
          throw new IsolationError(`cannot recover interrupted isolation apply: ${recovery.detail}`, "conflict");
        }
      }
      if (
        ((observed.owner.pid !== undefined && !processAlive(observed.owner.pid)) ||
          (observed.owner.pid === undefined && Date.now() - observed.mtimeMs > MALFORMED_REPO_LOCK_STALE_MS)) &&
        removeObservedDeadRepoLock(file, observed)
      ) {
        continue;
      }
      throw new IsolationError(`another isolation apply is active for ${repoRoot}`, "conflict");
    }
  }
  if (fd === undefined) throw new IsolationError(`could not acquire isolation apply lock for ${repoRoot}`, "conflict");
  const token = randomBytes(16).toString("hex");
  const identity = fs.fstatSync(fd);
  let journalPath: string | undefined;
  let retainForRecovery = false;
  const writeState = () => {
    const bytes = Buffer.from(JSON.stringify({ pid: process.pid, token, journalPath, createdAt: new Date().toISOString() }) + "\n");
    fs.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(fd);
  };
  writeState();
  return {
    file,
    setJournal: (value?: string) => {
      journalPath = value;
      writeState();
    },
    keepForRecovery: () => { retainForRecovery = true; },
    release: () => {
      try { fs.closeSync(fd); } finally {
        if (retainForRecovery) return;
        try {
          const current = observeRepoLock(file);
          if (
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            current.owner.pid === process.pid &&
            current.owner.token === token
          ) {
            fs.unlinkSync(file);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    },
  };
}

function sameFingerprint(a: WorkspaceFingerprint, b: WorkspaceFingerprint): boolean {
  return a.headOid === b.headOid && a.headRef === b.headRef && a.indexDigest === b.indexDigest && a.contentDigest === b.contentDigest;
}

function updateArtifact(handle: IsolationHandle, artifact: IsolationArtifact): void {
  atomicWrite(artifact.manifestPath, artifactManifest(artifact, handle.baseline));
}

function artifactPath(repoRoot: string, repoPath: string): string {
  const target = path.resolve(repoRoot, ...repoPath.split("/"));
  if (!repoPath || path.posix.isAbsolute(repoPath) || !isWithin(repoRoot, target)) {
    throw new IsolationError(`unsafe path in isolation artifact: ${JSON.stringify(repoPath)}`, "conflict");
  }
  return target;
}

interface ApplyBackupEntry {
  repoPath: string;
  kind: "missing" | "file" | "symlink";
  mode?: number;
  sha256?: string;
  linkTarget?: string;
  backupPath?: string;
}

interface ApplyBackup {
  dir: string;
  entries: ApplyBackupEntry[];
  absentParents: string[];
}

interface ApplyJournal {
  schemaVersion: 1;
  repoRoot: string;
  baseline: WorkspaceFingerprint;
  parentExcluded: string[];
  backup: ApplyBackup;
  manifestPath: string;
  finalContentDigest: string;
}

function createApplyBackup(handle: IsolationHandle, artifact: IsolationArtifact): ApplyBackup {
  const dir = path.join(handle.storeDir, "apply-backup");
  fs.rmSync(dir, { recursive: true, force: true });
  privateDir(dir);
  const entries: ApplyBackupEntry[] = [];
  const absentParents = new Set<string>();
  const backupDirectories = new Set<string>([dir]);
  for (const repoPath of artifact.changedRepoPaths) {
    const target = artifactPath(handle.repoRoot, repoPath);
    let ancestor = path.dirname(target);
    while (ancestor !== handle.repoRoot && isWithin(handle.repoRoot, ancestor) && !fs.existsSync(ancestor)) {
      absentParents.add(ancestor);
      ancestor = path.dirname(ancestor);
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        entries.push({ repoPath, kind: "missing" });
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ repoPath, kind: "symlink", linkTarget: fs.readlinkSync(target) });
      continue;
    }
    if (!stat.isFile()) throw new IsolationError(`cannot back up non-file artifact path: ${repoPath}`, "conflict");
    if (stat.nlink > 1) throw new IsolationError(`cannot apply through multiply-linked file: ${repoPath}`, "conflict");
    const backupPath = path.join(dir, ...repoPath.split("/"));
    privateDir(path.dirname(backupPath));
    for (let backupDirectory = path.dirname(backupPath); isWithin(dir, backupDirectory); backupDirectory = path.dirname(backupDirectory)) {
      backupDirectories.add(backupDirectory);
      if (backupDirectory === dir) break;
    }
    fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, stat.mode & 0o777);
    const backupFd = fs.openSync(backupPath, "r");
    try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
    entries.push({
      repoPath,
      kind: "file",
      mode: stat.mode & 0o777,
      sha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      backupPath,
    });
  }
  for (const backupDirectory of [...backupDirectories].sort((a, b) => b.length - a.length)) {
    const dirFd = fs.openSync(backupDirectory, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
  return {
    dir,
    entries,
    absentParents: [...absentParents].sort((a, b) => b.length - a.length),
  };
}

function restoreApplyBackup(repoRoot: string, backup: ApplyBackup): { ok: boolean; detail?: string } {
  try {
    for (const entry of backup.entries) {
      const target = artifactPath(repoRoot, entry.repoPath);
      fs.rmSync(target, { recursive: true, force: true });
      if (entry.kind === "missing") continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (entry.kind === "symlink") fs.symlinkSync(entry.linkTarget!, target);
      else {
        fs.copyFileSync(entry.backupPath!, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, entry.mode!);
      }
    }
    for (const dir of backup.absentParents) {
      try { fs.rmdirSync(dir); } catch (err) {
        if (!["ENOENT", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
    }
    for (const entry of backup.entries) {
      const target = artifactPath(repoRoot, entry.repoPath);
      if (entry.kind === "missing") {
        if (fs.existsSync(target)) return { ok: false, detail: `${entry.repoPath} should be absent` };
        continue;
      }
      const stat = fs.lstatSync(target);
      if (entry.kind === "symlink") {
        if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== entry.linkTarget) {
          return { ok: false, detail: `${entry.repoPath} symlink mismatch` };
        }
      } else if (
        !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== entry.mode ||
        createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== entry.sha256
      ) {
        return { ok: false, detail: `${entry.repoPath} file mismatch` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function writeApplyJournal(handle: IsolationHandle, artifact: IsolationArtifact, backup: ApplyBackup): string {
  const journalPath = path.join(handle.storeDir, "apply-journal.json");
  const journal: ApplyJournal = {
    schemaVersion: 1,
    repoRoot: handle.repoRoot,
    baseline: handle.baseline,
    parentExcluded: handle.parentExcluded,
    backup,
    manifestPath: artifact.manifestPath,
    finalContentDigest: artifact.finalContentDigest,
  };
  atomicWrite(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return journalPath;
}

function recoverInterruptedApply(repoRoot: string, journalPath: string): { ok: boolean; detail?: string } {
  try {
    const stat = fs.lstatSync(journalPath);
    if (stat.isSymbolicLink() || !stat.isFile() || path.basename(journalPath) !== "apply-journal.json") {
      return { ok: false, detail: "unsafe apply journal" };
    }
    const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Partial<ApplyJournal>;
    const canonicalRepo = fs.realpathSync(repoRoot);
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.repoRoot !== "string" || fs.realpathSync(parsed.repoRoot) !== canonicalRepo ||
      !parsed.baseline || typeof parsed.baseline.headOid !== "string" || typeof parsed.baseline.headRef !== "string" ||
      typeof parsed.baseline.indexDigest !== "string" || typeof parsed.baseline.contentDigest !== "string" ||
      !parsed.backup || !Array.isArray(parsed.backup.entries) ||
      !Array.isArray(parsed.backup.absentParents) || !Array.isArray(parsed.parentExcluded) ||
      typeof parsed.manifestPath !== "string" || !path.isAbsolute(parsed.manifestPath) ||
      typeof parsed.finalContentDigest !== "string" || !/^[0-9a-f]{64}$/i.test(parsed.finalContentDigest)
    ) {
      return { ok: false, detail: "invalid apply journal" };
    }
    const expectedBackupDir = path.join(path.dirname(journalPath), "apply-backup");
    if (path.resolve(parsed.backup.dir) !== path.resolve(expectedBackupDir)) {
      return { ok: false, detail: "apply journal backup path mismatch" };
    }
    const backupStat = fs.lstatSync(expectedBackupDir);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      return { ok: false, detail: "unsafe apply backup directory" };
    }
    if (path.dirname(path.resolve(parsed.manifestPath)) !== path.dirname(journalPath)) {
      return { ok: false, detail: "apply journal manifest path mismatch" };
    }
    for (const excluded of parsed.parentExcluded) {
      if (typeof excluded !== "string" || !path.isAbsolute(excluded) || !isWithin(canonicalRepo, excluded)) {
        return { ok: false, detail: "apply journal contains an unsafe excluded path" };
      }
    }
    for (const absent of parsed.backup.absentParents) {
      if (typeof absent !== "string" || !path.isAbsolute(absent) || absent === canonicalRepo || !isWithin(canonicalRepo, absent)) {
        return { ok: false, detail: "apply journal contains an unsafe parent path" };
      }
    }
    const seen = new Set<string>();
    for (const entry of parsed.backup.entries) {
      if (!entry || typeof entry.repoPath !== "string" || seen.has(entry.repoPath)) {
        return { ok: false, detail: "apply journal contains an invalid or duplicate entry" };
      }
      seen.add(entry.repoPath);
      artifactPath(canonicalRepo, entry.repoPath);
      if (entry.kind === "file") {
        if (
          typeof entry.backupPath !== "string" || !isWithin(expectedBackupDir, path.resolve(entry.backupPath)) ||
          !Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777 ||
          typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)
        ) return { ok: false, detail: "apply journal contains an invalid file entry" };
        const entryStat = fs.lstatSync(entry.backupPath);
        if (!entryStat.isFile() || entryStat.isSymbolicLink()) return { ok: false, detail: "unsafe apply backup file" };
      } else if (entry.kind === "symlink") {
        if (typeof entry.linkTarget !== "string") return { ok: false, detail: "invalid apply symlink entry" };
      } else if (entry.kind !== "missing") {
        return { ok: false, detail: "invalid apply journal entry kind" };
      }
    }
    const currentBeforeRecovery = fingerprint(canonicalRepo, parsed.parentExcluded);
    let manifestApplied = false;
    try {
      const manifest = JSON.parse(fs.readFileSync(parsed.manifestPath, "utf8")) as { applyStatus?: unknown };
      manifestApplied = manifest.applyStatus === "applied";
    } catch {
      // A missing/pending/corrupt manifest is not a committed apply.
    }
    if (
      manifestApplied &&
      currentBeforeRecovery.headOid === parsed.baseline.headOid &&
      currentBeforeRecovery.headRef === parsed.baseline.headRef &&
      currentBeforeRecovery.indexDigest === parsed.baseline.indexDigest &&
      currentBeforeRecovery.contentDigest === parsed.finalContentDigest
    ) {
      fs.rmSync(parsed.backup.dir, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      return { ok: true };
    }
    const restored = restoreApplyBackup(canonicalRepo, parsed.backup);
    if (!restored.ok) return restored;
    const current = fingerprint(canonicalRepo, parsed.parentExcluded);
    if (!sameFingerprint(parsed.baseline, current)) {
      return { ok: false, detail: "recovered paths do not match the baseline fingerprint" };
    }
    fs.rmSync(parsed.backup.dir, { recursive: true, force: true });
    fs.rmSync(journalPath, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function applyArtifact(
  handle: IsolationHandle,
  artifact: IsolationArtifact,
  options: { signal?: AbortSignal } = {},
): Promise<"applied" | "conflict" | "failed"> {
  let lock: ReturnType<typeof repoLock> | undefined;
  let backup: ApplyBackup | undefined;
  let journalPath: string | undefined;
  let mutationStarted = false;
  const checkInterrupted = () => {
    if (options.signal?.aborted) {
      throw new IsolationError("isolation apply interrupted", "internal");
    }
  };
  const yieldForInterrupt = async () => {
    if (!options.signal) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    checkInterrupted();
  };
  try {
    checkInterrupted();
    lock = repoLock(handle.repoRoot);
    const current = fingerprint(handle.repoRoot, handle.parentExcluded);
    if (!sameFingerprint(handle.baseline, current)) {
      artifact.applyStatus = "conflict";
      artifact.conflict = "parent HEAD, index, or workspace content changed after isolation began";
      updateArtifact(handle, artifact);
      return "conflict";
    }
    const patchStat = fs.lstatSync(artifact.patchPath);
    if (patchStat.isSymbolicLink() || !patchStat.isFile()) {
      throw new IsolationError("isolation patch is not a regular file", "conflict");
    }
    const patchDigest = createHash("sha256").update(fs.readFileSync(artifact.patchPath)).digest("hex");
    if (patchDigest !== artifact.patchSha256) {
      throw new IsolationError("isolation patch failed its SHA-256 integrity check", "conflict");
    }
    if (artifact.applyStatus === "not_needed") {
      if (current.contentDigest !== artifact.finalContentDigest) {
        artifact.applyStatus = "conflict";
        artifact.conflict = "no-op artifact does not match its recorded final workspace";
        updateArtifact(handle, artifact);
        return "conflict";
      }
      updateArtifact(handle, artifact);
      return "applied";
    }
    const changedSet = new Set(artifact.changedRepoPaths);
    if (Object.keys(artifact.finalModes).some((repoPath) => !changedSet.has(repoPath))) {
      throw new IsolationError("isolation mode metadata contains an untracked artifact path", "conflict");
    }
    if (patchStat.size > 0) git(["apply", "--check", "--binary", artifact.patchPath], { cwd: handle.repoRoot });
    // Close the check/apply window for other LocalRig workers.
    if (!sameFingerprint(handle.baseline, fingerprint(handle.repoRoot, handle.parentExcluded))) {
      artifact.applyStatus = "conflict";
      artifact.conflict = "parent changed during patch preflight";
      updateArtifact(handle, artifact);
      return "conflict";
    }
    backup = createApplyBackup(handle, artifact);
    journalPath = writeApplyJournal(handle, artifact, backup);
    lock.setJournal(journalPath);
    if (!sameFingerprint(handle.baseline, fingerprint(handle.repoRoot, handle.parentExcluded))) {
      throw new IsolationError("parent changed while the apply backup was being prepared", "conflict");
    }
    // Give a queued SIGINT a chance to run before the first parent mutation.
    // The repo lock, durable journal, and backup remain held while yielding.
    await yieldForInterrupt();
    mutationStarted = true;
    if (patchStat.size > 0) git(["apply", "--binary", artifact.patchPath], { cwd: handle.repoRoot });
    for (const [repoPath, mode] of Object.entries(artifact.finalModes)) {
      const target = artifactPath(handle.repoRoot, repoPath);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new IsolationError(`cannot restore final mode for non-regular path: ${repoPath}`, "conflict");
      }
      fs.chmodSync(target, mode);
    }
    const after = fingerprint(handle.repoRoot, handle.parentExcluded);
    if (after.headOid !== handle.baseline.headOid || after.headRef !== handle.baseline.headRef || after.indexDigest !== handle.baseline.indexDigest || after.contentDigest !== artifact.finalContentDigest) {
      throw new IsolationError("post-apply HEAD/index/content verification failed", "internal");
    }
    // SIGINT is deferred by the command-level handler while this critical
    // section runs. Observe it before committing the journal so the catch path
    // can restore and verify the parent from the durable backup.
    await yieldForInterrupt();
    artifact.applyStatus = "applied";
    artifact.conflict = undefined;
    artifact.rollbackFailed = false;
    updateArtifact(handle, artifact);
    lock.setJournal(undefined);
    fs.rmSync(journalPath, { force: true });
    fs.rmSync(backup.dir, { recursive: true, force: true });
    backup = undefined;
    journalPath = undefined;
    return "applied";
  } catch (err) {
    let detail = err instanceof Error ? err.message : String(err);
    if (options.signal && !options.signal.aborted) {
      // A real terminal SIGINT can terminate a synchronous spawnSync Git child
      // before Node dispatches its own JS signal callback. Yield once while the
      // durable lock/backup are still held so the command-level handler can
      // abort this signal and the result is classified as an interruption.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (options.signal?.aborted) detail = "isolation apply interrupted";
    if (mutationStarted && backup) {
      const rollback = restoreApplyBackup(handle.repoRoot, backup);
      let baselineRestored = false;
      try { baselineRestored = sameFingerprint(handle.baseline, fingerprint(handle.repoRoot, handle.parentExcluded)); } catch { /* reported below */ }
      if (!rollback.ok || !baselineRestored) {
        detail += `; rollback verification FAILED${rollback.detail ? `: ${rollback.detail}` : ""}`;
        artifact.rollbackFailed = true;
        lock?.keepForRecovery();
      } else {
        detail += "; rollback verified against the baseline fingerprint";
        artifact.rollbackFailed = false;
        lock?.setJournal(undefined);
        if (journalPath) fs.rmSync(journalPath, { force: true });
        fs.rmSync(backup.dir, { recursive: true, force: true });
      }
      artifact.applyStatus = "failed";
    } else {
      if (journalPath) lock?.setJournal(undefined);
      if (backup) fs.rmSync(backup.dir, { recursive: true, force: true });
      if (journalPath) fs.rmSync(journalPath, { force: true });
      artifact.applyStatus = err instanceof IsolationError && err.code === "conflict" ? "conflict" : "failed";
    }
    artifact.conflict = detail;
    updateArtifact(handle, artifact);
    return artifact.applyStatus === "conflict" ? "conflict" : "failed";
  } finally {
    lock?.release();
  }
}

export async function cleanupIsolation(
  handle: IsolationHandle,
  artifact?: IsolationArtifact,
  retainWorktree = false,
): Promise<"removed" | "retained"> {
  if (retainWorktree || artifact?.rollbackFailed) {
    if (artifact) {
      artifact.cleanupStatus = "retained";
      updateArtifact(handle, artifact);
    }
    return "retained";
  }
  try {
    fs.rmSync(handle.worktreeRoot, { recursive: true, force: true });
    fs.rmSync(handle.gitDir, { recursive: true, force: true });
    fs.rmSync(path.join(handle.storeDir, "seed"), { recursive: true, force: true });
    fs.rmSync(path.join(handle.storeDir, "final-seed"), { recursive: true, force: true });
    fs.rmSync(path.join(handle.storeDir, "git-template"), { recursive: true, force: true });
    fs.rmSync(path.join(handle.storeDir, "baseline.index"), { force: true });
    fs.rmSync(path.join(handle.storeDir, "final.index"), { force: true });
    fs.rmSync(path.join(handle.storeDir, OWNER_FILE), { force: true });
    if (artifact) {
      // Keep the former path in metadata so a resumed transcript can rewrite
      // absolute tool paths even after the checkout itself is removed.
      artifact.worktreePath = handle.worktreeRoot;
      artifact.cleanupStatus = "removed";
      updateArtifact(handle, artifact);
    } else {
      fs.rmSync(handle.storeDir, { recursive: true, force: true });
    }
    return "removed";
  } catch (err) {
    if (artifact) {
      artifact.cleanupStatus = "retained";
      artifact.worktreePath = handle.worktreeRoot;
      artifact.conflict ??= `cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
      updateArtifact(handle, artifact);
    }
    return "retained";
  }
}
