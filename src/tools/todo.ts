import type { Config } from "../config.ts";
import type { TodoItem, ToolDef, ToolResult } from "../types.ts";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

/** Render todos as checklist lines: [x] done, [>] in progress, [ ] pending. */
export function renderTodos(todos: TodoItem[]): string {
  return todos
    .map((t) => {
      const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
      return `[${mark}] ${t.content}`;
    })
    .join("\n");
}

export function createTodoTool(_config: Config): ToolDef {
  return {
    name: "todo",
    mutating: false,
    description:
      "Maintain your task list. Call with the FULL updated list each time (it replaces the previous list). " +
      "Use for multi-step tasks: plan first, mark in_progress when starting an item (only one at a time), completed immediately when done. " +
      'Example: {"items": [{"content": "add tests", "status": "in_progress"}, {"content": "run linter", "status": "pending"}]}',
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The complete todo list (replaces the old one)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short description of the task" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task state" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["items"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const raw = args.items;
        if (!Array.isArray(raw)) {
          return {
            ok: false,
            output:
              '"items" must be an array of {content, status} objects. Example: {"items": [{"content": "run tests", "status": "pending"}]}',
          };
        }
        const parsed: TodoItem[] = [];
        for (let i = 0; i < raw.length; i++) {
          const it = raw[i];
          if (typeof it !== "object" || it === null || Array.isArray(it)) {
            return { ok: false, output: `items[${i}] must be an object like {"content": "run tests", "status": "pending"}` };
          }
          const o = it as Record<string, unknown>;
          const content = o.content;
          const status = o.status ?? "pending";
          if (typeof content !== "string" || content.trim().length === 0) {
            return { ok: false, output: `items[${i}].content must be a non-empty string.` };
          }
          if (typeof status !== "string" || !STATUSES.has(status)) {
            return {
              ok: false,
              output: `items[${i}].status must be "pending", "in_progress" or "completed" (got ${JSON.stringify(status)}).`,
            };
          }
          parsed.push({ id: i + 1, content: content.trim(), status: status as TodoItem["status"] });
        }

        // Replace the shared list in place.
        ctx.todos.length = 0;
        ctx.todos.push(...parsed);

        const rendered = renderTodos(ctx.todos);
        const done = parsed.filter((t) => t.status === "completed").length;
        return {
          ok: true,
          output: rendered.length > 0 ? rendered : "(todo list is now empty)",
          display: `todo (${parsed.length} items, ${done} done)`,
        };
      } catch (err) {
        return { ok: false, output: `todo failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
