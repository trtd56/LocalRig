import * as fs from "node:fs";
import * as path from "node:path";
import { validateRunId } from "./run-support.ts";

export interface RepeatedRunMetadata {
  experimentId?: string | null;
  runId?: string | null;
  repetition?: number;
  repeat?: number;
  cacheState?: "cold" | "warm";
  orderSeed?: string;
  armOrder?: string[];
}

export interface RepeatedSummaryEntry {
  task: string;
  agent: string;
  passed: boolean;
  durationSec?: number;
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  usage?: Record<string, number | undefined>;
  workers?: Array<{ costUsd?: number; durationMs?: number; usage?: Record<string, number | undefined> }>;
  run?: RepeatedRunMetadata;
}

export interface Distribution {
  count: number;
  total: number | null;
  mean: number | null;
  min: number | null;
  median: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

export interface ArmStatistics {
  agent: string;
  sampleCount: number;
  taskCount: number;
  passCount: number;
  qualitySuccessRate: number | null;
  wallTimeSec: Distribution;
  upperCostUsd: Distribution;
  billedCostUsd: Distribution;
  coldSamples: number;
  warmSamples: number;
}

export interface RepeatedComparison {
  baseline: ArmStatistics;
  candidate: ArmStatistics;
  commonTasks: string[];
  dataCompleteness: {
    complete: boolean;
    expectedRepeat: number | null;
    errors: string[];
  };
  qualityRateDelta: number | null;
  upperCostSavings: {
    pairedSamples: number;
    totalUsd: number | null;
    meanUsdPerSample: number | null;
    percent: number | null;
  };
}

export interface GateThresholds {
  maxQualityDrop: number;
  minUpperCostSavingsUsd: number;
  maxP95WallSec: number;
}

export interface GateCheck {
  name: "data_completeness" | "quality_non_inferiority" | "positive_upper_cost_savings" | "p95_wall_budget";
  passed: boolean;
  actual: number | null;
  threshold: number;
  message: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

export function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new Error(`percentile must be in [0, 1] (received ${percentileValue})`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

export function distribution(values: Array<number | undefined>): Distribution {
  const finite: number[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`distribution values must be finite numbers >= 0 (received ${String(value)})`);
    }
    finite.push(value);
  }
  if (finite.length === 0) {
    return { count: 0, total: null, mean: null, min: null, median: null, p90: null, p95: null, max: null };
  }
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    total,
    mean: total / finite.length,
    min: Math.min(...finite),
    median: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  };
}

function billedCost(entry: RepeatedSummaryEntry): number | undefined {
  const orchestrator = entry.costUsd;
  const workerCosts = (entry.workers ?? [])
    .map((worker) => worker.costUsd)
    .filter((value): value is number => value !== undefined);
  if (orchestrator === undefined && workerCosts.length === 0) return undefined;
  return (orchestrator ?? 0) + workerCosts.reduce((sum, value) => sum + value, 0);
}

function validateMetricTree(value: unknown, location: string, insideUsage = false): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateMetricTree(item, `${location}[${index}]`, insideUsage));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childLocation = `${location}.${key}`;
    const metric = insideUsage || /token/i.test(key) || /duration(?:sec|ms)?$/i.test(key) || /cost(?:usd)?$/i.test(key);
    if (metric && child !== undefined) {
      if (typeof child !== "number" || !Number.isFinite(child) || child < 0) {
        throw new Error(`${childLocation} must be a finite number >= 0`);
      }
    }
    validateMetricTree(child, childLocation, insideUsage || key === "usage");
  }
}

