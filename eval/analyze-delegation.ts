#!/usr/bin/env bun
// Compares the `claude` baseline arm against `claude-delegate` and reports
// whether delegating to the local `lh` CLI actually saved Claude API cost.
//
//   bun run eval/analyze-delegation.ts
//
// Reads eval/results/summary-claude.json (baseline) and
// summary-claude-delegate.json, emits a markdown report to stdout AND writes it
// to eval/results/delegation-comparison.md. Cost is the primary metric: dollars
// are billed, whereas the prompt-token counts here include prompt-cache reads
// and creation and so overstate "real" prompt size (see the caveats section).

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RESULTS_DIR = path.join(ROOT, "eval", "results");
const OUT_FILE = path.join(RESULTS_DIR, "delegation-comparison.md");

interface Delegation {
  sessionId: string;
  status: string;
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  errorKind?: string;
}

// Only the fields this report reads; summary entries carry more (see run.ts
// TaskResult). All optional so older/partial summaries don't blow up.
interface Entry {
  task: string;
  passed?: boolean;
  durationSec?: number;
  turns?: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  delegated?: boolean;
  delegations?: Delegation[];
  feedback?: { sessionId: string; verdict: string; notes?: string }[];
}

function readSummary(agent: string): Entry[] {
  const p = path.join(RESULTS_DIR, `summary-${agent}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Recover a run's dollar cost from the raw agent log when the summary entry
 * predates costUsd capture. The claude CLI's result JSON (with total_cost_usd)
 * is one of the `{`-lines in <agent>-<task>.log; scan from the end for the
 * first parseable one that has it. Tolerates a missing log.
 */
function costFromLog(agent: string, task: string): number | undefined {
  const p = path.join(RESULTS_DIR, `${agent}-${task}.log`);
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.total_cost_usd === "number") return obj.total_cost_usd;
    } catch {
      // Not the JSON line we want; keep scanning older lines.
    }
  }
  return undefined;
}

function costOf(agent: string, e: Entry | undefined): number | undefined {
  if (!e) return undefined;
  return e.costUsd ?? costFromLog(agent, e.task);
}

// ---------- formatting helpers ----------

const dash = "—";
const money = (n: number | undefined) => (n === undefined ? dash : `$${n.toFixed(4)}`);
const int = (n: number | undefined) => (n === undefined ? dash : Math.round(n).toLocaleString("en-US"));
const secs = (n: number | undefined) => (n === undefined ? dash : `${n}s`);
const yesno = (b: boolean | undefined) => (b === undefined ? dash : b ? "yes" : "no");
const pass = (b: boolean | undefined) => (b === undefined ? dash : b ? "PASS" : "FAIL");

/** "base→deleg" with both sides formatted by `fmt`. */
function pair<T>(base: T | undefined, deleg: T | undefined, fmt: (v: T | undefined) => string): string {
  return `${fmt(base)} → ${fmt(deleg)}`;
}

/** Percent of baseline cost saved by delegating (positive = cheaper). */
function savedPct(base: number | undefined, deleg: number | undefined): string {
  if (base === undefined || deleg === undefined || base === 0) return dash;
  const pct = ((base - deleg) / base) * 100;
  const sign = pct > 0 ? "" : "+"; // negative pct = got more expensive; show +N% cost
  return pct >= 0 ? `${pct.toFixed(0)}% saved` : `${sign}${(-pct).toFixed(0)}% cost`;
}

/** Local-side rollup for one delegate entry: total tokens / wall time (calls). */
function localSide(e: Entry | undefined): string {
  if (!e || !e.delegated || !e.delegations || e.delegations.length === 0) return dash;
  let tok = 0;
  let ms = 0;
  for (const d of e.delegations) {
    tok += (d.promptTokens ?? 0) + (d.completionTokens ?? 0);
    ms += d.durationMs ?? 0;
  }
  const n = e.delegations.length;
  return `${int(tok)} tok / ${Math.round(ms / 1000)}s (${n} call${n === 1 ? "" : "s"})`;
}

function main(): void {
  const baseArr = readSummary("claude");
  const delegArr = readSummary("claude-delegate");
  const baseByTask = new Map(baseArr.map((e) => [e.task, e]));
  const delegByTask = new Map(delegArr.map((e) => [e.task, e]));

  const tasks = [...new Set([...baseByTask.keys(), ...delegByTask.keys()])].sort();

  const lines: string[] = [];
  lines.push("# Delegation comparison: `claude` vs `claude-delegate`");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "Does having Claude Code delegate the implementation to the local `lh` CLI " +
      "save Claude API cost versus Claude Code doing the task itself? " +
      "**Cost (USD) is the primary metric.**",
  );
  lines.push("");

  if (tasks.length === 0) {
    lines.push(
      "_No results found. Run both arms first, e.g. " +
        "`bun run eval/run.ts --agent claude --task doc-sync` and " +
        "`bun run eval/run.ts --agent claude-delegate --task doc-sync`._",
    );
    const out = lines.join("\n") + "\n";
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, out);
    process.stdout.write(out);
    return;
  }

  // ---- per-task table ----
  lines.push("## Per-task");
  lines.push("");
  lines.push(
    "| task | pass (base→deleg) | cost base→deleg | Claude saved | output tok base→deleg | prompt tok\\* base→deleg | turns base→deleg | wall base→deleg | delegated? | local-side (tok / dur) |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

  // Aggregates
  let baseCostSum = 0;
  let delegCostSum = 0;
  let baseCostKnown = false;
  let delegCostKnown = false;
  let baseOut = 0;
  let delegOut = 0;
  let basePrompt = 0;
  let delegPrompt = 0;
  let baseWall = 0;
  let delegWall = 0;
  let basePass = 0;
  let delegPass = 0;
  // Totals cover only the intersection — tasks with an entry in BOTH arms — so
  // the aggregate cost comparison is apples-to-apples. The per-task table above
  // still lists every baseline task (delegate-less rows show "—").
  const bothTasks: string[] = [];
  let localTok = 0;
  let localMs = 0;
  let delegatedCount = 0;

  for (const task of tasks) {
    const b = baseByTask.get(task);
    const d = delegByTask.get(task);
    const bCost = costOf("claude", b);
    const dCost = costOf("claude-delegate", d);

    lines.push(
      `| ${task} | ${pair(b?.passed, d?.passed, pass)} | ${pair(bCost, dCost, money)} | ${savedPct(bCost, dCost)} | ` +
        `${pair(b?.completionTokens, d?.completionTokens, int)} | ${pair(b?.promptTokens, d?.promptTokens, int)} | ` +
        `${pair(b?.turns, d?.turns, int)} | ${pair(b?.durationSec, d?.durationSec, secs)} | ${yesno(d?.delegated)} | ${localSide(d)} |`,
    );

    // Aggregate only over tasks present in both arms.
    if (b && d) {
      bothTasks.push(task);
      if (b.passed) basePass++;
      if (d.passed) delegPass++;
      if (bCost !== undefined) {
        baseCostSum += bCost;
        baseCostKnown = true;
      }
      if (dCost !== undefined) {
        delegCostSum += dCost;
        delegCostKnown = true;
      }
      baseOut += b.completionTokens ?? 0;
      delegOut += d.completionTokens ?? 0;
      basePrompt += b.promptTokens ?? 0;
      delegPrompt += d.promptTokens ?? 0;
      baseWall += b.durationSec ?? 0;
      delegWall += d.durationSec ?? 0;
      if (d.delegated) delegatedCount++;
      for (const del of d.delegations ?? []) {
        localTok += (del.promptTokens ?? 0) + (del.completionTokens ?? 0);
        localMs += del.durationMs ?? 0;
      }
    }
  }

  // ---- aggregate totals (intersection only) ----
  const baseCostAgg = baseCostKnown ? baseCostSum : undefined;
  const delegCostAgg = delegCostKnown ? delegCostSum : undefined;
  const bothN = bothTasks.length;

  lines.push("");
  lines.push("## Totals");
  lines.push("");
  if (bothN === 0) {
    lines.push(
      "_No task has been run in both arms yet, so there is nothing to aggregate. " +
        "Run the delegate arm on a task that also has a baseline entry, e.g. " +
        "`bun run eval/run.ts --agent claude-delegate --task doc-sync`._",
    );
    lines.push("");
  } else {
    lines.push(
      `Totals below cover only the ${bothN} task${bothN === 1 ? "" : "s"} run in **both** arms ` +
        `(${bothTasks.join(", ")}); the per-task table above lists all baseline tasks.`,
    );
    lines.push("");
    lines.push("| metric | baseline (claude) | delegate (claude-delegate) |");
    lines.push("|---|---|---|");
    lines.push(`| tasks (both arms) | ${bothN} | ${bothN} |`);
    lines.push(`| passed | ${basePass}/${bothN} | ${delegPass}/${bothN} |`);
    lines.push(`| Claude cost | ${money(baseCostAgg)} | ${money(delegCostAgg)} |`);
    lines.push(`| Claude output tokens | ${int(baseOut)} | ${int(delegOut)} |`);
    lines.push(`| Claude prompt tokens\\* | ${int(basePrompt)} | ${int(delegPrompt)} |`);
    lines.push(`| Claude wall time | ${secs(baseWall)} | ${secs(delegWall)} |`);
    lines.push(`| tasks delegated | ${dash} | ${delegatedCount}/${bothN} |`);
    lines.push(`| local-side compute (Ollama) | ${dash} | ${int(localTok)} tok |`);
    lines.push(`| local-side duration (Ollama) | ${dash} | ${secs(Math.round(localMs / 1000))} |`);
    lines.push("");

    if (baseCostAgg !== undefined && delegCostAgg !== undefined) {
      lines.push(`**Net Claude cost: ${money(baseCostAgg)} → ${money(delegCostAgg)} (${savedPct(baseCostAgg, delegCostAgg)}).**`);
      lines.push("");
    }
  }

  // ---- caveats ----
  lines.push("## Caveats");
  lines.push("");
  lines.push(
    "- **n=1 per arm.** Each cell is a single run of a single task; there is no variance estimate. Treat directional, not significant.",
  );
  lines.push(
    "- **Cost is the metric that matters.** `total_cost_usd` is what Anthropic bills. The token columns are diagnostic.",
  );
  lines.push(
    "- **\\*Prompt tokens include prompt-cache reads and creation.** They sum `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, so they overstate the \"true\" prompt size and are NOT proportional to cost (cached reads are much cheaper). Do not read the prompt-token delta as a cost delta.",
  );
  lines.push(
    "- **The delegate arm's Claude cost still includes orchestration + verification** — writing the work order, parsing `lh` JSON, checking the diff, recording feedback. Savings come from Claude not doing the implementation edits itself, not from Claude going idle.",
  );
  lines.push(
    "- **Local-side compute is not billed by Anthropic.** Moving work to the local model is the whole point, but that compute still costs wall-clock time and hardware — it is not free, just not on the API bill.",
  );
  lines.push(
    "- **Baseline cost may be recovered from raw logs** (`<agent>-<task>.log`) for entries written before cost capture existed; `—` means neither the summary nor the log had it.",
  );
  lines.push(
    "- **`delegated? = no`** means Claude ignored the nudge and did the task itself, so that row is not really a delegation measurement.",
  );
  lines.push("");

  const out = lines.join("\n") + "\n";
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  process.stdout.write(out);
}

main();
