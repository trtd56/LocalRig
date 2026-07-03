// Shared type contracts for the harness. All modules depend on this file only
// (plus config.ts) — keep it dependency-free.

// ---------- Chat messages (Ollama chat API shape) ----------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    // Ollama returns parsed objects; text-fallback parsing may yield strings
    // that validate.ts must repair.
    arguments: Record<string, unknown> | string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  /** For role:"tool" — echoes the tool name back to the model. */
  tool_name?: string;
  // ---- Harness-internal bookkeeping (stripped before sending to Ollama) ----
  /** Actual token cost measured from Ollama counters, once known. */
  _tokens?: number;
  /** Marks a tool result that has been pruned down to a stub. */
  _pruned?: boolean;
  /** Absolute file path if this tool result came from reading a file (dedup). */
  _filePath?: string;
  /** Monotonic sequence number for ordering/pruning decisions. */
  _seq?: number;
}

// ---------- Tools ----------

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Execute the tool. Must never throw — return ok:false instead. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Whether this tool mutates state (asks permission unless --yolo). */
  mutating: boolean;
}

export interface ToolContext {
  cwd: string;
  /** Files already read this session: path -> message seq of latest read. */
  readFiles: Map<string, number>;
  todos: TodoItem[];
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model (post-truncation). */
  output: string;
  /** Absolute file path when the result is a file read (for dedup-pruning). */
  filePath?: string;
  /** Short human-facing summary line for the UI. */
  display?: string;
}

export interface TodoItem {
  id: number;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// ---------- Provider ----------

export interface ChatRequestOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_ctx: number;
  /** Max tokens to generate per turn. */
  num_predict?: number;
}

export interface ChatChunk {
  /** Incremental content text. */
  content?: string;
  /** Incremental thinking text. */
  thinking?: string;
}

export interface ChatResponse {
  message: ChatMessage;
  promptTokens: number;
  evalTokens: number;
  /** True when generation stopped because num_predict was exhausted. */
  truncated: boolean;
}

// ---------- Events the agent loop emits to the UI ----------

export type AgentEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "turn_end" }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; display: string }
  | { type: "tool_end"; name: string; result: ToolResult }
  | { type: "repair"; problem: string }
  | { type: "loop_warning"; message: string }
  | { type: "prune"; freedTokens: number }
  | { type: "compact"; beforeTokens: number; afterTokens: number }
  | { type: "status"; message: string }
  | { type: "usage"; promptTokens: number; ctxPercent: number };
