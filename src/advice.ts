import {
  evaluateKindGate,
  type DimensionCoverage,
  type KindGate,
  type KindStats,
  type Stats,
} from "./session.ts";

export type AdviceRoute =
  | "direct"
  | "script"
  | "delegate"
  | "batch"
  | "distill"
  | "scout"
  | "diff"
  | "research";

export type AdviceRisk = "low" | "medium" | "high" | "unknown";

/** Mechanically observable facts supplied by the upstream coding agent. */
export interface AdviceInput {
  task: string;
  kind?: string;
  /** Number of known input/target files. */
  files?: number;
  /** Number of known input/target lines. */
  lines?: number;
  /** Number of known input/target bytes. */
  bytes?: number;
  check?: boolean;
  risk?: AdviceRisk;
  caller?: string;
  model?: string;
  hardware?: string;
  latencyBudgetMs?: number;
  batchCandidates?: number;
  webSources?: number;
  scriptable?: boolean;
}

export interface AdviceResult {
  route: AdviceRoute;
  /** True when the route calls a LocalRig model; false for direct/script. */
  recommended: boolean;
  /** Router confidence, 0..1 (not the model success probability). */
  confidence: number;
  reasons: string[];
  estimated_success_lower_bound: number | null;
  p50_ms: number | null;
  p90_ms: number | null;
  sample_size: number;
  coverage_rate: number | null;
  dimension_coverage_rate: number | null;
  dimension_matched: number;
  dimension_unknown: number;
  dimension_excluded: number;
  rework_rate: number | null;
  gate: KindGate;
}

export interface ParsedAdviceArgs {
  input: AdviceInput;
  json: boolean;
}

export class AdviceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdviceConfigError";
  }
}

interface RelevantStats {
  sampleSize: number;
  successLowerBound: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  reworkRate: number | null;
  coverageRate: number | null;
  dimensionCoverage: DimensionCoverage;
  gate: KindGate;
}

const emptyDimensionCoverage = (): DimensionCoverage => ({
  matched: 0,
  unknown: 0,
  excluded: 0,
  eligible: 0,
  rate: null,
});

function conservativeCoverage(slice: number | null, overall: number | null): number | null {
  if (slice === null || overall === null) return null;
  return Math.min(slice, overall);
}

const DISTILL_LINES = 1_000;
const DISTILL_BYTES = 64 * 1024;
const LARGE_DIFF_LINES = 500;
const LARGE_DIFF_BYTES = 32 * 1024;
const SMALL_TASK_LINES = 100;
const SMALL_TASK_BYTES = 16 * 1024;
const MAX_REWORK_RATE = 25;
const MIN_COVERAGE_RATE = 50;

function relevantStats(kindValue: string | undefined, stats: Stats): RelevantStats {
  const kind = kindValue?.trim();
  const byKind: KindStats | undefined = kind
    ? stats.byKind?.find((candidate) => candidate.kind === kind)
    : undefined;
  if (kind && !byKind) {
    return {
      sampleSize: 0,
      successLowerBound: null,
      p50Ms: null,
      p90Ms: null,
      reworkRate: null,
      coverageRate: null,
      dimensionCoverage: emptyDimensionCoverage(),
      gate: evaluateKindGate(0, null),
    };
  }
  if (byKind) {
    const coverageRate = conservativeCoverage(byKind.coverageRate, stats.coverageRate);
    return {
      sampleSize: byKind.graded,
      successLowerBound: byKind.successLowerBound,
      p50Ms: byKind.p50DurationMs,
      p90Ms: byKind.p90DurationMs,
      reworkRate: byKind.reworkRate,
      coverageRate,
      dimensionCoverage: byKind.dimensionCoverage,
      gate: evaluateKindGate(byKind.graded, byKind.rate, {
        successLowerBound: byKind.successLowerBound,
        coverageRate,
      }),
    };
  }
  return {
    sampleSize: stats.graded,
    successLowerBound: stats.successLowerBound,
    p50Ms: stats.p50DurationMs,
    p90Ms: stats.p90DurationMs,
    reworkRate: stats.reworkRate,
    coverageRate: stats.coverageRate,
    dimensionCoverage: stats.dimensionCoverage,
    gate: evaluateKindGate(stats.graded, stats.rate, {
      successLowerBound: stats.successLowerBound,
      coverageRate: stats.coverageRate,
    }),
  };
}

