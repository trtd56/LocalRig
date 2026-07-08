import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
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
  runtimeMetricDimensions,
  saveSession,
  evaluateKindGate,
  FEEDBACK_SCHEMA_VERSION,
  InvalidSessionIdError,
  isValidSessionId,
  SESSION_SCHEMA_VERSION,
  SessionStoreError,
  successLowerBound,
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

describe("runtime metric dimensions", () => {
  test("records explicit CLI provenance, env fallbacks, stable detection, and version metadata", () => {
    const explicit = runtimeMetricDimensions({
      model: "qwen",
      hardware: "m4-max-64gb",
      caller: "codex",
      integrationVersion: "2.3.4",
      env: {},
    });
    expect(explicit).toMatchObject({
      model: "qwen",
      hardware: "m4-max-64gb",
      hardwareSource: "cli",
      caller: "codex",
      callerSource: "cli",
      integrationVersion: "2.3.4",
      integrationVersionSource: "cli",
      localrigVersion: "0.1.0",
    });

    const fromEnv = runtimeMetricDimensions({
      model: "qwen",
      env: { LH_HARDWARE: "env-hardware", LH_CALLER: "claude-code", LH_INTEGRATION_VERSION: "9.0" },
    });
    expect(fromEnv).toMatchObject({
      hardware: "env-hardware",
      hardwareSource: "env",
      caller: "claude-code",
      callerSource: "env",
      integrationVersion: "9.0",
      integrationVersionSource: "env",
    });

    const detectedA = runtimeMetricDimensions({ model: "qwen", env: {} });
    const detectedB = runtimeMetricDimensions({ model: "qwen", env: {} });
    expect(detectedA.hardware ?? detectedA.hardwareUnavailableReason).toBeTruthy();
    expect(detectedB.hardware ?? detectedB.hardwareUnavailableReason).toBe(
      detectedA.hardware ?? detectedA.hardwareUnavailableReason,
    );
    expect(detectedA.callerUnavailableReason).toContain("LH_CALLER");
    expect(detectedA.integrationVersionUnavailableReason).toContain("LH_INTEGRATION_VERSION");
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
    const file = saveSession(rec);
    expect(loadSession(rec.id)).toMatchObject({
      ...rec,
      schemaVersion: SESSION_SCHEMA_VERSION,
      generation: 1,
      durations: { total_ms: 12345 },
      tokens: {
        prompt: 1000,
        completion: 200,
        prompt_last: 1000,
        prompt_total: 1000,
        completion_total: 200,
      },
      dimensions: { model: rec.model },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("loadSession returns null for unknown id", () => {
    expect(loadSession("nope")).toBeNull();
  });

  test("resumedFrom survives the save/load roundtrip", () => {
    const rec = makeRecord("20260703-120000-cccc", { resumedFrom: "20260703-100000-aaaa" });
    saveSession(rec);
    expect(loadSession(rec.id)!.resumedFrom).toBe("20260703-100000-aaaa");
  });

  test("isolation metadata survives roundtrip and malformed paths/hashes/statuses are corrupt", () => {
    const rec = makeRecord("isolated", {
      isolation: {
        mode: "worktree",
        source_cwd: "/tmp/project",
        workspace_id: "isolated",
        baseline_commit: "a".repeat(40),
        baseline_tree: "b".repeat(40),
        patch_path: "/tmp/private/changes.patch",
        patch_sha256: "c".repeat(64),
        apply_status: "retained",
        cleanup_status: "removed",
        worktree_path: "/tmp/private/worktree",
      },
    });
    saveSession(rec);
    expect(loadSession(rec.id)?.isolation).toEqual(rec.isolation);

    const dir = path.join(tmpHome, "sessions");
    for (const [id, isolation] of [
      ["bad-path", { ...rec.isolation, patch_path: "relative.patch" }],
      ["bad-hash", { ...rec.isolation, patch_sha256: "not-a-hash" }],
      ["bad-status", { ...rec.isolation, apply_status: "maybe" }],
    ] as const) {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(makeRecord(id, {
        isolation: isolation as unknown as SessionRecord["isolation"],
      })));
      expect(() => loadSession(id)).toThrow(SessionStoreError);
    }
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

  test("rejects traversal ids at every persistence entrance", () => {
    expect(() => loadSession("../outside")).toThrow(InvalidSessionIdError);
    expect(() => saveSession(makeRecord("../outside"))).toThrow(InvalidSessionIdError);
    expect(() => appendFeedback({ sessionId: "../outside", verdict: "pass", createdAt: "t" })).toThrow(
      InvalidSessionIdError,
    );
  });

  test("keeps safe compatibility with legacy ids containing single dots", () => {
    expect(isValidSessionId("legacy.v1-run")).toBe(true);
    expect(isValidSessionId("a..b")).toBe(false);
    expect(isValidSessionId(".hidden")).toBe(false);
    expect(isValidSessionId("trailing.")).toBe(false);
    saveSession(makeRecord("legacy.v1-run"));
    expect(loadSession("legacy.v1-run")?.id).toBe("legacy.v1-run");
    expect(listSessionIds()).toContain("legacy.v1-run");
    appendFeedback({ sessionId: "legacy.v1-run", verdict: "pass", createdAt: "t" });
    expect(readFeedback()[0]?.sessionId).toBe("legacy.v1-run");
  });

  test("rejects a symlinked sessions directory instead of escaping LH_HOME", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-outside-"));
    try {
      fs.symlinkSync(outside, path.join(tmpHome, "sessions"));
      expect(() => saveSession(makeRecord("escape"))).toThrow(SessionStoreError);
      expect(fs.existsSync(path.join(outside, "escape.json"))).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpHome, "sessions"), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("distinguishes an unknown session from a corrupt or unsupported one", () => {
    const dir = path.join(tmpHome, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), '{"id":"broken"');
    expect(loadSession("missing")).toBeNull();
    expect(() => loadSession("broken")).toThrow(SessionStoreError);
    try {
      loadSession("broken");
    } catch (err) {
      expect((err as SessionStoreError).code).toBe("corrupt");
    }

    fs.writeFileSync(path.join(dir, "future.json"), JSON.stringify({ id: "future", schemaVersion: 999 }));
    try {
      loadSession("future");
    } catch (err) {
      expect((err as SessionStoreError).code).toBe("unsupported_schema");
    }
  });

  test("migrates a schema-v1 session without inventing historical prompt totals", () => {
    const legacy = makeRecord("legacy", { tokens: { prompt: 321, completion: 45 } });
    const dir = path.join(tmpHome, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify(legacy));
    const loaded = loadSession("legacy")!;
    expect(loaded.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(loaded.generation).toBe(0);
    expect(loaded.tokens).toEqual({
      prompt_last: 321,
      prompt_total: 321,
      completion_total: 45,
      prompt: 321,
      completion: 45,
    });
    expect(loaded.dimensions).toEqual({ model: legacy.model });
  });

  test("generation CAS prevents a stale submit parent from overwriting a completed worker", () => {
    saveSession(makeRecord("race", { status: "running" }));
    const staleParent = loadSession("race")!;
    saveSession(makeRecord("race", { status: "ok", result: "worker finished" }));
    expect(() =>
      saveSession({ ...staleParent, pid: 123 }, { expectedGeneration: staleParent.generation }),
    ).toThrow(SessionStoreError);
    expect(loadSession("race")).toMatchObject({ status: "ok", result: "worker finished", generation: 2 });
  });

  test("persists provider/tool/check/TTFT duration components", () => {
    saveSession(makeRecord("timings", {
      durationMs: 1000,
      durations: { total_ms: 1000, model_ms: 700, tool_ms: 150, check_ms: 100, ttft_ms: 25 },
    }));
    expect(loadSession("timings")!.durations).toEqual({
      total_ms: 1000,
      model_ms: 700,
      tool_ms: 150,
      check_ms: 100,
      ttft_ms: 25,
    });
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
    expect(all[0]).toMatchObject({
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      outcome: "accepted_as_is",
      verdict: "pass",
    });
    expect(fs.statSync(path.join(tmpHome, "feedback.jsonl")).mode & 0o777).toBe(0o600);
  });

  test("recovers a trailing partial record before the next append", () => {
    appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" });
    fs.appendFileSync(path.join(tmpHome, "feedback.jsonl"), '{"sessionId":"partial"');
    expect(readFeedback().map((item) => item.sessionId)).toEqual(["s1"]);
    appendFeedback({ sessionId: "s2", verdict: "fail", createdAt: "t" });
    expect(readFeedback().map((item) => item.sessionId)).toEqual(["s1", "s2"]);
    expect(fs.readFileSync(path.join(tmpHome, "feedback.jsonl"), "utf8")).not.toContain('"partial"');
  });

  test("preserves a complete final record that was missing only its newline", () => {
    const file = path.join(tmpHome, "feedback.jsonl");
    fs.writeFileSync(file, JSON.stringify({ sessionId: "s1", verdict: "pass", createdAt: "t" }));
    appendFeedback({ sessionId: "s2", verdict: "fail", createdAt: "t" });
    expect(readFeedback().map((item) => item.sessionId)).toEqual(["s1", "s2"]);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  test("does not hide a syntactically complete future feedback schema", () => {
    const file = path.join(tmpHome, "feedback.jsonl");
    const future = JSON.stringify({
      schemaVersion: FEEDBACK_SCHEMA_VERSION + 1,
      sessionId: "future",
      outcome: "accepted_as_is",
      createdAt: "t",
    });
    fs.writeFileSync(file, future);
    const assertUnsupported = (fn: () => unknown) => {
      try {
        fn();
        throw new Error("expected unsupported schema");
      } catch (err) {
        expect(err).toBeInstanceOf(SessionStoreError);
        expect((err as SessionStoreError).code).toBe("unsupported_schema");
      }
    };
    assertUnsupported(() => readFeedback());
    assertUnsupported(() => appendFeedback({ sessionId: "new", verdict: "pass", createdAt: "t" }));
    expect(fs.readFileSync(file, "utf8")).toBe(future);
  });

  test("never steals an old lock while its owner pid is alive", () => {
    const lock = path.join(tmpHome, "feedback.jsonl.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "live-owner" }) + "\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(() => appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" })).toThrow(SessionStoreError);
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toMatchObject({ pid: process.pid, token: "live-owner" });
  });

  test("recovers a lock whose owner process is dead", () => {
    const lock = path.join(tmpHome, "feedback.jsonl.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 99_999_999, token: "dead-owner" }) + "\n");
    appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" });
    expect(readFeedback().map((item) => item.sessionId)).toEqual(["s1"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("an old owner release cannot unlink a replacement lock", () => {
    const lock = path.join(tmpHome, "feedback.jsonl.lock");
    const displaced = `${lock}.displaced`;
    const originalFsync = fs.fsyncSync;
    let replaced = false;
    const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      if (!replaced && fs.existsSync(lock)) {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string };
        if (owner.token) {
          fs.renameSync(lock, displaced);
          fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "replacement" }) + "\n");
          replaced = true;
        }
      }
      return originalFsync(fd);
    });
    try {
      appendFeedback({ sessionId: "s1", verdict: "pass", createdAt: "t" });
    } finally {
      fsyncSpy.mockRestore();
    }
    expect(replaced).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toMatchObject({ token: "replacement" });
    fs.rmSync(lock, { force: true });
    fs.rmSync(displaced, { force: true });
  });

  test("migrates schema-v1 pass/fail feedback on read", () => {
    fs.writeFileSync(
      path.join(tmpHome, "feedback.jsonl"),
      JSON.stringify({ sessionId: "old", verdict: "fail", notes: "bad patch", createdAt: "t" }) + "\n",
    );
    expect(readFeedback()[0]).toMatchObject({
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      outcome: "rejected",
      verdict: "fail",
      notes: "bad patch",
    });
  });

  test("stores richer outcomes, rework metadata, caller receipt, and dimensions", () => {
    appendFeedback({
      sessionId: "s1",
      outcome: "accepted_after_resume",
      failureCode: "wrong_scope",
      reworkMs: 1200,
      callerReceipt: { inputTokens: 100, cacheReadTokens: 80, outputTokens: 20, costUsd: 0.01 },
      dimensions: { model: "qwen", hardware: "m4-max", caller: "codex" },
      createdAt: "t",
    });
    expect(readFeedback()[0]).toMatchObject({
      outcome: "accepted_after_resume",
      verdict: "pass",
      failureCode: "wrong_scope",
      reworkMs: 1200,
      callerReceipt: { inputTokens: 100, cacheReadTokens: 80, outputTokens: 20, costUsd: 0.01 },
      dimensions: { model: "qwen", hardware: "m4-max", caller: "codex" },
    });
  });

  test("feedback CLI keeps pass/fail compatibility and accepts the richer outcome", async () => {
    const { cmdFeedback } = await import("../src/index.ts");
    const originalLog = console.log;
    console.log = () => {};
    try {
      saveSession(makeRecord("legacy-pass"));
      expect(cmdFeedback(["legacy-pass", "pass", "--source", "codex"])).toBe(0);
      expect(readFeedback().at(-1)).toMatchObject({ outcome: "accepted_as_is", verdict: "pass" });

      expect(cmdFeedback([
        "legacy-pass", "accepted_after_resume", "--rework-ms", "250", "--failure-code", "bad_scope",
        "--caller-input-tokens", "100", "--caller-cache-read-tokens", "80", "--caller-cost-usd", "0.01",
        "--hardware", "m4-max", "--source", "codex",
      ])).toBe(0);
      expect(readFeedback().at(-1)).toMatchObject({
        outcome: "accepted_after_resume",
        verdict: "pass",
        reworkMs: 250,
        failureCode: "bad_scope",
        callerReceipt: { inputTokens: 100, cacheReadTokens: 80, costUsd: 0.01 },
        dimensions: { model: "qwen36-27b-mtp:latest", hardware: "m4-max", caller: "codex" },
      });
    } finally {
      console.log = originalLog;
    }
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
    expect(stats.byKind).toHaveLength(2);
    expect(stats.byKind![0]).toMatchObject({
      kind: "(untagged)", graded: 1, pass: 1, fail: 0, rate: 100,
      avgDurationMs: 20_000, p50DurationMs: 20_000, p90DurationMs: 20_000,
      rework: 0, reworkRate: 0, gate: { status: "insufficient_data" },
    });
    expect(stats.byKind![1]).toMatchObject({
      kind: "rename", graded: 2, pass: 1, fail: 1, rate: 50,
      avgDurationMs: 20_000, p50DurationMs: 10_000, p90DurationMs: 30_000,
      rework: 0, reworkRate: 0, gate: { status: "insufficient_data" },
    });
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
    // rename:    pass 4 / graded 4 → its 95% lower bound clears 50
    const docVerdicts: Array<"pass" | "fail"> = ["fail", "fail", "fail", "pass"];
    docVerdicts.forEach((verdict, i) => {
      const id = `d${i}`;
      saveSession(makeRecord(id, { kind: "doc-tweak" }));
      appendFeedback({ sessionId: id, verdict, kind: "doc-tweak", createdAt: "t" });
    });
    for (const i of [0, 1, 2, 3]) {
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
    expect(doc.gate.status).toBe("block");
    expect(rename.gate.status).toBe("allow");

    // The mechanical gate now uses the conservative confidence bound, not only
    // the point estimate, so tiny lucky samples do not over-authorize.
    const skipDelegation = (k: typeof doc) => k.gate.status === "block";
    expect(skipDelegation(doc)).toBe(true);
    expect(skipDelegation(rename)).toBe(false);
  });

  test("evaluateKindGate returns an explicit status and reason", () => {
    expect(evaluateKindGate(2, 0).status).toBe("insufficient_data");
    expect(evaluateKindGate(3, 49).status).toBe("block");
    expect(evaluateKindGate(3, 100).status).toBe("block");
    expect(evaluateKindGate(4, 100).status).toBe("allow");
    expect(successLowerBound(3, 3)).toBe(43.9);
    expect(evaluateKindGate(3, 100, { successLowerBound: successLowerBound(3, 3) }).status).toBe("block");
    expect(evaluateKindGate(4, 100, { successLowerBound: successLowerBound(4, 4) }).status).toBe("allow");
  });

  test("stats reports coverage, rework rate, p50/p90, and a conservative success bound", () => {
    for (const [id, durationMs] of [["s1", 100], ["s2", 200], ["s3", 300], ["s4", 400]] as const) {
      saveSession(makeRecord(id, { durationMs }));
    }
    appendFeedback({ sessionId: "s1", outcome: "accepted_as_is", createdAt: "t" });
    appendFeedback({ sessionId: "s2", outcome: "accepted_after_resume", reworkMs: 50, createdAt: "t" });
    appendFeedback({ sessionId: "s3", outcome: "rejected", failureCode: "bad_patch", createdAt: "t" });
    const stats = computeStats();
    expect(stats).toMatchObject({
      sessions: 4,
      gradable: 4,
      graded: 3,
      coverageRate: 75,
      pass: 2,
      fail: 1,
      rate: 67,
      rework: 1,
      reworkRate: 33.3,
      p50DurationMs: 200,
      p90DurationMs: 300,
    });
    expect(stats.successLowerBound).toBe(20.8);
  });

  test("dimension filters keep unknown sessions in the denominator and metrics use only true matches", () => {
    for (let i = 1; i <= 10; i++) {
      saveSession(makeRecord(`m${i}`, { model: "model-a", kind: "tests", durationMs: i * 100 }));
    }
    // A known model mismatch is explicit exclusion, not an unknown denominator.
    saveSession(makeRecord("other", {
      model: "model-b",
      kind: "tests",
      durationMs: 9_999,
      dimensions: { model: "model-b", hardware: "h2", caller: "other" },
    }));
    for (let i = 1; i <= 4; i++) {
      appendFeedback({
        sessionId: `m${i}`,
        outcome: i === 2 ? "accepted_after_resume" : "accepted_as_is",
        kind: "tests",
        createdAt: "t",
        dimensions: { model: "model-a", hardware: "h1", caller: "codex" },
      });
    }
    // This feedback is graded globally, but cannot be attributed to the
    // requested hardware/caller slice and therefore must not affect metrics.
    appendFeedback({ sessionId: "m5", outcome: "rejected", kind: "tests", createdAt: "t" });
    appendFeedback({
      sessionId: "other",
      outcome: "rejected",
      kind: "tests",
      createdAt: "t",
      dimensions: { model: "model-b", hardware: "h2", caller: "other" },
    });

    const stats = computeStats({ model: "model-a", hardware: "h1", caller: "codex", byKind: true });
    expect(stats).toMatchObject({
      sessions: 10,
      gradable: 10,
      graded: 4,
      coverageRate: 40,
      dimensionCoverage: { matched: 4, unknown: 6, excluded: 1, eligible: 10, rate: 40 },
      pass: 4,
      fail: 0,
      rate: 100,
      rework: 1,
      reworkRate: 25,
      p50DurationMs: 200,
      p90DurationMs: 400,
    });
    expect(stats.successLowerBound).toBe(51);
    expect(stats.byKind).toHaveLength(1);
    expect(stats.byKind![0]).toMatchObject({
      kind: "tests",
      gradable: 10,
      graded: 4,
      coverageRate: 40,
      dimensionCoverage: { matched: 4, unknown: 6, excluded: 1, eligible: 10, rate: 40 },
      gate: { status: "insufficient_data" },
    });
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
    const opts = parseArgs([
      "-p", "do it", "--check", "bun test", "--check-retries", "3", "--kind", "tests",
      "--caller", "codex", "--hardware", "m4", "--integration-version", "2.1.0",
    ]);
    expect(opts.checkCommand).toBe("bun test");
    expect(opts.checkRetries).toBe(3);
    expect(opts.kind).toBe("tests");
    expect(opts.caller).toBe("codex");
    expect(opts.hardware).toBe("m4");
    expect(opts.integrationVersion).toBe("2.1.0");
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
