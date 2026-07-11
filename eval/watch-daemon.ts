#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { fetchRunnerSnapshot, type RunnerSnapshot } from "../src/provider/ollama.ts";

export interface WatchEntry extends RunnerSnapshot { url: string }

export interface DaemonWatcher {
  entries: WatchEntry[];
  stop(): Promise<void>;
}

export function foreignEntriesForInterval(
  entries: WatchEntry[],
  startMs: number,
  endMs: number,
  allowedDigests: ReadonlySet<string>,
): WatchEntry[] {
  const latestBefore = new Map<string, WatchEntry>();
  for (const entry of entries) {
    const at = Date.parse(entry.captured_at);
    if (!Number.isFinite(at) || at > startMs) continue;
    const previous = latestBefore.get(entry.url);
    if (!previous || Date.parse(previous.captured_at) < at) latestBefore.set(entry.url, entry);
  }
  const candidates = [...new Set([
    ...latestBefore.values(),
    ...entries.filter((entry) => {
      const at = Date.parse(entry.captured_at);
      return Number.isFinite(at) && at >= startMs && at <= endMs;
    }),
  ])];
  return candidates.filter((entry) => {
    const at = Date.parse(entry.captured_at);
    return Number.isFinite(at) && (entry.models ?? []).some((model) => !model.digest || ![...allowedDigests].some((allowed) =>
        model.digest === allowed || model.digest!.startsWith(allowed) || allowed.startsWith(model.digest!),
      ));
  });
}

export async function startDaemonWatcher(urls: string[], out: string, intervalMs = 30_000): Promise<DaemonWatcher> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const entries: WatchEntry[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async () => {
    const snapshots = await Promise.all(urls.map(async (url): Promise<WatchEntry> => ({ url, ...await fetchRunnerSnapshot(url) })));
    entries.push(...snapshots);
    fs.appendFileSync(out, snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n");
  };
  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = tick().finally(() => { if (!stopped) schedule(); });
    }, intervalMs);
  };
  await tick();
  schedule();
  return {
    entries,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

function parse(argv: string[]) {
  const urls: string[] = [];
  let intervalMs = 30_000;
  let out = path.join(import.meta.dir, "results", "daemon-watch", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--url") urls.push(next());
    else if (arg === "--interval-ms") intervalMs = Number(next());
    else if (arg === "--out") out = path.resolve(next());
    else throw new Error(`unknown option: ${arg}`);
  }
  if (urls.length === 0) urls.push(process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434");
  if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error("--interval-ms must be >= 100");
  return { urls, intervalMs, out };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: ReturnType<typeof parse>;
  try { options = parse(argv); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.error(`watching ${options.urls.join(", ")} -> ${options.out}`);
  const watcher = await startDaemonWatcher(options.urls, options.out, options.intervalMs);
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs, 1000)));
  await watcher.stop();
  return 0;
}

if (import.meta.main) process.exitCode = await main();
