#!/usr/bin/env bun
import * as readline from "node:readline";
import { Agent } from "./agent.ts";
import { defaultConfig, type Config } from "./config.ts";
import { createRenderer, c } from "./ui/render.ts";

function parseArgs(argv: string[]): { config: Config; prompt?: string; verbose: boolean } {
  const config = { ...defaultConfig };
  let prompt: string | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-p":
      case "--print":
        prompt = argv[++i];
        break;
      case "--model":
        config.model = argv[++i]!;
        break;
      case "--num-ctx":
        config.numCtx = Number(argv[++i]);
        break;
      case "--temperature":
        config.temperature = Number(argv[++i]);
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        config.yolo = true;
        break;
      case "-v":
      case "--verbose":
        verbose = true;
        break;
      case "-h":
      case "--help":
        console.log(`localllm-harness — coding agent for local LLMs via Ollama

Usage:
  lh                      interactive REPL
  lh -p "task"            one-shot mode (auto-approves tools)
  lh --model NAME         override model (default: ${defaultConfig.model})
  lh --num-ctx N          context window (default: ${defaultConfig.numCtx})
  lh --temperature T      sampling temperature (default: ${defaultConfig.temperature})
  lh --yolo               auto-approve mutating tools
  lh -v                   verbose (tool output, token usage)`);
        process.exit(0);
    }
  }
  return { config, prompt, verbose };
}

async function main() {
  const { config, prompt, verbose } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const render = createRenderer(verbose);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  const askPermission = async (name: string, _args: Record<string, unknown>, display: string) => {
    const answer = await ask(c.yellow(`  allow ${display}? [y/N/a(lways)] `));
    if (answer.trim().toLowerCase() === "a") {
      config.yolo = true;
      return true;
    }
    return answer.trim().toLowerCase() === "y";
  };

  if (prompt !== undefined) config.yolo = true; // one-shot mode can't prompt

  const agent = new Agent(config, cwd, render, askPermission);

  process.on("SIGINT", () => {
    agent.interrupt();
    process.stdout.write("\n" + c.yellow("[interrupted]") + "\n");
    if (prompt !== undefined) process.exit(130);
  });

  if (prompt !== undefined) {
    const answer = await agent.run(prompt);
    if (answer) process.stdout.write("\n" + answer + "\n");
    rl.close();
    return;
  }

  console.log(c.bold(`localllm-harness`) + c.dim(` — ${config.model} @ ${config.ollamaUrl} (ctx ${config.numCtx})`));
  console.log(c.dim(`cwd: ${cwd} — type a task, "exit" to quit`));
  for (;;) {
    const input = (await ask(c.bold("\n> "))).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    try {
      await agent.run(input);
    } catch (err) {
      console.error(c.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  rl.close();
}

main();