function finish(
  route: AdviceRoute,
  confidence: number,
  reasons: string[],
  evidence: RelevantStats,
): AdviceResult {
  return {
    route,
    recommended: route !== "direct" && route !== "script",
    confidence,
    reasons,
    estimated_success_lower_bound: evidence.successLowerBound,
    p50_ms: evidence.p50Ms,
    p90_ms: evidence.p90Ms,
    sample_size: evidence.sampleSize,
    coverage_rate: evidence.coverageRate,
    dimension_coverage_rate: evidence.dimensionCoverage.rate,
    dimension_matched: evidence.dimensionCoverage.matched,
    dimension_unknown: evidence.dimensionCoverage.unknown,
    dimension_excluded: evidence.dimensionCoverage.excluded,
    rework_rate: evidence.reworkRate,
    gate: evidence.gate,
  };
}

function isLocationTask(input: AdviceInput, normalizedTask: string): boolean {
  if (input.kind === "scout" || input.kind === "location" || input.kind === "investigation") return true;
  return /\b(where|locate|location|which files?|find (?:the )?(?:implementation|definition|owner))\b|所在|どこ|場所/.test(normalizedTask);
}

function isDiffTask(input: AdviceInput, normalizedTask: string): boolean {
  return input.kind === "diff" || /\b(diff|patch|changeset)\b|差分/.test(normalizedTask);
}

/**
 * Pick the cheapest safe route. Candidate selection is mechanical, but every
 * route that calls a LocalRig model must clear the same evidence/risk/check/
 * latency gates before it can be recommended.
 */
