import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRunPlan,
  mergeSummaryFile,
  parseRunArgs,
  safeRunId,
  seededArmOrder,
} from "./run-support.ts";
import {
  compareRepeatedArms,
  distribution,
  evaluateGate,
  percentile,
  readSummaryEntries,
  summaryFiles,
} from "./repeated-stats.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "repeated-results");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("repeated run planning", () => {
  test("parses multiple arms, repeats, seed, and legacy run options", () => {
    const options = parseRunArgs([
      "--agent",
      "claude,claude-delegate,claude",
      "--task",
      "alpha,beta",
      "--repeat",
      "3",
      "--order-seed",
      "ci-42",
      "--run-id",
      "nightly",
      "--keep",
    ]);
    expect(options.agents).toEqual(["claude", "claude-delegate"]);
    expect(options.only).toEqual(new Set(["alpha", "beta"]));
    expect(options.repeat).toBe(3);
    expect(options.orderSeed).toBe("ci-42");
    expect(options.runId).toBe("nightly");
    expect(options.keep).toBe(true);
  });

  test("rejects invalid repeat counts and unknown options", () => {
    expect(() => parseRunArgs(["--repeat", "0"])).toThrow("integer in");
    expect(() => parseRunArgs(["--repeat", "1001"])).toThrow("integer in");
    expect(() => parseRunArgs(["--wat"])).toThrow("unknown option");
  });

  test("strictly rejects unsafe or normalization-colliding run ids", () => {
    for (const id of [".", "..", "a/b", "a\\b", "a?b", "a..b", "\u0000bad"]) {
      expect(() => parseRunArgs(["--run-id", id])).toThrow("--run-id");
      expect(() => safeRunId(id)).toThrow("--run-id");
    }
    expect(safeRunId("cell-1.r001")).toBe("cell-1.r001");
  });

  test("uses a deterministic seeded order and rotates arms between repetitions", () => {
    const agents = ["base", "delegate", "control"];
    const seeded = seededArmOrder(agents, "fixed-seed");
    expect(seededArmOrder(agents, "fixed-seed")).toEqual(seeded);
    const plan = buildRunPlan(
      { agents, keep: false, repeat: 3, orderSeed: "fixed-seed", runId: "cell" },
      "unused",
    );
    expect(plan.map((round) => round.runId)).toEqual(["cell.r001", "cell.r002", "cell.r003"]);
    expect(plan[1]!.armOrder).toEqual([...seeded.slice(1), seeded[0]!]);
    expect(plan[2]!.armOrder).toEqual([...seeded.slice(2), ...seeded.slice(0, 2)]);
  });

  test("preserves legacy repeat=1 run-id naming", () => {
    const [round] = buildRunPlan({ agents: ["harness"], keep: false, repeat: 1, orderSeed: "0", runId: "old-cell" });
    expect(round?.runId).toBe("old-cell");
  });

  test("summary merge replaces only matching tasks", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-summary-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "summary.json");
    mergeSummaryFile(file, [{ task: "b", value: 1 }, { task: "a", value: 1 }], (entry) => entry.task);
    mergeSummaryFile(file, [{ task: "a", value: 2 }], (entry) => entry.task);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([
      { task: "a", value: 2 },
      { task: "b", value: 1 },
    ]);
  });

  test("summary merge is lossless across concurrent writers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-summary-race-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "summary.json");
    const target = Date.now() + 600;
    const modulePath = path.join(import.meta.dir, "run-support.ts");
    const code = `
      import { mergeSummaryFile } from ${JSON.stringify(modulePath)};
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const target = Number(process.argv[3]);
      while (Date.now() < target) Atomics.wait(wait, 0, 0, Math.max(1, target - Date.now()));
      mergeSummaryFile(process.argv[1], [{ task: process.argv[2] }], (entry) => entry.task);
    `;
    const children = Array.from({ length: 16 }, (_, index) => Bun.spawn([
      process.execPath, "-e", code, file, String(index), String(target),
    ], { stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(16).fill(0));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(16);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test("summary merge refuses to erase a corrupt existing file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-summary-corrupt-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "summary.json");
    fs.writeFileSync(file, "{partial");
    expect(() => mergeSummaryFile(file, [{ task: "new" }], (entry) => entry.task)).toThrow("corrupt summary");
    expect(fs.readFileSync(file, "utf8")).toBe("{partial");
  });
});

