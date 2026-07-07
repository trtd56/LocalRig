// Tests for config defaults, env-var parsing, and CLI flag parsing.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { defaultConfig, resolveProfile } from "../src/config.ts";
import { parseArgs } from "../src/index.ts";

describe("defaultConfig", () => {
  test("new knobs have their documented defaults", () => {
    expect(defaultConfig.thinkBudgetChars).toBe(6000);
    expect(defaultConfig.presencePenalty).toBe(1.0);
    expect(defaultConfig.maxTimeMs).toBe(0);
    expect(defaultConfig.headroomTokens).toBe(4096);
    expect(defaultConfig.numPredict).toBe(16384);
    expect(defaultConfig.numCtx).toBe(32768);
  });

  test("dead maxRepairAttempts knob is gone", () => {
    expect("maxRepairAttempts" in defaultConfig).toBe(false);
  });
});

describe("parseArgs (CLI flags)", () => {
  test("--max-time is seconds, stored as ms", () => {
    expect(parseArgs(["-p", "x", "--max-time", "1500"]).config.maxTimeMs).toBe(1_500_000);
  });

  test("--presence-penalty, --think-budget, --headroom, --num-predict", () => {
    const { config } = parseArgs([
      "-p", "x",
      "--presence-penalty", "0.3",
      "--think-budget", "8000",
      "--headroom", "2048",
      "--num-predict", "4096",
    ]);
    expect(config.presencePenalty).toBe(0.3);
    expect(config.thinkBudgetChars).toBe(8000);
    expect(config.headroomTokens).toBe(2048);
    expect(config.numPredict).toBe(4096);
  });

  test("defaults survive when flags are absent", () => {
    const { config } = parseArgs(["-p", "x"]);
    expect(config.maxTimeMs).toBe(defaultConfig.maxTimeMs);
    expect(config.thinkBudgetChars).toBe(defaultConfig.thinkBudgetChars);
    expect(config.presencePenalty).toBe(defaultConfig.presencePenalty);
    expect(config.headroomTokens).toBe(defaultConfig.headroomTokens);
  });
});

describe("env-var parsing", () => {
  test("env overrides are read at module load (subprocess, no network)", () => {
    const configPath = path.join(import.meta.dir, "..", "src", "config.ts");
    const code = `const m = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(m.defaultConfig));`;
    const proc = Bun.spawnSync([process.execPath, "-e", code], {
      env: {
        ...process.env,
        LH_THINK_BUDGET: "1234",
        LH_HEADROOM: "999",
        LH_PRESENCE_PENALTY: "0.5",
        LH_MAX_TIME: "42",
        LH_NUM_CTX: "65536",
      },
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString().trim());
    expect(out.thinkBudgetChars).toBe(1234);
    expect(out.headroomTokens).toBe(999);
    expect(out.presencePenalty).toBe(0.5);
    expect(out.maxTimeMs).toBe(42_000); // seconds → ms
    expect(out.numCtx).toBe(65536);
  });

  test("LH_TEMPERATURE / LH_TOP_P / LH_TOP_K beat the model's profile", () => {
    const configPath = path.join(import.meta.dir, "..", "src", "config.ts");
    const code = `const m = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(m.defaultConfig));`;
    const proc = Bun.spawnSync([process.execPath, "-e", code], {
      env: {
        ...process.env,
        LH_MODEL: "qwen36-27b-mtp:latest",
        LH_TEMPERATURE: "0.9",
        LH_TOP_P: "0.5",
        LH_TOP_K: "7",
      },
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString().trim());
    expect(out.temperature).toBe(0.9);
    expect(out.topP).toBe(0.5);
    expect(out.topK).toBe(7);
  });
});

describe("resolveProfile (model profiles)", () => {
  test("a model name containing 'qwen' resolves the Qwen profile", () => {
    const profile = resolveProfile("qwen36-27b-mtp:latest");
    expect(profile).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.0, thinkBudgetChars: 6000 });
  });

  test("matching is case-insensitive", () => {
    expect(resolveProfile("Qwen3-32B-Instruct")).toEqual(resolveProfile("qwen3-32b-instruct"));
  });

  test("an unknown model name falls back to the default profile", () => {
    // Same values as Qwen3.6 today (the only validated profile), but resolved
    // via the no-match path rather than the "qwen" pattern.
    expect(resolveProfile("llama3-70b")).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      presencePenalty: 1.0,
      thinkBudgetChars: 6000,
    });
  });
});

describe("parseArgs (--model re-resolves the profile)", () => {
  test("--model alone picks up that model's profile", () => {
    const { config } = parseArgs(["-p", "x", "--model", "some-llama-model"]);
    expect(config.model).toBe("some-llama-model");
    expect(config.temperature).toBe(resolveProfile("some-llama-model").temperature);
  });

  test("an explicit --temperature after --model is not clobbered by the profile", () => {
    const { config } = parseArgs(["-p", "x", "--model", "some-llama-model", "--temperature", "0.42"]);
    expect(config.temperature).toBe(0.42);
  });

  test("an explicit --temperature before --model survives the later profile re-resolve", () => {
    const { config } = parseArgs(["-p", "x", "--temperature", "0.42", "--model", "some-llama-model"]);
    expect(config.temperature).toBe(0.42);
  });
});