function validateEntry(entry: RepeatedSummaryEntry, expectedAgent: string, location: string): void {
  if (typeof entry !== "object" || entry === null) throw new Error(`${location} must be an object`);
  if (typeof entry.task !== "string" || !entry.task.trim()) throw new Error(`${location}.task must be a non-empty string`);
  if (entry.agent !== expectedAgent) throw new Error(`${location}.agent must equal ${expectedAgent}`);
  if (typeof entry.passed !== "boolean") throw new Error(`${location}.passed must be boolean`);
  validateMetricTree(entry, location);
  if (entry.workers !== undefined && !Array.isArray(entry.workers)) throw new Error(`${location}.workers must be an array`);
  if (entry.run !== undefined) {
    if (typeof entry.run !== "object" || entry.run === null) throw new Error(`${location}.run must be an object`);
    const { repetition, repeat, experimentId, runId, cacheState } = entry.run;
    if (!Number.isSafeInteger(repetition) || repetition! < 1) throw new Error(`${location}.run.repetition must be an integer >= 1`);
    if (!Number.isSafeInteger(repeat) || repeat! < 1) throw new Error(`${location}.run.repeat must be an integer >= 1`);
    if (repetition! > repeat!) throw new Error(`${location}.run.repetition exceeds run.repeat`);
    if (experimentId !== null && typeof experimentId !== "string") throw new Error(`${location}.run.experimentId is required`);
    if (runId !== null && typeof runId !== "string") throw new Error(`${location}.run.runId is required`);
    if (typeof experimentId === "string") validateRunId(experimentId);
    if (typeof runId === "string") validateRunId(runId);
    if (repeat! > 1 && (typeof experimentId !== "string" || typeof runId !== "string")) {
      throw new Error(`${location}.run needs experimentId and runId for repeated evaluation`);
    }
    if (repeat! > 1 && (typeof entry.run.orderSeed !== "string" || entry.run.orderSeed.length === 0)) {
      throw new Error(`${location}.run.orderSeed is required for repeated evaluation`);
    }
    if (repeat! > 1 && (!Array.isArray(entry.run.armOrder) || entry.run.armOrder.length < 2)) {
      throw new Error(`${location}.run.armOrder is required for repeated evaluation`);
    }
    if ((experimentId === null) !== (runId === null)) throw new Error(`${location}.run experimentId/runId nullability differs`);
    if (cacheState !== "cold" && cacheState !== "warm") throw new Error(`${location}.run.cacheState must be cold or warm`);
    if (entry.run.armOrder !== undefined && (
      !Array.isArray(entry.run.armOrder) || entry.run.armOrder.some((agent) => typeof agent !== "string" || !agent)
    )) throw new Error(`${location}.run.armOrder must be an array of agent names`);
    if (entry.run.armOrder && (!entry.run.armOrder.includes(expectedAgent) || new Set(entry.run.armOrder).size !== entry.run.armOrder.length)) {
      throw new Error(`${location}.run.armOrder must contain each arm exactly once`);
    }
  }
}

export function armStatistics(agent: string, entries: RepeatedSummaryEntry[]): ArmStatistics {
  entries.forEach((entry, index) => validateEntry(entry, agent, `${agent}[${index}]`));
  const passes = entries.filter((entry) => entry.passed).length;
  return {
    agent,
    sampleCount: entries.length,
    taskCount: new Set(entries.map((entry) => entry.task)).size,
    passCount: passes,
    qualitySuccessRate: entries.length > 0 ? passes / entries.length : null,
    wallTimeSec: distribution(entries.map((entry) => entry.durationSec)),
    upperCostUsd: distribution(entries.map((entry) => entry.costUsd)),
    billedCostUsd: distribution(entries.map(billedCost)),
    coldSamples: entries.filter((entry) => entry.run?.cacheState === "cold").length,
    warmSamples: entries.filter((entry) => entry.run?.cacheState === "warm").length,
  };
}

function compareEntryOrder(a: RepeatedSummaryEntry, b: RepeatedSummaryEntry): number {
  const repetition = (a.run?.repetition ?? Number.MAX_SAFE_INTEGER) - (b.run?.repetition ?? Number.MAX_SAFE_INTEGER);
  if (repetition !== 0) return repetition;
  return (a.run?.runId ?? "").localeCompare(b.run?.runId ?? "");
}

function runKey(entry: RepeatedSummaryEntry): string | undefined {
  if (entry.run?.runId) return entry.run.runId;
  if (entry.run?.repetition !== undefined) return `repetition:${entry.run.repetition}`;
  return undefined;
}

function duplicateErrors(label: string, entries: RepeatedSummaryEntry[]): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const entry of entries) {
    const key = `${entry.task}\0${runKey(entry) ?? "legacy"}`;
    if (seen.has(key)) errors.push(`${label} has duplicate sample for task=${entry.task}, run=${runKey(entry) ?? "legacy"}`);
    seen.add(key);
  }
  return errors;
}

