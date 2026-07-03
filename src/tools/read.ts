import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";

/** True if the first 8KB contain a null byte (binary heuristic). */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function createReadTool(config: Config): ToolDef {
  return {
    name: "read",
    mutating: false,
    description:
      "Read a text file, returning numbered lines. Args: path (required), offset (1-based first line, optional), limit (max lines, optional). " +
      'Example: {"path": "src/main.ts", "offset": 1, "limit": 100}. ' +
      "The line numbers are labels only — never copy them into edit old_string. " +
      "Omit optional parameters entirely when unused — never pass 'undefined' or 'null' as a string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        offset: { type: "number", description: "1-based line number to start from (optional)" },
        limit: { type: "number", description: "Maximum number of lines to return (optional)" },
      },
      required: ["path"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const p = args.path;
        if (typeof p !== "string" || p.length === 0) {
          return { ok: false, output: 'Missing "path". Call read like: {"path": "src/main.ts"}' };
        }
        const abs = path.resolve(ctx.cwd, p);
        const rel = relPath(ctx.cwd, abs);
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          return {
            ok: false,
            output: `File not found: ${abs}. Use the glob tool to locate it, e.g. {"pattern": "**/${path.basename(abs)}"}.`,
          };
        }
        if (st.isDirectory()) {
          return {
            ok: false,
            output: `${abs} is a directory, not a file. Use the glob tool to list its files, e.g. {"pattern": "${rel === "." ? "" : rel + "/"}**/*"}.`,
          };
        }
        const buf = await fs.readFile(abs);
        if (isBinary(buf)) {
          return {
            ok: false,
            output: `${abs} looks like a binary file (contains null bytes); refusing to read it as text. If you must inspect it, use the bash tool (e.g. file, strings, xxd).`,
          };
        }
        const text = buf.toString("utf8");
        if (text.length === 0) {
          ctx.readFiles.set(abs, Date.now());
          return { ok: true, output: "(empty file)", filePath: abs, display: `read ${rel} (empty)` };
        }
        const lines = text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
        const total = lines.length;

        const offset = clampInt(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
        if (offset > total) {
          return {
            ok: false,
            output: `offset ${offset} is past the end of the file (${total} lines). Use an offset between 1 and ${total}.`,
          };
        }
        const limit = clampInt(args.limit, 1, config.readMaxLines, config.readMaxLines);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const endLine = offset - 1 + slice.length;
        const width = String(endLine).length;
        const numbered = slice.map((line, i) => {
          let l = line;
          if (l.length > config.readMaxLineChars) {
            l = l.slice(0, config.readMaxLineChars) + "… [line truncated]";
          }
          return String(offset + i).padStart(width) + "\t" + l;
        });
        let output = numbered.join("\n");
        if (endLine < total) {
          output += `\n[Showing lines ${offset}–${endLine} of ${total}. Use offset=${endLine + 1} to continue.]`;
        } else if (offset > 1) {
          output += `\n[Showing lines ${offset}–${endLine} of ${total}.]`;
        }
        ctx.readFiles.set(abs, Date.now());
        return {
          ok: true,
          output,
          filePath: abs,
          display: `read ${rel} (${slice.length} lines)`,
        };
      } catch (err) {
        return { ok: false, output: `read failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  if (r === "") return ".";
  return r.startsWith("..") ? abs : r;
}
