// Tests for the pure thinking-watchdog decision. The agent loop wires this
// into the streaming callback; here we exercise the decision table directly.

import { describe, expect, test } from "bun:test";
import { shouldInterruptThinking } from "../src/agent.ts";

describe("shouldInterruptThinking", () => {
  const base = { thinkingChars: 10_000, budgetChars: 6000, sawOutput: false, interruptionsSoFar: 0 };

  test("interrupts when thinking exceeds budget before any output", () => {
    expect(shouldInterruptThinking(base)).toBe(true);
  });

  test("does not interrupt while under budget", () => {
    expect(shouldInterruptThinking({ ...base, thinkingChars: 6000 })).toBe(false);
    expect(shouldInterruptThinking({ ...base, thinkingChars: 5999 })).toBe(false);
  });

  test("strictly greater than budget is required", () => {
    expect(shouldInterruptThinking({ ...base, thinkingChars: 6001 })).toBe(true);
  });

  test("never interrupts once real output (content or tool call) has begun", () => {
    expect(shouldInterruptThinking({ ...base, sawOutput: true })).toBe(false);
  });

  test("caps at two interruptions per turn", () => {
    expect(shouldInterruptThinking({ ...base, interruptionsSoFar: 1 })).toBe(true);
    expect(shouldInterruptThinking({ ...base, interruptionsSoFar: 2 })).toBe(false);
    expect(shouldInterruptThinking({ ...base, interruptionsSoFar: 3 })).toBe(false);
  });

  test("budget of 0 disables the watchdog entirely", () => {
    expect(shouldInterruptThinking({ ...base, budgetChars: 0, thinkingChars: 1_000_000 })).toBe(false);
  });
});
