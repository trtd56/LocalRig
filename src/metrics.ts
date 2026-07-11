import type { AgentEvent } from "./types.ts";

export interface ModelTurnMetric {
  turn: number;
  task_id?: string;
  duration_ms: number;
  ttft_ms?: number;
  load_ms?: number;
  prompt_eval_ms?: number;
  eval_ms?: number;
  prompt_tokens?: number;
  eval_tokens?: number;
  thinking_chars?: number;
  interrupted?: boolean;
  prefill_tps?: number;
  decode_tps?: number;
  context_event?: "prune" | "compact";
}

export interface MetricsTotals {
  modelMs: number;
  toolMs: number;
  ttftMs?: number;
  loadMs: number;
  promptEvalMs: number;
  evalMs: number;
}

export function createMetricsCollector(taskId?: () => string | undefined) {
  const modelTurns: ModelTurnMetric[] = [];
  const totals: MetricsTotals = { modelMs: 0, toolMs: 0, loadMs: 0, promptEvalMs: 0, evalMs: 0 };
  let pendingContextEvent: ModelTurnMetric["context_event"];

  const collect = (event: AgentEvent): void => {
    if (event.type === "prune" || event.type === "compact") {
      pendingContextEvent = event.type;
      return;
    }
    if (event.type !== "timing") return;
    if (event.phase === "tool") {
      totals.toolMs += event.durationMs;
      return;
    }
    totals.modelMs += event.durationMs;
    if (totals.ttftMs === undefined && event.ttftMs !== undefined) totals.ttftMs = event.ttftMs;
    totals.loadMs += event.loadMs ?? 0;
    totals.promptEvalMs += event.promptEvalMs ?? 0;
    totals.evalMs += event.evalMs ?? 0;
    modelTurns.push({
      turn: modelTurns.length + 1,
      task_id: taskId?.(),
      duration_ms: event.durationMs,
      ttft_ms: event.ttftMs,
      load_ms: event.loadMs,
      prompt_eval_ms: event.promptEvalMs,
      eval_ms: event.evalMs,
      prompt_tokens: event.promptTokens,
      eval_tokens: event.evalTokens,
      thinking_chars: event.thinkingChars,
      interrupted: event.interrupted,
      prefill_tps: rate(event.promptTokens, event.promptEvalMs),
      decode_tps: rate(event.evalTokens, event.evalMs),
      context_event: pendingContextEvent,
    });
    pendingContextEvent = undefined;
  };
  return { collect, modelTurns, totals };
}

function rate(tokens: number | undefined, durationMs: number | undefined): number | undefined {
  if (tokens === undefined || durationMs === undefined || tokens < 0 || durationMs <= 0) return undefined;
  return tokens / (durationMs / 1000);
}
