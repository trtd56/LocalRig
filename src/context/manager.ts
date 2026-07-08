// Context management: token accounting → batched pruning → full compaction.
//
// LOCAL-PERF CONSTRAINT: Ollama reuses the prefix KV cache between requests;
// mutating any older message invalidates the cache from that point on and
// forces a full prompt re-evaluation (~minutes at 27B for ~50k tokens).
// Therefore pruning/compaction must be RARE and BATCHED: when triggered, free
// a LOT at once (target dropping usage to ~50% of num_ctx), never nibbling
// per turn.

import type { Config } from "../config.ts";
import type { AgentEvent, ChatMessage, ToolCall } from "../types.ts";
import type { OllamaClient } from "../provider/ollama.ts";
import { TokenLedger } from "./tokens.ts";

/** _seq for messages minted by compaction. Starts far above the agent's own
 *  counter; that counter only moves forward on push, so no collision. */
let compactionSeq = 1_000_000_000;

/** Tool outputs at or below this size are not worth breaking the cache for. */
const PRUNE_MIN_CHARS = 500;
/** Superseded file reads below this size are left alone (cache preservation). */
const STUB_MIN_CHARS = 1000;
/** Cap on the serialized transcript fed to the summarizer (~24k tokens). */
const TRANSCRIPT_CAP_CHARS = Math.round(24_000 * 3.3);
/** Cap on any single serialized transcript entry. */
const PART_MAX_CHARS = 20_000;
/** Cap on serialized tool results inside the transcript. */
const TOOL_RESULT_MAX_CHARS = 2000;
/** Cap on each tool-call argument value inside the transcript. */
const ARG_MAX_CHARS = 100;

const SUMMARIZER_SYSTEM_PROMPT =
  "You summarize an in-progress coding session so the agent can continue with a fresh context window. " +
  "Do NOT continue the conversation. Do NOT respond to questions in it. ONLY output the structured summary.";

const SUMMARY_STRUCTURE =
  "## Goal\n" +
  "## Constraints & Preferences\n" +
  "## Progress\n" +
  "### Done\n" +
  "### In Progress\n" +
  "### Blocked\n" +
  "## Key Decisions\n" +
  "## Next Steps\n" +
  "## Critical Context";

export class ContextManager {
  private ledger = new TokenLedger();

  constructor(
    private config: Config,
    private client: OllamaClient,
  ) {}