export function advise(input: AdviceInput, stats: Stats): AdviceResult {
  const task = input.task.trim();
  if (!task) throw new AdviceConfigError("task must not be empty");
  for (const [name, value] of [
    ["files", input.files],
    ["lines", input.lines],
    ["bytes", input.bytes],
    ["batchCandidates", input.batchCandidates],
    ["webSources", input.webSources],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new AdviceConfigError(`${name} must be a safe integer >= 0`);
    }
  }
  if (input.latencyBudgetMs !== undefined && (!Number.isFinite(input.latencyBudgetMs) || input.latencyBudgetMs < 0)) {
    throw new AdviceConfigError("latencyBudgetMs must be a finite number >= 0");
  }
  if (input.risk !== undefined && !new Set<AdviceRisk>(["low", "medium", "high", "unknown"]).has(input.risk)) {
    throw new AdviceConfigError("risk must be low, medium, high, or unknown");
  }
  const normalizedTask = task.toLowerCase();
  let candidate: AdviceRoute;
  let evidenceKind: string | undefined;
  let candidateReason: string;
  if ((input.webSources ?? 0) >= 2 || input.kind === "research") {
    candidate = "research";
    evidenceKind = "research";
    candidateReason = "multiple Web sources need semantic selection";
  } else if (isDiffTask(input, normalizedTask) &&
    ((input.lines ?? 0) >= LARGE_DIFF_LINES || (input.bytes ?? 0) >= LARGE_DIFF_BYTES || input.kind === "diff")
  ) {
    candidate = "diff";
    evidenceKind = "diff";
    candidateReason = "a large or explicitly tagged diff should be reduced with verified citations";
  } else if ((input.files ?? 0) >= 5 && isLocationTask(input, normalizedTask)) {
    candidate = "scout";
    evidenceKind = "scout";
    candidateReason = "repository-location work is expected to inspect at least five files";
  } else if ((input.lines ?? 0) >= DISTILL_LINES || (input.bytes ?? 0) >= DISTILL_BYTES) {
    candidate = "distill";
    evidenceKind = "distill";
    candidateReason = "known input meets the 1000-line or 64-KiB distillation threshold";
  } else if (input.scriptable) {
    candidate = "script";
    evidenceKind = input.kind;
    candidateReason = "the transformation is mechanically codifiable, so a script avoids model overhead";
  } else {
    candidate = (input.batchCandidates ?? 0) >= 2 ? "batch" : "delegate";
    evidenceKind = input.kind;
    candidateReason = candidate === "batch"
      ? "multiple independent eligible tasks can amortize the fixed session cost"
      : "task is large, low/medium risk, objectively checkable, and clears the historical gate";
  }

  const evidence = relevantStats(evidenceKind, stats);
  const coverage = evidence.coverageRate;

  // Risk classification applies even to script/preprocessing suggestions. A
  // high or unclassified risk stays with the upstream agent; read-only local
  // routes reduce context but still expose evidence to a fallible model.
  if (input.risk === "high") {
    return finish("direct", 0.93, ["high-risk changes require upstream judgement"], evidence);
  }
  if (input.risk === undefined || input.risk === "unknown") {
    return finish("direct", 0.8, ["risk was not classified; conservative routing keeps the task upstream"], evidence);
  }

  // Script is the only non-direct route that does not call a LocalRig model,
  // so historical model gates and latency do not apply after risk is cleared.
  if (candidate === "script") return finish("script", 0.92, [candidateReason], evidence);

  if (candidate === "delegate" || candidate === "batch") {
    const sizeKnown = input.files !== undefined || input.lines !== undefined || input.bytes !== undefined;
    if (!sizeKnown) {
      return finish("direct", 0.82, ["task size is unknown, so delegation's fixed cost cannot be justified"], evidence);
    }
    const smallTask = (input.files ?? 0) <= 1 &&
      (input.lines ?? 0) < SMALL_TASK_LINES &&
      (input.bytes ?? 0) < SMALL_TASK_BYTES;
    if (smallTask) return finish("direct", 0.9, ["the task is below the delegation cost floor"], evidence);
    if (!evidenceKind?.trim()) {
      return finish("direct", 0.86, ["implementation delegation requires an explicit task kind"], evidence);
    }
  }

  if (!input.check) {
    return finish("direct", 0.9, ["no objective acceptance check was supplied for the proposed local route"], evidence);
  }

  if (evidence.gate.status === "block") {
    return finish("direct", 0.97, [`delegation gate blocked this evidence slice: ${evidence.gate.reason}`], evidence);
  }
  if (evidence.gate.status === "insufficient_data") {
    return finish("direct", 0.78, [`delegation evidence is insufficient: ${evidence.gate.reason}`], evidence);
  }
  if (evidence.gate.status !== "allow") {
    return finish("direct", 0.9, ["delegation gate returned an invalid status"], evidence);
  }

  if (coverage === null || !Number.isFinite(coverage) || coverage < 0 || coverage > 100) {
    return finish("direct", 0.82, ["feedback coverage is unavailable or invalid"], evidence);
  }
  if (coverage < MIN_COVERAGE_RATE) {
    return finish("direct", 0.84, [`feedback coverage ${coverage}% is below ${MIN_COVERAGE_RATE}%`], evidence);
  }
  if (evidence.reworkRate === null || !Number.isFinite(evidence.reworkRate) || evidence.reworkRate < 0 || evidence.reworkRate > 100) {
    return finish("direct", 0.84, ["rework-rate evidence is unavailable or invalid"], evidence);
  }
  if (evidence.reworkRate > MAX_REWORK_RATE) {
    return finish("direct", 0.88, [`rework rate ${evidence.reworkRate}% exceeds ${MAX_REWORK_RATE}%`], evidence);
  }

  if (input.latencyBudgetMs !== undefined) {
    if (evidence.p90Ms === null || !Number.isFinite(evidence.p90Ms) || evidence.p90Ms < 0) {
      return finish("direct", 0.8, ["no p90 duration is available for the latency budget"], evidence);
    }
    if (evidence.p90Ms > input.latencyBudgetMs) {
      return finish(
        "direct",
        0.92,
        [`p90 duration ${evidence.p90Ms}ms exceeds the ${input.latencyBudgetMs}ms latency budget`],
        evidence,
      );
    }
  }

  const confidence = Math.min(0.96, 0.75 + Math.min(evidence.sampleSize, 20) / 100);
  return finish(candidate, confidence, [candidateReason, evidence.gate.reason], evidence);
}

