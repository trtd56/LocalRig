// Tests for the pure thinking-watchdog decision. The agent loop wires this
// into the streaming callback; here we exercise the decision table directly.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { Agent, shouldInterruptThinking } from "../src/agent.ts";
import { defaultConfig } from "../src/config.ts";
import { buildScoutSystemPrompt } from "../src/prompt/system.ts";
import type { ChatMessage, ToolDef } from "../src/types.ts";

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

describe("Agent system prompt", () => {
  test("uses an injected system prompt verbatim (lh batch reuses one across tasks)", () => {
    const agent = new Agent({ ...defaultConfig }, os.tmpdir(), () => {}, async () => false, "SHARED SYS PROMPT");
    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("SHARED SYS PROMPT");
  });

  test("builds its own system prompt when none is injected (one-shot/REPL)", () => {
    const agent = new Agent({ ...defaultConfig }, os.tmpdir(), () => {}, async () => false);
    expect(agent.getMessages()[0]!.content).toContain("You are a coding agent");
  });

  test("accepts an injected tool set without changing the initial transcript", () => {
    const tool: ToolDef = {
      name: "read",
      description: "fake read",
      parameters: { type: "object", properties: {}, required: [] },
      mutating: false,
      execute: async () => ({ ok: true, output: "ok" }),
    };
    const agent = new Agent({ ...defaultConfig }, os.tmpdir(), () => {}, async () => false, "SYS", [tool], true);
    expect(agent.getMessages()).toEqual([{ role: "system", content: "SYS", _seq: 0 }]);
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

describe("Agent.runTextOnly", () => {
  test("runs one turn without tools or a max-iteration wrap-up prompt", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const line = JSON.stringify({
        message: { role: "assistant", content: '{"answer":"fixed"}' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 3,
      });
      return new Response(line + "\n", { status: 200 });
    }) as typeof fetch;
    try {
      const tool: ToolDef = {
        name: "read",
        description: "test",
        parameters: { type: "object", properties: {}, required: [] },
        mutating: false,
        execute: async () => ({ ok: true, output: "unused" }),
      };
      const agent = new Agent({ ...defaultConfig }, os.tmpdir(), () => {}, async () => false, "SYS", [tool], true);
      expect(await agent.runTextOnly("repair as JSON")).toBe('{"answer":"fixed"}');
      expect(requestBody?.tools).toEqual([]);
      const messages = requestBody?.messages as Array<{ content: string }>;
      expect(messages.at(-1)?.content).toBe("repair as JSON");
      expect(messages.some((m) => m.content.includes("CRITICAL - stopping now"))).toBe(false);
      expect(agent.lastRunStatus).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("buildScoutSystemPrompt", () => {
  test("describes read-only exploration and digest JSON requirements", () => {
    const prompt = buildScoutSystemPrompt(os.tmpdir(), { ...defaultConfig }, "where is retry?", ["src"]);
    expect(prompt).toContain("read-only repository scout");
    expect(prompt).toContain("Use glob");
    expect(prompt).toContain("Use grep");
    expect(prompt).toContain("Use read");
    expect(prompt).toContain("not_found true");
    expect(prompt).toContain('"citations"');
    expect(prompt).toContain("path hints: src");
  });
});
