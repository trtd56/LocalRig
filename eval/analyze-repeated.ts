#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compareRepeatedArms,
  readSummaryEntries,
  summaryFiles,
  type Distribution,
  type RepeatedComparison,
} from "./repeated-stats.ts";
import { validateRunId } from "./run-support.ts";

const ROOT = path.resolve(import.meta.dir, "..");

interface AnalyzeOptions {
  baseline: string;
  candidate: string;
  runId?: string;
  resultsDir: string;
  json: boolean;
  out?: string;
}

function parseArgs(argv: string[]): AnalyzeOptions {
  let baseline = "claude";
  let candidate = "claude-delegate";
  let runId: string | undefined;
  let resultsDir = path.join(ROOT, "eval", "results");
  let json = false;
  let out: string | undefined;
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--baseline") baseline = valueAfter(index++, arg);
    else if (arg === "--candidate") candidate = valueAfter(index++, arg);
    else if (arg === "--run-id") runId = valueAfter(index++, arg);
    else if (arg === "--results-dir") resultsDir = path.resolve(valueAfter(index++, arg));
    else if (arg === "--out") out = path.resolve(valueAfter(index++, arg));
    else if (arg === "--json") json = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (runId !== undefined) validateRunId(runId);
  return { baseline, candidate, runId, resultsDir, json, out };
}

function number(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function distributionRow(label: string, unit: string, baseline: Distribution, candidate: Distribution): string {
  const cell = (value: Distribution) =>
    `${number(value.median)} / ${number(value.p90)} / ${number(value.p95)}${unit} (n=${value.count})`;
  return `| ${label} median / p90 / p95 | ${cell(baseline)} | ${cell(candidate)} |`;
}

export function renderMarkdown(comparison: RepeatedComparison, runId?: string): string {
  const lines = [
    `# Repeated evaluation: \`${comparison.baseline.agent}\` vs \`${comparison.candidate.agent}\``,
    "",
    runId ? `Run id: \`${runId}\`` : "Run id: all matching summaries",
    "",
    `Common tasks (${comparison.commonTasks.length}): ${comparison.commonTasks.join(", ") || "none"}`,
    `Data completeness: ${comparison.dataCompleteness.complete ? "complete" : `INCOMPLETE — ${comparison.dataCompleteness.errors.join("; ")}`}`,
    "",
    "| metric | baseline | candidate |",
    "|---|---:|---:|",
    `| samples | ${comparison.baseline.sampleCount} | ${comparison.candidate.sampleCount} |`,
    `| quality success | ${comparison.baseline.passCount}/${comparison.baseline.sampleCount} (${percent(comparison.baseline.qualitySuccessRate)}) | ${comparison.candidate.passCount}/${comparison.candidate.sampleCount} (${percent(comparison.candidate.qualitySuccessRate)}) |`,
    distributionRow("wall time", "s", comparison.baseline.wallTimeSec, comparison.candidate.wallTimeSec),
    distributionRow("upper cost", " USD", comparison.baseline.upperCostUsd, comparison.candidate.upperCostUsd),
    distributionRow("total billed cost", " USD", comparison.baseline.billedCostUsd, comparison.candidate.billedCostUsd),
    `| cold / warm samples | ${comparison.baseline.coldSamples} / ${comparison.baseline.warmSamples} | ${comparison.candidate.coldSamples} / ${comparison.candidate.warmSamples} |`,
    "",
    `Quality-rate delta (candidate − baseline): **${percent(comparison.qualityRateDelta)}**.`,
    "",
    `Paired upper-level cost saving: **${number(comparison.upperCostSavings.meanUsdPerSample, 6)} USD/sample** ` +
      `(${percent(comparison.upperCostSavings.percent)}, n=${comparison.upperCostSavings.pairedSamples}, ` +
      `total ${number(comparison.upperCostSavings.totalUsd, 6)} USD).`,
    "",
    "Upper-level cost is the caller/orchestrator `costUsd`; local Ollama compute is unbilled. Total billed cost additionally includes recorded paid worker costs.",
  ];
  return `${lines.join("\n")}\n`;
}

export function analyze(options: AnalyzeOptions): RepeatedComparison {
  const baselineFiles = summaryFiles(options.resultsDir, options.baseline, options.runId);
  const candidateFiles = summaryFiles(options.resultsDir, options.candidate, options.runId);
  const baselineEntries = readSummaryEntries(baselineFiles, options.baseline, options.runId);
  const candidateEntries = readSummaryEntries(candidateFiles, options.candidate, options.runId);
  return compareRepeatedArms(options.baseline, baselineEntries, options.candidate, candidateEntries);
}

export function main(argv = process.argv.slice(2)): number {
  let options: AnalyzeOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let comparison: RepeatedComparison;
  try {
    comparison = analyze(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const output = options.json ? `${JSON.stringify(comparison, null, 2)}\n` : renderMarkdown(comparison, options.runId);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, output);
  }
  process.stdout.write(output);
  return comparison.commonTasks.length > 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
