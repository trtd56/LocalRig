import { describe, expect, test } from "bun:test";
import type { JsonSchema, ToolCall, ToolDef, ToolResult } from "../src/types.ts";
import { resolveToolCall, type ResolvedCall } from "../src/toolcall/validate.ts";
import { parseFallbackToolCalls } from "../src/toolcall/fallback.ts";
import { LoopDetector, stableStringify } from "../src/toolcall/loopdetect.ts";

// ---------------------------------------------------------------------------
// Fixtures: tool defs mirroring the real registry
// ---------------------------------------------------------------------------

function tool(name: string, parameters: JsonSchema): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters,
    mutating: false,
    execute: async () => ({ ok: true, output: "" }),
  };
}

const TOOLS: ToolDef[] = [
  tool("read", {
    type: "object",
    properties: {
      path: { type: "string", description: "absolute path to the file" },
      offset: { type: "number", description: "line to start reading from" },
      limit: { type: "number", description: "number of lines to read" },
    },
    required: ["path"],
  }),
  tool("write", {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  }),
  tool("edit", {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "exact text to replace" },
      new_string: { type: "string", description: "replacement text" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  }),
  tool("bash", {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
    },
    required: ["command"],
  }),
  tool("grep", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
  }),
  tool("glob", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
  }),
  tool("todo", {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["items"],
  }),
];

function mk(name: string, args: Record<string, unknown> | string): ToolCall {
  return { function: { name, arguments: args } };
}

function resolve(name: string, args: Record<string, unknown> | string): ResolvedCall {
  return resolveToolCall(mk(name, args), TOOLS);
}