describe("repeated statistics and CI gate", () => {
  test("computes interpolated median, p90, and p95", () => {
    expect(percentile([10, 20, 12, 22], 0.5)).toBe(16);
    const stats = distribution([10, 20, 12, 22]);
    expect(stats.p90).toBeCloseTo(21.4);
    expect(stats.p95).toBeCloseTo(21.7);
  });

  test("loads run-scoped fixtures and aggregates quality, latency, and savings", () => {
    const baseline = readSummaryEntries(summaryFiles(FIXTURES, "claude", "exp"), "claude", "exp");
    const candidate = readSummaryEntries(
      summaryFiles(FIXTURES, "claude-delegate", "exp"),
      "claude-delegate",
      "exp",
    );
    const comparison = compareRepeatedArms("claude", baseline, "claude-delegate", candidate);
    expect(comparison.commonTasks).toEqual(["alpha", "beta"]);
    expect(comparison.baseline.qualitySuccessRate).toBe(0.75);
    expect(comparison.candidate.qualitySuccessRate).toBe(0.75);
    expect(comparison.candidate.wallTimeSec.median).toBe(21);
    expect(comparison.candidate.wallTimeSec.p95).toBeCloseTo(26.7);
    expect(comparison.upperCostSavings.meanUsdPerSample).toBeCloseTo(0.55);
    expect(comparison.upperCostSavings.percent).toBeCloseTo(2.2 / 6.4);
    expect(comparison.baseline.coldSamples).toBe(1);
    expect(comparison.baseline.warmSamples).toBe(3);
  });

  test("passes all three checks and fails unavailable/over-budget metrics", () => {
    const baseline = readSummaryEntries(summaryFiles(FIXTURES, "claude", "exp"), "claude", "exp");
    const candidate = readSummaryEntries(
      summaryFiles(FIXTURES, "claude-delegate", "exp"),
      "claude-delegate",
      "exp",
    );
    const comparison = compareRepeatedArms("claude", baseline, "claude-delegate", candidate);
    expect(
      evaluateGate(comparison, { maxQualityDrop: 0, minUpperCostSavingsUsd: 0, maxP95WallSec: 30 }).passed,
    ).toBe(true);
    const failed = evaluateGate(comparison, {
      maxQualityDrop: 0,
      minUpperCostSavingsUsd: 1,
      maxP95WallSec: 20,
    });
    expect(failed.passed).toBe(false);
    expect(failed.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "positive_upper_cost_savings",
      "p95_wall_budget",
    ]);
  });

  test("fails closed when either arm omits a task", () => {
    const sample = (task: string, agent: string, costUsd: number) => ({
      task, agent, passed: true, durationSec: 1, costUsd,
      run: { experimentId: "cell", runId: "cell", repetition: 1, repeat: 1, cacheState: "warm" as const },
    });
    const comparison = compareRepeatedArms(
      "base",
      [sample("a", "base", 2), sample("b", "base", 2)],
      "candidate",
      [sample("a", "candidate", 1)],
    );
    const gate = evaluateGate(comparison, { maxQualityDrop: 0, minUpperCostSavingsUsd: 0, maxP95WallSec: 10 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]).toMatchObject({ name: "data_completeness", passed: false });
    expect(gate.checks[0]!.message).toContain("missing tasks: b");
  });

  test("can skip unavailable upper-level cost for harness-vs-harness gates", () => {
    const sample = (task: string, agent: string) => ({
      task, agent, passed: true, durationSec: 1,
      run: { experimentId: "h", runId: "h", repetition: 1, repeat: 1, cacheState: "warm" as const },
    });
    const comparison = compareRepeatedArms("old", [sample("a", "old")], "new", [sample("a", "new")]);
    const gate = evaluateGate(comparison, {
      maxQualityDrop: 0, minUpperCostSavingsUsd: 0, maxP95WallSec: 10, skipCost: true,
    });
    expect(gate.passed).toBe(true);
    expect(gate.checks.find((check) => check.name === "positive_upper_cost_savings")).toMatchObject({ passed: true });
  });

  test("fails closed when planned repetitions or paired metadata are missing", () => {
    const sample = (agent: string, runId: string, orderSeed: string) => ({
      task: "a", agent, passed: true, durationSec: 1, costUsd: agent === "base" ? 2 : 1,
      run: {
        experimentId: "cell", runId, repetition: 1, repeat: 3,
        orderSeed, armOrder: ["base", "candidate"], cacheState: "cold" as const,
      },
    });
    const comparison = compareRepeatedArms(
      "base", [sample("base", "cell.r001", "seed-a")],
      "candidate", [sample("candidate", "cell.r001", "seed-b")],
    );
    const gate = evaluateGate(comparison, { maxQualityDrop: 0, minUpperCostSavingsUsd: 0, maxP95WallSec: 10 });
    expect(gate.passed).toBe(false);
    expect(comparison.dataCompleteness.errors.join("; ")).toContain("missing repetitions 2, 3");
    expect(comparison.dataCompleteness.errors.join("; ")).toContain("orderSeed mismatch");
  });

  test("rejects negative duration, cost, and token metrics", () => {
    const valid = {
      task: "a", agent: "base", passed: true, durationSec: 1, costUsd: 2, promptTokens: 1,
      run: { experimentId: "cell", runId: "cell", repetition: 1, repeat: 1, cacheState: "warm" as const },
    };
    for (const invalid of [
      { ...valid, durationSec: -1 },
      { ...valid, costUsd: -1 },
      { ...valid, promptTokens: -1 },
    ]) {
      expect(() => compareRepeatedArms("base", [invalid], "candidate", [{ ...valid, agent: "candidate" }])).toThrow(
        "finite number >= 0",
      );
    }
  });

  test("summary reader rejects parse errors and duplicate samples", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-read-strict-"));
    temporaryDirectories.push(directory);
    const corrupt = path.join(directory, "summary-base.cell.json");
    fs.writeFileSync(corrupt, "{partial");
    expect(() => readSummaryEntries([corrupt], "base", "cell")).toThrow("cannot parse summary");

    const duplicate = path.join(directory, "summary-base.dupe.json");
    const entry = {
      task: "a", agent: "base", passed: true, durationSec: 1, costUsd: 2,
      run: { experimentId: "dupe", runId: "dupe", repetition: 1, repeat: 1, cacheState: "warm" },
    };
    fs.writeFileSync(duplicate, JSON.stringify([entry, entry]));
    expect(() => readSummaryEntries([duplicate], "base", "dupe")).toThrow("duplicate sample");
  });

  test("gate command exits nonzero on a violated budget without invoking an LLM", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        path.join(import.meta.dir, "gate.ts"),
        "--results-dir",
        FIXTURES,
        "--run-id",
        "exp",
        "--max-p95-sec",
        "20",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL  p95_wall_budget");
  });

  test("gate command fails closed on a corrupt selected summary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-gate-corrupt-"));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, "summary-base.cell.json"), "{partial");
    fs.writeFileSync(path.join(directory, "summary-candidate.cell.json"), "[]");
    const result = spawnSync(
      "bun",
      [
        "run", path.join(import.meta.dir, "gate.ts"),
        "--baseline", "base", "--candidate", "candidate",
        "--results-dir", directory, "--run-id", "cell",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL  data_completeness");
    expect(result.stdout).toContain("cannot parse summary");
  });
});
