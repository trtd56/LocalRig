#!/usr/bin/env node
// Claude Code PreToolUse hook: ask before reading a large file wholesale, and
// suggest `lh distill` instead. This is intentionally advisory (`ask`), not a
// hard block, because a human or upstream agent may need the raw file.

import fs from "node:fs";
import path from "node:path";

const MIN_BYTES = Number(process.env.LH_DISTILL_HOOK_MIN_BYTES ?? 64 * 1024);
const MIN_LINES = Number(process.env.LH_DISTILL_HOOK_MIN_LINES ?? 1000);
const PRECISE_READ_MAX_LINES = Number(process.env.LH_DISTILL_HOOK_PRECISE_LINES ?? 220);

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function allow() {
  process.exit(0);
}

function decision(permissionDecision, permissionDecisionReason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    }),
  );
  process.exit(0);
}

function isPreciseRead(input) {
  const offset = Number(input.offset);
  const limit = Number(input.limit);
  return Number.isFinite(offset) && Number.isFinite(limit) && limit > 0 && limit <= PRECISE_READ_MAX_LINES;
}

let event;
try {
  event = JSON.parse(readStdin());
} catch {
  allow();
}

if (event?.hook_event_name !== "PreToolUse" || event?.tool_name !== "Read") allow();
const input = event.tool_input ?? {};
if (typeof input.file_path !== "string" || input.file_path.trim() === "") allow();
if (isPreciseRead(input)) allow();

const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
const file = path.isAbsolute(input.file_path) ? input.file_path : path.resolve(cwd, input.file_path);

let stat;
try {
  stat = fs.statSync(file);
} catch {
  allow();
}
if (!stat.isFile()) allow();

let lineCount = 0;
try {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
    for (let i = 0; i < bytesRead; i++) {
      if (chunk[i] === 10) lineCount++;
      if (lineCount >= MIN_LINES) break;
    }
    if (lineCount >= MIN_LINES) break;
  }
  fs.closeSync(fd);
} catch {
  allow();
}

if (stat.size < MIN_BYTES && lineCount < MIN_LINES) allow();

const rel = path.relative(cwd, file) || file;
const lineLabel = lineCount >= MIN_LINES ? `>=${lineCount}` : `${lineCount}`;
decision(
  "ask",
  `Large Read target (${rel}, ${stat.size} bytes, ${lineLabel} lines). Prefer \`lh distill -q "<specific question>" ${JSON.stringify(rel)} --json\` unless you need a precise cited range. Offset/limit reads of <=${PRECISE_READ_MAX_LINES} lines are allowed.`,
);
