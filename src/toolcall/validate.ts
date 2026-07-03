// Tool-call validation and repair for a local model that emits malformed
// calls: wrong tool names, stringified/double-encoded JSON args, wrong arg
// key names, wrong types. Resolution never throws — it either produces a
// runnable (tool, args) pair or an actionable problem string the model can
// use to self-repair on the next turn.

import type { JsonSchema, ToolCall, ToolDef } from "../types.ts";

export type ResolvedCall =
  | { ok: true; tool: ToolDef; args: Record<string, unknown> }
  | { ok: false; name: string; problem: string };

/**
 * Resolve a (possibly malformed) tool call against the registry.
 * `maxRepairAttempts` is currently informational — the error text always
 * includes a valid example so the model can self-repair.
 */
export function resolveToolCall(
  call: ToolCall,
  tools: ToolDef[],
  _maxRepairAttempts: number,
): ResolvedCall {
  const rawName = call.function?.name ?? "";

  // ---- 1. Tool name ----
  const tool = resolveToolName(rawName, tools);
  if (!tool) {
    const available = tools.map((t) => t.name).join(", ");
    return {
      ok: false,
      name: rawName,
      problem: `Unknown tool "${rawName}". Available tools: ${available}.`,
    };
  }

  // ---- 2. Arguments to object ----
  const rawArgs = call.function?.arguments;
  const parsed = argsToObject(rawArgs);
  if (parsed === null) {
    const received =
      typeof rawArgs === "string" ? rawArgs.slice(0, 160) : JSON.stringify(rawArgs)?.slice(0, 160);
    return {
      ok: false,
      name: tool.name,
      problem:
        `Invalid arguments for "${tool.name}": arguments could not be parsed as a JSON object. ` +
        `Received: ${received}. Expected: ${buildExample(tool)}. Retry with corrected arguments.`,
    };
  }

  // ---- 3. Key normalization ----
  const { args, dropped } = normalizeKeys(parsed, tool);

  // ---- 4. Type coercion ----
  const props = tool.parameters.properties ?? {};
  for (const key of Object.keys(args)) {
    args[key] = coerceValue(args[key], props[key]);
  }

  // ---- 5. Required check ----
  const required = tool.parameters.required ?? [];
  const missing = required.filter((r) => !(r in args) || args[r] === undefined);
  if (missing.length > 0) {
    const missingList = missing.map((m) => `"${m}"`).join(", ");
    const receivedKeys = `[${Object.keys(args).join(", ")}]`;
    const droppedNote =
      dropped.length > 0 ? ` Dropped unknown keys: [${dropped.join(", ")}].` : "";
    return {
      ok: false,
      name: tool.name,
      problem:
        `Invalid arguments for "${tool.name}": missing required ${missingList}. ` +
        `Received keys: ${receivedKeys}.${droppedNote} ` +
        `Expected: ${buildExample(tool)}. Retry with corrected arguments.`,
    };
  }

  return { ok: true, tool, args };
}

// ---------------------------------------------------------------------------
// Tool-name resolution
// ---------------------------------------------------------------------------

