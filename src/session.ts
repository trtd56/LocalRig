// Persistent store for one-shot sessions and caller feedback. This is what
// lets an orchestrating agent (Claude Code / Codex) grade a delegated run
// after verifying it, and lets `lh stats` report how delegation is going.
//
// Layout under $LH_HOME (default ~/.localrig):
//   sessions/<id>.json   one record per one-shot run, full transcript included
//   feedback.jsonl       append-only verdicts keyed by session id

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMessage, ErrorKind, RunStatus } from "./types.ts";

export interface SessionTokens {
  /** Prompt tokens of the final turn (context size at completion). */
  prompt: number;
  /** Total completion tokens generated across all turns. */
  completion: number;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  prompt: string;
  status: RunStatus;
  result: string;
  error?: string;
  /** Coarse cause bucket for `error`, e.g. for retry/triage logic. Unset when error is unset. */
  errorKind?: ErrorKind;
  durationMs: number;
  turns: number;
  toolCalls: number;
  tokens: SessionTokens;
  /** Full message transcript for post-hoc debugging. */
  messages?: readonly ChatMessage[];
}

export interface FeedbackRecord {
  sessionId: string;
  verdict: "pass" | "fail";
  notes?: string;
  /** Who graded it, e.g. "claude-code", "codex", "human". */
  source?: string;
  createdAt: string;
}

export function dataDir(): string {
  return process.env.LH_HOME ?? path.join(os.homedir(), ".localrig");
}

const sessionsDir = () => path.join(dataDir(), "sessions");
const feedbackFile = () => path.join(dataDir(), "feedback.jsonl");

export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function saveSession(record: SessionRecord): string {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const file = path.join(sessionsDir(), `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

export function loadSession(id: string): SessionRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Session ids sorted oldest → newest (ids start with a timestamp). */
export function listSessionIds(): string[] {
  try {
    return fs
      .readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

export function latestSessionId(): string | null {
  const ids = listSessionIds();
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

export function appendFeedback(fb: FeedbackRecord): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(feedbackFile(), JSON.stringify(fb) + "\n");
}

export function readFeedback(): FeedbackRecord[] {
  try {
    return fs
      .readFileSync(feedbackFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export interface Stats {
  sessions: number;
  graded: number;
  pass: number;
  fail: number;
  recentFailures: FeedbackRecord[];
}

/** Aggregate pass/fail over all recorded feedback (re-grades: last one wins). */
export function computeStats(): Stats {
  const byId = new Map<string, FeedbackRecord>();
  for (const fb of readFeedback()) byId.set(fb.sessionId, fb);
  const graded = [...byId.values()];
  const pass = graded.filter((f) => f.verdict === "pass").length;
  const failures = graded.filter((f) => f.verdict === "fail").slice(-5);
  return {
    sessions: listSessionIds().length,
    graded: graded.length,
    pass,
    fail: graded.length - pass,
    recentFailures: failures,
  };
}
