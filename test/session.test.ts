import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendFeedback,
  computeStats,
  dataDir,
  latestSessionId,
  listSessionIds,
  loadSession,
  newSessionId,
  readFeedback,
  restoreTranscript,
  ResumeError,
  saveSession,
  type SessionRecord,
} from "../src/session.ts";
import type { ChatMessage } from "../src/types.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-test-"));
  process.env.LH_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.LH_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    createdAt: "2026-07-03T10:00:00.000Z",
    cwd: "/tmp/project",
    model: "qwen36-27b-mtp:latest",
    prompt: "fix the bug",
    status: "ok",
    result: "done",
    durationMs: 12345,
    turns: 3,
    toolCalls: 5,
    tokens: { prompt: 1000, completion: 200 },
    ...overrides,
  };
}

describe("dataDir", () => {
  test("honors LH_HOME", () => {
    expect(dataDir()).toBe(tmpHome);
  });
});

describe("newSessionId", () => {
  test("is timestamp-prefixed and sortable", () => {
    const a = newSessionId(new Date(2026, 6, 3, 9, 5, 1));
    const b = newSessionId(new Date(2026, 6, 3, 10, 0, 0));
    expect(a).toMatch(/^20260703-090501-[a-z0-9]{4}$/);
    expect(a < b).toBe(true);
  });
});

describe("session store", () => {
  test("save/load roundtrip", () => {
    const rec = makeRecord("20260703-100000-aaaa");
    saveSession(rec);
    expect(loadSession(rec.id)).toEqual(rec);
  });

  test("loadSession returns null for unknown id", () => {
    expect(loadSession("nope")).toBeNull();
  });

  test("resumedFrom survives the save/load roundtrip", () => {
    const rec = makeRecord("20260703-120000-cccc", { resumedFrom: "20260703-100000-aaaa" });
    saveSession(rec);
    expect(loadSession(rec.id)!.resumedFrom).toBe("20260703-100000-aaaa");
  });

  test("listSessionIds sorts oldest first; latestSessionId picks newest", () => {
    saveSession(makeRecord("20260703-110000-bbbb"));
    saveSession(makeRecord("20260703-100000-aaaa"));
    expect(listSessionIds()).toEqual(["20260703-100000-aaaa", "20260703-110000-bbbb"]);
    expect(latestSessionId()).toBe("20260703-110000-bbbb");
  });

  test("empty store", () => {
    expect(listSessionIds()).toEqual([]);
    expect(latestSessionId()).toBeNull();
  });
});

