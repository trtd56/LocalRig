// Token accounting for context management.
//
// Estimates are heuristic (chars / 3.3) and continuously calibrated against
// Ollama's real prompt_eval_count so thresholds in manager.ts stay honest.

import type { ChatMessage } from "../types.ts";

/** Rough token estimate for plain text: chars / 3.3, minimum 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.3));
}

/** Fixed per-message overhead (role tokens, chat-template framing). */
const MESSAGE_OVERHEAD = 8;
const EMA_ALPHA = 0.3;
const RATIO_MIN = 0.5;
const RATIO_MAX = 3;

export class TokenLedger {
  /**
   * EMA of actual/estimated prompt tokens. Applied only to messages that do
   * not carry a measured _tokens value.
   */
  private ratio = 1;

  /** Estimate one message: content + JSON of tool_calls + overhead. A
   *  measured _tokens value (from Ollama counters) beats the estimate. */
  estimateMessage(m: ChatMessage): number {
    if (m._tokens !== undefined) return m._tokens;
    let tokens = estimateTokens(m.content);
    if (m.tool_calls && m.tool_calls.length > 0) {
      tokens += estimateTokens(JSON.stringify(m.tool_calls));
    }
    return tokens + MESSAGE_OVERHEAD;
  }

  /** Total estimated tokens; the calibration ratio applies to messages that
   *  lack a measured _tokens value. */
  estimateTotal(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += m._tokens !== undefined ? m._tokens : this.estimateMessage(m) * this.ratio;
    }
    return Math.ceil(total);
  }

  /**
   * Fold a real measurement into the calibration ratio.
   * actualPromptTokens is Ollama's prompt_eval_count covering ALL of
   * `messages` (everything that was sent for the last request).
   */
  calibrate(messages: ChatMessage[], actualPromptTokens: number): void {
    if (actualPromptTokens <= 0) return;
    let estimated = 0;
    for (const m of messages) estimated += this.estimateMessage(m);
    if (estimated <= 0) return;
    const sample = Math.min(RATIO_MAX, Math.max(RATIO_MIN, actualPromptTokens / estimated));
    this.ratio = this.ratio + EMA_ALPHA * (sample - this.ratio);
  }
}
