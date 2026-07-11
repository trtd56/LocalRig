// Tests for the pure thinking-watchdog decision. The agent loop wires this
// into the streaming callback; here we exercise the decision table directly.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import { Agent, shouldInterruptThinking } from "../src/agent.ts";
import { defaultConfig } from "../src/config.ts";
import { buildScoutSystemPrompt } from "../src/prompt/system.ts";
import type { AgentEvent, ChatMessage, ToolDef } from "../src/types.ts";

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
        total_duration: 20_000_000,
        load_duration: 1_000_000,
        prompt_eval_duration: 5_000_000,
        eval_duration: 12_000_000,
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
      const events: AgentEvent[] = [];
      const agent = new Agent({ ...defaultConfig }, os.tmpdir(), (event) => events.push(event), async () => false, "SYS", [tool], true);
      expect(await agent.runTextOnly("repair as JSON")).toBe('{"answer":"fixed"}');
      expect(requestBody?.tools).toEqual([]);
      expect(requestBody?.keep_alive).toBe("30m");
      const messages = requestBody?.messages as Array<{ content: string }>;
      expect(messages.at(-1)?.content).toBe("repair as JSON");
      expect(messages.some((m) => m.content.includes("CRITICAL - stopping now"))).toBe(false);
      expect(agent.lastRunStatus).toBe("ok");
      expect(events.find((event) => event.type === "timing")).toMatchObject({
        type: "timing",
        phase: "model",
        loadMs: 1,
        promptEvalMs: 5,
        evalMs: 12,
        promptTokens: 10,
        evalTokens: 3,
        thinkingChars: 0,
        interrupted: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("thinking watchdog integration", () => {
  test("aborts twice, injects nudges, then retries with think:false", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      attempt++;
      if (attempt <= 2) {
        const signal = init?.signal!;
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), { once: true });
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              message: { role: "assistant", thinking: "t".repeat(11) }, done: false,
            }) + "\n"));
          },
        }));
      }
      return new Response(JSON.stringify({
        message: { role: "assistant", content: "done" }, done: true,
        prompt_eval_count: 10, eval_count: 1,
      }) + "\n");
    }) as typeof fetch;
    const events: AgentEvent[] = [];
    try {
      const agent = new Agent(
        { ...defaultConfig, thinkBudgetChars: 10 }, os.tmpdir(),
        (event) => events.push(event), async () => false, "SYS", [], true,
      );
      expect(await agent.run("finish")).toBe("done");
      expect(bodies.map((body) => body.think)).toEqual([true, true, false]);
      expect(events.filter((event) => event.type === "thinking_interrupt")).toHaveLength(2);
      expect(events.filter((event) => event.type === "timing" && event.interrupted)).toHaveLength(2);
      const nudges = agent.getMessages().filter((message) => message.role === "user" && message.content.includes("reasoning was interrupted"));
      expect(nudges).toHaveLength(2);
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
