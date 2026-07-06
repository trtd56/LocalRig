/** How mutating tool calls get approved:
 *  "default" asks for every call, "auto" only asks for dangerous bash
 *  commands (see permissions.ts), "yolo" approves everything. */
export type PermissionMode = "default" | "auto" | "yolo";

export interface Config {
  ollamaUrl: string;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  topP: number;
  topK: number;
  /** Qwen anti-repetition lever, mapped to Ollama options.presence_penalty. */
  presencePenalty: number;
  maxIterations: number;
  /** Wall-clock budget for one run() in ms; 0 disables it. */
  maxTimeMs: number;
  /** Abort a turn if thinking exceeds this many chars before any output. */
  thinkBudgetChars: number;
  permissionMode: PermissionMode;
  // ---- Tool output limits ----
  bashMaxChars: number;
  bashTimeoutMs: number;
  readMaxLines: number;
  readMaxLineChars: number;
  grepMaxMatches: number;
  // ---- Context management thresholds (fractions of numCtx) ----
  pruneAt: number;
  compactAt: number;
  /** Keep this many most-recent messages untouched when pruning/compacting. */
  keepRecentMessages: number;
  /** Tokens reserved above the current estimate when checking prune/compact
   *  gates — the room the next reply needs, NOT the full num_predict cap. */
  headroomTokens: number;
  // ---- Tool-call robustness ----
  loopWarnAfter: number;
  loopAbortAfter: number;
}

export const defaultConfig: Config = {
  ollamaUrl: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  model: process.env.LH_MODEL ?? "qwen36-27b-mtp:latest",
  numCtx: Number(process.env.LH_NUM_CTX ?? 32768),
  numPredict: 16384,
  // Qwen3.6 thinking-mode coding recommendation (HF model card): 0.6 / 0.95 / 20.
  // Lower temperatures cause repetition loops when thinking is enabled.
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  // Official Qwen anti-repetition lever (thinking preset uses 1.5, coding 0.0);
  // the Modelfile sets none, so 1.0 breaks observed reasoning loops.
  presencePenalty: Number(process.env.LH_PRESENCE_PENALTY ?? 1.0),
  maxIterations: 60,
  maxTimeMs: Number(process.env.LH_MAX_TIME ?? 0) * 1000,
  thinkBudgetChars: Number(process.env.LH_THINK_BUDGET ?? 6000),
  permissionMode: "default",
  bashMaxChars: 30_000,
  bashTimeoutMs: 120_000,
  readMaxLines: 2000,
  readMaxLineChars: 2000,
  grepMaxMatches: 100,
  pruneAt: 0.75,
  compactAt: 0.85,
  keepRecentMessages: 10,
  headroomTokens: Number(process.env.LH_HEADROOM ?? 4096),
  loopWarnAfter: 3,
  loopAbortAfter: 5,
};