  /** Record real token counts after a completed model turn. A turn aborted
   *  mid-thinking has no prompt_eval_count, so skip it to avoid corrupting the
   *  calibration EMA with a zero measurement. */
  recordUsage(messages: ChatMessage[], promptTokens: number, evalTokens: number): void {
    if (promptTokens <= 0) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant") {
        m._tokens = evalTokens;
        break;
      }
    }
    // promptTokens covers everything that was sent — all but the reply itself.
    this.ledger.calibrate(messages.slice(0, -1), promptTokens);
  }

  /**
   * Dedup: a fresh read of the same file supersedes older copies in history.
   * Called BEFORE the new read result is pushed. Stubbing breaks the prefix
   * cache, so only large superseded reads (≥ 1000 chars) are stubbed.
   */
  stubOlderFileReads(messages: ChatMessage[], filePath: string): void {
    for (const m of messages) {
      if (m.role !== "tool" || m._pruned || m._filePath !== filePath) continue;
      if (m.content.length < STUB_MIN_CHARS) continue;
      m.content = `[superseded: newer read of ${displayPath(filePath)} below]`;
      m._pruned = true;
      m._tokens = undefined;
    }
  }

  /** Called before every model call. Prunes/compacts only when thresholds hit. */
  async manage(
    messages: ChatMessage[],
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { numCtx, pruneAt, compactAt, keepRecentMessages } = this.config;
    if (this.totalWithHeadroom(messages) < pruneAt * numCtx) return;

    // ---- PRUNE: batched — once one message changes, the cache is broken
    // anyway, so stub every eligible old tool output in one pass.
    const beforePrune = this.ledger.estimateTotal(messages);
    const protectedFrom = Math.max(0, messages.length - keepRecentMessages);
    let prunedAny = false;
    for (let i = 0; i < protectedFrom; i++) {
      const m = messages[i]!;
      if (m.role === "tool" && !m._pruned && m.content.length > PRUNE_MIN_CHARS) {
        this.pruneToolMessage(m);
        prunedAny = true;
      }
    }
    if (prunedAny) {
      const freed = Math.max(0, beforePrune - this.ledger.estimateTotal(messages));
      onEvent({ type: "prune", freedTokens: freed });
    }

    // ---- COMPACT: full summarization rebuild when pruning wasn't enough.
    if (this.totalWithHeadroom(messages) >= compactAt * numCtx) {
      await this.compact(messages, onEvent, signal);
    }

    // ---- SAFETY VALVE: drop oldest non-system messages entirely.
    let dropped = false;
    while (messages.length > 2 && this.totalWithHeadroom(messages) > 0.95 * numCtx) {
      messages.splice(1, 1);
      // Never leave orphan tool results at the front of the history.
      while (messages.length > 1 && messages[1]!.role === "tool") messages.splice(1, 1);
      dropped = true;
    }
    if (dropped) {
      onEvent({ type: "status", message: "dropped oldest messages to stay within the context window" });
    }
  }

  // ---------------------------------------------------------------- internal

  private totalWithHeadroom(messages: ChatMessage[]): number {
    return this.ledger.estimateTotal(messages) + this.config.headroomTokens;
  }

  private pruneToolMessage(m: ChatMessage): void {
    const was = this.ledger.estimateMessage(m);
    m.content = `[pruned to save context: ${m.tool_name ?? "tool"} output, was ~${was} tokens. Re-run the tool if you need it again.]`;
    m._pruned = true;
    m._tokens = undefined;
  }

  private async compact(
    messages: ChatMessage[],
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const beforeTokens = this.ledger.estimateTotal(messages);
    const firstUser = messages.find((m) => m.role === "user");
    const transcriptMessages = messages.slice(1); // skip the system prompt

    const request: ChatMessage[] = [
      { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Below is the transcript of an in-progress coding session.\n\n" +
          serializeTranscript(transcriptMessages) +
          "\n\nSummarize the session above. Output ONLY a summary with EXACTLY this structure:\n\n" +
          SUMMARY_STRUCTURE +
          "\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.",
      },
    ];

    let summary: string;
    try {
      summary = await this.client.complete(
        request,
        { num_ctx: this.config.numCtx, num_predict: 4096, temperature: 0.1 },
        signal,
      );
    } catch (err) {
      // Command cancellation is terminal. Do not downgrade it to a recoverable
      // compaction failure and proceed into another model generation.
      if (signal.aborted) throw err;
      this.hardPruneFallback(messages, onEvent, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!summary.trim()) {
      this.hardPruneFallback(messages, onEvent, "model returned an empty summary");
      return;
    }

    // Mechanical file-operation tracking compensates when the summarizer
    // omits files the session touched.
    const ops = collectFileOps(transcriptMessages);
    let fileBlocks = "";
    if (ops.read.length > 0) {
      fileBlocks += `\n\n<read-files>\n${ops.read.join("\n")}\n</read-files>`;
    }
    if (ops.modified.length > 0) {
      fileBlocks += `\n\n<modified-files>\n${ops.modified.join("\n")}\n</modified-files>`;
    }

    // Tail: last keepRecentMessages, with the boundary adjusted so it never
    // starts with an orphan tool result or splits a tool-call turn.
    const initial = Math.max(1, messages.length - this.config.keepRecentMessages);
    const start = adjustTailStart(messages, initial);
    const tail = messages.slice(start);

    const bridge: ChatMessage = {
      role: "user",
      content:
        `[Context was compacted. Summary of the session so far:]\n\n${summary.trim()}${fileBlocks}\n\n` +
        `[Continue the task from "Next Steps". The original user request follows.]\n` +
        (firstUser?.content ?? ""),
      _seq: compactionSeq++,
    };

    // Guard against an inflated summary: if the rebuilt list would not be
    // smaller than what we had, drop the compaction result entirely.
    const rebuilt = [messages[0]!, bridge, ...tail];
    const afterTokens = this.ledger.estimateTotal(rebuilt);
    if (afterTokens >= beforeTokens) {
      this.hardPruneFallback(messages, onEvent, "summary did not shrink the context");
      return;
    }

    // Rebuild IN PLACE — the array identity must be preserved.
    messages.splice(1, messages.length - 1, bridge, ...tail);
    onEvent({ type: "compact", beforeTokens, afterTokens });
  }

  /** Compaction failed: keep going with an aggressively pruned history. */
  private hardPruneFallback(
    messages: ChatMessage[],
    onEvent: (e: AgentEvent) => void,
    reason: string,
  ): void {
    onEvent({ type: "status", message: `compaction failed: ${reason} — continuing with pruned context` });
    const protectedFrom = Math.max(0, messages.length - this.config.keepRecentMessages);
    for (let i = 0; i < protectedFrom; i++) {
      const m = messages[i]!;
      if (m.role === "tool" && !m._pruned) this.pruneToolMessage(m);
    }
  }
}

// -------------------------------------------------------------- tail boundary

/**
 * A cut at position p is valid only when the previous message is a final
 * assistant text (no tool_calls) or a user message — so the tail never starts
 * with an orphan tool result and never splits a tool-call turn.
 */