function dataCompleteness(
  baselineAgent: string,
  baseline: RepeatedSummaryEntry[],
  candidateAgent: string,
  candidate: RepeatedSummaryEntry[],
): RepeatedComparison["dataCompleteness"] {
  const errors = [
    ...duplicateErrors(baselineAgent, baseline),
    ...duplicateErrors(candidateAgent, candidate),
  ];
  if (baseline.length === 0) errors.push(`${baselineAgent} has no samples`);
  if (candidate.length === 0) errors.push(`${candidateAgent} has no samples`);

  const baselineTasks = new Set(baseline.map((entry) => entry.task));
  const candidateTasks = new Set(candidate.map((entry) => entry.task));
  const missingCandidate = [...baselineTasks].filter((task) => !candidateTasks.has(task)).sort();
  const missingBaseline = [...candidateTasks].filter((task) => !baselineTasks.has(task)).sort();
  if (missingCandidate.length > 0) errors.push(`${candidateAgent} is missing tasks: ${missingCandidate.join(", ")}`);
  if (missingBaseline.length > 0) errors.push(`${baselineAgent} is missing tasks: ${missingBaseline.join(", ")}`);

  const all = [...baseline, ...candidate];
  const metadataCount = all.filter((entry) => entry.run !== undefined).length;
  if (metadataCount !== 0 && metadataCount !== all.length) errors.push("run metadata is missing from only part of the samples");
  let expectedRepeat: number | null = all.length > 0 ? 1 : null;
  if (metadataCount === all.length && all.length > 0) {
    const repeats = new Set(all.map((entry) => entry.run!.repeat!));
    if (repeats.size !== 1) errors.push(`run.repeat disagrees across samples: ${[...repeats].sort((a, b) => a - b).join(", ")}`);
    expectedRepeat = repeats.size === 1 ? [...repeats][0]! : null;
    const experiments = new Set(all.map((entry) => entry.run!.experimentId ?? "<default>"));
    if (experiments.size !== 1) errors.push(`experimentId disagrees across samples: ${[...experiments].join(", ")}`);

    if (expectedRepeat !== null) {
      for (let repetition = 1; repetition <= expectedRepeat; repetition++) {
        const repetitionEntries = all.filter((entry) => entry.run!.repetition === repetition);
        const runIds = new Set(repetitionEntries.map((entry) => entry.run!.runId ?? "<default>"));
        if (runIds.size !== 1) errors.push(`runId disagrees within repetition ${repetition}: ${[...runIds].join(", ")}`);
        const seeds = new Set(repetitionEntries.map((entry) => entry.run!.orderSeed ?? "<missing>"));
        if (seeds.size !== 1) errors.push(`orderSeed disagrees within repetition ${repetition}`);
        const orders = new Set(repetitionEntries.map((entry) => JSON.stringify(entry.run!.armOrder ?? null)));
        if (orders.size !== 1) errors.push(`armOrder disagrees within repetition ${repetition}`);
      }
      const verifyArm = (label: string, entries: RepeatedSummaryEntry[]) => {
        for (const task of new Set(entries.map((entry) => entry.task))) {
          const taskEntries = entries.filter((entry) => entry.task === task);
          const repetitions = new Set(taskEntries.map((entry) => entry.run!.repetition!));
          const missing = Array.from({ length: expectedRepeat! }, (_, index) => index + 1)
            .filter((repetition) => !repetitions.has(repetition));
          if (taskEntries.length !== expectedRepeat || missing.length > 0) {
            errors.push(
              `${label} task=${task} has ${taskEntries.length}/${expectedRepeat} samples` +
              (missing.length > 0 ? ` (missing repetitions ${missing.join(", ")})` : ""),
            );
          }
        }
      };
      verifyArm(baselineAgent, baseline);
      verifyArm(candidateAgent, candidate);

      for (const task of [...baselineTasks].filter((value) => candidateTasks.has(value))) {
        for (let repetition = 1; repetition <= expectedRepeat; repetition++) {
          const baselineEntry = baseline.find((entry) => entry.task === task && entry.run!.repetition === repetition);
          const candidateEntry = candidate.find((entry) => entry.task === task && entry.run!.repetition === repetition);
          if (baselineEntry && candidateEntry && baselineEntry.run!.runId !== candidateEntry.run!.runId) {
            errors.push(
              `paired runId mismatch for task=${task}, repetition=${repetition}: ` +
              `${baselineEntry.run!.runId ?? "<default>"}/${candidateEntry.run!.runId ?? "<default>"}`,
            );
          }
          if (baselineEntry && candidateEntry) {
            if (baselineEntry.run!.orderSeed !== candidateEntry.run!.orderSeed) {
              errors.push(`orderSeed mismatch for task=${task}, repetition=${repetition}`);
            }
            if (JSON.stringify(baselineEntry.run!.armOrder) !== JSON.stringify(candidateEntry.run!.armOrder)) {
              errors.push(`armOrder mismatch for task=${task}, repetition=${repetition}`);
            }
          }
        }
      }
    }
  }
  return { complete: errors.length === 0, expectedRepeat, errors: [...new Set(errors)] };
}

