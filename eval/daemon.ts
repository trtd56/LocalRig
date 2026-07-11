#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "../src/session.ts";

export type DaemonCommand = "start" | "stop" | "status";

export interface DaemonOptions {
  command: DaemonCommand;
  port: number;
  foreground: boolean;
  flashAttention: boolean;
  kvCacheType?: string;
  numParallel: number;
  maxLoadedModels: number;
  extraEnv: Record<string, string>;
  binary: string;
}

export function defaultOllamaBinary(): string {
  if (process.env.OLLAMA_BIN) return process.env.OLLAMA_BIN;
  const appBinary = "/Applications/Ollama.app/Contents/Resources/ollama";
  return process.platform === "darwin" && fs.existsSync(appBinary) ? appBinary : "ollama";
}

export function parseDaemonArgs(argv: string[]): DaemonOptions {
  const command = argv[0] as DaemonCommand | undefined;
  if (command !== "start" && command !== "stop" && command !== "status") {
    throw new Error("usage: eval:daemon <start|stop|status> [options]");
  }
  const options: DaemonOptions = {
    command, port: 11500, foreground: false, flashAttention: false,
    numParallel: 1, maxLoadedModels: 1, extraEnv: {},
    binary: defaultOllamaBinary(),
  };
  const value = (index: number, flag: string) => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port") options.port = Number(value(i++, arg));
    else if (arg === "--foreground") options.foreground = true;
    else if (arg === "--flash-attention") options.flashAttention = true;
    else if (arg === "--kv-cache-type") options.kvCacheType = value(i++, arg);
    else if (arg === "--num-parallel") options.numParallel = Number(value(i++, arg));
    else if (arg === "--max-loaded-models") options.maxLoadedModels = Number(value(i++, arg));
    else if (arg === "--binary") options.binary = value(i++, arg);
    else if (arg === "--env") {
      const assignment = value(i++, arg);
      const equals = assignment.indexOf("=");
      if (equals <= 0) throw new Error("--env requires KEY=VAL");
      options.extraEnv[assignment.slice(0, equals)] = assignment.slice(equals + 1);
    } else throw new Error(`unknown option: ${arg}`);
  }
  for (const [flag, n] of [["--port", options.port], ["--num-parallel", options.numParallel], ["--max-loaded-models", options.maxLoadedModels]] as const) {
    if (!Number.isSafeInteger(n) || n < 1 || (flag === "--port" && n > 65535)) throw new Error(`${flag} must be a positive integer`);
  }
  return options;
}

export function daemonPaths(port: number, home = dataDir()) {
  const dir = path.join(home, "daemon", String(port));
  return { dir, pid: path.join(dir, "ollama.pid"), log: path.join(dir, "ollama.log") };
}

export function daemonEnv(options: DaemonOptions, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    OLLAMA_HOST: `127.0.0.1:${options.port}`,
    OLLAMA_NUM_PARALLEL: String(options.numParallel),
    OLLAMA_MAX_LOADED_MODELS: String(options.maxLoadedModels),
    OLLAMA_KEEP_ALIVE: "30m",
    ...(options.flashAttention ? { OLLAMA_FLASH_ATTENTION: "1" } : {}),
    ...(options.kvCacheType ? { OLLAMA_KV_CACHE_TYPE: options.kvCacheType } : {}),
    ...options.extraEnv,
  };
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function healthy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try { return (await fetch(`http://127.0.0.1:${port}/api/version`, { signal: controller.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < end);
  return false;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: DaemonOptions;
  try { options = parseDaemonArgs(argv); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const paths = daemonPaths(options.port);
  const existing = readPid(paths.pid);
  if (options.command === "status") {
    const running = existing !== undefined && alive(existing) && await healthy(options.port);
    console.log(running ? `running pid=${existing} url=http://127.0.0.1:${options.port}` : "stopped");
    return running ? 0 : 1;
  }
  if (options.command === "stop") {
    if (existing === undefined || !alive(existing)) {
      fs.rmSync(paths.pid, { force: true });
      console.log("already stopped");
      return 0;
    }
    process.kill(existing, "SIGTERM");
    if (!await waitUntil(() => !alive(existing), 10_000)) {
      try { process.kill(existing, "SIGKILL"); } catch {}
    }
    fs.rmSync(paths.pid, { force: true });
    console.log(`stopped pid=${existing}`);
    return 0;
  }
  if (existing !== undefined && alive(existing)) {
    console.error(`daemon already running: pid ${existing}`);
    return 1;
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  if (options.foreground) {
    const child = spawn(options.binary, ["serve"], { env: daemonEnv(options), stdio: "inherit" });
    return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  }
  const log = fs.openSync(paths.log, "a");
  const child = spawn(options.binary, ["serve"], { env: daemonEnv(options), detached: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  if (child.pid === undefined) throw new Error("failed to start ollama");
  fs.writeFileSync(paths.pid, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  if (!await waitUntil(() => healthy(options.port), 30_000)) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    fs.rmSync(paths.pid, { force: true });
    console.error(`daemon failed health check; see ${paths.log}`);
    return 1;
  }
  console.log(`started pid=${child.pid} url=http://127.0.0.1:${options.port} log=${paths.log}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
