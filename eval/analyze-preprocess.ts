#!/usr/bin/env bun
// Aggregates preprocessing eval runs (claude baseline vs claude-scout /
// claude-research / future claude-distill arms). Designed for P2 n=3 runs written with
// eval/run.ts --run-id <id>.
//
//   bun run eval/analyze-preprocess.ts --baseline-agent claude --arm-agent claude-scout --task scout-locate

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RESULTS_DIR = path.join(ROOT, "eval", "results");
const OUT_FILE = path.join(RESULTS_DIR, "preprocess-comparison.md");

interface DelegationMetric {
  sessionId?: string;
  kind?: string;
  digestNotFound?: boolean;
  digestCitationsDropped?: number;
  digestCitationCount?: number;
  digestParseFailed?: boolean;
  citationRecall?: number;
  inputTokens?: number;
  outputTokens?: number;
  compressionRatio?: number;
  fetchedPageCount?: number;
}

interface Entry {
  task: string;
  agent?: string;
  passed?: boolean;
  durationSec?: number;
  costUsd?: number;
  delegated?: boolean;
  delegations?: DelegationMetric[];
  preprocessQualityFailed?: boolean;
}

interface RunEntry extends Entry {
  summaryFile: string;
}

function parseArgs(): { baselineAgent: string; armAgent: string; task?: string; outFile: string } {
  const argv = process.argv.slice(2);
  let baselineAgent = "claude";
  let armAgent = "claude-scout";
  let task: string | undefined;
  let outFile = OUT_FILE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline-agent") baselineAgent = argv[++i]!;
    else if (argv[i] === "--arm-agent") armAgent = argv[++i]!;
    else if (argv[i] === "--task") task = argv[++i];
    else if (argv[i] === "--out") outFile = argv[++i]!;
  }
  return { baselineAgent, armAgent, task, outFile };
}

function summaryFiles(agent: string): string[] {
  const exact = `summary-${agent}.json`;
  const prefix = `summary-${agent}.`;
  try {
    return fs
      .readdirSync(RESULTS_DIR)
      .filter((f) => f === exact || (f.startsWith(prefix) && f.endsWith(".json")))
      .sort()
      .map((f) => path.join(RESULTS_DIR, f));
  } catch {
    return [];
  }
}

function readRuns(agent: string, task?: string): RunEntry[] {
  const out: RunEntry[] = [];
  for (const file of summaryFiles(agent)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed as Entry[]) {
      if (task && entry.task !== task) continue;
      out.push({ ...entry, summaryFile: path.basename(file) });
    }
  }
  return out;
}

function median(values: number[]): number | undefined {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1]! + nums[mid]!) / 2;
}

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${Math.round(n * 100)}%`;
}

function money(n: number | undefined): string {
  return n === undefined ? "—" : `$${n.toFixed(4)}`;
}

function secs(n: number | undefined): string {
  return n === undefined ? "—" : `${Math.round(n)}s`;
}

function preprocessRuns(runs: RunEntry[]): DelegationMetric[] {
  return runs
    .flatMap((r) => r.delegations ?? [])
    .filter((d) => d.kind === "scout" || d.kind === "distill" || d.kind === "research");
}

function renderAgent(agent: string, runs: RunEntry[]): string[] {
  const lines: string[] = [];
  const pp = preprocessRuns(runs);
  const costs = runs.map((r) => r.costUsd).filter((n): n is number => typeof n === "number");
  const durations = runs.map((r) => r.durationSec).filter((n): n is number => typeof n === "number");
  const recall = pp.map((d) => d.citationRecall).filter((n): n is number => typeof n === "number");
  const drops = pp
    .map((d) => d.digestCitationsDropped)
    .filter((n): n is number => typeof n === "number")
    .reduce((a, b) => a + b, 0);
  const delegated = runs.filter((r) => r.delegated).length;
  const pass = runs.filter((r) => r.passed).length;
  const qualityFail = runs.filter((r) => r.preprocessQualityFailed).length;
  const compression = pp.map((d) => d.compressionRatio).filter((n): n is number => typeof n === "number");
  const fetched = pp.map((d) => d.fetchedPageCount).filter((n): n is number => typeof n === "number");

  lines.push(
    `| ${agent} | ${runs.length} | ${pass}/${runs.length} | ${money(median(costs))} | ${secs(median(durations))} | ` +
      `${delegated}/${runs.length} | ${pct(median(recall))} | ${drops} | ${median(compression)?.toFixed(3) ?? "—"} | ` +
      `${median(fetched)?.toFixed(1) ?? "—"} | ${qualityFail} |`,
  );
  return lines;
}

function main(): void {
  const { baselineAgent, armAgent, task, outFile } = parseArgs();
  const baseline = readRuns(baselineAgent, task);
  const arm = readRuns(armAgent, task);
  const tasks = [...new Set([...baseline, ...arm].map((r) => r.task))].sort();

  const lines: string[] = [];
  lines.push("# Preprocessing comparison");
  lines.push("");
  lines.push(`Baseline agent: \`${baselineAgent}\``);
  lines.push(`Preprocess arm: \`${armAgent}\``);
  if (task) lines.push(`Task filter: \`${task}\``);
  lines.push("");
  lines.push("## Rollup");
  lines.push("");
  lines.push("| agent | runs | pass | median cost | median wall | preprocess used | median citation recall | citation drops | median compression | median pages | quality fails |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(...renderAgent(baselineAgent, baseline));
  lines.push(...renderAgent(armAgent, arm));
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| task | agent | summary | pass | cost | wall | preprocess used | recall | drops |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|");
  for (const t of tasks) {
    for (const r of [...baseline, ...arm].filter((e) => e.task === t)) {
      const pp = preprocessRuns([r]);
      const recall = median(pp.map((d) => d.citationRecall).filter((n): n is number => typeof n === "number"));
      const drops = pp
        .map((d) => d.digestCitationsDropped)
        .filter((n): n is number => typeof n === "number")
        .reduce((a, b) => a + b, 0);
      lines.push(
        `| ${r.task} | ${r.agent ?? "—"} | ${r.summaryFile} | ${r.passed ? "PASS" : "FAIL"} | ` +
          `${money(r.costUsd)} | ${secs(r.durationSec)} | ${r.delegated ? "yes" : "no"} | ${pct(recall)} | ${drops} |`,
      );
    }
  }
  lines.push("");
  lines.push("Notes: compare only same-day, same Claude CLI version, warm-cache runs. Missing cost means the raw summary did not include `total_cost_usd`.");
  lines.push("");

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join("\n"));
  process.stdout.write(lines.join("\n") + "\n");
}

main();
