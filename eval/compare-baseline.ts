#!/usr/bin/env bun
// Compares a saved baseline summary against a current summary run, so a model
// upgrade (or any other change to the harness) can be checked for regressions
// before it's trusted.
//
//   bun run eval/compare-baseline.ts --baseline eval/baselines/qwen36-27b-mtp.json --summary eval/results/summary-harness.json
//
// The baseline file is the {model, capturedAt, note, results: [...]} wrapper
// written by hand (see eval/baselines/), while the summary file is the plain
// array eval/run.ts writes to eval/results/summary-<agent>.json. Emits a
// per-task Markdown table (pass/fail, durationSec, promptTokens,
// completionTokens) plus a totals section, to stdout.

import * as fs from "node:fs";

interface Entry {
  task: string;
  passed?: boolean;
  durationSec?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface BaselineFile {
  model?: string;
  capturedAt?: string;
  note?: string;
  results: Entry[];
}

function parseArgs(): { baseline: string; summary: string } {
  const argv = process.argv.slice(2);
  let baseline: string | undefined;
  let summary: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline") baseline = argv[++i];
    else if (argv[i] === "--summary") summary = argv[++i];
  }
  if (!baseline || !summary) {
    console.error("usage: bun run eval/compare-baseline.ts --baseline <path> --summary <path>");
    process.exit(1);
  }
  return { baseline, summary };
}

function readBaseline(p: string): BaselineFile {
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  return { results: Array.isArray(parsed.results) ? parsed.results : [], ...parsed };
}

function readSummary(p: string): Entry[] {
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

// ---------- formatting helpers ----------

const dash = "—";
const int = (n: number | undefined) => (n === undefined ? dash : Math.round(n).toLocaleString("en-US"));
const secs = (n: number | undefined) => (n === undefined ? dash : `${n}s`);
const pass = (b: boolean | undefined) => (b === undefined ? dash : b ? "PASS" : "FAIL");

/** Signed delta, "—" when either side is missing, "0" when unchanged. */
function delta(base: number | undefined, cur: number | undefined): string {
  if (base === undefined || cur === undefined) return dash;
  const d = cur - base;
  if (d === 0) return "0";
  return d > 0 ? `+${int(d)}` : `${int(d)}`;
}

/** "PASS→FAIL" style transition marker; "" (no flag) when unchanged or either side unknown. */
function passFlag(base: boolean | undefined, cur: boolean | undefined): string {
  if (base === undefined || cur === undefined || base === cur) return "";
  return base && !cur ? " ⚠ regressed" : " ✓ fixed";
}

function main(): void {
  const { baseline: baselinePath, summary: summaryPath } = parseArgs();
  const baseline = readBaseline(baselinePath);
  const current = readSummary(summaryPath);

  const baseByTask = new Map(baseline.results.map((e) => [e.task, e]));
  const curByTask = new Map(current.map((e) => [e.task, e]));
  const tasks = [...new Set([...baseByTask.keys(), ...curByTask.keys()])].sort();

  const lines: string[] = [];
  lines.push("# Baseline comparison");
  lines.push("");
  lines.push(`Baseline: \`${baselinePath}\` (model: ${baseline.model ?? dash}, captured: ${baseline.capturedAt ?? dash})`);
  if (baseline.note) lines.push(`Note: ${baseline.note}`);
  lines.push(`Current: \`${summaryPath}\``);
  lines.push("");
  lines.push("## Per-task");
  lines.push("");
  lines.push("| task | pass (base→cur) | duration base→cur (Δ) | promptTokens base→cur (Δ) | completionTokens base→cur (Δ) |");
  lines.push("|---|---|---|---|---|");

  let basePassCount = 0;
  let curPassCount = 0;
  let baseDurationSum = 0;
  let curDurationSum = 0;
  let basePromptSum = 0;
  let curPromptSum = 0;
  let baseCompletionSum = 0;
  let curCompletionSum = 0;
  const bothTasks: string[] = [];

  for (const task of tasks) {
    const b = baseByTask.get(task);
    const c = curByTask.get(task);
    const onlyIn = !b ? " (current only)" : !c ? " (baseline only)" : "";

    lines.push(
      `| ${task}${onlyIn} | ${pass(b?.passed)}→${pass(c?.passed)}${passFlag(b?.passed, c?.passed)} | ` +
        `${secs(b?.durationSec)}→${secs(c?.durationSec)} (${delta(b?.durationSec, c?.durationSec)}) | ` +
        `${int(b?.promptTokens)}→${int(c?.promptTokens)} (${delta(b?.promptTokens, c?.promptTokens)}) | ` +
        `${int(b?.completionTokens)}→${int(c?.completionTokens)} (${delta(b?.completionTokens, c?.completionTokens)}) |`,
    );

    if (b && c) {
      bothTasks.push(task);
      if (b.passed) basePassCount++;
      if (c.passed) curPassCount++;
      baseDurationSum += b.durationSec ?? 0;
      curDurationSum += c.durationSec ?? 0;
      basePromptSum += b.promptTokens ?? 0;
      curPromptSum += c.promptTokens ?? 0;
      baseCompletionSum += b.completionTokens ?? 0;
      curCompletionSum += c.completionTokens ?? 0;
    }
  }

  lines.push("");
  lines.push("## Totals");
  lines.push("");
  const n = bothTasks.length;
  if (n === 0) {
    lines.push("_No task appears in both the baseline and the current summary, so there is nothing to aggregate._");
  } else {
    lines.push(`Totals below cover only the ${n} task${n === 1 ? "" : "s"} present in **both** files.`);
    lines.push("");
    lines.push("| metric | baseline | current | Δ |");
    lines.push("|---|---|---|---|");
    lines.push(`| passed | ${basePassCount}/${n} | ${curPassCount}/${n} | ${delta(basePassCount, curPassCount)} |`);
    lines.push(`| total duration | ${secs(baseDurationSum)} | ${secs(curDurationSum)} | ${delta(baseDurationSum, curDurationSum)} |`);
    lines.push(`| total promptTokens | ${int(basePromptSum)} | ${int(curPromptSum)} | ${delta(basePromptSum, curPromptSum)} |`);
    lines.push(
      `| total completionTokens | ${int(baseCompletionSum)} | ${int(curCompletionSum)} | ${delta(baseCompletionSum, curCompletionSum)} |`,
    );
  }
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

main();
