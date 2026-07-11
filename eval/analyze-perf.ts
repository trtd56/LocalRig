#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, type SessionRecord } from "../src/session.ts";
import type { ModelTurnMetric } from "../src/metrics.ts";

interface ColdPoint { prompt_tokens: number; prefill_tps: number; }
type Classification = "HIT" | "MISS" | "RELOAD" | "UNKNOWN";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sessionsDir = path.resolve(arg("--sessions") ?? path.join(dataDir(), "sessions"));
const jsonOutput = argv.includes("--json");

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos), high = Math.ceil(pos);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (pos - low);
}
function loadColdCurve(): ColdPoint[] {
  const file = arg("--probe");
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as { samples?: Array<Record<string, unknown>> };
  return (parsed.samples ?? [])
    .filter((s) => s.phase === "cold" && finite(s.prompt_tokens) && finite(s.prefill_tps))
    .map((s) => ({ prompt_tokens: s.prompt_tokens as number, prefill_tps: s.prefill_tps as number }));
}
function coldRate(turn: ModelTurnMetric, curve: ColdPoint[]): number | undefined {
  if (!finite(turn.prompt_tokens) || !curve.length) return undefined;
  return [...curve].sort((a, b) => Math.abs(a.prompt_tokens - turn.prompt_tokens!) - Math.abs(b.prompt_tokens - turn.prompt_tokens!))[0]!.prefill_tps;
}
function classify(turn: ModelTurnMetric, curve: ColdPoint[]): Classification {
  if ((turn.load_ms ?? 0) > 1000) return "RELOAD";
  const baseline = coldRate(turn, curve);
  if (!baseline || !finite(turn.prefill_tps)) return "UNKNOWN";
  return turn.prefill_tps > baseline * 3 ? "HIT" : "MISS";
}

const curve = loadColdCurve();
const files = fs.existsSync(sessionsDir)
  ? fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).sort()
  : [];
const sessions = files.flatMap((name) => {
  try { return [JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8")) as SessionRecord]; }
  catch { return []; }
}).filter((session) => Array.isArray(session.modelTurns) && session.modelTurns.length > 0);

const reports = sessions.map((session) => {
  const turns = session.modelTurns!;
  const classified = turns.map((turn, index) => ({
    turn: turn.turn,
    task_id: turn.task_id,
    classification: index === 0 ? "UNKNOWN" as const : classify(turn, curve),
    context_event: turn.context_event,
    prefill_tps: turn.prefill_tps,
    decode_tps: turn.decode_tps,
    load_ms: turn.load_ms,
  }));
  const counts = Object.fromEntries((["HIT", "MISS", "RELOAD", "UNKNOWN"] as Classification[])
    .map((key) => [key, classified.filter((item) => item.classification === key).length]));
  const eligible = classified.slice(1).filter((item) => item.classification !== "UNKNOWN");
  const decode = turns.map((turn) => turn.decode_tps).filter(finite);
  const midpoint = Math.ceil(decode.length / 2);
  const first = percentile(decode.slice(0, midpoint), 0.5);
  const last = percentile(decode.slice(midpoint), 0.5);
  const thinkingMs = turns.filter((turn) => (turn.thinking_chars ?? 0) > 0).reduce((sum, turn) => sum + turn.duration_ms, 0);
  const modelMs = turns.reduce((sum, turn) => sum + turn.duration_ms, 0);
  return {
    session_id: session.id,
    duration_ms: session.durationMs,
    turns: turns.length,
    cache_hit_rate: eligible.length ? counts.HIT / eligible.length : undefined,
    counts,
    prefill_tps_median: percentile(turns.map((turn) => turn.prefill_tps).filter(finite), 0.5),
    prefill_tps_p95: percentile(turns.map((turn) => turn.prefill_tps).filter(finite), 0.95),
    decode_tps_median: percentile(decode, 0.5),
    decode_tps_p95: percentile(decode, 0.95),
    thinking_model_time_share: modelMs ? thinkingMs / modelMs : undefined,
    decode_trend_ratio: first && last ? last / first : undefined,
    turns_detail: classified,
  };
});

const allTurns = sessions.flatMap((session) => session.modelTurns!);
const aggregate = {
  sessions: reports.length,
  cold_curve_points: curve.length,
  duration_ms_median: percentile(sessions.map((session) => session.durationMs).filter(finite), 0.5),
  prefill_tps_median: percentile(allTurns.map((turn) => turn.prefill_tps).filter(finite), 0.5),
  prefill_tps_p95: percentile(allTurns.map((turn) => turn.prefill_tps).filter(finite), 0.95),
  decode_tps_median: percentile(allTurns.map((turn) => turn.decode_tps).filter(finite), 0.5),
  decode_tps_p95: percentile(allTurns.map((turn) => turn.decode_tps).filter(finite), 0.95),
  reloads: reports.reduce((sum, report) => sum + report.counts.RELOAD, 0),
  misses: reports.reduce((sum, report) => sum + report.counts.MISS, 0),
};

if (jsonOutput) process.stdout.write(JSON.stringify({ aggregate, sessions: reports }, null, 2) + "\n");
else {
  const pct = (n: number | undefined) => n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
  console.log("# LocalRig performance analysis\n");
  console.log(`Sessions: ${aggregate.sessions}; cold-curve points: ${aggregate.cold_curve_points}`);
  console.log(`Aggregate prefill median/p95: ${aggregate.prefill_tps_median?.toFixed(1) ?? "—"}/${aggregate.prefill_tps_p95?.toFixed(1) ?? "—"} tok/s`);
  console.log(`Aggregate decode median/p95: ${aggregate.decode_tps_median?.toFixed(1) ?? "—"}/${aggregate.decode_tps_p95?.toFixed(1) ?? "—"} tok/s`);
  console.log(`MISS: ${aggregate.misses}; RELOAD: ${aggregate.reloads}\n`);
  console.log("| session | duration ms | turns | hit rate | MISS | RELOAD | decode trend | thinking share |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const report of reports) {
    console.log(`| ${report.session_id} | ${report.duration_ms} | ${report.turns} | ${pct(report.cache_hit_rate)} | ${report.counts.MISS} | ${report.counts.RELOAD} | ${report.decode_trend_ratio?.toFixed(2) ?? "—"} | ${pct(report.thinking_model_time_share)} |`);
  }
}