describe("restoreTranscript", () => {
  const transcript: ChatMessage[] = [
    { role: "system", content: "you are an agent", _seq: 0 },
    { role: "user", content: "create hello.txt", _seq: 1 },
    { role: "assistant", content: "", _seq: 2, tool_calls: [{ function: { name: "write", arguments: { path: "hello.txt" } } }] },
    { role: "tool", content: "wrote hello.txt", tool_name: "write", _seq: 3 },
    { role: "assistant", content: "done", _seq: 4 },
  ];

  test("returns the saved messages, preserving roles and content", () => {
    const rec = makeRecord("s1", { messages: transcript });
    const out = restoreTranscript("s1", rec);
    expect(out).toHaveLength(5);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(out[4]!.content).toBe("done");
    expect(out[2]!.tool_calls).toEqual(transcript[2]!.tool_calls!);
  });

  test("re-stamps _seq densely so the agent counter can continue past it", () => {
    const withCompactionSeq: ChatMessage[] = [
      { role: "system", content: "sys", _seq: 0 },
      { role: "user", content: "hi", _seq: 1_000_000_005 }, // compaction-minted seq
      { role: "assistant", content: "ok", _seq: 1_000_000_006 },
    ];
    const out = restoreTranscript("s1", makeRecord("s1", { messages: withCompactionSeq }));
    expect(out.map((m) => m._seq)).toEqual([0, 1, 2]);
  });

  test("does not mutate the caller's record (shallow copy)", () => {
    const rec = makeRecord("s1", { messages: transcript });
    const out = restoreTranscript("s1", rec);
    out[1]!.content = "mutated";
    out[1]!._seq = 999;
    expect(transcript[1]!.content).toBe("create hello.txt");
    expect(transcript[1]!._seq).toBe(1);
  });

  test("throws a config-kind ResumeError for an unknown session", () => {
    let caught: unknown;
    try {
      restoreTranscript("nope", null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResumeError);
    expect((caught as ResumeError).kind).toBe("config");
    expect((caught as Error).message).toContain("unknown session: nope");
  });

  test("throws when the record has no transcript", () => {
    expect(() => restoreTranscript("s1", makeRecord("s1"))).toThrow(ResumeError);
    expect(() => restoreTranscript("s1", makeRecord("s1", { messages: [] }))).toThrow(/no saved transcript/);
  });

  test("throws when the transcript does not start with a system prompt", () => {
    const bad = makeRecord("s1", { messages: [{ role: "user", content: "hi" }] });
    expect(() => restoreTranscript("s1", bad)).toThrow(/system prompt/);
  });
});

describe("feedback", () => {
  test("append and read back", () => {
    appendFeedback({ sessionId: "s1", verdict: "pass", source: "claude-code", createdAt: "2026-07-03T10:01:00Z" });
    appendFeedback({ sessionId: "s2", verdict: "fail", notes: "tests broke", createdAt: "2026-07-03T10:02:00Z" });
    const all = readFeedback();
    expect(all).toHaveLength(2);
    expect(all[1]!.notes).toBe("tests broke");
  });

  test("stats aggregates with last-verdict-wins on re-grade", () => {
    saveSession(makeRecord("s1"));
    saveSession(makeRecord("s2"));
    saveSession(makeRecord("s3"));
    appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" });
    appendFeedback({ sessionId: "s2", verdict: "fail", notes: "wrong file", createdAt: "t" });
    appendFeedback({ sessionId: "s2", verdict: "pass", createdAt: "t" }); // re-graded after retry
    const stats = computeStats();
    expect(stats.sessions).toBe(3);
    expect(stats.graded).toBe(2);
    expect(stats.pass).toBe(2);
    expect(stats.fail).toBe(0);
    expect(stats.recentFailures).toEqual([]);
  });

  test("stats surfaces recent failures with notes", () => {
    appendFeedback({ sessionId: "s1", verdict: "fail", notes: "hallucinated API", createdAt: "t" });
    const stats = computeStats();
    expect(stats.fail).toBe(1);
    expect(stats.recentFailures[0]!.notes).toBe("hallucinated API");
  });

  test("stats aggregates feedback by kind", () => {
    saveSession(makeRecord("s1", { kind: "rename", durationMs: 10_000 }));
    saveSession(makeRecord("s2", { kind: "rename", durationMs: 30_000 }));
    saveSession(makeRecord("s3", { durationMs: 20_000 }));
    appendFeedback({ sessionId: "s1", verdict: "pass", kind: "rename", createdAt: "t" });
    appendFeedback({ sessionId: "s2", verdict: "fail", kind: "rename", createdAt: "t" });
    appendFeedback({ sessionId: "s3", verdict: "pass", createdAt: "t" });
    const stats = computeStats({ byKind: true });
    expect(stats.byKind).toEqual([
      { kind: "(untagged)", graded: 1, pass: 1, fail: 0, rate: 100, avgDurationMs: 20_000 },
      { kind: "rename", graded: 2, pass: 1, fail: 1, rate: 50, avgDurationMs: 20_000 },
    ]);
  });

  test("stats reports pass rate as a percentage, null when nothing graded", () => {
    expect(computeStats().rate).toBeNull();
    for (const id of ["s1", "s2", "s3", "s4"]) saveSession(makeRecord(id));
    appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" });
    appendFeedback({ sessionId: "s2", verdict: "pass", createdAt: "t" });
    appendFeedback({ sessionId: "s3", verdict: "pass", createdAt: "t" });
    appendFeedback({ sessionId: "s4", verdict: "fail", createdAt: "t" });
    expect(computeStats().rate).toBe(75);
  });

  test("by-kind rate lets a caller gate delegation on fail-majority (n>=3)", () => {
    // doc-tweak: fail 3 / graded 4 → rate 25 (should NOT delegate)
    // rename:    pass 3 / graded 3 → rate 100 (safe to delegate)
    const docVerdicts: Array<"pass" | "fail"> = ["fail", "fail", "fail", "pass"];
    docVerdicts.forEach((verdict, i) => {
      const id = `d${i}`;
      saveSession(makeRecord(id, { kind: "doc-tweak" }));
      appendFeedback({ sessionId: id, verdict, kind: "doc-tweak", createdAt: "t" });
    });
    for (const i of [0, 1, 2]) {
      const id = `r${i}`;
      saveSession(makeRecord(id, { kind: "rename" }));
      appendFeedback({ sessionId: id, verdict: "pass", kind: "rename", createdAt: "t" });
    }

    const byKind = computeStats({ byKind: true }).byKind!;
    const doc = byKind.find((k) => k.kind === "doc-tweak")!;
    const rename = byKind.find((k) => k.kind === "rename")!;
    expect(doc.graded).toBe(4);
    expect(doc.rate).toBe(25);
    expect(rename.rate).toBe(100);

    // The mechanical gate the SKILL/AGENTS guidance describes: skip a kind once
    // it has enough signal (graded >= 3) and fail is the majority (rate < 50).
    const skipDelegation = (k: typeof doc) => k.graded >= 3 && k.rate !== null && k.rate < 50;
    expect(skipDelegation(doc)).toBe(true);
    expect(skipDelegation(rename)).toBe(false);
  });
});

describe("cli parseArgs", () => {
  test("one-shot flags", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs(["-p", "do it", "--json", "--cwd", "/tmp/x", "--max-iterations", "10", "--auto"]);
    expect(opts.prompt).toBe("do it");
    expect(opts.json).toBe(true);
    expect(opts.cwd).toBe("/tmp/x");
    expect(opts.config.maxIterations).toBe(10);
    expect(opts.config.permissionMode).toBe("auto");
    expect(opts.permissionModeSet).toBe(true);
  });

  test("check and kind flags", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs(["-p", "do it", "--check", "bun test", "--check-retries", "3", "--kind", "tests"]);
    expect(opts.checkCommand).toBe("bun test");
    expect(opts.checkRetries).toBe(3);
    expect(opts.kind).toBe("tests");
  });

  test("resume flag", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs(["-p", "fix the typo", "--resume", "20260101-000000-abcd", "--json"]);
    expect(opts.prompt).toBe("fix the typo");
    expect(opts.resumeFrom).toBe("20260101-000000-abcd");
    expect(opts.json).toBe(true);
  });

  test("defaults", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs([]);
    expect(opts.prompt).toBeUndefined();
    expect(opts.json).toBe(false);
    expect(opts.permissionModeSet).toBe(false);
  });
});
