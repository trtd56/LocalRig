import type { AgentEvent } from "../types.ts";

const isTTY = process.stdout.isTTY ?? false;
const c = {
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
};

export { c };

/**
 * Streams agent events to the terminal. Thinking is dimmed, tool calls are
 * one-liners, tool output is shown truncated.
 */
export function createRenderer(verbose: boolean): (e: AgentEvent) => void {
  let mode: "idle" | "thinking" | "content" = "idle";

  const ensureNewline = () => {
    if (mode !== "idle") {
      process.stdout.write("\n");
      mode = "idle";
    }
  };

  return (e: AgentEvent) => {
    switch (e.type) {
      case "thinking_delta":
        if (mode !== "thinking") {
          ensureNewline();
          process.stdout.write(c.dim("· thinking: "));
          mode = "thinking";
        }
        process.stdout.write(c.dim(e.text.replace(/\n+/g, " ")));
        break;
      case "content_delta":
        if (mode !== "content") {
          ensureNewline();
          mode = "content";
        }
        process.stdout.write(e.text);
        break;
      case "turn_end":
        ensureNewline();
        break;
      case "tool_start":
        ensureNewline();
        process.stdout.write(c.cyan(`⏺ ${e.display}`) + "\n");
        break;
      case "tool_end": {
        const head = e.result.display ?? firstLine(e.result.output);
        const mark = e.result.ok ? c.green("  ⎿ ") : c.red("  ⎿ ✗ ");
        process.stdout.write(mark + c.dim(truncate(head, 120)) + "\n");
        if (verbose && e.result.output.length > 120) {
          process.stdout.write(c.dim(indent(truncate(e.result.output, 2000), "    ")) + "\n");
        }
        break;
      }
      case "repair":
        ensureNewline();
        process.stdout.write(c.yellow(`  ⚠ tool-call repair: ${truncate(e.problem, 160)}`) + "\n");
        break;
      case "loop_warning":
        ensureNewline();
        process.stdout.write(c.yellow(`  ⚠ ${e.message}`) + "\n");
        break;
      case "prune":
        ensureNewline();
        process.stdout.write(c.dim(`· pruned old tool output (~${e.freedTokens} tokens freed)`) + "\n");
        break;
      case "compact":
        ensureNewline();
        process.stdout.write(
          c.dim(`· compacted context: ~${e.beforeTokens} → ~${e.afterTokens} tokens`) + "\n",
        );
        break;
      case "status":
        ensureNewline();
        process.stdout.write(c.dim(`· ${e.message}`) + "\n");
        break;
      case "usage":
        if (verbose) {
          ensureNewline();
          process.stdout.write(c.dim(`· ctx: ${e.promptTokens} prompt tokens (${e.ctxPercent}%)`) + "\n");
        }
        break;
    }
  };
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i) + " …";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function indent(s: string, pad: string): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