function expectOk(r: ResolvedCall): Extract<ResolvedCall, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got problem: ${r.problem}`);
  return r;
}

function expectErr(r: ResolvedCall): Extract<ResolvedCall, { ok: false }> {
  if (r.ok) throw new Error(`expected failure, got ok for tool ${r.tool.name}`);
  return r;
}

// ---------------------------------------------------------------------------
// validate.ts — tool name resolution
// ---------------------------------------------------------------------------

describe("resolveToolCall: tool names", () => {
  test("exact and case-insensitive match", () => {
    expect(expectOk(resolve("bash", { command: "ls" })).tool.name).toBe("bash");
    expect(expectOk(resolve("Bash", { command: "ls" })).tool.name).toBe("bash");
    expect(expectOk(resolve("READ", { path: "a.ts" })).tool.name).toBe("read");
  });

  test("alias execute_command -> bash", () => {
    const r = expectOk(resolve("execute_command", { command: "ls" }));
    expect(r.tool.name).toBe("bash");
  });

  test("alias read_file -> read (via normalization + alias table)", () => {
    const r = expectOk(resolve("read_file", { path: "a.ts" }));
    expect(r.tool.name).toBe("read");
  });

  test("more aliases: str_replace -> edit, ls -> glob, todo_write -> todo", () => {
    expect(
      expectOk(resolve("str_replace", { path: "a", old_string: "x", new_string: "y" })).tool.name,
    ).toBe("edit");
    expect(expectOk(resolve("ls", { pattern: "*" })).tool.name).toBe("glob");
    expect(expectOk(resolve("todo_write", { items: [] })).tool.name).toBe("todo");
  });

  test("levenshtein: baash -> bash", () => {
    const r = expectOk(resolve("baash", { command: "ls" }));
    expect(r.tool.name).toBe("bash");
  });

  test("unknown tool lists available tools", () => {
    const r = expectErr(resolve("frobnicate", {}));
    expect(r.name).toBe("frobnicate");
    expect(r.problem).toContain('Unknown tool "frobnicate"');
    expect(r.problem).toContain("Available tools: read, write, edit, bash, grep, glob, todo.");
  });
});

// ---------------------------------------------------------------------------
// validate.ts — argument parsing / repair
// ---------------------------------------------------------------------------

describe("resolveToolCall: argument parsing", () => {
  test("string args parsed as JSON", () => {
    const r = expectOk(resolve("bash", '{"command": "ls -la"}'));
    expect(r.args).toEqual({ command: "ls -la" });
  });

  test("double-encoded JSON args unwrapped once", () => {
    const doubled = JSON.stringify(JSON.stringify({ command: "echo hi" }));
    const r = expectOk(resolve("bash", doubled));
    expect(r.args).toEqual({ command: "echo hi" });
  });

  test("single-quoted JSON repaired", () => {
    const r = expectOk(resolve("write", "{'path': 'a.ts', 'content': 'hello'}"));
    expect(r.args).toEqual({ path: "a.ts", content: "hello" });
  });

  test("single-quote repair tolerates apostrophes inside strings", () => {
    const r = expectOk(resolve("bash", "{'command': 'echo it's fine'}"));
    expect(r.args).toEqual({ command: "echo it's fine" });
  });

  test("trailing comma repaired", () => {
    const r = expectOk(resolve("bash", '{"command": "ls",}'));
    expect(r.args).toEqual({ command: "ls" });
  });

  test("markdown code fences stripped", () => {
    const r = expectOk(resolve("bash", '```json\n{"command": "ls"}\n```'));
    expect(r.args).toEqual({ command: "ls" });
  });

  test("empty/undefined-ish args become {} (then required check fires)", () => {
    const r = expectErr(resolve("bash", ""));
    expect(r.problem).toContain('missing required "command"');
  });

  test("unparseable args produce an error containing an example", () => {
    const r = expectErr(resolve("bash", "run ls for me please"));
    expect(r.problem).toContain('Invalid arguments for "bash"');
    expect(r.problem).toContain('"command"');
  });
});

// ---------------------------------------------------------------------------
// validate.ts — key normalization
// ---------------------------------------------------------------------------

describe("resolveToolCall: key normalization", () => {
  test("file_path -> path", () => {
    const r = expectOk(resolve("read", { file_path: "src/a.ts" }));
    expect(r.args).toEqual({ path: "src/a.ts" });
  });

  test("old_str/new_str -> old_string/new_string", () => {
    const r = expectOk(resolve("edit", { path: "a.ts", old_str: "foo", new_str: "bar" }));
    expect(r.args).toEqual({ path: "a.ts", old_string: "foo", new_string: "bar" });
  });

  test("camelCase keys match snake_case properties", () => {
    const r = expectOk(resolve("edit", { path: "a.ts", oldString: "x", newString: "y" }));
    expect(r.args).toEqual({ path: "a.ts", old_string: "x", new_string: "y" });
  });

  test("cmd -> command, query -> pattern, todos -> items", () => {
    expect(expectOk(resolve("bash", { cmd: "ls" })).args).toEqual({ command: "ls" });
    expect(expectOk(resolve("grep", { query: "foo" })).args).toEqual({ pattern: "foo" });
    const todo = expectOk(resolve("todo", { todos: [{ content: "x", status: "pending" }] }));
    expect(todo.args["items"]).toEqual([{ content: "x", status: "pending" }]);
  });

  test("unknown keys are dropped and reported when validation fails", () => {
    const r = expectErr(resolve("edit", { path: "a.ts", new_string: "y", wibble: 1 }));
    expect(r.problem).toContain('missing required "old_string"');
    expect(r.problem).toContain("wibble");
  });
});

// ---------------------------------------------------------------------------
// validate.ts — type coercion
// ---------------------------------------------------------------------------

describe("resolveToolCall: type coercion", () => {
  test('"5" -> 5 for number properties', () => {
    const r = expectOk(resolve("read", { path: "a.ts", offset: "5", limit: "10" }));
    expect(r.args).toEqual({ path: "a.ts", offset: 5, limit: 10 });
  });

  test('"true" -> true for boolean properties', () => {
    const r = expectOk(
      resolve("edit", { path: "a", old_string: "x", new_string: "y", replace_all: "true" }),
    );
    expect(r.args["replace_all"]).toBe(true);
  });

  test("number -> string when schema says string", () => {
    const r = expectOk(resolve("write", { path: "a.txt", content: 42 }));
    expect(r.args["content"]).toBe("42");
  });

  test("single object -> [object] for array properties", () => {
    const r = expectOk(resolve("todo", { items: { content: "x", status: "pending" } }));
    expect(r.args["items"]).toEqual([{ content: "x", status: "pending" }]);
  });

  test("todo items as strings become {content, status: pending}", () => {
    const r = expectOk(resolve("todo", { items: ["write tests", "run tests"] }));
    expect(r.args["items"]).toEqual([
      { content: "write tests", status: "pending" },
      { content: "run tests", status: "pending" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// validate.ts — required check / self-repair message
// ---------------------------------------------------------------------------

describe("resolveToolCall: required check", () => {
  test("missing required includes received keys and an example JSON", () => {
    const r = expectErr(resolve("edit", { path: "src/a.ts", new_string: "bar" }));
    expect(r.name).toBe("edit");
    expect(r.problem).toContain('Invalid arguments for "edit"');
    expect(r.problem).toContain('missing required "old_string"');
    expect(r.problem).toContain("Received keys: [path, new_string]");
    expect(r.problem).toContain("Retry with corrected arguments");
    // The example must be valid JSON covering the required params.
    const exampleMatch = r.problem.match(/Expected: (\{.*\})\./);
    expect(exampleMatch).not.toBeNull();
    const example = JSON.parse(exampleMatch![1]!) as Record<string, unknown>;
    expect(Object.keys(example)).toEqual(["path", "old_string", "new_string"]);
    expect(typeof example["old_string"]).toBe("string");
  });

  test("all required present passes", () => {
    const r = expectOk(resolve("edit", { path: "a", old_string: "x", new_string: "y" }));
    expect(r.args).toEqual({ path: "a", old_string: "x", new_string: "y" });
  });
});

// ---------------------------------------------------------------------------
// fallback.ts
// ---------------------------------------------------------------------------

describe("parseFallbackToolCalls", () => {
  test("single Qwen <tool_call> block", () => {
    const calls = parseFallbackToolCalls(
      'I will read the file.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("read");
    expect(calls[0]!.function.arguments).toEqual({ path: "a.ts" });
  });

  test("multiple Qwen blocks", () => {
    const calls = parseFallbackToolCalls(
      '<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>\n' +
        '<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.function.name).toBe("read");
    expect(calls[1]!.function.name).toBe("bash");
  });

  test("unclosed <tool_call> at end of string", () => {
    const calls = parseFallbackToolCalls(
      'Running it now.\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("bash");
    expect(calls[0]!.function.arguments).toEqual({ command: "ls" });
  });

  test("fenced json block", () => {
    const calls = parseFallbackToolCalls(
      'Let me search for that.\n```json\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n```\nDone.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("grep");
    expect(calls[0]!.function.arguments).toEqual({ pattern: "TODO" });
  });

  test("fenced json array of calls", () => {
    const calls = parseFallbackToolCalls(
      '```json\n[{"name": "read", "arguments": {"path": "a.ts"}}, {"name": "read", "parameters": {"path": "b.ts"}}]\n```',
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.function.arguments).toEqual({ path: "b.ts" });
  });

  test("bare top-level JSON object (whole content)", () => {
    const calls = parseFallbackToolCalls('{"name": "bash", "arguments": {"command": "ls"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("bash");
  });

  test("bare JSON object as the whole last line", () => {
    const calls = parseFallbackToolCalls(
      'I need to look at the file first.\n{"name": "read", "arguments": {"path": "a.ts"}}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("read");
  });

  test("OpenAI-style {function: {name, arguments}} shape", () => {
    const calls = parseFallbackToolCalls(
      '{"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe("bash");
    // Nested JSON string is left as-is; validate.ts repairs it later.
    expect(calls[0]!.function.arguments).toBe('{"command": "ls"}');
    expect(calls[0]!.id).toBe("call_1");
  });

  test("JSON inside prose is NOT matched", () => {
    const calls = parseFallbackToolCalls(
      'The config format is {"name": "test", "arguments": {"a": 1}} which you can edit later.',
    );
    expect(calls).toEqual([]);
  });

  test("call-shaped-ish object without arguments key is NOT matched bare", () => {
    expect(parseFallbackToolCalls('{"name": "config"}')).toEqual([]);
    expect(parseFallbackToolCalls('{"name": "x", "value": 3, "arguments": {}}')).toEqual([]);
  });

  test("invalid tool name rejected", () => {
    expect(parseFallbackToolCalls('{"name": "not a name!", "arguments": {}}')).toEqual([]);
    expect(parseFallbackToolCalls('{"name": "9lives", "arguments": {}}')).toEqual([]);
  });

  test("plain prose returns []", () => {
    expect(parseFallbackToolCalls("All done. The tests pass.")).toEqual([]);
    expect(parseFallbackToolCalls("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loopdetect.ts
// ---------------------------------------------------------------------------

const OK: ToolResult = { ok: true, output: "fine" };
const FAIL: ToolResult = { ok: false, output: "Error: no such file or directory" };

describe("LoopDetector", () => {
  test("warns at 3 consecutive identical calls, only once, aborts at 5", () => {
    const d = new LoopDetector(3, 5);
    const iterate = (): { message: string; abort: boolean } | null => {
      d.noteCall("read", { path: "a.ts" });
      d.noteResult("read", OK);
      return d.check();
    };
    expect(iterate()).toBeNull(); // 1
    expect(iterate()).toBeNull(); // 2
    const warn = iterate(); // 3 -> warn
    expect(warn).not.toBeNull();
    expect(warn!.abort).toBe(false);
    expect(warn!.message).toContain("repeated the exact same tool call 3 times");
    expect(iterate()).toBeNull(); // 4 -> already warned, not yet abort
    const abort = iterate(); // 5 -> abort
    expect(abort).not.toBeNull();
    expect(abort!.abort).toBe(true);
    expect(abort!.message).toContain("5 times");
  });

  test("argument key order does not defeat the signature", () => {
    const d = new LoopDetector(3, 5);
    d.noteCall("bash", { command: "ls", timeout: 5 });
    expect(d.check()).toBeNull();
    d.noteCall("bash", { timeout: 5, command: "ls" });
    expect(d.check()).toBeNull();
    d.noteCall("bash", { command: "ls", timeout: 5 });
    const warn = d.check();
    expect(warn).not.toBeNull();
    expect(warn!.abort).toBe(false);
  });

  test("different calls do not trigger", () => {
    const d = new LoopDetector(3, 5);
    for (let i = 0; i < 6; i++) {
      d.noteCall("read", { path: `file${i}.ts` });
      d.noteResult("read", OK);
      expect(d.check()).toBeNull();
    }
  });

  test("reset clears state", () => {
    const d = new LoopDetector(3, 5);
    for (let i = 0; i < 3; i++) d.noteCall("bash", { command: "ls" });
    expect(d.check()).not.toBeNull();
    d.reset();
    expect(d.check()).toBeNull();
    d.noteCall("bash", { command: "ls" });
    expect(d.check()).toBeNull();
  });

  test("identical failing results 3+ times warns to change strategy", () => {
    const d = new LoopDetector(10, 20); // keep repeat thresholds out of the way
    for (let i = 0; i < 2; i++) {
      d.noteCall("bash", { command: `attempt${i}` });
      d.noteResult("bash", FAIL);
      expect(d.check()).toBeNull();
    }
    d.noteCall("bash", { command: "attempt2" });
    d.noteResult("bash", FAIL);
    const warn = d.check();
    expect(warn).not.toBeNull();
    expect(warn!.abort).toBe(false);
    expect(warn!.message).toContain("The same error keeps occurring");
    // Warned once; does not repeat next iteration.
    d.noteCall("bash", { command: "attempt3" });
    d.noteResult("bash", FAIL);
    expect(d.check()).toBeNull();
  });

  test("sliding-window cycling: A/B alternation warns once", () => {
    const d = new LoopDetector(3, 5);
    const sigs: Record<string, unknown>[] = [{ path: "a.ts" }, { path: "b.ts" }];
    let warned: { message: string; abort: boolean } | null = null;
    for (let i = 0; i < 12; i++) {
      d.noteCall("read", sigs[i % 2]!);
      d.noteResult("read", OK);
      const res = d.check();
      if (res) {
        expect(warned).toBeNull(); // fires at most once
        warned = res;
        expect(res.abort).toBe(false);
        expect(res.message).toContain("cycling");
      }
    }
    expect(warned).not.toBeNull();
  });

  test("empty turn: nudge first, give up on second consecutive", () => {
    const d = new LoopDetector(3, 5);
    expect(d.noteEmptyTurn()).toBe(true); // nudge
    expect(d.noteEmptyTurn()).toBe(false); // give up
  });

  test("a tool call breaks the empty-turn streak", () => {
    const d = new LoopDetector(3, 5);
    expect(d.noteEmptyTurn()).toBe(true);
    d.noteCall("bash", { command: "ls" });
    expect(d.noteEmptyTurn()).toBe(true); // streak restarted
  });
});

describe("stableStringify", () => {
  test("sorts keys recursively", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(stableStringify({ x: { d: [1, { z: 1, y: 2 }], c: "s" } })).toBe(
      stableStringify({ x: { c: "s", d: [1, { y: 2, z: 1 }] } }),
    );
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
  });
});
