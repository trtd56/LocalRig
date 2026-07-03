// Detects unproductive loops in the agent: the model repeating the exact
// same tool call, hammering the same failing action, cycling through a small
// set of calls, or producing consecutive empty turns.

import type { ToolResult } from "../types.ts";

const WINDOW_SIZE = 12;
const CYCLE_THRESHOLD = 4;
const FAIL_THRESHOLD = 3;

export class LoopDetector {
  // Consecutive identical call signatures.
  private lastSignature: string | null = null;
  private consecutiveCount = 0;
  private repeatWarned = false;

  // Consecutive identical failing results.
  private lastFailKey: string | null = null;
  private failCount = 0;
  private failWarned = false;

  // Sliding window for non-consecutive cycling.
  private window: string[] = [];
  private cycleWarned = false;

  // Consecutive empty turns.
  private emptyTurns = 0;

  constructor(
    private warnAfter: number,
    private abortAfter: number,
  ) {}

  /** Clear all state for a new user request. */
  reset(): void {
    this.lastSignature = null;
    this.consecutiveCount = 0;
    this.repeatWarned = false;
    this.lastFailKey = null;
    this.failCount = 0;
    this.failWarned = false;
    this.window = [];
    this.cycleWarned = false;
    this.emptyTurns = 0;
  }

  noteCall(name: string, args: Record<string, unknown>): void {
    this.emptyTurns = 0; // a tool call is progress; empty-turn streak broken
    const sig = `${name}(${stableStringify(args)})`;
    if (sig === this.lastSignature) {
      this.consecutiveCount++;
    } else {
      this.lastSignature = sig;
      this.consecutiveCount = 1;
      this.repeatWarned = false;
    }
    this.window.push(sig);
    if (this.window.length > WINDOW_SIZE) this.window.shift();
  }

  noteResult(name: string, result: ToolResult): void {
    if (result.ok) {
      this.lastFailKey = null;
      this.failCount = 0;
      this.failWarned = false;
      return;
    }
    const key = `${name}|${result.output.slice(0, 200)}`;
    if (key === this.lastFailKey) {
      this.failCount++;
    } else {
      this.lastFailKey = key;
      this.failCount = 1;
      this.failWarned = false;
    }
  }

  /**
   * Record an empty assistant turn. Returns true when the caller should
   * nudge the model to continue; false on the second consecutive empty turn,
   * meaning the caller should give up.
   */
  noteEmptyTurn(): boolean {
    this.emptyTurns++;
    return this.emptyTurns < 2;
  }

  /**
   * Called once per agent iteration after tools ran. Returns a warning (or
   * abort order) at most once per situation; escalates warn → abort.
   */
  check(): { message: string; abort: boolean } | null {
    // Escalation: identical call repeated abortAfter times → abort.
    if (this.consecutiveCount >= this.abortAfter) {
      return {
        message:
          `You have repeated the exact same tool call ${this.consecutiveCount} times. ` +
          `The result will not change — take a different action or report what is blocking you.`,
        abort: true,
      };
    }

    // Identical call repeated warnAfter times → warn once.
    if (this.consecutiveCount >= this.warnAfter && !this.repeatWarned) {
      this.repeatWarned = true;
      return {
        message:
          `You have repeated the exact same tool call ${this.consecutiveCount} times. ` +
          `The result will not change — take a different action or report what is blocking you.`,
        abort: false,
      };
    }

    // Identical failing results 3+ times in a row → warn once.
    if (this.failCount >= FAIL_THRESHOLD && !this.failWarned) {
      this.failWarned = true;
      return {
        message:
          "The same error keeps occurring. Change strategy: read the file/docs again or try a different tool.",
        abort: false,
      };
    }

    // Non-consecutive cycling within the sliding window → warn once.
    if (!this.cycleWarned && this.hasCycling()) {
      this.cycleWarned = true;
      return {
        message: "You are cycling through repeated calls.",
        abort: false,
      };
    }

    return null;
  }

  /** A signature appearing >= 4 times non-consecutively in the window. */
  private hasCycling(): boolean {
    const positions = new Map<string, number[]>();
    for (let i = 0; i < this.window.length; i++) {
      const sig = this.window[i] as string;
      const list = positions.get(sig);
      if (list) list.push(i);
      else positions.set(sig, [i]);
    }
    for (const idxs of positions.values()) {
      if (idxs.length < CYCLE_THRESHOLD) continue;
      const first = idxs[0] as number;
      const last = idxs[idxs.length - 1] as number;
      // Non-consecutive: occurrences have at least one gap between them.
      if (last - first + 1 > idxs.length) return true;
    }
    return false;
  }
}

/** JSON stringify with recursively sorted object keys, so {a,b} === {b,a}. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + stableStringify(v));
  }
  return "{" + parts.join(",") + "}";
}
