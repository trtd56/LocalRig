// Tests for src/context — token ledger, pruning, compaction, safety valve.
// Uses a fake client; never hits the network. Tiny numCtx values trigger the
// different phases cheaply.

import { describe, expect, test } from "bun:test";
import type { OllamaClient } from "../src/provider/ollama.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import type { AgentEvent, ChatMessage, Role } from "../src/types.ts";
import { ContextManager } from "../src/context/manager.ts";
import { TokenLedger, estimateTokens } from "../src/context/tokens.ts";

// ------------------------------------------------------------------ helpers

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig,
    numCtx: 2000,
    numPredict: 100,
    // Gates reserve headroomTokens (not the full num_predict) above the
    // current estimate; keep it small so these tiny-numCtx tests trip cleanly.
    headroomTokens: 100,
    pruneAt: 0.75,
    compactAt: 0.85,
    keepRecentMessages: 4,
    ...overrides,
  };
}

const GOOD_SUMMARY =
  "## Goal\nBuild the widget\n" +
  "## Constraints & Preferences\n- none\n" +
  "## Progress\n### Done\n- step 1\n### In Progress\n- step 2\n### Blocked\n- none\n" +
  "## Key Decisions\n- use bun\n" +
  "## Next Steps\n1. finish step 2\n" +
  "## Critical Context\n- none";

function fakeClient(behavior: () => Promise<string>): { client: OllamaClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]): Promise<string> => {
      calls.push(messages);
      return behavior();
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

let seq = 0;
function msg(role: Role, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, _seq: seq++, ...extra };
}

function collect(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const signal = new AbortController().signal;

// ------------------------------------------------------------- token ledger

describe("tokens", () => {
  test("estimateTokens: chars/3.3, minimum 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("x")).toBe(1);
    expect(estimateTokens("x".repeat(33))).toBe(10);
  });

  test("estimateMessage: measured _tokens beats estimate", () => {
    const ledger = new TokenLedger();
    const m: ChatMessage = { role: "assistant", content: "y".repeat(10_000), _tokens: 5 };
    expect(ledger.estimateMessage(m)).toBe(5);
    expect(ledger.estimateTotal([m])).toBe(5);
  });

  test("estimateMessage counts tool_calls JSON", () => {
    const ledger = new TokenLedger();
    const bare: ChatMessage = { role: "assistant", content: "hi" };
    const withCalls: ChatMessage = {
      role: "assistant",
      content: "hi",
      tool_calls: [{ function: { name: "bash", arguments: { command: "ls -la /tmp" } } }],
    };
    expect(ledger.estimateMessage(withCalls)).toBeGreaterThan(ledger.estimateMessage(bare));
  });

  test("calibrate adjusts estimates toward actual", () => {
    const ledger = new TokenLedger();
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(660) }];
    const e0 = ledger.estimateTotal(messages);
    const actual = e0 * 2;

    ledger.calibrate(messages, actual);
    const e1 = ledger.estimateTotal(messages);
    expect(e1).toBeGreaterThan(e0);
    expect(Math.abs(e1 - actual)).toBeLessThan(Math.abs(e0 - actual));

    ledger.calibrate(messages, actual);
    const e2 = ledger.estimateTotal(messages);
    expect(Math.abs(e2 - actual)).toBeLessThanOrEqual(Math.abs(e1 - actual));
  });

  test("calibrate clamps extreme ratios", () => {
    const ledger = new TokenLedger();
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(330) }];
    const e0 = ledger.estimateTotal(messages);
    ledger.calibrate(messages, e0 * 1000); // sample clamped to 3
    // One EMA step from 1 toward the clamped 3: ratio = 1 + 0.3*(3-1) = 1.6
    expect(ledger.estimateTotal(messages)).toBeLessThanOrEqual(Math.ceil(e0 * 1.6));
  });
});

// ---------------------------------------------------------------- recordUsage

describe("recordUsage", () => {
  test("sets _tokens on the last assistant message", () => {
    const { client } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg(), client);
    const messages = [msg("system", "sys"), msg("user", "q"), msg("assistant", "answer")];
    cm.recordUsage(messages, 120, 42);
    expect(messages[2]!._tokens).toBe(42);
    expect(messages[0]!._tokens).toBeUndefined();
    expect(messages[1]!._tokens).toBeUndefined();
  });
});

// --------------------------------------------------------------------- manage