function pairTaskEntries(
  baseline: RepeatedSummaryEntry[],
  candidate: RepeatedSummaryEntry[],
): Array<[RepeatedSummaryEntry, RepeatedSummaryEntry]> {
  const baselineKeys = baseline.map(runKey);
  const candidateKeys = candidate.map(runKey);
  if (baselineKeys.every((key) => key !== undefined) && candidateKeys.every((key) => key !== undefined)) {
    const candidates = new Map(candidate.map((entry) => [runKey(entry)!, entry]));
    return baseline.flatMap((entry) => {
      const match = candidates.get(runKey(entry)!);
      return match ? [[entry, match] as [RepeatedSummaryEntry, RepeatedSummaryEntry]] : [];
    });
  }
  const sortedBaseline = [...baseline].sort(compareEntryOrder);
  const sortedCandidate = [...candidate].sort(compareEntryOrder);
  return sortedBaseline
    .slice(0, Math.min(sortedBaseline.length, sortedCandidate.length))
    .map((entry, index) => [entry, sortedCandidate[index]!] as [RepeatedSummaryEntry, RepeatedSummaryEntry]);
}

export function compareRepeatedArms(
  baselineAgent: string,
  baselineEntries: RepeatedSummaryEntry[],
  candidateAgent: string,
  candidateEntries: RepeatedSummaryEntry[],
): RepeatedComparison {
  baselineEntries.forEach((entry, index) => validateEntry(entry, baselineAgent, `${baselineAgent}[${index}]`));
  candidateEntries.forEach((entry, index) => validateEntry(entry, candidateAgent, `${candidateAgent}[${index}]`));
  const completeness = dataCompleteness(baselineAgent, baselineEntries, candidateAgent, candidateEntries);
  const baselineTasks = new Set(baselineEntries.map((entry) => entry.task));
  const candidateTasks = new Set(candidateEntries.map((entry) => entry.task));
  const commonTasks = [...baselineTasks].filter((task) => candidateTasks.has(task)).sort();
  const common = new Set(commonTasks);
  const baseline = baselineEntries.filter((entry) => common.has(entry.task));
  const candidate = candidateEntries.filter((entry) => common.has(entry.task));
  const baselineStats = armStatistics(baselineAgent, baseline);
  const candidateStats = armStatistics(candidateAgent, candidate);

  const pairedSavings: number[] = [];
  let pairedBaselineCost = 0;
  for (const task of commonTasks) {
    const pairs = pairTaskEntries(
      baseline.filter((entry) => entry.task === task),
      candidate.filter((entry) => entry.task === task),
    );
    for (const [baselineEntry, candidateEntry] of pairs) {
      const baselineCost = baselineEntry.costUsd;
      const candidateCost = candidateEntry.costUsd;
      if (baselineCost === undefined || candidateCost === undefined) continue;
      pairedBaselineCost += baselineCost;
      pairedSavings.push(baselineCost - candidateCost);
    }
  }
  const totalSavings = pairedSavings.length > 0 ? pairedSavings.reduce((sum, value) => sum + value, 0) : null;
  const qualityRateDelta =
    baselineStats.qualitySuccessRate === null || candidateStats.qualitySuccessRate === null
      ? null
      : candidateStats.qualitySuccessRate - baselineStats.qualitySuccessRate;

  return {
    baseline: baselineStats,
    candidate: candidateStats,
    commonTasks,
    dataCompleteness: completeness,
    qualityRateDelta,
    upperCostSavings: {
      pairedSamples: pairedSavings.length,
      totalUsd: totalSavings,
      meanUsdPerSample: totalSavings === null ? null : totalSavings / pairedSavings.length,
      percent: totalSavings === null || pairedBaselineCost === 0 ? null : totalSavings / pairedBaselineCost,
    },
  };
}

