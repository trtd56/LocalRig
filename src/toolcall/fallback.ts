// Parses tool calls that the model wrote as TEXT instead of native calls.
//
// Supported formats, in priority order:
//   1. <tool_call>{"name": ..., "arguments": {...}}</tool_call> blocks (Qwen).
//   2. Fenced ```json blocks containing a call-shaped object (or array of them).
//   3. A bare top-level JSON object (whole content, or the whole last line).
//
// Guards against false positives: names must look like identifiers, objects
// must have exactly the call shape (a few well-known extra keys tolerated),
// and JSON embedded in ordinary prose is never matched outside the
// recognized wrappers.

import type { ToolCall } from "../types.ts";

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Keys allowed on a call-shaped object beyond name/arguments. */
const TOLERATED_KEYS = new Set([
  "name",
  "arguments",
  "parameters",
  "args",
  "id",
  "type",
  "index",
  "function",
]);

const INNER_TOLERATED_KEYS = new Set(["name", "arguments", "parameters", "args", "description"]);

export function parseFallbackToolCalls(content: string): ToolCall[] {
  if (!content || !content.includes("{")) return [];

  // 1. Qwen <tool_call> blocks.
  const qwen = parseQwenBlocks(content);
  if (qwen.length > 0) return qwen;

  // 2. Fenced ```json blocks.
  const fenced = parseFencedBlocks(content);
  if (fenced.length > 0) return fenced;

  // 3. Bare top-level JSON object.
  return parseBareObject(content);
}

// ---------------------------------------------------------------------------
// Shape checking
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Convert a parsed JSON value into a ToolCall when it has exactly the call
 * shape. `requireArgsKey` demands an explicit arguments/parameters/args key
 * (used outside explicit <tool_call> wrappers to avoid matching prose JSON).
 */
function toToolCall(value: unknown, requireArgsKey: boolean): ToolCall | null {
  if (!isPlainObject(value)) return null;

  // OpenAI-style: {"id": ..., "type": "function", "function": {"name", "arguments"}}
  let callObj: Record<string, unknown> = value;
  let outerId: string | undefined;
  if (isPlainObject(value["function"])) {
    for (const key of Object.keys(value)) {
      if (!TOLERATED_KEYS.has(key)) return null;
    }
    if (typeof value["id"] === "string") outerId = value["id"];
    callObj = value["function"];
    for (const key of Object.keys(callObj)) {
      if (!INNER_TOLERATED_KEYS.has(key)) return null;
    }
  } else {
    for (const key of Object.keys(callObj)) {
      if (!TOLERATED_KEYS.has(key)) return null;
    }
  }

  const name = callObj["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;

  const argsValue = callObj["arguments"] ?? callObj["parameters"] ?? callObj["args"];
  const hasArgsKey = "arguments" in callObj || "parameters" in callObj || "args" in callObj;
  if (requireArgsKey && !hasArgsKey) return null;

  // arguments may be a plain object, a nested JSON string (validate.ts
  // repairs it), or absent (inside an explicit wrapper).
  let args: Record<string, unknown> | string;
  if (isPlainObject(argsValue)) args = argsValue;
  else if (typeof argsValue === "string") args = argsValue;
  else if (argsValue === undefined || argsValue === null) args = {};
  else return null; // arrays / scalars are not a call shape

  const call: ToolCall = { function: { name, arguments: args } };
  const id = outerId ?? (typeof callObj["id"] === "string" ? (callObj["id"] as string) : undefined);
  if (id !== undefined) call.id = id;
  return call;
}

/** Parse candidate JSON leniently: as-is, then outermost {...} block. */
function parseCandidate(text: string): unknown {
  const s = text.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    // Tolerate leading/trailing junk around the object.
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 1. Qwen <tool_call> blocks
// ---------------------------------------------------------------------------

function parseQwenBlocks(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const call = toToolCall(parseCandidate(m[1] ?? ""), false);
    if (call) calls.push(call);
    lastEnd = re.lastIndex;
  }
  // Tolerate a missing closing tag at the end of the string.
  const rest = content.slice(lastEnd);
  const openIdx = rest.indexOf("<tool_call>");
  if (openIdx !== -1) {
    const tail = rest.slice(openIdx + "<tool_call>".length);
    if (!tail.includes("<tool_call>")) {
      const call = toToolCall(parseCandidate(tail), false);
      if (call) calls.push(call);
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 2. Fenced ```json blocks
// ---------------------------------------------------------------------------

function parseFencedBlocks(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const body = (m[1] ?? "").trim();
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      // Array of call-shaped objects: all elements must match.
      const batch: ToolCall[] = [];
      for (const el of parsed) {
        const call = toToolCall(el, true);
        if (!call) {
          batch.length = 0;
          break;
        }
        batch.push(call);
      }
      calls.push(...batch);
    } else {
      const call = toToolCall(parsed, true);
      if (call) calls.push(call);
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// 3. Bare top-level JSON object
// ---------------------------------------------------------------------------

function parseBareObject(content: string): ToolCall[] {
  const trimmed = content.trim();

  // Whole content is the JSON object.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const call = toToolCall(JSON.parse(trimmed), true);
      if (call) return [call];
    } catch {
      // fall through to last-line check
    }
  }

  // The JSON object is the whole last (non-empty) line.
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const call = toToolCall(JSON.parse(line), true);
        if (call) return [call];
      } catch {
        return [];
      }
    }
    return []; // last non-empty line is prose — never scan inside it
  }
  return [];
}
