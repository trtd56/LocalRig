import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";
import { globToRegExp } from "./glob.ts";
import { isBinary } from "./read.ts";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 1024 * 1024; // manual fallback skips files > 1MB

export function createGrepTool(config: Config): ToolDef {
  return {
    name: "grep",
    mutating: false,
    description:
      "Search file contents with a regex. Args: pattern (required, regex), path (optional file or directory, default cwd), " +
      'glob (optional filename filter like "*.ts"), ignore_case (optional bool). ' +
      'Example: {"pattern": "function\\\\s+main", "glob": "*.ts"}. ' +
      "Returns file:line: text matches. Omit optional parameters entirely when unused — never pass 'undefined' or 'null' as a string.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search (default: working directory)" },
        glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.ts"' },
        ignore_case: { type: "boolean", description: "Case-insensitive search (default: false)" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const pattern = args.pattern;
        if (typeof pattern !== "string" || pattern.length === 0) {
          return { ok: false, output: 'Missing "pattern". Call grep like: {"pattern": "TODO", "glob": "*.ts"}' };
        }
        const ignoreCase = args.ignore_case === true;
        const globPat = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : undefined;
        const baseArg = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
        const baseAbs = path.resolve(ctx.cwd, baseArg);

        try {
          await fs.stat(baseAbs);
        } catch {
          return { ok: false, output: `Path not found: ${baseAbs}. Omit "path" to search the whole working directory.` };
        }

        // Validate the regex up front (also used by the manual fallback).
        let re: RegExp;
        try {
          re = new RegExp(pattern, ignoreCase ? "i" : "");
        } catch (err) {
          return {
            ok: false,
            output:
              `Invalid regex: ${err instanceof Error ? err.message : String(err)}. ` +
              'Use JavaScript regex syntax and escape literal dots/braces, e.g. {"pattern": "foo\\\\.bar"}.',
          };
        }

        const rg = await tryRipgrep(pattern, baseAbs, ctx.cwd, globPat, ignoreCase, config.grepMaxMatches);
        let matches: string[];
        if (rg.available) {
          if (rg.error) return { ok: false, output: rg.error };
          matches = rg.matches;
        } else {
          matches = await manualGrep(re, baseAbs, ctx.cwd, globPat, config.grepMaxMatches);
        }

        if (matches.length === 0) {
          return { ok: true, output: "no matches found", display: `grep ${pattern} (0 matches)` };
        }
        let output = matches.slice(0, config.grepMaxMatches).join("\n");
        if (matches.length >= config.grepMaxMatches) {
          output += `\n[capped at ${config.grepMaxMatches} matches — narrow the pattern]`;
        }
        const shown = Math.min(matches.length, config.grepMaxMatches);
        return { ok: true, output, display: `grep ${pattern} (${shown} matches)` };
      } catch (err) {
        return { ok: false, output: `grep failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ripgrep front end
// ---------------------------------------------------------------------------

interface RgOutcome {
  available: boolean;
  matches: string[];
  error?: string;
}

function tryRipgrep(
  pattern: string,
  baseAbs: string,
  cwd: string,
  globPat: string | undefined,
  ignoreCase: boolean,
  maxMatches: number,
): Promise<RgOutcome> {
  return new Promise((resolve) => {
    const rgArgs = ["--line-number", "--no-heading", "--with-filename", "--color", "never"];
    if (ignoreCase) rgArgs.push("-i");
    if (globPat) rgArgs.push("--glob", globPat);
    rgArgs.push("-e", pattern, "--", baseAbs);

    const proc = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let unavailable = false;
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
      if (stdout.length > maxMatches * 2000) proc.kill("SIGTERM"); // plenty collected
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.on("error", () => {
      unavailable = true; // rg not installed
      resolve({ available: false, matches: [] });
    });
    proc.on("close", (code) => {
      if (unavailable) return;
      if (code !== 0 && code !== 1 && stdout === "") {
        // 2 = rg error (e.g. bad pattern for rust regex) — fall back to manual? The
        // JS regex already validated, so report rg's message with a hint.
        resolve({ available: false, matches: [] });
        return;
      }
      const matches: string[] = [];
      for (const line of stdout.split("\n")) {
        if (line === "") continue;
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const rel = relPath(cwd, m[1]!);
        matches.push(`${rel}:${m[2]}: ${m[3]}`);
        if (matches.length >= maxMatches) break;
      }
      resolve({ available: true, matches });
    });
  });
}

// ---------------------------------------------------------------------------
// manual fallback (no rg on the machine)
// ---------------------------------------------------------------------------

export async function manualGrep(
  re: RegExp,
  baseAbs: string,
  cwd: string,
  globPat: string | undefined,
  maxMatches: number,
): Promise<string[]> {
  const globRe = globPat ? globToRegExp(globPat) : null;
  const matchesGlob = (rel: string): boolean => {
    if (!globRe) return true;
    const target = globPat!.includes("/") ? rel : rel.split("/").pop()!;
    return globRe.test(target);
  };

  const out: string[] = [];
  const files: string[] = [];
  const st = await fs.stat(baseAbs);
  if (st.isFile()) {
    files.push(baseAbs);
  } else {
    await collectFiles(baseAbs, files);
    files.sort();
  }

  for (const file of files) {
    if (out.length >= maxMatches) break;
    const rel = relPath(cwd, file);
    if (!matchesGlob(path.relative(baseAbs, file).split(path.sep).join("/") || path.basename(file))) continue;
    let buf: Buffer;
    try {
      const s = await fs.stat(file);
      if (s.size > MAX_FILE_BYTES) continue;
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (re.test(line)) {
        out.push(`${rel}:${i + 1}: ${line.endsWith("\r") ? line.slice(0, -1) : line}`);
        if (out.length >= maxMatches) break;
      }
    }
  }
  return out;
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collectFiles(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  if (r === "") return ".";
  return r.startsWith("..") ? abs : r;
}
