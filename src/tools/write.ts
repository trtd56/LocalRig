import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";

export function createWriteTool(_config: Config): ToolDef {
  return {
    name: "write",
    mutating: true,
    description:
      "Write a file (creates it, or fully replaces its contents). Parent directories are created automatically. " +
      'Args: path (required), content (required, the COMPLETE new file contents), overwrite (optional). ' +
      'Example: {"path": "src/util.ts", "content": "export const x = 1;\\n"}. ' +
      "To change part of an existing file, use the edit tool instead — full rewrites frequently drop existing code.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        content: { type: "string", description: "Complete new file contents" },
        overwrite: { type: "boolean", description: "Required to replace an existing file of 30+ lines" },
      },
      required: ["path", "content"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const p = args.path;
        if (typeof p !== "string" || p.length === 0) {
          return { ok: false, output: 'Missing "path". Call write like: {"path": "src/util.ts", "content": "..."}' };
        }
        const content = args.content;
        if (typeof content !== "string") {
          return {
            ok: false,
            output: 'Missing "content" (must be a string — the complete file contents). Call write like: {"path": "src/util.ts", "content": "..."}',
          };
        }
        const overwrite = args.overwrite === true;
        const abs = path.resolve(ctx.cwd, p);
        const rel = relPath(ctx.cwd, abs);

        // Inspect any existing file so we can no-op identical writes and guard
        // against full rewrites that silently drop code.
        let existing: string | null = null;
        try {
          const st = await fs.stat(abs);
          if (st.isDirectory()) {
            return { ok: false, output: `${abs} is a directory. Pass a file path instead.` };
          }
          existing = await fs.readFile(abs, "utf8");
        } catch {
          // does not exist (or unreadable) — treat as a new file
        }

        if (existing !== null) {
          // Identical content: don't touch disk (kills duplicate rewrites).
          if (existing === content) {
            ctx.readFiles.set(abs, Date.now());
            return { ok: true, output: "No change: file already contains exactly this content.", display: `no change ${rel}` };
          }
          const existingLines = countLines(existing);
          if (existingLines >= 30 && !overwrite) {
            return {
              ok: false,
              output:
                `${abs} already exists (${existingLines} lines). Use edit for targeted changes — ` +
                `full rewrites of existing files frequently drop existing code. If you truly need to ` +
                `replace the entire file, re-issue write with overwrite: true and the COMPLETE file contents.`,
            };
          }
        }

        const existedUnread = existing !== null && !ctx.readFiles.has(abs);

        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        ctx.readFiles.set(abs, Date.now());

        const n = countLines(content);
        let output = `wrote ${n} lines to ${abs}`;
        if (existedUnread) {
          output = `[warning] overwrote existing file that was never read\n` + output;
        }
        return { ok: true, output, display: `wrote ${rel} (${n} lines)` };
      } catch (err) {
        return { ok: false, output: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  if (r === "") return ".";
  return r.startsWith("..") ? abs : r;
}
