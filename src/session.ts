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
import type { ChatMessage, ErrorKind, RunReport, RunStatus } from "./types.ts";

export interface CheckRecord {
  command: string;
  exit_code: number | null;
  attempts: number;
  output_tail: string;
  timed_out?: boolean;
}

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
  kind?: string;
  status: RunStatus;
  result: string;
  error?: string;
  /** Coarse cause bucket for `error`, e.g. for retry/triage logic. Unset when error is unset. */
  errorKind?: ErrorKind;
  durationMs: number;
  turns: number;
  toolCalls: number;
  tokens: SessionTokens;
  check?: CheckRecord;
  report?: RunReport;
  /** Detached worker pid for `lh submit` sessions while status is running. */
  pid?: number;
  /** Full message transcript for post-hoc debugging. */
  messages?: readonly ChatMessage[];
  /** For sessions started with `--resume`: the id of the session whose saved
   *  transcript was restored to seed this one. */
  resumedFrom?: string;
}

export interface FeedbackRecord {
  sessionId: string;
  verdict: "pass" | "fail";
  kind?: string;
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

/** Raised when a `--resume` target can't be replayed. `kind` maps to the
 *  ErrorKind bucket so a caller can branch without parsing the message. */
export class ResumeError extends Error {
  readonly kind: ErrorKind = "config";
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

/**
 * Rebuild the message transcript for `lh --resume` from a saved session. Pure:
 * the caller does the I/O of loading `record` (pass the id too, only for error
 * messages). Throws ResumeError with a clear, config-kind message when the id
 * is unknown or the record carries no replayable transcript.
 *
 * _seq is re-stamped densely (0..n-1) so the agent's counter can resume past
 * the restored messages without colliding: compaction mints _seq in the
 * billions, so seeding from a naive max would strand the counter up there.
 * Messages are shallow-copied so mutations by the resumed run don't touch the
 * caller's record.
 */
export function restoreTranscript(id: string, record: SessionRecord | null): ChatMessage[] {
  if (!record) {
    throw new ResumeError(`unknown session: ${id} (see \`lh sessions\`)`);
  }
  const messages = record.messages;
  if (!messages || messages.length === 0) {
    throw new ResumeError(`session ${id} has no saved transcript to resume`);
  }
  if (messages[0]!.role !== "system") {
    throw new ResumeError(`session ${id} transcript does not start with a system prompt`);
  }
  return messages.map((m, i) => ({ ...m, _seq: i }));
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
  /** Pass rate as an integer percentage (0-100), or null when nothing is graded.
   *  Lets a caller read "is fail the majority for this kind" straight from JSON. */
  rate: number | null;
  recentFailures: FeedbackRecord[];
  byKind?: KindStats[];
}

export interface KindStats {
  kind: string;
  graded: number;
  pass: number;
  fail: number;
  /** Pass rate as an integer percentage (0-100), or null when graded is 0. */
  rate: number | null;
  avgDurationMs: number;
}

/** Pass rate as an integer percentage, or null when there is nothing graded. */
function passRate(pass: number, graded: number): number | null {
  return graded > 0 ? Math.round((100 * pass) / graded) : null;
}

/** Aggregate pass/fail over all recorded feedback (re-grades: last one wins). */
export function computeStats(options: { byKind?: boolean } = {}): Stats {
  const byId = new Map<string, FeedbackRecord>();
  for (const fb of readFeedback()) byId.set(fb.sessionId, fb);
  const graded = [...byId.values()];
  const pass = graded.filter((f) => f.verdict === "pass").length;
  const failures = graded.filter((f) => f.verdict === "fail").slice(-5);
  const stats: Stats = {
    sessions: listSessionIds().length,
    graded: graded.length,
    pass,
    fail: graded.length - pass,
    rate: passRate(pass, graded.length),
    recentFailures: failures,
  };
  if (options.byKind) stats.byKind = computeKindStats(graded);
  return stats;
}

function computeKindStats(graded: FeedbackRecord[]): KindStats[] {
  const buckets = new Map<string, { graded: number; pass: number; fail: number; durationMs: number }>();
  for (const fb of graded) {
    const session = loadSession(fb.sessionId);
    const kind = fb.kind ?? session?.kind ?? "(untagged)";
    const cur = buckets.get(kind) ?? { graded: 0, pass: 0, fail: 0, durationMs: 0 };
    cur.graded++;
    if (fb.verdict === "pass") cur.pass++;
    else cur.fail++;
    cur.durationMs += session?.durationMs ?? 0;
    buckets.set(kind, cur);
  }
  return [...buckets.entries()]
    .map(([kind, s]) => ({
      kind,
      graded: s.graded,
      pass: s.pass,
      fail: s.fail,
      rate: passRate(s.pass, s.graded),
      avgDurationMs: s.graded > 0 ? Math.round(s.durationMs / s.graded) : 0,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
