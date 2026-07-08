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
  /** Whether this tool mutates state (asks permission depending on permissionMode). */
  mutating: boolean;
}

export interface ToolContext {
  cwd: string;
  /** Canonical filesystem scope enforced by every coding tool. */
  scope?: WorkspaceScope;
  /** Files already read this session: path -> message seq of latest read. */
  readFiles: Map<string, number>;
  todos: TodoItem[];
  signal: AbortSignal;
  /** Absolute command deadline. Tools clamp their own timeout to this value. */
  deadlineAt?: number;
  report?: RunReportBuilder;
}

/** User-facing path scope before symlinks and relative paths are resolved. */
export interface WorkspaceScopeInput {
  /** Paths the agent may inspect or modify. Defaults to the whole cwd. */
  allowedPaths?: string[];
  /** Paths the agent may inspect but must never modify. */
  protectedPaths?: string[];
}

/** Canonical, cwd-contained path scope used at tool execution time. */
export interface WorkspaceScope {
  cwd: string;
  allowedPaths: string[];
  protectedPaths: string[];
  /** Harness-owned Git metadata that sandboxed commands may read/write. */
  privateGitPaths?: string[];
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

// ---------- Machine-readable run report ----------

export type ChangedFileAction = "created" | "modified" | "deleted";

export interface ChangedFileReport {
  path: string;
  action: ChangedFileAction;
}

export interface RunReport {
  changedFiles: ChangedFileReport[];
  commandsRun: string[];
}

export interface RunReportBuilder {
  changedFiles: Map<string, ChangedFileAction>;
  commandsRun: string[];
}

// ---------- Provider ----------

export interface ChatRequestOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_ctx: number;
  /** Max tokens to generate per turn. */
  num_predict?: number;
  /** Qwen anti-repetition lever (Ollama options.presence_penalty). */
  presence_penalty?: number;
  /** Toggle the model's reasoning phase. Sent only when explicitly set. */
  think?: boolean;
  /** Ollama structured-output format, usually a JSON schema. */
  format?: unknown;
  /** Non-streaming completion usage callback. */
  onUsage?: (usage: { promptTokens: number; evalTokens: number }) => void;
}

export interface ChatChunk {
  /** Incremental content text. */
  content?: string;
  /** Incremental thinking text. */
  thinking?: string;
  /** Set once native tool-call tokens start arriving (real output began). */
  toolCall?: boolean;
}

export interface ChatResponse {
  message: ChatMessage;
  promptTokens: number;
  evalTokens: number;
  /** True when generation stopped because num_predict was exhausted. */
  truncated: boolean;
}

// ---------- Run outcome ----------

/** Why a run() call ended. Used for CLI exit codes and session records.
 *  "not_run" is not produced by run() itself — `lh batch` stamps it on tasks
 *  that never started because a fatal earlier task aborted the batch. */
export type RunStatus =
  | "ok"
  | "check_failed"
  | "running"
  | "died"
  | "max_iterations"
  | "timeout"
  | "loop_abort"
  | "interrupted"
  | "empty"
  | "not_run"
  | "error";

/**
 * Coarse bucket for a caught run error, so an orchestrating agent can branch
 * on cause (e.g. retry on "connection", give up on "ollama_error") without
 * parsing the free-form `error` string. Only set when `error` is set.
 */
export type ErrorKind = "connection" | "ollama_error" | "config" | "conflict" | "internal";

// ---------- Events the agent loop emits to the UI ----------

export type AgentEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "turn_end" }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; display: string }
  | { type: "tool_end"; name: string; result: ToolResult }
  | { type: "repair"; problem: string }
  | { type: "loop_warning"; message: string }
  | { type: "thinking_interrupt"; budgetChars: number }
  | { type: "prune"; freedTokens: number }
  | { type: "compact"; beforeTokens: number; afterTokens: number }
  | { type: "status"; message: string }
  /** Fine-grained runtime timing; session persistence may aggregate these. */
  | { type: "timing"; phase: "model" | "tool"; durationMs: number; ttftMs?: number }
  | { type: "usage"; promptTokens: number; evalTokens: number; ctxPercent: number };
