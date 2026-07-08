#!/usr/bin/env bun
// Compares the `claude` baseline arm against the delegate arms and reports
// whether delegating actually saved Claude API cost.
//
//   bun run eval/analyze-delegation.ts
//
// Reads eval/results/summary-claude.json (baseline), summary-claude-delegate.json
// (delegates to the local `lh` CLI), and — when present —
// summary-claude-delegate-haiku.json (delegates to a `claude --model haiku`
// worker). With the haiku summary present the report becomes a 3-way comparison;
// otherwise it stays the original 2-way report. Emits markdown to stdout AND to
// eval/results/delegation-comparison.md. Cost is the primary metric: dollars are
// billed, whereas the prompt-token counts here include prompt-cache reads and
// creation and so overstate "real" prompt size (see the caveats section).

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
  /** Present in v2 summaries; promptTokens is the compatibility fallback. */
  promptTotalTokens?: number;
  promptLastTokens?: number;
  completionTokens: number;
  durationMs: number;
  errorKind?: string;
}

interface Worker {
  file: string;
  costUsd?: number;
  isError?: boolean;
  turns?: number;
  durationMs?: number;
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
  workers?: Worker[];
  workerSessions?: number;
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

/** Orchestrator cost for an arm's entry (falls back to the raw log). */
function costOf(agent: string, e: Entry | undefined): number | undefined {
  if (!e) return undefined;
  return e.costUsd ?? costFromLog(agent, e.task);
}

/** Summed billed cost of the Haiku workers (undefined if no worker had a cost). */
function workerCost(e: Entry | undefined): number | undefined {
  if (!e || !e.workers || e.workers.length === 0) return undefined;
  let sum = 0;
  let any = false;
  for (const w of e.workers) {
    if (typeof w.costUsd === "number") {
      sum += w.costUsd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

function workerErrors(e: Entry | undefined): number {
  return e?.workers?.filter((w) => w.isError === true).length ?? 0;
}

/** a + b, treating undefined as 0, but undefined when BOTH are undefined. */
function sumCost(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
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

/** "a / b / c" with all three formatted by `fmt`. */
function triple<T>(a: T | undefined, b: T | undefined, c: T | undefined, fmt: (v: T | undefined) => string): string {
  return `${fmt(a)} / ${fmt(b)} / ${fmt(c)}`;
}

/** Percent of baseline cost saved by delegating (positive = cheaper). */
function savedPct(base: number | undefined, deleg: number | undefined): string {
  if (base === undefined || deleg === undefined || base === 0) return dash;
  const pct = ((base - deleg) / base) * 100;
  const sign = pct > 0 ? "" : "+"; // negative pct = got more expensive; show +N% cost
  return pct >= 0 ? `${pct.toFixed(0)}% saved` : `${sign}${(-pct).toFixed(0)}% cost`;
}

/** Local-side rollup for one lh-delegate entry: total tokens / wall time (calls). */
function localSide(e: Entry | undefined): string {
  if (!e || !e.delegated || !e.delegations || e.delegations.length === 0) return dash;
  let tok = 0;
  let ms = 0;
  for (const d of e.delegations) {
    tok += (d.promptTotalTokens ?? d.promptTokens ?? 0) + (d.completionTokens ?? 0);
    ms += d.durationMs ?? 0;
  }
  const n = e.delegations.length;
  return `${int(tok)} tok / ${Math.round(ms / 1000)}s (${n} call${n === 1 ? "" : "s"})`;
}

/** Haiku worker rollup cell: call count / session count / errors / lh contamination. */
function haikuCell(h: Entry | undefined): string {
  if (!h) return dash;
  const n = h.workers?.length ?? 0;
  const parts = [`${n} call${n === 1 ? "" : "s"}`, `${h.workerSessions ?? 0} sess`];
  const errs = workerErrors(h);
  if (errs > 0) parts.push(`${errs} err`);
  if ((h.delegations?.length ?? 0) > 0) parts.push("⚠ lh contamination");
  return parts.join(" / ");
}

// ---------- 2-way (baseline vs lh) ----------

function renderTwoWay(lines: string[], baseByTask: Map<string, Entry>, delegByTask: Map<string, Entry>): void {
  const tasks = [...new Set([...baseByTask.keys(), ...delegByTask.keys()])].sort();

  lines.push("## Per-task");
  lines.push("");
  lines.push(
    "| task | pass (base→deleg) | cost base→deleg | Claude saved | output tok base→deleg | prompt tok\\* base→deleg | turns base→deleg | wall base→deleg | delegated? | local-side (tok / dur) |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

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
        localTok += (del.promptTotalTokens ?? del.promptTokens ?? 0) + (del.completionTokens ?? 0);
        localMs += del.durationMs ?? 0;
      }
    }
  }

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
    return;
  }
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

// ---------- 3-way (baseline vs lh vs haiku) ----------

function renderThreeWay(
  lines: string[],
  baseByTask: Map<string, Entry>,
  delegByTask: Map<string, Entry>,
  haikuByTask: Map<string, Entry>,
): void {
  const tasks = [...new Set([...baseByTask.keys(), ...delegByTask.keys(), ...haikuByTask.keys()])].sort();

  lines.push("Columns are baseline (Claude does it) / `lh`-worker delegate / Haiku-worker delegate. The Haiku arm is a control: same Sonnet orchestrator, but the worker is `claude --model haiku` (billed) instead of the free local `lh`, isolating the fixed delegation-structure cost from local-model quality/latency.");
  lines.push("");

  // ---- per-task ----
  lines.push("## Per-task");
  lines.push("");
  lines.push(
    "| task | pass (base/lh/hk) | base cost | lh cost | hk orch cost | hk billed total | wall base/lh/hk | hk workers |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");

  const inAll: string[] = [];
  let basePass = 0;
  let lhPass = 0;
  let hkPass = 0;
  let baseCost = 0;
  let lhCost = 0;
  let hkOrchCost = 0;
  let hkWorkerCost = 0;
  let baseCostKnown = false;
  let lhCostKnown = false;
  let hkCostKnown = false;
  let baseWall = 0;
  let lhWall = 0;
  let hkWall = 0;
  let lhDelegated = 0;
  let hkDelegated = 0;
  let workerCalls = 0;
  let workerSess = 0;
  const h1rows: string[] = [];

  for (const task of tasks) {
    const b = baseByTask.get(task);
    const d = delegByTask.get(task);
    const h = haikuByTask.get(task);
    const bCost = costOf("claude", b);
    const dCost = costOf("claude-delegate", d);
    const hOrch = costOf("claude-delegate-haiku", h);
    const hWork = workerCost(h);
    const hTotal = h ? sumCost(hOrch, hWork) : undefined;

    lines.push(
      `| ${task} | ${triple(b?.passed, d?.passed, h?.passed, pass)} | ${money(bCost)} | ${money(dCost)} | ` +
        `${money(hOrch)} | ${money(hTotal)} | ${triple(b?.durationSec, d?.durationSec, h?.durationSec, secs)} | ${haikuCell(h)} |`,
    );

    // Aggregate + hypotheses cover only tasks present in all three arms.
    if (b && d && h) {
      inAll.push(task);
      if (b.passed) basePass++;
      if (d.passed) lhPass++;
      if (h.passed) hkPass++;
      if (bCost !== undefined) {
        baseCost += bCost;
        baseCostKnown = true;
      }
      if (dCost !== undefined) {
        lhCost += dCost;
        lhCostKnown = true;
      }
      if (hOrch !== undefined) {
        hkOrchCost += hOrch;
        hkCostKnown = true;
      }
      if (hWork !== undefined) hkWorkerCost += hWork;
      baseWall += b.durationSec ?? 0;
      lhWall += d.durationSec ?? 0;
      hkWall += h.durationSec ?? 0;
      if (d.delegated) lhDelegated++;
      if (h.delegated) hkDelegated++;
      workerCalls += h.workers?.length ?? 0;
      workerSess += h.workerSessions ?? 0;
      // H1 per-task: lh cost (all orchestration, worker free) vs haiku orchestrator-only cost.
      h1rows.push(`| ${task} | ${money(dCost)} | ${money(hOrch)} | ${savedPct(dCost, hOrch)} |`);
    }
  }

  const n = inAll.length;
  const baseCostAgg = baseCostKnown ? baseCost : undefined;
  const lhCostAgg = lhCostKnown ? lhCost : undefined;
  const hkOrchAgg = hkCostKnown ? hkOrchCost : undefined;
  const hkWorkerAgg = hkWorkerCost > 0 ? hkWorkerCost : undefined;
  const hkTotalAgg = hkCostKnown ? sumCost(hkOrchCost, hkWorkerCost) : undefined;

  // ---- totals ----
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  if (n === 0) {
    lines.push(
      "_No task has been run in all three arms yet, so there is nothing to aggregate 3-way. " +
        "Run the haiku arm on a task that also has baseline + lh-delegate entries, e.g. " +
        "`bun run eval/run.ts --agent claude-delegate-haiku --task doc-sync`._",
    );
    lines.push("");
    return;
  }
  lines.push(
    `Totals below cover only the ${n} task${n === 1 ? "" : "s"} run in **all three** arms ` +
      `(${inAll.join(", ")}); the per-task table above lists every task seen in any arm.`,
  );
  lines.push("");
  lines.push("| metric | baseline (claude) | lh-delegate | haiku-delegate |");
  lines.push("|---|---|---|---|");
  lines.push(`| tasks (all 3 arms) | ${n} | ${n} | ${n} |`);
  lines.push(`| passed | ${basePass}/${n} | ${lhPass}/${n} | ${hkPass}/${n} |`);
  lines.push(`| Claude billed cost | ${money(baseCostAgg)} | ${money(lhCostAgg)} | ${money(hkTotalAgg)} |`);
  lines.push(`| — orchestrator only | ${money(baseCostAgg)} | ${money(lhCostAgg)} | ${money(hkOrchAgg)} |`);
  lines.push(`| — worker (billed) | ${dash} | $0 (local, free) | ${money(hkWorkerAgg)} |`);
  lines.push(`| Claude wall time | ${secs(baseWall)} | ${secs(lhWall)} | ${secs(hkWall)} |`);
  lines.push(`| tasks delegated | ${dash} | ${lhDelegated}/${n} | ${hkDelegated}/${n} |`);
  lines.push(`| worker calls / sessions | ${dash} | ${dash} | ${workerCalls} / ${workerSess} |`);
  lines.push("");

  if (baseCostAgg !== undefined && lhCostAgg !== undefined && hkTotalAgg !== undefined) {
    lines.push(
      `**Net billed cost: baseline ${money(baseCostAgg)} → lh ${money(lhCostAgg)} (${savedPct(baseCostAgg, lhCostAgg)}) → ` +
        `haiku ${money(hkTotalAgg)} (${savedPct(baseCostAgg, hkTotalAgg)} vs baseline).**`,
    );
    lines.push("");
  }

  // ---- hypotheses ----
  lines.push("## Hypotheses");
  lines.push("");

  // H1: does the haiku arm's orchestrator-only cost match the lh arm's cost?
  lines.push(
    "**H1 — fixed orchestration floor.** The lh arm's cost is entirely Sonnet orchestration (the lh worker is free); the haiku arm's *orchestrator-only* cost is the same structural work with a different worker. If they match, the delegation cost is a fixed orchestration floor independent of which worker runs.",
  );
  lines.push("");
  lines.push("| task | lh cost | hk orchestrator cost | Δ |");
  lines.push("|---|---|---|---|");
  for (const r of h1rows) lines.push(r);
  lines.push(`| **all ${n}** | ${money(lhCostAgg)} | ${money(hkOrchAgg)} | ${savedPct(lhCostAgg, hkOrchAgg)} |`);
  lines.push("");

  // H2: worker quality via pass rates.
  const hkErrTotal = inAll.reduce((acc, t) => acc + workerErrors(haikuByTask.get(t)), 0);
  lines.push(
    `**H2 — worker quality.** Pass rate over the ${n} shared task${n === 1 ? "" : "s"}: baseline ${basePass}/${n}, ` +
      `lh ${lhPass}/${n}, haiku ${hkPass}/${n}. Haiku worker calls flagged \`is_error\`: ${hkErrTotal}. ` +
      "A gap between lh and haiku pass rates is worker capability, not delegation structure.",
  );
  lines.push("");

  // H3: wall time.
  lines.push(
    `**H3 — wall time.** Total wall time: baseline ${secs(baseWall)} / lh ${secs(lhWall)} / haiku ${secs(hkWall)}. ` +
      "Delegation trades wall-clock for cost; the haiku worker is far faster than local Qwen, so the haiku arm should sit " +
      "between baseline and the lh arm.",
  );
  lines.push("");
}

// ---------- batch amortization (opt-in: only when the batchcli arm has run) ----------

/**
 * Appends a self-contained "Batch amortization" section comparing, per task, the
 * baseline, the `claude-delegate` arm (one `lh -p -` per subtask in a session),
 * and the `claude-delegate-batchcli` arm (all subtasks in one `lh batch` call).
 * This isolates whether the batch primitive amortizes the fixed per-session
 * startup cost (S in the round-5 S+T model) across a task's subtasks. Renders
 * NOTHING when the batchcli arm has no summary, so the existing 2-way/3-way
 * report stays byte-identical until that arm is actually run.
 */
function renderBatch(
  lines: string[],
  baseByTask: Map<string, Entry>,
  delegByTask: Map<string, Entry>,
  batchByTask: Map<string, Entry>,
): void {
  if (batchByTask.size === 0) return;
  const tasks = [...batchByTask.keys()].sort();

  lines.push("## Batch amortization (`lh batch`)");
  lines.push("");
  lines.push(
    "Only tasks with a `claude-delegate-batchcli` entry appear here. This arm bundles a task's INDEPENDENT subtasks into ONE `lh batch` call, versus `seq lh` (the plain `claude-delegate` arm), which issues one `lh -p -` per subtask within a single session. The gap isolates whether the batch primitive amortizes the fixed per-session startup cost across subtasks (round-5 S+T model). Baseline is Sonnet solving the whole task itself.",
  );
  lines.push("");
  lines.push(
    "| task | pass (base / seq lh / batch) | base cost | seq-lh cost | batch cost | batch vs base | batch vs seq-lh | wall base/seq/batch | batch delegated? | batch local-side (tok / dur) |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

  for (const task of tasks) {
    const b = baseByTask.get(task);
    const d = delegByTask.get(task);
    const q = batchByTask.get(task);
    const bCost = costOf("claude", b);
    const dCost = costOf("claude-delegate", d);
    const qCost = costOf("claude-delegate-batchcli", q);
    lines.push(
      `| ${task} | ${triple(b?.passed, d?.passed, q?.passed, pass)} | ${money(bCost)} | ${money(dCost)} | ${money(qCost)} | ` +
        `${savedPct(bCost, qCost)} | ${savedPct(dCost, qCost)} | ${triple(b?.durationSec, d?.durationSec, q?.durationSec, secs)} | ` +
        `${yesno(q?.delegated)} | ${localSide(q)} |`,
    );
  }

  lines.push("");
  lines.push(
    "- **n=1 per cell**, as elsewhere — directional only. `batch local-side` rolls up the per-subtask `lh` sessions (tokens / wall / call count) the batch spawned; per-subtask verdicts are in `feedback.jsonl` under the arm's LH_HOME. A `batch delegated? = no` means the orchestrator ignored the nudge (did the work itself or never called `lh batch`), so that row is not a batch measurement.",
  );
  lines.push("");
}

// ---------- caveats ----------

function renderCaveats(lines: string[], threeWay: boolean): void {
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
    "- **A delegate arm's Claude cost still includes orchestration + verification** — writing the work order, parsing the worker result, checking the diff, recording the verdict. Savings come from Claude not doing the implementation edits itself, not from Claude going idle.",
  );
  lines.push(
    "- **Local-side (lh) compute is not billed by Anthropic**, but the Haiku worker IS — that is the whole point of the control: the haiku arm's true cost is orchestrator + worker, so compare its **billed total**, while the lh arm's worker is free.",
  );
  if (threeWay) {
    lines.push(
      "- **Haiku `delegated?` is worker-based** (a `.delegate/worker-*.json` appeared); `worker calls / sessions` is the mechanical cross-check from `~/.claude/projects/`. A `⚠ lh contamination` flag means the orchestrator wrongly called `lh` in the haiku arm.",
    );
  }
  lines.push(
    "- **Baseline cost may be recovered from raw logs** (`<agent>-<task>.log`) for entries written before cost capture existed; `—` means neither the summary nor the log had it.",
  );
  lines.push(
    "- **`delegated? = no`** means the orchestrator ignored the nudge and did the task itself, so that row is not really a delegation measurement.",
  );
  lines.push("");
}

function main(): void {
  const baseArr = readSummary("claude");
  const delegArr = readSummary("claude-delegate");
  const haikuArr = readSummary("claude-delegate-haiku");
  const batchArr = readSummary("claude-delegate-batchcli");
  const threeWay = haikuArr.length > 0;

  const baseByTask = new Map(baseArr.map((e) => [e.task, e]));
  const delegByTask = new Map(delegArr.map((e) => [e.task, e]));
  const haikuByTask = new Map(haikuArr.map((e) => [e.task, e]));
  const batchByTask = new Map(batchArr.map((e) => [e.task, e]));

  const lines: string[] = [];
  lines.push(
    threeWay
      ? "# Delegation comparison: baseline vs `lh` worker vs Haiku worker"
      : "# Delegation comparison: `claude` vs `claude-delegate`",
  );
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    threeWay
      ? "Does delegating save Claude API cost, and is the saving a property of delegation *structure* or of the free local worker? **Cost (USD) is the primary metric.**"
      : "Does having Claude Code delegate the implementation to the local `lh` CLI save Claude API cost versus Claude Code doing the task itself? **Cost (USD) is the primary metric.**",
  );
  lines.push("");

  const anyTasks = baseByTask.size + delegByTask.size + haikuByTask.size + batchByTask.size > 0;
  if (!anyTasks) {
    lines.push(
      "_No results found. Run the arms first, e.g. " +
        "`bun run eval/run.ts --agent claude --task doc-sync` and " +
        "`bun run eval/run.ts --agent claude-delegate --task doc-sync`._",
    );
  } else if (threeWay) {
    renderThreeWay(lines, baseByTask, delegByTask, haikuByTask);
    renderBatch(lines, baseByTask, delegByTask, batchByTask);
    renderCaveats(lines, true);
  } else {
    renderTwoWay(lines, baseByTask, delegByTask);
    renderBatch(lines, baseByTask, delegByTask, batchByTask);
    renderCaveats(lines, false);
  }

  const out = lines.join("\n") + "\n";
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  process.stdout.write(out);
}

main();
