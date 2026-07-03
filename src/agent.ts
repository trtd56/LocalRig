import type { Config } from "./config.ts";
import type { AgentEvent, ChatMessage, ToolContext, ToolDef, ToolResult } from "./types.ts";
import { OllamaClient } from "./provider/ollama.ts";
import { buildSystemPrompt } from "./prompt/system.ts";
import { createTools, renderTodos } from "./tools/registry.ts";
import { resolveToolCall, type ResolvedCall } from "./toolcall/validate.ts";
import { parseFallbackToolCalls } from "./toolcall/fallback.ts";
import { LoopDetector } from "./toolcall/loopdetect.ts";
import { ContextManager } from "./context/manager.ts";
import { canAutoApprove } from "./permissions.ts";

export type PermissionFn = (
  name: string,
  args: Record<string, unknown>,
  display: string,
) => Promise<boolean>;

export class Agent {
  private messages: ChatMessage[] = [];
  private client: OllamaClient;
  private tools: ToolDef[];
  private toolCtx: ToolContext;
  private loopDetector: LoopDetector;
  private contextManager: ContextManager;
  private seq = 0;
  private lastTodoRender = "";
  private abort = new AbortController();

  constructor(
    private config: Config,
    private cwd: string,
    private onEvent: (e: AgentEvent) => void,
    private askPermission: PermissionFn,
  ) {
    this.client = new OllamaClient(config.ollamaUrl, config.model);
    this.toolCtx = {
      cwd,
      readFiles: new Map(),
      todos: [],
      signal: this.abort.signal,
    };
    this.tools = createTools(config, this.toolCtx);
    this.loopDetector = new LoopDetector(config.loopWarnAfter, config.loopAbortAfter);
    this.contextManager = new ContextManager(config, this.client);
    this.messages.push(this.stamp({ role: "system", content: buildSystemPrompt(cwd, config) }));
  }

  interrupt(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.toolCtx.signal = this.abort.signal;
  }

  private stamp(m: ChatMessage): ChatMessage {
    m._seq = this.seq++;
    return m;
  }

  private push(m: ChatMessage): void {
    this.messages.push(this.stamp(m));
  }

