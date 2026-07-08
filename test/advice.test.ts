import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  advise,
  parseAdviceArgs,
  type AdviceInput,
} from "../src/advice.ts";
import { cmdAdvise, cmdStats } from "../src/index.ts";
import {
  appendFeedback,
  computeStats,
  evaluateKindGate,
  saveSession,
  type Stats,
  type SessionRecord,
} from "../src/session.ts";

function emptyStats(): Stats {
  return {
    sessions: 0,
    gradable: 0,
    graded: 0,
    coverageRate: null,
    dimensionCoverage: { matched: 0, unknown: 0, excluded: 0, eligible: 0, rate: null },
    pass: 0,
    fail: 0,
    rate: null,
    successLowerBound: null,
    rework: 0,
    reworkRate: null,
    p50DurationMs: null,
    p90DurationMs: null,
    recentFailures: [],
    byKind: [],
  };
}

function provenStats(overrides: Partial<Stats> = {}): Stats {
  const gate = evaluateKindGate(10, 100, { successLowerBound: 72.2 });
  const kindStats = (kind: string) => ({
    kind,
    gradable: 10,
    graded: 10,
    coverageRate: 100,
    dimensionCoverage: { matched: 10, unknown: 0, excluded: 0, eligible: 10, rate: 100 },
    pass: 10,
    fail: 0,
    rate: 100,
    successLowerBound: 72.2,
    rework: 1,
    reworkRate: 10,
    avgDurationMs: 40_000,
    p50DurationMs: 30_000,
    p90DurationMs: 90_000,
    gate,
  });
  return {
    sessions: 10,
    gradable: 10,
    graded: 10,
    coverageRate: 100,
    dimensionCoverage: { matched: 10, unknown: 0, excluded: 0, eligible: 10, rate: 100 },
    pass: 10,
    fail: 0,
    rate: 100,
    successLowerBound: 72.2,
    rework: 1,
    reworkRate: 10,
    p50DurationMs: 30_000,
    p90DurationMs: 90_000,
    recentFailures: [],
    byKind: ["tests", "research", "diff", "scout", "distill"].map(kindStats),
    ...overrides,
  };
}

const eligibleTask: AdviceInput = {
  task: "add a comprehensive regression test suite",
  kind: "tests",
  files: 3,
  lines: 300,
  bytes: 24_000,
  check: true,
  risk: "low",
};