describe("manage: below threshold", () => {
  test("no mutation, no events, no summarizer call", async () => {
    const { client, calls } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg(), client);
    const { events, onEvent } = collect();
    const messages = [msg("system", "sys"), msg("user", "hello"), msg("assistant", "hi")];
    const snapshot = structuredClone(messages);

    await cm.manage(messages, onEvent, signal);

    expect(messages).toEqual(snapshot);
    expect(events.length).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe("manage: headroom gate math", () => {
  // The gate is `estimateTotal + headroomTokens >= pruneAt * numCtx`. Build a
  // fixed transcript, measure its estimate, then size numCtx so the prune gate
  // sits just above the estimate — headroom decides whether it trips.
  const bigOld = "x".repeat(16_000); // prunable old tool output (> PRUNE_MIN_CHARS)
  function build(): ChatMessage[] {
    return [
      msg("system", "sys"),
      msg("user", "do the task"),
      msg("tool", bigOld, { tool_name: "bash" }),
      // tail: last keepRecentMessages (4) are protected from pruning
      msg("assistant", "working"),
      msg("tool", "small tail output", { tool_name: "read_file" }),
      msg("assistant", "ok"),
      msg("user", "continue"),
    ];
  }
  const estimate = new TokenLedger().estimateTotal(build());
  const numCtx = Math.ceil((estimate + 300) / 0.75); // prune gate ≈ estimate + 300

  test("no prune when estimate + headroom stays below the gate", async () => {
    const { client, calls } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ numCtx, headroomTokens: 100 }), client);
    const { events, onEvent } = collect();
    const messages = build();
    await cm.manage(messages, onEvent, signal);
    expect(events.length).toBe(0);
    expect(messages[2]!._pruned).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("prune fires once headroom pushes the total over the gate", async () => {
    const { client } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ numCtx, headroomTokens: 600 }), client);
    const { events, onEvent } = collect();
    const messages = build();
    await cm.manage(messages, onEvent, signal);
    expect(events.some((e) => e.type === "prune")).toBe(true);
    expect(events.some((e) => e.type === "compact")).toBe(false);
    expect(messages[2]!._pruned).toBe(true);
  });

  test("num_predict no longer affects the gate", async () => {
    // A huge num_predict must NOT trip the gate — only headroomTokens does.
    const { client } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ numCtx, headroomTokens: 100, numPredict: 100_000 }), client);
    const { events, onEvent } = collect();
    const messages = build();
    await cm.manage(messages, onEvent, signal);
    expect(events.length).toBe(0);
    expect(messages[2]!._pruned).toBeUndefined();
  });
});

