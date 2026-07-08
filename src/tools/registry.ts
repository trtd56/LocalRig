import type { Config } from "../config.ts";
import type { ToolContext, ToolDef } from "../types.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createBashTool } from "./bash.ts";
import { createGrepTool } from "./grep.ts";
import { createGlobTool } from "./glob.ts";
import { createTodoTool } from "./todo.ts";
import { PathOutsideCwdError, resolveExistingPathWithinCwd } from "./path-boundary.ts";

export { renderTodos } from "./todo.ts";

/**
 * Build the tool set. Each tool captures `config`; the live ToolContext is the
 * one the agent passes to execute() on every call (`_ctx` here is accepted for
 * API symmetry but tools must use the execute-time ctx).
 */
export function createTools(config: Config, _ctx: ToolContext): ToolDef[] {
  return [
    createReadTool(config),
    createWriteTool(config),
    createEditTool(config),
    createBashTool(config),
    createGrepTool(config),
    createGlobTool(config),
    createTodoTool(config),
  ];
}

/** Read-only exploration profile for `lh scout`. */
export function createScoutTools(config: Config, _ctx: ToolContext): ToolDef[] {
  return [createReadTool(config), createGrepTool(config), createGlobTool(config)].map(restrictToCwd);
}

/** Keep scout discovery inside its repository without narrowing the normal coding agent. */
function restrictToCwd(tool: ToolDef): ToolDef {
  return {
    ...tool,
    async execute(args, ctx) {
      const candidate = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
      try {
        await resolveExistingPathWithinCwd(ctx.cwd, candidate);
      } catch (err) {
        if (err instanceof PathOutsideCwdError) return { ok: false, output: err.message };
        return tool.execute(args, ctx);
      }
      return tool.execute(args, ctx);
    },
  };
}
