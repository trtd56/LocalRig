// Tests for the pure thinking-watchdog decision. The agent loop wires this
// into the streaming callback; here we exercise the decision table directly.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { Agent, shouldInterruptThinking } from "../src/agent.ts";
import { defaultConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/types.ts";

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

describe("Agent.restore", () => {
  test("replaces the fresh system prompt with a restored transcript", () => {
    const agent = new Agent({ ...defaultConfig }, os.tmpdir(), () => {}, async () => false);
    // A fresh agent starts with just its own system prompt.
    expect(agent.getMessages()).toHaveLength(1);

    const transcript: ChatMessage[] = [
      { role: "system", content: "restored system prompt", _seq: 0 },
      { role: "user", content: "original task", _seq: 1 },
      { role: "assistant", content: "did it", _seq: 2 },
    ];
    agent.restore(transcript);

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe("restored system prompt");
    expect(msgs[2]!.content).toBe("did it");
  });
});
