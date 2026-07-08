import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Raised when an existing path resolves outside the tool working directory. */
export class PathOutsideCwdError extends Error {
  constructor(candidate: string) {
    super(`Path is outside the working directory: ${candidate}`);
    this.name = "PathOutsideCwdError";
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
  const [realCwd, realTarget] = await Promise.all([fs.realpath(cwd), fs.realpath(path.resolve(cwd, candidate))]);
  const rel = path.relative(realCwd, realTarget);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathOutsideCwdError(path.resolve(cwd, candidate));
  }
  return { cwd: realCwd, target: realTarget };
}