/** Alias → canonical tool name. Keys are normalized (lowercase, [a-z0-9] only). */
const TOOL_ALIASES: Record<string, string> = {
  // read
  readfile: "read",
  cat: "read",
  view: "read",
  openfile: "read",
  // write
  writefile: "write",
  createfile: "write",
  save: "write",
  create: "write",
  // edit
  strreplace: "edit",
  replace: "edit",
  strreplaceeditor: "edit",
  editfile: "edit",
  modify: "edit",
  // bash
  run: "bash",
  shell: "bash",
  execute: "bash",
  executecommand: "bash",
  runcommand: "bash",
  terminal: "bash",
  cmd: "bash",
  // grep
  search: "grep",
  rg: "grep",
  ripgrep: "grep",
  findinfiles: "grep",
  searchfiles: "grep",
  // glob
  find: "glob",
  ls: "glob",
  list: "glob",
  listfiles: "glob",
  listdir: "glob",
  findfiles: "glob",
  // todo
  todowrite: "todo",
  updatetodo: "todo",
  task: "todo",
  tasks: "todo",
  plan: "todo",
};

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveToolName(raw: string, tools: ToolDef[]): ToolDef | null {
  if (!raw) return null;

  // Exact match.
  for (const t of tools) if (t.name === raw) return t;

  // Case-insensitive.
  const lower = raw.toLowerCase();
  for (const t of tools) if (t.name.toLowerCase() === lower) return t;

  // Normalized (strip non-alphanumerics).
  const norm = normalizeName(raw);
  if (norm) {
    for (const t of tools) if (normalizeName(t.name) === norm) return t;

    // Alias table.
    const canonical = TOOL_ALIASES[norm];
    if (canonical) {
      for (const t of tools) if (t.name === canonical) return t;
    }
  }

  // Levenshtein distance <= 2 against real names.
  let best: ToolDef | null = null;
  let bestDist = 3;
  for (const t of tools) {
    const d = levenshtein(lower, t.name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[n] ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Arguments → object (with textual JSON repair)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Returns the args object, or null when parsing is impossible. */
function argsToObject(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return isPlainObject(raw) ? raw : null;

  let s = raw.trim();
  if (s === "") return {};

  // Repairs applied cumulatively; retry parse after each step.
  const repairs: ((x: string) => string)[] = [
    (x) => x,
    stripCodeFences,
    repairSingleQuotes,
    stripTrailingCommas,
    extractBraceBlock,
  ];
  for (const repair of repairs) {
    s = repair(s);
    const attempt = tryParse(s);
    if (!attempt.ok) continue;
    let value = attempt.value;
    // Double-encoded JSON: unwrap once.
    if (typeof value === "string") {
      const inner = tryParse(value.trim());
      if (inner.ok) value = inner.value;
    }
    if (isPlainObject(value)) return value;
    // Parsed to something that is not an object (number, array, plain
    // string, ...). Further textual repairs will not change that.
    return null;
  }
  return null;
}

/** Strip a markdown code fence wrapping the whole string. */
function stripCodeFences(s: string): string {
  const m = s.match(/^```[a-zA-Z0-9]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  return m?.[1] !== undefined ? m[1].trim() : s;
}

/**
 * Convert single-quoted keys/strings to double-quoted (best effort). An
 * apostrophe inside a single-quoted string is kept literal when the quote is
 * not followed by a structural character (, : } ] or end).
 */
function repairSingleQuotes(s: string): string {
  if (!s.includes("'")) return s;
  let out = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inDouble) {
      out += c;
      if (c === "\\") {
        i++;
        if (i < s.length) out += s[i] as string;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "\\" && s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      if (c === "\\") {
        out += c;
        i++;
        if (i < s.length) out += s[i] as string;
        continue;
      }
      if (c === '"') {
        out += '\\"';
        continue;
      }
      if (c === "'") {
        const rest = s.slice(i + 1);
        const closes = rest.length === 0 || /^\s*[,:}\]]/.test(rest) || /^\s*$/.test(rest);
        if (closes) {
          out += '"';
          inSingle = false;
        } else {
          out += "'"; // literal apostrophe (e.g. "it's")
        }
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += '"';
      continue;
    }
    out += c;
  }
  return out;
}

/** Remove trailing commas before } or ] (string-unaware; best effort). */
function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

/** Extract the outermost {...} block. */
function extractBraceBlock(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) return s.slice(start, end + 1);
  return s;
}

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

/** Alias → canonical parameter name. Keys are normalized. */
const KEY_ALIASES: Record<string, string> = {
  // path
  filepath: "path",
  filename: "path",
  file: "path",
  targetfile: "path",
  absolutepath: "path",
  // command
  cmd: "command",
  script: "command",
  shellcommand: "command",
  commandline: "command",
  // content
  text: "content",
  contents: "content",
  body: "content",
  data: "content",
  filetext: "content",
  newcontent: "content",
  // old_string
  oldstr: "old_string",
  original: "old_string",
  search: "old_string",
  find: "old_string",
  // new_string
  newstr: "new_string",
  replacement: "new_string",
  // pattern
  query: "pattern",
  regex: "pattern",
  searchpattern: "pattern",
  // offset
  startline: "offset",
  start: "offset",
  // limit
  numlines: "limit",
  maxlines: "limit",
  count: "limit",
  // replace_all
  recursive: "replace_all",
  all: "replace_all",
  // items
  todos: "items",
  list: "items",
  tasks: "items",
};

function normalizeKeys(
  input: Record<string, unknown>,
  tool: ToolDef,
): { args: Record<string, unknown>; dropped: string[] } {
  const props = tool.parameters.properties ?? {};
  const propNames = Object.keys(props);
  const byNorm = new Map<string, string>();
  for (const p of propNames) byNorm.set(normalizeName(p), p);

  const args: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    let target: string | undefined;

    // Exact property name.
    if (key in props) {
      target = key;
    } else {
      // Case/snake/camel-insensitive match.
      const norm = normalizeName(key);
      target = byNorm.get(norm);
      // Alias map (only if the canonical name exists on this tool's schema).
      if (!target) {
        const canonical = KEY_ALIASES[norm];
        if (canonical) target = byNorm.get(normalizeName(canonical));
      }
    }

    if (target === undefined || target in args) {
      dropped.push(key);
      continue;
    }
    args[target] = value;
  }
  return { args, dropped };
}

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

function coerceValue(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || !schema.type) return value;
  switch (schema.type) {
    case "number":
    case "integer": {
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      return value;
    }
    case "boolean": {
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
      }
      return value;
    }
    case "string": {
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;
    }
    case "array": {
      let arr: unknown[];
      if (Array.isArray(value)) arr = value;
      else if (isPlainObject(value)) arr = [value]; // single object → [object]
      else return value;
      // Todo-style items: array of strings → [{content, status: "pending"}].
      const itemSchema = schema.items;
      if (itemSchema?.type === "object" && itemSchema.properties && "content" in itemSchema.properties) {
        const hasStatus = "status" in itemSchema.properties;
        arr = arr.map((el) =>
          typeof el === "string"
            ? hasStatus
              ? { content: el, status: "pending" }
              : { content: el }
            : el,
        );
      }
      return arr;
    }
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Example builder (for self-repair error messages)
// ---------------------------------------------------------------------------

const STRING_PLACEHOLDERS: Record<string, string> = {
  path: "src/a.ts",
  oldstring: "exact text from the file",
  newstring: "replacement text",
  command: "ls -la",
  pattern: "TODO",
  content: "file contents",
};

function placeholderFor(name: string, schema: JsonSchema | undefined, depth = 0): unknown {
  if (schema?.enum && schema.enum.length > 0) return schema.enum[0];
  const type = schema?.type ?? "string";
  switch (type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "array": {
      if (depth > 3) return [];
      return [placeholderFor(name, schema?.items, depth + 1)];
    }
    case "object": {
      if (depth > 3) return {};
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema?.properties ?? {})) {
        obj[k] = placeholderFor(k, v, depth + 1);
      }
      return obj;
    }
    default: {
      const known = STRING_PLACEHOLDERS[normalizeName(name)];
      if (known) return known;
      const desc = schema?.description;
      if (desc) return desc.length > 48 ? desc.slice(0, 45) + "..." : desc;
      return `<${name}>`;
    }
  }
}

/** Compact JSON example of a valid call for this tool, built from its schema. */
function buildExample(tool: ToolDef): string {
  const props = tool.parameters.properties ?? {};
  const required = tool.parameters.required ?? [];
  const keys = required.length > 0 ? required : Object.keys(props);
  const example: Record<string, unknown> = {};
  for (const k of keys) {
    example[k] = placeholderFor(k, props[k]);
  }
  return JSON.stringify(example);
}
