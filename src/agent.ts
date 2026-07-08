import type { Config } from "./config.ts";
import type {
  AgentEvent,
  ChatMessage,
  ChatResponse,
  RunReport,
  RunStatus,
  ToolContext,
  ToolDef,
  ToolResult,
} from "./types.ts";
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

/** Injected after the watchdog aborts a runaway reasoning block. */
const THINKING_INTERRUPT_NUDGE =
  "[system] Your reasoning was interrupted for length. Do not re-derive the analysis from scratch. " +
  "State your current best hypothesis in 1-2 sentences, then immediately verify it with a tool call " +
  "(e.g. run the relevant test or command).";

/**
 * Decide whether to abort the current streaming turn mid-thinking. Thinking
 * always streams before any content/tool-call tokens, so once real output has
 * begun we leave the turn alone. Pure so the decision table is unit-testable.
 */
export function shouldInterruptThinking(params: {
  thinkingChars: number;
  budgetChars: number;
  sawOutput: boolean;
  interruptionsSoFar: number;
}): boolean {
  const { thinkingChars, budgetChars, sawOutput, interruptionsSoFar } = params;
  if (budgetChars <= 0) return false; // watchdog disabled
  if (sawOutput) return false; // real output already began this turn
  if (interruptionsSoFar >= 2) return false; // never interrupt more than twice
  return thinkingChars > budgetChars;
}

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
  /** Why the most recent run() ended. Valid after run() resolves. */
  lastRunStatus: RunStatus = "ok";

  constructor(
    private config: Config,
    private cwd: string,
    private onEvent: (e: AgentEvent) => void,
    private askPermission: PermissionFn,
    // Prebuilt system prompt. `lh batch` builds one at batch start and passes
    // the same string to every task's agent so it stays byte-identical (Ollama's
    // prefix KV cache holds); a one-shot/REPL agent omits it and builds its own.
    systemPrompt?: string,
    tools?: ToolDef[],
    private forceThink?: boolean,
  ) {
    this.client = new OllamaClient(config.ollamaUrl, config.model);
    this.toolCtx = {
      cwd,
      readFiles: new Map(),
      todos: [],
      signal: this.abort.signal,
      report: { changedFiles: new Map(), commandsRun: [] },
    };
    this.tools = tools ?? createTools(config, this.toolCtx);
    this.loopDetector = new LoopDetector(config.loopWarnAfter, config.loopAbortAfter);
    this.contextManager = new ContextManager(config, this.client);
    this.messages.push(this.stamp({ role: "system", content: systemPrompt ?? buildSystemPrompt(cwd, config) }));
  }

  interrupt(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.toolCtx.signal = this.abort.signal;
  }

  /**
   * Seed the agent with a transcript restored from a saved session (for
   * `lh --resume`), replacing the fresh system prompt with the saved
   * conversation. Expects messages already re-stamped densely by
   * restoreTranscript; the seq counter continues past them so subsequently
   * pushed messages stay ordered.
   */
  restore(messages: ChatMessage[]): void {
    this.messages = messages;
    this.seq = messages.length;
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
    this.lastRunStatus = "error"; // overwritten on every graceful exit path
    this.push({ role: "user", content: userInput });
    this.loopDetector.reset();
    const startTime = Date.now();

    for (let iteration = 0; iteration <= this.config.maxIterations; iteration++) {
      // Force a text-only wrap-up (instead of dropping the session) on the last
      // iteration or once the wall-clock budget is exhausted.
      const timedOut =
        this.config.maxTimeMs > 0 && Date.now() - startTime > this.config.maxTimeMs;
      const wrapUp = iteration === this.config.maxIterations || timedOut;
      if (wrapUp) {
        this.push({
          role: "user",
          content:
            "[system] CRITICAL - stopping now (step or time budget reached). Do NOT make any tool calls. Respond with text only: summarize what was accomplished, what remains, and any blockers.",
        });
      }
      await this.contextManager.manage(this.messages, this.onEvent, this.abort.signal);

      // Stream the model turn, retrying if the thinking watchdog interrupts a
      // runaway reasoning block. Wrap-up turns disable thinking outright; the
      // second interruption in a turn does the same before retrying.
      let response: ChatResponse;
      let interruptions = 0;
      let think: boolean | undefined = wrapUp ? false : this.forceThink;
      for (;;) {
        const turn = await this.streamTurn(think, interruptions);
        if (turn.kind === "user_abort") {
          this.lastRunStatus = "interrupted";
          return "[interrupted]";
        }
        if (turn.kind === "response") {
          response = turn.response;
          break;
        }
        // Watchdog interrupted mid-thinking: record the nudge as a normal
        // message and retry. First retry keeps thinking; second turns it off.
        interruptions++;
        this.push({ role: "user", content: THINKING_INTERRUPT_NUDGE });
        if (interruptions >= 2) think = false;
      }
      this.onEvent({ type: "turn_end" });

      const msg = response.message;
      this.push(msg);
      this.contextManager.recordUsage(this.messages, response.promptTokens, response.evalTokens);
      this.onEvent({
        type: "usage",
        promptTokens: response.promptTokens,
        evalTokens: response.evalTokens,
        ctxPercent: Math.round((100 * (response.promptTokens + response.evalTokens)) / this.config.numCtx),
      });

      if (wrapUp) {
        this.lastRunStatus = timedOut ? "timeout" : "max_iterations";
        return (
          msg.content ||
          (timedOut ? "[stopped: reached time budget]" : "[stopped: reached max iterations]")
        );
      }

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
          this.lastRunStatus = "empty";
          return "[the model produced no output]";
        }
        this.lastRunStatus = "ok";
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
        const resolved = resolveToolCall(call, this.tools);
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
        this.lastRunStatus = "loop_abort";
        return `[aborted: ${loopMsg.message}]`;
      }
      if (loopMsg) {
        this.onEvent({ type: "loop_warning", message: loopMsg.message });
        this.push({ role: "user", content: `[system] ${loopMsg.message}` });
      }
    }
    this.lastRunStatus = "max_iterations";
    return "[stopped: reached max iterations]";
  }

  /**
   * Run exactly one non-thinking, tool-free model turn. Used when a caller
   * needs a final serialization repair without reopening the agent loop.
   */
  async runTextOnly(userInput: string): Promise<string> {
    this.lastRunStatus = "error";
    this.push({ role: "user", content: userInput });
    await this.contextManager.manage(this.messages, this.onEvent, this.abort.signal);
    const turn = await this.streamTurn(false, 0, []);
    if (turn.kind === "user_abort") {
      this.lastRunStatus = "interrupted";
      return "[interrupted]";
    }
    if (turn.kind === "interrupted") {
      this.lastRunStatus = "error";
      return "[thinking interrupted]";
    }

    const response = turn.response;
    this.onEvent({ type: "turn_end" });
    this.push(response.message);
    this.contextManager.recordUsage(this.messages, response.promptTokens, response.evalTokens);
    this.onEvent({
      type: "usage",
      promptTokens: response.promptTokens,
      evalTokens: response.evalTokens,
      ctxPercent: Math.round((100 * (response.promptTokens + response.evalTokens)) / this.config.numCtx),
    });
    this.lastRunStatus = response.message.content.trim() ? "ok" : "empty";
    return response.message.content || "[the model produced no output]";
  }

  /**
   * Stream one model turn under the thinking watchdog. The watchdog gets its
   * own AbortController; a user Ctrl+C (userSignal) is forwarded to it so both
   * cancel the in-flight request, but we then read userSignal to tell a user
   * abort apart from a watchdog interrupt. userSignal is captured up front:
   * interrupt() swaps in a fresh this.abort, so re-reading it would inspect the
   * wrong controller.
   */
  private async streamTurn(
    think: boolean | undefined,
    interruptionsSoFar: number,
    tools: ToolDef[] = this.tools,
  ): Promise<
    | { kind: "response"; response: ChatResponse }
    | { kind: "interrupted" }
    | { kind: "user_abort" }
  > {
    const userSignal = this.abort.signal;
    const watchdog = new AbortController();
    const onUserAbort = () => watchdog.abort();
    userSignal.addEventListener("abort", onUserAbort, { once: true });

    let thinkingChars = 0;
    let sawOutput = false;
    let interrupted = false;
    try {
      const response = await this.client.chat(
        this.messages,
        tools,
        {
          num_ctx: this.config.numCtx,
          num_predict: this.config.numPredict,
          temperature: this.config.temperature,
          top_p: this.config.topP,
          top_k: this.config.topK,
          presence_penalty: this.config.presencePenalty,
          think,
        },
        (chunk) => {
          if (chunk.content || chunk.toolCall) sawOutput = true;
          if (chunk.thinking) {
            this.onEvent({ type: "thinking_delta", text: chunk.thinking });
            thinkingChars += chunk.thinking.length;
            if (
              !interrupted &&
              shouldInterruptThinking({
                thinkingChars,
                budgetChars: this.config.thinkBudgetChars,
                sawOutput,
                interruptionsSoFar,
              })
            ) {
              interrupted = true;
              this.onEvent({ type: "thinking_interrupt", budgetChars: this.config.thinkBudgetChars });
              watchdog.abort();
            }
          }
          if (chunk.content) this.onEvent({ type: "content_delta", text: chunk.content });
        },
        watchdog.signal,
      );
      return { kind: "response", response };
    } catch (err) {
      // A user Ctrl+C aborts userSignal (and, via the listener, the watchdog).
      if (userSignal.aborted) return { kind: "user_abort" };
      if (interrupted) return { kind: "interrupted" };
      throw err;
    } finally {
      userSignal.removeEventListener("abort", onUserAbort);
    }
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

  getReport(): RunReport {
    const report = this.toolCtx.report!;
    return {
      changedFiles: [...report.changedFiles.entries()].map(([path, action]) => ({ path, action })),
      commandsRun: [...report.commandsRun],
    };
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