describe("manage: prune phase", () => {
  test("stubs old big tool outputs, keeps recent keepRecentMessages intact", async () => {
    const { client, calls } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ keepRecentMessages: 4 }), client);
    const { events, onEvent } = collect();
    const big = "x".repeat(2000);

    const messages = [
      msg("system", "sys"),
      msg("user", "do the task"),
      msg("tool", big, { tool_name: "bash" }),
      msg("tool", big, { tool_name: "read_file", _filePath: "/a.ts" }),
      msg("tool", big, { tool_name: "grep" }),
      // ---- tail: last 4 must stay untouched ----
      msg("assistant", "working"),
      msg("tool", big, { tool_name: "read_file" }),
      msg("assistant", "ok"),
      msg("user", "continue"),
    ];

    await cm.manage(messages, onEvent, signal);

    // Old big tool outputs pruned (oldest-first, all in one batch).
    for (const i of [2, 3, 4]) {
      expect(messages[i]!.content).toStartWith("[pruned to save context:");
      expect(messages[i]!._pruned).toBe(true);
      expect(messages[i]!._tokens).toBeUndefined();
    }
    expect(messages[2]!.content).toContain("bash output");
    expect(messages[2]!.content).toContain("Re-run the tool");

    // Recent messages untouched, even the big tool output.
    expect(messages[5]!.content).toBe("working");
    expect(messages[6]!.content).toBe(big);
    expect(messages[6]!._pruned).toBeUndefined();
    expect(messages[7]!.content).toBe("ok");
    expect(messages[8]!.content).toBe("continue");

    // One prune event, no compaction.
    const prunes = events.filter((e) => e.type === "prune");
    expect(prunes.length).toBe(1);
    expect(prunes[0]!.type === "prune" && prunes[0]!.freedTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "compact")).toBe(false);
    expect(events.some((e) => e.type === "status")).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("manage: compact phase", () => {
  test("rebuilds in place with summary bridge, safe tail boundary, file-op lists", async () => {
    const { client, calls } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ keepRecentMessages: 3 }), client);
    const { events, onEvent } = collect();
    const filler = "u".repeat(1400);

    const messages = [
      msg("system", "You are a test agent."),
      msg("user", "ORIGINAL: build the widget"),
      msg("user", filler),
      msg("assistant", "editing now", {
        tool_calls: [
          { function: { name: "edit", arguments: { path: "/proj/y.ts", old_string: "aa", new_string: "bb" } } },
        ],
      }),
      msg("tool", "edited ok", { tool_name: "edit" }),
      msg("user", filler),
      msg("assistant", filler),
      msg("user", filler),
      // Carrier + its tool result: initial tail start (12-3=9) lands on the
      // tool message, so the boundary must extend back to index 8.
      msg("assistant", "", {
        tool_calls: [{ function: { name: "read_file", arguments: { path: "/proj/x.ts" } } }],
      }),
      msg("tool", "contents of x", { tool_name: "read_file" }),
      msg("assistant", "did the read"),
      msg("user", "continue"),
    ];
    const alias = messages;
    const systemMsg = messages[0]!;
    const carrier = messages[8]!;
    const toolResult = messages[9]!;
    const carrierSeq = carrier._seq;

    await cm.manage(messages, onEvent, signal);

    // In-place rebuild: same array identity, visible through the alias.
    expect(alias).toBe(messages);
    expect(alias.length).toBe(6);

    // System prompt preserved at [0] (same object).
    expect(messages[0]).toBe(systemMsg);

    // Bridge user message at [1]: summary + file ops + original request.
    const bridge = messages[1]!;
    expect(bridge.role).toBe("user");
    expect(bridge.content).toStartWith("[Context was compacted.");
    expect(bridge.content).toContain("## Next Steps");
    expect(bridge.content).toContain("ORIGINAL: build the widget");
    expect(bridge.content).toContain("<read-files>\n/proj/x.ts\n</read-files>");
    expect(bridge.content).toContain("<modified-files>\n/proj/y.ts\n</modified-files>");
    expect(bridge._seq).toBeGreaterThanOrEqual(1_000_000_000);

    // Tail boundary extended backwards to the tool_calls carrier — the tail
    // never starts with a role:"tool" message.
    expect(messages[2]).toBe(carrier);
    expect(messages[2]!.role).toBe("assistant");
    expect(messages[2]!.tool_calls?.length).toBe(1);
    expect(messages[2]!._seq).toBe(carrierSeq);
    expect(messages[3]).toBe(toolResult);
    expect(messages[4]!.content).toBe("did the read");
    expect(messages[5]!.content).toBe("continue");

    // Compact event with shrinking totals.
    const compacts = events.filter((e) => e.type === "compact");
    expect(compacts.length).toBe(1);
    if (compacts[0]!.type === "compact") {
      expect(compacts[0]!.beforeTokens).toBeGreaterThan(compacts[0]!.afterTokens);
    }

    // Summarizer request: plain-text transcript, not a conversation.
    expect(calls.length).toBe(1);
    const req = calls[0]!;
    expect(req.length).toBe(2);
    expect(req[0]!.role).toBe("system");
    expect(req[0]!.content).toContain("Do NOT continue the conversation");
    expect(req[1]!.content).toContain("[User]: ORIGINAL: build the widget");
    expect(req[1]!.content).toContain('[Assistant tool calls]: edit(path="/proj/y.ts"');
    expect(req[1]!.content).toContain("[Tool result]: edited ok");
    expect(req[1]!.content).toContain("## Goal");
    expect(req[1]!.content).toContain("## Critical Context");
  });

  test("compaction failure (throw) falls back to hard prune", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("boom");
    });
    const cm = new ContextManager(cfg({ keepRecentMessages: 4 }), client);
    const { events, onEvent } = collect();
    const filler = "u".repeat(1200);

    const messages = [
      msg("system", "sys"),
      msg("user", "task: do the thing"),
      msg("user", filler),
      msg("assistant", filler),
      msg("user", filler),
      msg("assistant", filler),
      // Small tool output: survives normal prune (≤500 chars) but must be
      // stubbed by the hard-prune fallback.
      msg("tool", "t".repeat(300), { tool_name: "bash" }),
      msg("assistant", "step done"),
      msg("user", "go on"),
      msg("assistant", "ok"),
      msg("user", "next"),
    ];

    await cm.manage(messages, onEvent, signal);

    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.length).toBe(1);
    if (statuses[0]!.type === "status") {
      expect(statuses[0]!.message).toContain("compaction failed: boom");
      expect(statuses[0]!.message).toContain("continuing with pruned context");
    }

    // Not compacted — original shape kept.
    expect(messages.length).toBe(11);
    expect(events.some((e) => e.type === "compact")).toBe(false);
    expect(messages.every((m) => !m.content.includes("[Context was compacted"))).toBe(true);

    // Hard prune stubbed the small tool output outside the tail.
    expect(messages[6]!._pruned).toBe(true);
    expect(messages[6]!.content).toStartWith("[pruned to save context: bash");
    // Tail untouched.
    expect(messages[7]!.content).toBe("step done");
  });

  test("inflated summary (rebuilt not smaller) is dropped, hard prune instead", async () => {
    const { client, calls } = fakeClient(async () => "## Goal\n" + "z".repeat(20_000));
    const cm = new ContextManager(cfg({ keepRecentMessages: 4 }), client);
    const { events, onEvent } = collect();
    const filler = "u".repeat(1200);

    const messages = [
      msg("system", "sys"),
      msg("user", "task: do the thing"),
      msg("user", filler),
      msg("assistant", filler),
      msg("user", filler),
      msg("assistant", filler),
      msg("tool", "t".repeat(300), { tool_name: "bash" }),
      msg("assistant", "step done"),
      msg("user", "go on"),
      msg("assistant", "ok"),
      msg("user", "next"),
    ];

    await cm.manage(messages, onEvent, signal);

    expect(calls.length).toBe(1);
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.length).toBe(1);
    if (statuses[0]!.type === "status") {
      expect(statuses[0]!.message).toContain("compaction failed: summary did not shrink the context");
    }
    expect(events.some((e) => e.type === "compact")).toBe(false);
    expect(messages.length).toBe(11);
    expect(messages.every((m) => !m.content.includes("zzzz"))).toBe(true);
    expect(messages[6]!._pruned).toBe(true); // hard-prune fallback applied
  });
});