function parseNonNegativeInteger(raw: string | undefined, flag: string): number {
  if (raw === undefined || !raw.trim()) throw new AdviceConfigError(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new AdviceConfigError(`${flag} must be a safe integer >= 0`);
  return value;
}

function parseNonNegativeNumber(raw: string | undefined, flag: string): number {
  if (raw === undefined || !raw.trim()) throw new AdviceConfigError(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new AdviceConfigError(`${flag} must be a finite number >= 0`);
  return value;
}

/** Strict, subcommand-specific parser; unknown flags never fall through. */
export function parseAdviceArgs(argv: string[]): ParsedAdviceArgs {
  let task: string | undefined;
  let json = false;
  let checkFlag: "check" | "no-check" | undefined;
  const input: Partial<AdviceInput> = {};
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || !value.trim() || value.startsWith("-")) throw new AdviceConfigError(`${flag} requires a value`);
    return value;
  };
  const setTask = (value: string, flag: string) => {
    if (task !== undefined) throw new AdviceConfigError(`${flag} conflicts with the task already supplied`);
    task = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "-p":
      case "--prompt":
      case "--task":
        setTask(valueAfter(i, flag), flag);
        i++;
        break;
      case "--kind":
        input.kind = valueAfter(i, flag);
        i++;
        break;
      case "--files":
        input.files = parseNonNegativeInteger(argv[++i], flag);
        break;
      case "--lines":
      case "--input-lines":
        input.lines = parseNonNegativeInteger(argv[++i], flag);
        break;
      case "--bytes":
      case "--input-bytes":
        input.bytes = parseNonNegativeInteger(argv[++i], flag);
        break;
      case "--check":
        if (checkFlag === "no-check") throw new AdviceConfigError("--check and --no-check are mutually exclusive");
        checkFlag = "check";
        input.check = true;
        break;
      case "--no-check":
        if (checkFlag === "check") throw new AdviceConfigError("--check and --no-check are mutually exclusive");
        checkFlag = "no-check";
        input.check = false;
        break;
      case "--risk": {
        const risk = valueAfter(i, flag);
        if (risk !== "low" && risk !== "medium" && risk !== "high" && risk !== "unknown") {
          throw new AdviceConfigError("--risk must be low, medium, high, or unknown");
        }
        input.risk = risk;
        i++;
        break;
      }
      case "--caller":
        input.caller = valueAfter(i, flag);
        i++;
        break;
      case "--model":
        input.model = valueAfter(i, flag);
        i++;
        break;
      case "--hardware":
        input.hardware = valueAfter(i, flag);
        i++;
        break;
      case "--latency-budget":
        input.latencyBudgetMs = parseNonNegativeNumber(argv[++i], flag) * 1_000;
        if (!Number.isFinite(input.latencyBudgetMs)) throw new AdviceConfigError("--latency-budget is too large");
        break;
      case "--latency-budget-ms":
        input.latencyBudgetMs = parseNonNegativeNumber(argv[++i], flag);
        break;
      case "--batch-candidates":
      case "--batch-size":
        input.batchCandidates = parseNonNegativeInteger(argv[++i], flag);
        break;
      case "--web-sources":
        input.webSources = parseNonNegativeInteger(argv[++i], flag);
        break;
      case "--scriptable":
        input.scriptable = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        if (flag.startsWith("-")) throw new AdviceConfigError(`unknown advise option: ${flag}`);
        setTask(flag, "positional task");
        break;
    }
  }

  if (task === undefined || !task.trim()) throw new AdviceConfigError("advise requires --task/--prompt or one positional task");
  return { input: { ...input, task }, json };
}