function isValidCut(messages: ChatMessage[], p: number): boolean {
  if (p <= 1) return true; // whole conversation kept
  if (p >= messages.length) return true; // empty tail
  if (messages[p]!.role === "tool") return false;
  const prev = messages[p - 1]!;
  if (prev.role === "user") return true;
  if (prev.role === "assistant" && (!prev.tool_calls || prev.tool_calls.length === 0)) return true;
  return false;
}

function adjustTailStart(messages: ChatMessage[], initial: number): number {
  const n = messages.length;
  const p = Math.min(Math.max(1, initial), n);
  if (isValidCut(messages, p)) return p;

  // Extend the tail backwards: walk over the run of tool results to include
  // the assistant message carrying the matching tool_calls.
  let q = p;
  while (q > 1 && messages[q]!.role === "tool") q--;
  if (
    q < p &&
    messages[q]!.role === "assistant" &&
    (messages[q]!.tool_calls?.length ?? 0) > 0 &&
    isValidCut(messages, q)
  ) {
    return q;
  }

  // Otherwise shrink the tail forward past orphan messages.
  let f = p + 1;
  while (f < n && !isValidCut(messages, f)) f++;
  return f;
}

// ---------------------------------------------------------- transcript & ops

function parseArgs(a: Record<string, unknown> | string): Record<string, unknown> | null {
  if (typeof a !== "string") return a;
  try {
    const parsed: unknown = JSON.parse(a);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatToolCall(c: ToolCall): string {
  const args = parseArgs(c.function.arguments);
  if (args === null) {
    const raw = String(c.function.arguments);
    return `${c.function.name}(${truncate(raw, ARG_MAX_CHARS)})`;
  }
  const parts = Object.entries(args).map(([k, v]) => {
    const s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
    return `${k}=${JSON.stringify(truncate(s, ARG_MAX_CHARS))}`;
  });
  return `${c.function.name}(${parts.join(", ")})`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Serialize the conversation as plain text (not a chat) so the summarizer
 * doesn't treat it as a conversation to continue. Caps individual tool
 * results, individual entries, and the overall transcript (dropping middle
 * chunks) to keep the summarization request itself within budget.
 */
function serializeTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const lines: string[] = [];
    if (m.role === "tool") {
      lines.push(`[Tool result]: ${truncate(m.content, TOOL_RESULT_MAX_CHARS)}`);
    } else if (m.role === "assistant") {
      if (m.content.trim()) lines.push(`[Assistant]: ${m.content}`);
      if (m.tool_calls && m.tool_calls.length > 0) {
        lines.push(`[Assistant tool calls]: ${m.tool_calls.map(formatToolCall).join("; ")}`);
      }
    } else if (m.role === "user") {
      lines.push(`[User]: ${m.content}`);
    } else {
      lines.push(`[System]: ${m.content}`);
    }
    if (lines.length === 0) continue;
    parts.push(truncate(lines.join("\n"), PART_MAX_CHARS));
  }

  let total = 0;
  for (const p of parts) total += p.length + 1;
  if (total <= TRANSCRIPT_CAP_CHARS) return parts.join("\n");

  // Over budget: keep the head and the tail, drop the middle.
  const headBudget = TRANSCRIPT_CAP_CHARS * 0.5;
  const tailBudget = TRANSCRIPT_CAP_CHARS * 0.45;
  const head: string[] = [];
  const tail: string[] = [];
  let i = 0;
  let j = parts.length - 1;
  let len = 0;
  while (i <= j) {
    const p = parts[i]!;
    if (len + p.length + 1 > headBudget) break;
    head.push(p);
    len += p.length + 1;
    i++;
  }
  len = 0;
  while (j >= i) {
    const p = parts[j]!;
    if (len + p.length + 1 > tailBudget) break;
    tail.unshift(p);
    len += p.length + 1;
    j--;
  }
  return [...head, "…[omitted]…", ...tail].join("\n");
}

/** Mechanically collect file paths touched by read/write/edit tool calls. */
function collectFileOps(messages: ChatMessage[]): { read: string[]; modified: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const c of m.tool_calls) {
      const name = c.function.name.toLowerCase();
      const args = parseArgs(c.function.arguments);
      if (!args) continue;
      const rawPath = typeof args.path === "string" ? args.path : args.file_path;
      if (typeof rawPath !== "string" || rawPath.length === 0) continue;
      if (name.includes("write") || name.includes("edit")) modified.add(rawPath);
      else if (name.includes("read")) read.add(rawPath);
    }
  }
  return { read: [...read], modified: [...modified] };
}

// ------------------------------------------------------------------- helpers

function displayPath(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}
