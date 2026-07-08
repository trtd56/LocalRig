import type { Config } from "../config.ts";
import type { ToolContext, ToolDef, WorkspaceScope } from "../types.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createBashTool } from "./bash.ts";
import { createGrepTool } from "./grep.ts";
import { createGlobTool } from "./glob.ts";
import { createTodoTool } from "./todo.ts";
import { PathOutsideCwdError, PathScopeError, prepareWorkspaceScope, resolvePathWithinScope } from "./path-boundary.ts";

export { renderTodos } from "./todo.ts";

/**
 * Build the tool set. Each tool captures `config`; the live ToolContext is the
 * one the agent passes to execute() on every call (`_ctx` here is accepted for
 * API symmetry but tools must use the execute-time ctx).
 */
export function createTools(config: Config, _ctx: ToolContext): ToolDef[] {
  return [
    restrictPathTool(createReadTool(config), false, true),
    restrictPathTool(createWriteTool(config), true, true),
    restrictPathTool(createEditTool(config), true, true),
    createBashTool(config),
    restrictPathTool(createGrepTool(config), false, true),
    restrictPathTool(createGlobTool(config), false, true),
    createTodoTool(config),
  ];
}

/** Read-only exploration profile for `lh scout`. */
export function createScoutTools(config: Config, _ctx: ToolContext): ToolDef[] {
  return [createReadTool(config), createGrepTool(config), createGlobTool(config)].map((tool) => restrictPathTool(tool, false, true));
}

/** Apply the same cwd/symlink/scope boundary to normal coding and scout tools. */
function restrictPathTool(tool: ToolDef, mutation = false, allowMissing = false): ToolDef {
  return {
    ...tool,
    async execute(args, ctx) {
      const candidate = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
      let scope: WorkspaceScope;
      try {
        scope = ctx.scope ?? prepareWorkspaceScope(ctx.cwd);
        const target = resolvePathWithinScope(scope, candidate, { mustExist: !allowMissing, mutation });
        args = { ...args, path: target };
      } catch (err) {
        if (err instanceof PathOutsideCwdError || err instanceof PathScopeError) return { ok: false, output: err.message };
        return { ok: false, output: `${tool.name} path validation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      return tool.execute(args, ctx.cwd === scope.cwd
        ? ctx
        : { ...ctx, cwd: scope.cwd });
    },
  };
}