describe("advice router", () => {
  test("routes context reduction by observable thresholds", () => {
    const safe = { risk: "low" as const, check: true };
    expect(advise({ task: "compare sources", webSources: 2, ...safe }, provenStats()).route).toBe("research");
    expect(advise({ task: "review this diff", kind: "diff", lines: 700, ...safe }, provenStats()).route).toBe("diff");
    expect(advise({ task: "where is request auth defined?", files: 5, ...safe }, provenStats()).route).toBe("scout");
    expect(advise({ task: "extract root cause", lines: 1_000, ...safe }, provenStats()).route).toBe("distill");
    expect(advise({ task: "extract root cause", bytes: 65_536, ...safe }, provenStats()).route).toBe("distill");
  });

  test("prefers a deterministic script over model work", () => {
    const result = advise({ ...eligibleTask, scriptable: true }, provenStats());
    expect(result.route).toBe("script");
    expect(result.recommended).toBe(false);
  });

  test("delegates only a sufficiently large, checked, proven task", () => {
    const result = advise(eligibleTask, provenStats());
    expect(result).toMatchObject({
      route: "delegate",
      recommended: true,
      estimated_success_lower_bound: 72.2,
      p50_ms: 30_000,
      p90_ms: 90_000,
      sample_size: 10,
      gate: { status: "allow" },
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  test("bundles multiple independently eligible tasks", () => {
    expect(advise({ ...eligibleTask, batchCandidates: 3 }, provenStats()).route).toBe("batch");
  });

  test("a blocked gate never returns delegate or batch", () => {
    const blocked = provenStats({
      byKind: [{
        ...provenStats().byKind![0]!,
        pass: 2,
        fail: 8,
        rate: 20,
        successLowerBound: 5.7,
        gate: evaluateKindGate(10, 20, { successLowerBound: 5.7 }),
      }],
    });
    const result = advise({ ...eligibleTask, batchCandidates: 4 }, blocked);
    expect(result.route).toBe("direct");
    expect(result.gate.status).toBe("block");
  });

  test("blocked or insufficient evidence prevents every LocalRig route", () => {
    const blocked = provenStats({
      byKind: provenStats().byKind!.map((kind) => ({
        ...kind,
        pass: 2,
        fail: 8,
        rate: 20,
        successLowerBound: 5.7,
        gate: evaluateKindGate(10, 20, { successLowerBound: 5.7 }),
      })),
    });
    const candidates: AdviceInput[] = [
      { task: "sources", kind: "research", webSources: 2, risk: "low", check: true },
      { task: "diff", kind: "diff", lines: 700, risk: "low", check: true },
      { task: "where is it?", files: 5, risk: "low", check: true },
      { task: "logs", lines: 1_000, risk: "low", check: true },
      eligibleTask,
    ];
    for (const input of candidates) {
      expect(advise(input, blocked).route).toBe("direct");
      expect(advise(input, emptyStats()).route).toBe("direct");
    }
  });

  test("risk, check, coverage, and latency gates precede preprocessing", () => {
    const research: AdviceInput = {
      task: "compare sources", kind: "research", webSources: 3, risk: "low", check: true,
    };
    expect(advise({ ...research, risk: "high" }, provenStats()).route).toBe("direct");
    expect(advise({ ...research, risk: "unknown" }, provenStats()).route).toBe("direct");
    expect(advise({ ...research, check: false }, provenStats()).route).toBe("direct");
    expect(advise(research, provenStats({ coverageRate: 40 })).route).toBe("direct");
    expect(advise({ ...research, latencyBudgetMs: 1 }, provenStats()).route).toBe("direct");
  });

  test("missing facts, small tasks, no check, rework, and latency are conservative", () => {
    expect(advise({ task: "change it", risk: "low" }, provenStats()).route).toBe("direct");
    expect(advise({ ...eligibleTask, files: 1, lines: 20, bytes: 500 }, provenStats()).route).toBe("direct");
    expect(advise({ ...eligibleTask, check: false }, provenStats()).route).toBe("direct");
    expect(advise(eligibleTask, provenStats({
      byKind: [{ ...provenStats().byKind![0]!, reworkRate: 40 }],
    })).route).toBe("direct");
    expect(advise({ ...eligibleTask, latencyBudgetMs: 60_000 }, provenStats()).route).toBe("direct");
  });
});

describe("advise CLI parser", () => {
  test("parses every machine-supplied routing fact", () => {
    const parsed = parseAdviceArgs([
      "--task", "migrate callers", "--kind", "tests", "--files", "8", "--lines", "400", "--bytes", "12000",
      "--check", "--risk", "medium", "--caller", "codex", "--model", "qwen", "--hardware", "m4",
      "--latency-budget", "120", "--batch-candidates", "3", "--web-sources", "0", "--scriptable", "--json",
    ]);
    expect(parsed).toEqual({
      json: true,
      input: {
        task: "migrate callers",
        kind: "tests",
        files: 8,
        lines: 400,
        bytes: 12_000,
        check: true,
        risk: "medium",
        caller: "codex",
        model: "qwen",
        hardware: "m4",
        latencyBudgetMs: 120_000,
        batchCandidates: 3,
        webSources: 0,
        scriptable: true,
      },
    });
  });

  test("rejects unknown, conflicting, and malformed input", () => {
    expect(() => parseAdviceArgs(["--task", "x", "--wat"])).toThrow(/unknown advise option/);
    expect(() => parseAdviceArgs(["--task", "x", "--check", "--no-check"])).toThrow(/mutually exclusive/);
    expect(() => parseAdviceArgs(["--task", "x", "--files", "1.5"])).toThrow(/integer/);
    expect(() => parseAdviceArgs(["--task", "x", "--files", "1e100"])).toThrow(/safe integer/);
    expect(() => parseAdviceArgs(["--task", "x", "--latency-budget", "1e308"])).toThrow(/too large/);
    expect(() => parseAdviceArgs([])).toThrow(/requires/);
  });
});

describe("dimension-filtered evidence and CLI JSON", () => {
  let home: string;
  let logs: string[];
  const originalLog = console.log;

  const record = (id: string, model: string, hardware: string, caller: string): SessionRecord => ({
    id,
    createdAt: "2026-07-08T00:00:00.000Z",
    cwd: "/tmp/project",
    model,
    prompt: "task",
    kind: "tests",
    status: "ok",
    result: "done",
    durationMs: 1_000,
    turns: 1,
    toolCalls: 0,
    tokens: { prompt: 10, completion: 5 },
    dimensions: { model, hardware, caller },
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-advice-"));
    process.env.LH_HOME = home;
    logs = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
    delete process.env.LH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("computeStats and stats CLI filter model/hardware/caller dimensions", () => {
    saveSession(record("a1", "m1", "h1", "codex"));
    saveSession(record("a2", "m1", "h1", "codex"));
    saveSession(record("b1", "m2", "h2", "claude"));
    appendFeedback({
      sessionId: "a1", outcome: "accepted_as_is", kind: "tests", createdAt: "t",
      dimensions: { model: "m1", hardware: "h1", caller: "codex" },
    });
    appendFeedback({
      sessionId: "b1", outcome: "rejected", kind: "tests", createdAt: "t",
      dimensions: { model: "m2", hardware: "h2", caller: "claude" },
    });

    expect(computeStats({ model: "m1", hardware: "h1", caller: "codex" })).toMatchObject({
      sessions: 2,
      gradable: 2,
      graded: 1,
      pass: 1,
      fail: 0,
      coverageRate: 50,
      dimensionCoverage: { matched: 2, unknown: 0, excluded: 1, eligible: 2, rate: 100 },
      filters: { model: "m1", hardware: "h1", caller: "codex" },
    });
    expect(cmdStats(["--model", "m2", "--hardware", "h2", "--caller", "claude", "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ graded: 1, pass: 0, fail: 1 });
  });

  test("lh advise --json emits the stable machine fields", () => {
    expect(cmdAdvise(["--task", "summarize logs", "--lines", "1000", "--json"])).toBe(0);
    const output = JSON.parse(logs.at(-1)!);
    expect(output).toMatchObject({ route: "direct", recommended: false, gate: { status: "insufficient_data" } });
    for (const key of [
      "confidence", "reasons", "estimated_success_lower_bound", "p50_ms", "p90_ms", "sample_size", "gate",
      "coverage_rate", "dimension_coverage_rate", "dimension_matched", "dimension_unknown", "dimension_excluded",
    ]) expect(key in output).toBe(true);
  });

  test("unknown execution dimensions lower stats coverage and keep the router conservative", () => {
    for (let i = 1; i <= 10; i++) {
      saveSession({ ...record(`legacy-${i}`, "m1", "unused", "unused"), dimensions: { model: "m1" } });
    }
    for (let i = 1; i <= 4; i++) {
      appendFeedback({
        sessionId: `legacy-${i}`,
        outcome: "accepted_as_is",
        kind: "tests",
        createdAt: "t",
        dimensions: { model: "m1", hardware: "h1", caller: "codex" },
      });
    }

    expect(cmdStats(["--model", "m1", "--hardware", "h1", "--caller", "codex", "--json", "--by-kind"])).toBe(0);
    const statsOutput = JSON.parse(logs.at(-1)!);
    expect(statsOutput).toMatchObject({
      gradable: 10,
      graded: 4,
      coverageRate: 40,
      dimensionCoverage: { matched: 4, unknown: 6, excluded: 0, eligible: 10, rate: 40 },
      byKind: [{ gate: { status: "insufficient_data" } }],
    });

    logs = [];
    expect(cmdAdvise([
      "--task", "add tests", "--kind", "tests", "--files", "3", "--lines", "300",
      "--check", "--risk", "low", "--model", "m1", "--hardware", "h1", "--caller", "codex", "--json",
    ])).toBe(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      route: "direct",
      recommended: false,
      coverage_rate: 40,
      dimension_coverage_rate: 40,
      dimension_matched: 4,
      dimension_unknown: 6,
      dimension_excluded: 0,
      gate: { status: "insufficient_data" },
    });
  });

  test("stats and advise reject unknown flags with one JSON error", () => {
    expect(cmdStats(["--json", "--wat"])).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: "error", error_kind: "config" });
    logs = [];
    expect(cmdAdvise(["--json", "--task", "x", "--wat"])).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ status: "error", error_kind: "config" });
  });
});
