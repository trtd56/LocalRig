/** How mutating tool calls get approved:
 *  "default" asks for every call, "auto" approves only inside the mechanical
 *  path/OS sandbox, and "yolo" explicitly permits unsandboxed host bash. */
export type PermissionMode = "default" | "auto" | "yolo";

export interface Config {
  ollamaUrl: string;
  model: string;
  /** How long Ollama keeps the model runner resident; "0" unloads it. */
  keepAlive: string;
  numCtx: number;
  /** Ollama prompt batch size; undefined keeps the server/model default. */
  numBatch?: number;
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

/** Sampling knobs that vary by model family. */
export interface ModelProfile {
  temperature: number;
  topP: number;
  topK: number;
  /** Qwen anti-repetition lever, mapped to Ollama options.presence_penalty. */
  presencePenalty: number;
  thinkBudgetChars: number;
}

// Qwen3.6 thinking-mode coding recommendation (HF model card): 0.6 / 0.95 / 20.
// Lower temperatures cause repetition loops when thinking is enabled.
// Official Qwen anti-repetition lever (thinking preset uses 1.5, coding 0.0);
// the Modelfile sets none, so 1.0 breaks observed reasoning loops.
const QWEN_PROFILE: ModelProfile = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  presencePenalty: 1.0,
  thinkBudgetChars: 6000,
};

// Gemma 4 26B (Ollama) defaults observed from the Modelfile: 1 / 0.95 / 64.
// Keep repetition penalties neutral; the full harness run used these values.
const GEMMA_PROFILE: ModelProfile = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  presencePenalty: 0,
  thinkBudgetChars: 6000,
};

// Model name (case-insensitive substring) → profile. First match wins.
const MODEL_PROFILES: { pattern: string; profile: ModelProfile }[] = [
  { pattern: "qwen", profile: QWEN_PROFILE },
  { pattern: "gemma", profile: GEMMA_PROFILE },
];

// Fallback for a model matching no pattern above. Keep the conservative Qwen3.6
// settings so an unrecognized model stays on the original validated profile.
const DEFAULT_PROFILE: ModelProfile = QWEN_PROFILE;

export function resolveProfile(model: string): ModelProfile {
  const lower = model.toLowerCase();
  return MODEL_PROFILES.find((p) => lower.includes(p.pattern))?.profile ?? DEFAULT_PROFILE;
}

/** Profile fields and the env var that pins each one, in priority order below. */
export const PROFILE_FIELD_ENV = {
  temperature: "LH_TEMPERATURE",
  topP: "LH_TOP_P",
  topK: "LH_TOP_K",
  presencePenalty: "LH_PRESENCE_PENALTY",
  thinkBudgetChars: "LH_THINK_BUDGET",
} as const satisfies Record<keyof ModelProfile, string>;

export type ProfileField = keyof ModelProfile;
export const PROFILE_FIELDS = Object.keys(PROFILE_FIELD_ENV) as ProfileField[];

/**
 * Re-resolve and apply a model's profile onto an existing config (used when
 * --model switches models mid-parse). Fields already pinned explicitly — a CLI
 * flag, or an env var baked into defaultConfig at load time — are left alone;
 * the profile only fills in whatever the caller didn't set itself.
 */
export function applyProfile(config: Config, model: string, explicit: ReadonlySet<ProfileField>): void {
  const profile = resolveProfile(model);
  for (const field of PROFILE_FIELDS) {
    if (!explicit.has(field)) config[field] = profile[field];
  }
}

const resolvedModel = process.env.LH_MODEL ?? "qwen36-27b-mtp:latest";
const profile = resolveProfile(resolvedModel);

export const defaultConfig: Config = {
  ollamaUrl: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  model: resolvedModel,
  keepAlive: process.env.LH_KEEP_ALIVE ?? "30m",
  numCtx: Number(process.env.LH_NUM_CTX ?? 32768),
  numBatch: process.env.LH_NUM_BATCH === undefined ? undefined : Number(process.env.LH_NUM_BATCH),
  numPredict: 16384,
  temperature: Number(process.env.LH_TEMPERATURE ?? profile.temperature),
  topP: Number(process.env.LH_TOP_P ?? profile.topP),
  topK: Number(process.env.LH_TOP_K ?? profile.topK),
  presencePenalty: Number(process.env.LH_PRESENCE_PENALTY ?? profile.presencePenalty),
  maxIterations: 60,
  maxTimeMs: Number(process.env.LH_MAX_TIME ?? 0) * 1000,
  thinkBudgetChars: Number(process.env.LH_THINK_BUDGET ?? profile.thinkBudgetChars),
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
