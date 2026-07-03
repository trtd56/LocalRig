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
  maxIterations: number;
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
  // ---- Tool-call robustness ----
  maxRepairAttempts: number;
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
  maxIterations: 60,
  permissionMode: "default",
  bashMaxChars: 30_000,
  bashTimeoutMs: 120_000,
  readMaxLines: 2000,
  readMaxLineChars: 2000,
  grepMaxMatches: 100,
  pruneAt: 0.75,
  compactAt: 0.85,
  keepRecentMessages: 10,
  maxRepairAttempts: 3,
  loopWarnAfter: 3,
  loopAbortAfter: 5,
};
