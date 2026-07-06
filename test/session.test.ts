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
  saveSession,
  type SessionRecord,
} from "../src/session.ts";

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
      { kind: "(untagged)", graded: 1, pass: 1, fail: 0, avgDurationMs: 20_000 },
      { kind: "rename", graded: 2, pass: 1, fail: 1, avgDurationMs: 20_000 },
    ]);
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

  test("defaults", async () => {
    const { parseArgs } = await import("../src/index.ts");
    const opts = parseArgs([]);
    expect(opts.prompt).toBeUndefined();
    expect(opts.json).toBe(false);
    expect(opts.permissionModeSet).toBe(false);
  });
});
