#!/usr/bin/env bun
import * as path from "node:path";
import { compareRepeatedArms, evaluateGate, readSummaryEntries, summaryFiles, type GateThresholds } from "./repeated-stats.ts";
import { validateRunId } from "./run-support.ts";

const ROOT = path.resolve(import.meta.dir, "..");

interface GateOptions {
  baseline: string;
  candidate: string;
  runId?: string;
  resultsDir: string;
  thresholds: GateThresholds;
  json: boolean;
}

function parseFinite(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number (received ${value})`);
  return parsed;
}

function parseArgs(argv: string[]): GateOptions {
  let baseline = "claude";
  let candidate = "claude-delegate";
  let runId: string | undefined;
  let resultsDir = path.join(ROOT, "eval", "results");
  let json = false;
  const thresholds: GateThresholds = {
    maxQualityDrop: 0,
    minUpperCostSavingsUsd: 0,
    maxP95WallSec: 1800,
  };
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
    else if (arg === "--max-quality-drop") thresholds.maxQualityDrop = parseFinite(valueAfter(index++, arg), arg);
    else if (arg === "--min-cost-saving-usd" || arg === "--min-upper-cost-saving-usd") {
      thresholds.minUpperCostSavingsUsd = parseFinite(valueAfter(index++, arg), arg);
    } else if (arg === "--max-p95-sec" || arg === "--max-p95-wall-sec") {
      thresholds.maxP95WallSec = parseFinite(valueAfter(index++, arg), arg);
    } else if (arg === "--json") json = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (thresholds.maxQualityDrop < 0 || thresholds.maxQualityDrop > 1) {
    throw new Error("--max-quality-drop must be in [0, 1]");
  }
  if (thresholds.minUpperCostSavingsUsd < 0) throw new Error("--min-cost-saving-usd must be >= 0");
  if (thresholds.maxP95WallSec <= 0) throw new Error("--max-p95-sec must be > 0");
  if (runId !== undefined) validateRunId(runId);
  return { baseline, candidate, runId, resultsDir, thresholds, json };
}

export function main(argv = process.argv.slice(2)): number {
  let options: GateOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let comparison;
  let gate;
  try {
    const baseline = readSummaryEntries(summaryFiles(options.resultsDir, options.baseline, options.runId), options.baseline, options.runId);
    const candidate = readSummaryEntries(summaryFiles(options.resultsDir, options.candidate, options.runId), options.candidate, options.runId);
    comparison = compareRepeatedArms(options.baseline, baseline, options.candidate, candidate);
    gate = evaluateGate(comparison, options.thresholds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({
        gate: {
          passed: false,
          checks: [{ name: "data_completeness", passed: false, actual: null, threshold: 0, message }],
        },
        comparison: null,
      }, null, 2));
    } else {
      console.log(`FAIL  data_completeness: ${message}`);
      console.log("FAIL  repeated evaluation gate");
    }
    return 1;
  }
  if (options.json) {
    console.log(JSON.stringify({ gate, comparison }, null, 2));
  } else {
    for (const check of gate.checks) console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}: ${check.message}`);
    console.log(`${gate.passed ? "PASS" : "FAIL"}  repeated evaluation gate`);
  }
  return gate.passed ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