  /** Run one user request to completion. Returns the final assistant text. */
  async run(userInput: string): Promise<string> {
    this.push({ role: "user", content: userInput });
    this.loopDetector.reset();

    for (let iteration = 0; iteration <= this.config.maxIterations; iteration++) {
      // Last iteration: force a text-only wrap-up instead of dropping the session.
      const wrapUp = iteration === this.config.maxIterations;
      if (wrapUp) {
        this.push({
          role: "user",
          content:
            "[system] CRITICAL - maximum steps reached. Do NOT make any tool calls. Respond with text only: summarize what was accomplished, what remains, and any blockers.",
        });
      }
      await this.contextManager.manage(this.messages, this.onEvent, this.abort.signal);

      let response;
      try {
        response = await this.client.chat(
          this.messages,
          this.tools,
          {
            num_ctx: this.config.numCtx,
            num_predict: this.config.numPredict,
            temperature: this.config.temperature,
            top_p: this.config.topP,
            top_k: this.config.topK,
          },
          (chunk) => {
            if (chunk.thinking) this.onEvent({ type: "thinking_delta", text: chunk.thinking });
            if (chunk.content) this.onEvent({ type: "content_delta", text: chunk.content });
          },
          this.abort.signal,
        );
      } catch (err) {
        if (this.abort.signal.aborted) return "[interrupted]";
        throw err;
      }
      this.onEvent({ type: "turn_end" });

      const msg = response.message;
      this.push(msg);
      this.contextManager.recordUsage(this.messages, response.promptTokens, response.evalTokens);
      this.onEvent({
        type: "usage",
        promptTokens: response.promptTokens,
        ctxPercent: Math.round((100 * (response.promptTokens + response.evalTokens)) / this.config.numCtx),
      });

      if (wrapUp) return msg.content || "[stopped: reached max iterations]";

      // Fallback: some turns emit tool calls as text instead of native calls.
      let calls = msg.tool_calls ?? [];
      if (calls.length === 0 && msg.content) {
        const parsed = parseFallbackToolCalls(msg.content);
        if (parsed.length > 0) {
          calls = parsed;
          msg.tool_calls = parsed;
          // Strip the textual call blocks so history doesn't render them twice.
          msg.content = msg.content
            .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "")
            .replace(/```json\s*\{[\s\S]*?```/g, "")
            .trim();
        }
      }

      if (calls.length === 0) {
        if (response.truncated) {
          this.push({
            role: "user",
            content:
              "[system] Your previous message hit the output-length limit and was cut off. Continue exactly from where it stopped — do not repeat what you already wrote.",
          });
          continue;
        }
        if (!msg.content.trim()) {
          // Empty turn: nudge once, then give up to avoid spinning.
          if (this.loopDetector.noteEmptyTurn()) {
            this.push({
              role: "user",
              content:
                "[system] Your last message was empty. Either call a tool to make progress or write your final answer as plain text.",
            });
            continue;
          }
          return "[the model produced no output]";
        }
        return msg.content; // final answer
      }

      for (const call of calls) {
        // A truncated response may carry an incomplete edit/write payload —
        // executing it would corrupt files (rule borrowed from qwen-code).
        if (response.truncated && isMutatingName(call.function?.name)) {
          this.push({
            role: "tool",
            content:
              "[rejected] Your response was cut off by the output-length limit, so this mutating call may be incomplete. Re-issue the call in full, with less surrounding text.",
            tool_name: call.function?.name ?? "unknown",
          });
          continue;
        }
        const resolved = resolveToolCall(call, this.tools, this.config.maxRepairAttempts);
        if (!resolved.ok) {
          this.onEvent({ type: "repair", problem: resolved.problem });
          this.push({
            role: "tool",
            content: resolved.problem,
            tool_name: resolved.name,
          });
          continue;
        }
        const result = await this.executeCall(resolved);
        this.push({
          role: "tool",
          content: result.output,
          tool_name: resolved.tool.name,
          _filePath: result.filePath,
        });
      }

      this.injectTodoReminderIfChanged();

      const loopMsg = this.loopDetector.check();
      if (loopMsg?.abort) {
        this.onEvent({ type: "loop_warning", message: loopMsg.message });
        return `[aborted: ${loopMsg.message}]`;
      }
      if (loopMsg) {
        this.onEvent({ type: "loop_warning", message: loopMsg.message });
        this.push({ role: "user", content: `[system] ${loopMsg.message}` });
      }
    }
    return "[stopped: reached max iterations]";
  }

  private async executeCall(resolved: ResolvedCall & { ok: true }): Promise<ToolResult> {
    const { tool, args } = resolved;
    const display = tool.name + " " + summarizeArgs(args);
    this.loopDetector.noteCall(tool.name, args);

    if (tool.mutating && !canAutoApprove(this.config.permissionMode, tool.name, args)) {
      const approved = await this.askPermission(tool.name, args, display);
      if (!approved) {
        return { ok: false, output: "[denied] The user declined this action. Ask them how to proceed or try a different approach." };
      }
    }

    this.onEvent({ type: "tool_start", name: tool.name, args, display });
    let result: ToolResult;
    try {
      result = await tool.execute(args, this.toolCtx);
    } catch (err) {
      result = { ok: false, output: `Tool crashed: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.loopDetector.noteResult(tool.name, result);
    this.onEvent({ type: "tool_end", name: tool.name, result });

    // Dedup: a fresh read of the same file supersedes older copies in history.
    if (result.filePath) {
      this.contextManager.stubOlderFileReads(this.messages, result.filePath);
    }
    return result;
  }

  /** Keep the model on track: re-show todos at the tail whenever they change. */
  private injectTodoReminderIfChanged(): void {
    const rendered = renderTodos(this.toolCtx.todos);
    if (rendered === this.lastTodoRender) return;
    this.lastTodoRender = rendered;
    if (!rendered) return;
    this.push({
      role: "user",
      content: `[system] Current todo list (keep it updated with the todo tool; work items top to bottom):\n${rendered}`,
    });
  }

  getMessages(): readonly ChatMessage[] {
    return this.messages;
  }
}

function isMutatingName(name: string | undefined): boolean {
  return name === "edit" || name === "write";
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 80 ? s.slice(0, 77) + "..." : s}`);
  }
  return parts.join(" ");
}