export function evaluateGate(comparison: RepeatedComparison, thresholds: GateThresholds): GateResult {
  if (!Number.isFinite(thresholds.maxQualityDrop) || thresholds.maxQualityDrop < 0 || thresholds.maxQualityDrop > 1) {
    throw new Error("maxQualityDrop must be in [0, 1]");
  }
  if (!Number.isFinite(thresholds.minUpperCostSavingsUsd) || thresholds.minUpperCostSavingsUsd < 0) {
    throw new Error("minUpperCostSavingsUsd must be >= 0");
  }
  if (!Number.isFinite(thresholds.maxP95WallSec) || thresholds.maxP95WallSec <= 0) {
    throw new Error("maxP95WallSec must be > 0");
  }
  const quality = comparison.qualityRateDelta;
  const savings = comparison.upperCostSavings.meanUsdPerSample;
  const p95 = comparison.candidate.wallTimeSec.p95;
  const balancedSamples =
    comparison.baseline.sampleCount > 0 && comparison.baseline.sampleCount === comparison.candidate.sampleCount;
  const completeCosts =
    balancedSamples && comparison.upperCostSavings.pairedSamples === comparison.baseline.sampleCount;
  const completeWall =
    comparison.candidate.sampleCount > 0 && comparison.candidate.wallTimeSec.count === comparison.candidate.sampleCount;
  const checks: GateCheck[] = [
    {
      name: "data_completeness",
      passed: comparison.dataCompleteness.complete,
      actual: comparison.dataCompleteness.errors.length,
      threshold: 0,
      message: comparison.dataCompleteness.complete
        ? `all tasks and ${comparison.dataCompleteness.expectedRepeat ?? 0} planned repetition(s) are complete and paired`
        : comparison.dataCompleteness.errors.join("; "),
    },
    {
      name: "quality_non_inferiority",
      passed: balancedSamples && quality !== null && quality >= -thresholds.maxQualityDrop,
      actual: quality,
      threshold: -thresholds.maxQualityDrop,
      message:
        !balancedSamples
          ? `baseline/candidate sample counts must be equal and nonzero (${comparison.baseline.sampleCount}/${comparison.candidate.sampleCount})`
          : quality === null
          ? "quality success rates are unavailable"
          : `candidate-baseline quality rate delta ${(quality * 100).toFixed(2)}pp must be >= ${(-thresholds.maxQualityDrop * 100).toFixed(2)}pp`,
    },
    {
      name: "positive_upper_cost_savings",
      passed: completeCosts && savings !== null && savings > thresholds.minUpperCostSavingsUsd,
      actual: savings,
      threshold: thresholds.minUpperCostSavingsUsd,
      message:
        !completeCosts
          ? `every balanced sample needs paired upper-level cost (${comparison.upperCostSavings.pairedSamples}/${comparison.baseline.sampleCount})`
          : savings === null
          ? "paired upper-level cost is unavailable"
          : `mean paired upper-level saving $${savings.toFixed(6)} must be > $${thresholds.minUpperCostSavingsUsd.toFixed(6)}`,
    },
    {
      name: "p95_wall_budget",
      passed: completeWall && p95 !== null && p95 <= thresholds.maxP95WallSec,
      actual: p95,
      threshold: thresholds.maxP95WallSec,
      message: !completeWall
        ? `every candidate sample needs wall time (${comparison.candidate.wallTimeSec.count}/${comparison.candidate.sampleCount})`
        : p95 === null
          ? "candidate wall time is unavailable"
          : `candidate p95 wall ${p95.toFixed(3)}s must be <= ${thresholds.maxP95WallSec}s`,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summaryFiles(resultsDir: string, agent: string, runId?: string): string[] {
  if (runId !== undefined) validateRunId(runId);
  const pattern = new RegExp(`^summary-${regexEscape(agent)}(?:\\..+)?\\.json$`);
  let files: string[];
  try {
    files = fs.readdirSync(resultsDir).filter((file) => pattern.test(file)).sort();
  } catch {
    return [];
  }
  if (!runId) return files.map((file) => path.join(resultsDir, file));
  return files
    .map((file) => path.join(resultsDir, file))
    .filter((file) => {
      const basename = path.basename(file);
      const legacyFilenameMatch = basename.includes(`.${runId}.`) || basename.endsWith(`.${runId}.json`);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(parsed)) return legacyFilenameMatch;
        const metadataMatch = parsed.some((entry) => {
          if (typeof entry !== "object" || entry === null) return false;
          const run = (entry as { run?: RepeatedSummaryEntry["run"] }).run;
          return run?.experimentId === runId || run?.runId === runId || run?.runId?.startsWith(`${runId}.`) === true;
        });
        return metadataMatch || legacyFilenameMatch;
      } catch {
        return legacyFilenameMatch;
      }
    });
}

export function readSummaryEntries(files: string[], agent: string, runId?: string): RepeatedSummaryEntry[] {
  if (runId !== undefined) validateRunId(runId);
  const entries: RepeatedSummaryEntry[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`cannot parse summary ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`summary ${file} must contain a JSON array`);
    for (let index = 0; index < parsed.length; index++) {
      const entry = parsed[index] as RepeatedSummaryEntry;
      validateEntry(entry, agent, `${file}[${index}]`);
      if (runId) {
        const matches =
          entry.run?.experimentId === runId || entry.run?.runId === runId || entry.run?.runId?.startsWith(`${runId}.`) === true;
        if (!matches && entry.run) continue;
      }
      entries.push(entry);
    }
  }
  const duplicates = duplicateErrors(agent, entries);
  if (duplicates.length > 0) throw new Error(duplicates.join("; "));
  return entries;
}
