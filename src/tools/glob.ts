import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";

/** Directories never descended into. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);

const MAX_RESULTS = 200;

/**
 * Translate a glob pattern to a RegExp. Supports **, *, ?, {a,b}, [abc].
 * `*` and `?` never cross `/`; `**` does.
 */
export function globToRegExp(pattern: string): RegExp {
  // Leading "./" is noise.
  let p = pattern;
  while (p.startsWith("./")) p = p.slice(2);
  let re = "";
  let braceDepth = 0;
  let i = 0;
  const NEEDS_ESCAPE = new Set([".", "+", "^", "$", "(", ")", "|", "\\", "}"]);
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**" — crosses directory boundaries.
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      // Character class: copy through to the closing "]".
      let j = i + 1;
      let cls = "";
      if (p[j] === "!" || p[j] === "^") {
        cls += "^";
        j += 1;
      }
      let closed = false;
      for (; j < p.length; j++) {
        const cc = p[j]!;
        if (cc === "]" && cls !== "" && cls !== "^") {
          closed = true;
          break;
        }
        cls += cc === "\\" || cc === "]" ? "\\" + cc : cc;
      }
      if (closed) {
        re += "[" + cls + "]";
        i = j + 1;
      } else {
        re += "\\["; // unterminated class -> literal "["
        i += 1;
      }
    } else if (c === "{") {
      braceDepth += 1;
      re += "(?:";
      i += 1;
    } else if (c === "}" && braceDepth > 0) {
      braceDepth -= 1;
      re += ")";
      i += 1;
    } else if (c === "," && braceDepth > 0) {
      re += "|";
      i += 1;
    } else {
      re += NEEDS_ESCAPE.has(c) ? "\\" + c : c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

interface Hit {
  rel: string;
  mtime: number;
}

async function walk(dir: string, baseAbs: string, re: RegExp, out: Hit[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip silently
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, baseAbs, re, out);
    } else if (e.isFile()) {
      const rel = path.relative(baseAbs, full).split(path.sep).join("/");
      if (re.test(rel)) {
        try {
          const st = await fs.stat(full);
          out.push({ rel, mtime: st.mtimeMs });
        } catch {
          out.push({ rel, mtime: 0 });
        }
      }
    }
    // Symlinks are ignored (avoids cycles).
  }
}

export function createGlobTool(_config: Config): ToolDef {
  return {
    name: "glob",
    mutating: false,
    description:
      'Find files by glob pattern (supports **, *, ?, {a,b}, [abc]). Args: pattern (required), path (optional base directory, default cwd). ' +
      'Example: {"pattern": "**/*.ts"} or {"pattern": "src/*.json", "path": "packages/core"}. ' +
      "Results are relative paths, newest first. Omit optional parameters entirely when unused — never pass 'undefined' or 'null' as a string.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts"' },
        path: { type: "string", description: "Base directory to search from (default: working directory)" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const pattern = args.pattern;
        if (typeof pattern !== "string" || pattern.length === 0) {
          return { ok: false, output: 'Missing "pattern". Call glob like: {"pattern": "**/*.ts"}' };
        }
        const baseArg = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
        const baseAbs = path.resolve(ctx.cwd, baseArg);
        let st;
        try {
          st = await fs.stat(baseAbs);
        } catch {
          return {
            ok: false,
            output: `Base directory not found: ${baseAbs}. Omit "path" to search from the working directory.`,
          };
        }
        if (!st.isDirectory()) {
          return {
            ok: false,
            output: `${baseAbs} is a file, not a directory. Pass a directory as "path", or read the file directly with the read tool.`,
          };
        }
        let re: RegExp;
        try {
          re = globToRegExp(pattern);
        } catch (err) {
          return {
            ok: false,
            output: `Could not parse glob pattern ${JSON.stringify(pattern)}: ${msg(err)}. Use a simple pattern like "**/*.ts".`,
          };
        }
        const hits: Hit[] = [];
        await walk(baseAbs, baseAbs, re, hits);
        if (hits.length === 0) {
          return {
            ok: true,
            output: "no files match",
            display: `glob ${pattern} (0 files)`,
          };
        }
        hits.sort((a, b) => b.mtime - a.mtime);
        const shown = hits.slice(0, MAX_RESULTS);
        let output = shown.map((h) => h.rel).join("\n");
        if (hits.length > MAX_RESULTS) {
          output += `\n[showing ${MAX_RESULTS} of ${hits.length} matches — narrow the pattern]`;
        }
        return {
          ok: true,
          output,
          display: `glob ${pattern} (${hits.length} files)`,
        };
      } catch (err) {
        return { ok: false, output: `glob failed: ${msg(err)}` };
      }
    },
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
