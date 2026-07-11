#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfig } from "../src/config.ts";
import { OllamaClient } from "../src/provider/ollama.ts";

interface ProbeSample {
  phase: "cold" | "warm" | "suffix" | "decode";
  target_tokens: number;
  num_ctx: number;
  prompt_tokens: number;
  eval_tokens: number;
  ttft_ms: number;
  load_ms?: number;
  prompt_eval_ms?: number;
  eval_ms?: number;
  prefill_tps?: number;
  decode_tps?: number;
}

function args() {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const numbers = (name: string, fallback: number[]) =>
    (value(name)?.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0) ?? fallback);
  return {
    sizes: numbers("--sizes", [10_000, 50_000, 100_000]),
    contexts: numbers("--num-ctx", [16_384, 32_768, 65_536, 131_072]),
    output: value("--output"),
    model: value("--model") ?? defaultConfig.model,
    url: value("--url") ?? defaultConfig.ollamaUrl,
  };
}

const rate = (tokens: number, ms: number | undefined) => ms && ms > 0 ? tokens / (ms / 1000) : undefined;
const synthetic = (tokens: number, salt: string) =>
  `LocalRig prefill probe ${salt}. Read silently and answer only OK.\n` + "x ".repeat(tokens);

async function sample(
  client: OllamaClient,
  prompt: string,
  targetTokens: number,
  numCtx: number,
  phase: ProbeSample["phase"],
  numPredict: number,
): Promise<ProbeSample> {
  const started = performance.now();
  let firstAt: number | undefined;
  const response = await client.chat(
    [{ role: "user", content: prompt }], [],
    { num_ctx: numCtx, num_predict: numPredict, temperature: 0, think: false },
    (chunk) => { if (firstAt === undefined && (chunk.content || chunk.thinking || chunk.toolCall)) firstAt = performance.now(); },
    new AbortController().signal,
  );
  return {
    phase, target_tokens: targetTokens, num_ctx: numCtx,
    prompt_tokens: response.promptTokens, eval_tokens: response.evalTokens,
    ttft_ms: (firstAt ?? performance.now()) - started,
    load_ms: response.timings?.loadMs,
    prompt_eval_ms: response.timings?.promptEvalMs,
    eval_ms: response.timings?.evalMs,
    prefill_tps: rate(response.promptTokens, response.timings?.promptEvalMs),
    decode_tps: rate(response.evalTokens, response.timings?.evalMs),
  };
}

async function main() {
  const options = args();
  const client = new OllamaClient(options.url, options.model, defaultConfig.keepAlive);
  const samples: ProbeSample[] = [];
  for (const numCtx of options.contexts) {
    for (const size of options.sizes) {
      if (size > numCtx * 0.85) continue;
      const prompt = synthetic(size, `${Date.now()}-${numCtx}-${size}`);
      samples.push(await sample(client, prompt, size, numCtx, "cold", 1));
    }
  }

  const warmCtx = Math.max(...options.contexts);
  const warmSize = Math.min(10_000, Math.floor(warmCtx * 0.5));
  const warmPrompt = synthetic(warmSize, "warm-semantics");
  samples.push(await sample(client, warmPrompt, warmSize, warmCtx, "warm", 1));
  samples.push(await sample(client, warmPrompt, warmSize, warmCtx, "warm", 1));
  samples.push(await sample(client, warmPrompt + " suffix", warmSize, warmCtx, "suffix", 1));
  samples.push(await sample(
    client,
    "Emit exactly 512 lowercase letter x tokens separated by spaces. Do not stop early and output nothing else.",
    0,
    warmCtx,
    "decode",
    512,
  ));

  const result = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    ollama_url: options.url,
    model: options.model,
    samples,
  };
  const text = JSON.stringify(result, null, 2) + "\n";
  if (options.output) {
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, text);
  }
  process.stdout.write(text);
}

await main();