describe("manage: safety valve", () => {
  test("drops oldest messages when even the compacted result is too big", async () => {
    const { client } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ keepRecentMessages: 4 }), client);
    const { events, onEvent } = collect();
    const big = "b".repeat(2000);

    const messages = [
      msg("system", "You are a test agent."),
      msg("user", "ORIGINAL: build the widget"),
      msg("user", "u".repeat(1200)),
      msg("assistant", "a".repeat(1200)),
      // Tail: 4 big non-prunable messages — even after compaction the total
      // exceeds 0.95 * numCtx, so the valve must drop from the front.
      msg("user", big),
      msg("assistant", big),
      msg("user", big),
      msg("assistant", big),
    ];
    const lastTwo = [messages[6]!, messages[7]!];

    await cm.manage(messages, onEvent, signal);

    // Compaction ran, then the valve dropped the bridge + oldest tail entries.
    expect(events.some((e) => e.type === "compact")).toBe(true);
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.length).toBe(1);
    if (statuses[0]!.type === "status") {
      expect(statuses[0]!.message).toContain("dropped oldest messages");
    }

    expect(messages[0]!.role).toBe("system");
    expect(messages.length).toBe(3);
    expect(messages[1]).toBe(lastTwo[0]!);
    expect(messages[2]).toBe(lastTwo[1]!);
    expect(messages[1]!.role).not.toBe("tool");
  });
});

// ---------------------------------------------------- markSupersededFileReads

describe("markSupersededFileReads", () => {
  test("marks without mutation, then stubs at the next prune gate", async () => {
    const { client } = fakeClient(async () => GOOD_SUMMARY);
    const cm = new ContextManager(cfg({ pruneAt: 0.1, compactAt: 2, keepRecentMessages: 10 }), client);

    const messages = [
      msg("system", "sys"),
      msg("tool", "r".repeat(1500), { tool_name: "read_file", _filePath: "/a/b.ts", _tokens: 999 }),
      msg("tool", "s".repeat(200), { tool_name: "read_file", _filePath: "/a/b.ts" }),
      msg("tool", "o".repeat(1500), { tool_name: "read_file", _filePath: "/other.ts" }),
      msg("tool", "p".repeat(1500), { tool_name: "read_file", _filePath: "/a/b.ts", _pruned: true }),
      msg("user", "read it again"),
    ];

    cm.markSupersededFileReads(messages, "/a/b.ts");

    expect(messages[1]!.content).toBe("r".repeat(1500));
    expect(messages[1]!._tokens).toBe(999);
    expect(messages[1]!._superseded).toBe(true);

    await cm.manage(messages, () => {}, new AbortController().signal);

    expect(messages[1]!.content).toBe("[superseded: newer read of /a/b.ts below]");
    expect(messages[1]!._pruned).toBe(true);
    expect(messages[1]!._tokens).toBeUndefined();
    expect(messages[1]!._superseded).toBe(false);

    // Small read of the same path: left alone (prefix-cache preservation).
    expect(messages[2]!.content).toBe("s".repeat(200));
    expect(messages[2]!._pruned).toBeUndefined();

    // Different path: untouched.
    expect(messages[3]!.content).toBe("o".repeat(1500));

    // Already pruned: untouched.
    expect(messages[4]!.content).toBe("p".repeat(1500));

    // Non-tool messages untouched.
    expect(messages[5]!.content).toBe("read it again");
  });
});
