import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceScope, WorkspaceScopeInput } from "../types.ts";

/** Raised when an existing path resolves outside the tool working directory. */
export class PathOutsideCwdError extends Error {
  constructor(candidate: string) {
    super(`Path is outside the working directory: ${candidate}`);
    this.name = "PathOutsideCwdError";
  }
}

/** Raised when a path is inside cwd but outside the delegated task scope. */
export class PathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathScopeError";
  }
}

export interface ResolvedToolPath {
  /** Canonical working directory, with symlinks resolved. */
  cwd: string;
  /** Canonical existing target path, with symlinks resolved. */
  target: string;
}

/**
 * Resolve an existing tool path and require its real location to be inside cwd.
 *
 * Resolving both sides prevents absolute paths, `..`, and symlinks from escaping
 * the working directory while still allowing absolute paths that point within it.
 */
export async function resolveExistingPathWithinCwd(cwd: string, candidate: string): Promise<ResolvedToolPath> {
  const [realCwd, realTarget] = await Promise.all([fs.promises.realpath(cwd), fs.promises.realpath(path.resolve(cwd, candidate))]);
  const rel = path.relative(realCwd, realTarget);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathOutsideCwdError(path.resolve(cwd, candidate));
  }
  return { cwd: realCwd, target: realTarget };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * Canonicalize an existing or prospective path without following a missing
 * leaf. For a new file, the nearest existing ancestor is realpathed and the
 * missing suffix is appended. This catches symlinked parent-directory escapes.
 */
function canonicalCandidate(realCwd: string, cwd: string, candidate: string, mustExist: boolean): string {
  const lexical = path.resolve(cwd, candidate);

  try {
    const target = fs.realpathSync(lexical);
    if (!isWithin(realCwd, target)) throw new PathOutsideCwdError(lexical);
    return target;
  } catch (err) {
    if (err instanceof PathOutsideCwdError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (mustExist || (code !== "ENOENT" && code !== "ENOTDIR")) throw err;
  }

  let ancestor = lexical;
  const suffix: string[] = [];
  for (;;) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      if (!isWithin(realCwd, realAncestor)) throw new PathOutsideCwdError(lexical);
      const target = path.join(realAncestor, ...suffix.reverse());
      if (!isWithin(realCwd, target)) throw new PathOutsideCwdError(lexical);
      return target;
    } catch (err) {
      if (err instanceof PathOutsideCwdError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // A dangling symlink (or symlink loop) cannot be safely treated as a
      // missing path: a later open() would follow it after this check.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw new PathOutsideCwdError(lexical);
      } catch (lstatErr) {
        if (lstatErr instanceof PathOutsideCwdError) throw lstatErr;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw err;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Resolve and validate CLI/manifest scope before starting a model session. */
export function prepareWorkspaceScope(cwd: string, input: WorkspaceScopeInput = {}): WorkspaceScope {
  const absoluteCwd = path.resolve(cwd);
  const realCwd = fs.realpathSync(absoluteCwd);
  if (!fs.statSync(realCwd).isDirectory()) throw new PathScopeError(`working directory is not a directory: ${cwd}`);

  const canonicalList = (values: string[] | undefined, fallback: string[]): string[] => {
    const list = values && values.length > 0 ? values : fallback;
    const out = list.map((value) => {
      if (typeof value !== "string" || value.trim() === "") throw new PathScopeError("scope paths must be non-empty strings");
      return canonicalCandidate(realCwd, absoluteCwd, value, false);
    });
    return [...new Set(out)];
  };

  return {
    cwd: realCwd,
    allowedPaths: canonicalList(input.allowedPaths, ["."]),
    protectedPaths: canonicalList(input.protectedPaths, []),
  };
}

/** Intersect allowlists and union protected paths; neither side can widen the other. */
export function intersectWorkspaceScopes(a: WorkspaceScope, b: WorkspaceScope): WorkspaceScope {
  if (a.cwd !== b.cwd) throw new PathScopeError("cannot combine scopes for different working directories");
  const allowed: string[] = [];
  for (const left of a.allowedPaths) {
    for (const right of b.allowedPaths) {
      if (isWithin(left, right)) allowed.push(right);
      else if (isWithin(right, left)) allowed.push(left);
    }
  }
  const deduped = [...new Set(allowed)];
  if (deduped.length === 0) throw new PathScopeError("task allowed_paths do not overlap the CLI allowed path scope");
  return {
    cwd: a.cwd,
    allowedPaths: deduped,
    protectedPaths: [...new Set([...a.protectedPaths, ...b.protectedPaths])],
    privateGitPaths: [...new Set([...(a.privateGitPaths ?? []), ...(b.privateGitPaths ?? [])])],
  };
}

/**
 * Resolve a tool path and enforce its allow/protect policy. The canonical path
 * is returned so the underlying tool never re-enters through the original
 * symlink spelling.
 */
export function resolvePathWithinScope(
  scope: WorkspaceScope,
  candidate: string,
  options: { mustExist?: boolean; mutation?: boolean } = {},
): string {
  const target = canonicalCandidate(scope.cwd, scope.cwd, candidate, options.mustExist ?? true);
  if (!scope.allowedPaths.some((allowed) => isWithin(allowed, target))) {
    throw new PathScopeError(`Path is outside the allowed task scope: ${path.resolve(scope.cwd, candidate)}`);
  }
  if (options.mutation && scope.protectedPaths.some((protectedPath) => isWithin(protectedPath, target))) {
    throw new PathScopeError(`Path is protected from modification: ${path.resolve(scope.cwd, candidate)}`);
  }
  if (options.mutation) {
    try {
      const stat = fs.statSync(target);
      if (stat.isFile() && stat.nlink > 1) {
        throw new PathScopeError(`Refusing to modify a hard-linked file: ${path.resolve(scope.cwd, candidate)}`);
      }
    } catch (err) {
      if (err instanceof PathScopeError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return target;
}
